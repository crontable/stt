const fs = require('fs-extra');
const { createHash, randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { nodewhisper } = require('nodejs-whisper');
const { MODELS_LIST, WHISPER_CPP_PATH } = require('nodejs-whisper/dist/constants');

// 연결 라이브러리의 large 파일 경로에 정식 large-v3 모델을 저장합니다.
const LARGE_V3_SHA1 = 'ad82bf6a9043ceed055076d0fd39f5f186ff8062';
const LARGE_V3_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin';

async function getModelChecksum(filePath) {
  const checksum = createHash('sha1');
  await pipeline(fs.createReadStream(filePath), checksum);
  return checksum.digest('hex');
}

// 지원하는 오디오 파일 확장자
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.avi', '.mov'];

class SpeechToTextConverter {
  constructor({ assetsDir, outputDir, modelName = 'large-v3', onProgress = () => {} } = {}) {
    if (!path.isAbsolute(assetsDir || '') || !path.isAbsolute(outputDir || '')) {
      throw new Error('입력·출력 폴더의 절대 경로를 지정해 주세요.');
    }
    Object.assign(this, { assetsDir, outputDir, modelName, onProgress });
  }

  get libraryModelName() {
    return this.modelName === 'large-v3' ? 'large' : this.modelName;
  }

  async prepareModel() {
    if (this.libraryModelName !== 'large') {
      return;
    }

    const modelPath = path.join(WHISPER_CPP_PATH, 'models', 'ggml-large.bin');
    const modelExists = await fs.pathExists(modelPath);
    if (modelExists && await getModelChecksum(modelPath) === LARGE_V3_SHA1) {
      return;
    }

    this.onProgress({ type: 'model-download-started' });
    const downloadPath = `${modelPath}.${process.pid}.download`;
    try {
      const response = await fetch(LARGE_V3_URL);
      if (!response.ok) {
        throw new Error(`large-v3 모델 다운로드에 실패했습니다. HTTP 상태 코드: ${response.status}`);
      }
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(downloadPath));
      if (await getModelChecksum(downloadPath) !== LARGE_V3_SHA1) {
        throw new Error('large-v3 모델 파일의 검증값이 일치하지 않습니다. 다시 실행하면 재다운로드합니다.');
      }
      await fs.rename(downloadPath, modelPath);
      this.onProgress({ type: 'model-download-completed' });
    } finally {
      await fs.remove(downloadPath);
    }
  }

  async initialize() {
    try {
      if (!MODELS_LIST.includes(this.libraryModelName)) {
        throw new Error(`지원하지 않는 Whisper 모델입니다: ${this.modelName}. 사용 가능한 모델: ${[...MODELS_LIST, 'large-v3'].join(', ')}`);
      }
      await this.prepareModel();

      // 필요한 디렉터리 생성
      await fs.ensureDir(this.assetsDir);
      await fs.ensureDir(this.outputDir);

      this.onProgress({
        type: 'initialized',
        modelName: this.libraryModelName === 'large' ? 'large-v3' : this.modelName,
        assetsDir: this.assetsDir,
        outputDir: this.outputDir,
      });
    } catch (error) {
      this.onProgress({ type: 'initialization-failed', error: error.message });
      throw error;
    }
  }

  async getInputFiles(inputPath) {
    if (inputPath.length === 0) {
      throw new Error('--input에 파일 또는 폴더 경로를 지정해 주세요.');
    }
    const resolvedPath = path.resolve(inputPath);
    const inputInfo = await fs.stat(resolvedPath);
    if (inputInfo.isFile()) {
      if (!SUPPORTED_EXTENSIONS.includes(path.extname(resolvedPath).toLowerCase())) {
        throw new Error(`지원하지 않는 입력 파일 형식입니다: ${resolvedPath}. 지원 형식: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      }
      return [resolvedPath];
    }
    if (!inputInfo.isDirectory()) {
      throw new Error(`입력 경로는 파일 또는 폴더여야 합니다: ${resolvedPath}`);
    }
    const files = await this.getAudioFiles(resolvedPath);
    return files.map((file) => path.join(resolvedPath, file));
  }

  async getAudioFiles(directory = this.assetsDir) {
    try {
      const files = await fs.readdir(directory, { withFileTypes: true });
      const audioFiles = files.filter((file) => {
        const ext = path.extname(file.name).toLowerCase();
        return (file.isFile() || file.isSymbolicLink()) && SUPPORTED_EXTENSIONS.includes(ext);
      }).map((file) => file.name);

      if (audioFiles.length === 0) {
        this.onProgress({ type: 'inputs-empty', directory, extensions: SUPPORTED_EXTENSIONS });
        return [];
      }

      return audioFiles;
    } catch (error) {
      this.onProgress({ type: 'input-list-failed', error: error.message });
      throw error;
    }
  }

  async convertToText(audioFile) {
    let temporaryDir;
    let pendingOutputPath;
    try {
      const audioPath = path.resolve(this.assetsDir, audioFile);
      const fileName = path.parse(audioFile).name;
      const outputPath = path.join(this.outputDir, `${fileName}.txt`);

      this.onProgress({ type: 'file-started', inputFile: audioFile });

      // 라이브러리가 WAV를 덮어쓰거나 삭제해도 원본에는 영향을 주지 않습니다.
      temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stt-'));
      const temporaryAudioPath = path.join(temporaryDir, `source${path.extname(audioFile).toLowerCase()}`);
      await fs.copy(audioPath, temporaryAudioPath);

      const originalCwd = process.cwd();
      try {
        await nodewhisper(temporaryAudioPath, {
          modelName: this.libraryModelName,
          // large-v3는 위에서 검증했으므로 라이브러리의 large 다운로드를 건너뜁니다.
          autoDownloadModelName: this.libraryModelName === 'large' ? undefined : this.libraryModelName,
          removeWavFileAfterTranscription: true, // 임시 사본의 WAV만 삭제합니다.
          withCuda: false, // CUDA를 끕니다. Apple Silicon의 Metal 사용과는 별개입니다.
          whisperOptions: {
            outputInText: true, // 텍스트 출력 활성화
            outputInJson: false,
            outputInSrt: false,
            outputInVtt: false,
            outputInCsv: false,
            outputInLrc: false,
            outputInWords: false,
            translateToEnglish: false,
            wordTimestamps: false,
            // 이 라이브러리는 true를 별도 입력 파일로 전달하므로 옵션을 끕니다.
            splitOnWord: false,
          },
        });
      } finally {
        // 연결 라이브러리가 변경한 작업 폴더를 성공·실패 모두에서 복구합니다.
        process.chdir(originalCwd);
      }

      const expectedTxtFile = path.join(temporaryDir, 'source.wav.txt');
      if (!await fs.pathExists(expectedTxtFile)) {
        throw new Error('음성 인식이 텍스트 파일을 생성하지 못했습니다.');
      }
      const transcription = await fs.readFile(expectedTxtFile, 'utf8');
      if (transcription.trim().length === 0) {
        throw new Error('생성된 텍스트 파일이 비어 있습니다.');
      }

      // 새 결과를 모두 저장한 뒤 교체하므로 저장 실패 시 기존 결과를 보존합니다.
      pendingOutputPath = path.join(this.outputDir, `.stt-${randomUUID()}.tmp`);
      await fs.outputFile(pendingOutputPath, transcription, { flag: 'wx' });
      await fs.rename(pendingOutputPath, outputPath);

      this.onProgress({ type: 'file-completed', inputFile: audioFile, outputPath });
      return { success: true, inputFile: audioFile, outputFile: `${fileName}.txt` };
    } catch (error) {
      this.onProgress({ type: 'file-failed', inputFile: audioFile, error: error.message });
      return { success: false, inputFile: audioFile, error: error.message };
    } finally {
      try {
        await Promise.all([temporaryDir, pendingOutputPath].filter(Boolean).map((temporaryPath) => fs.remove(temporaryPath)));
      } catch (error) {
        this.onProgress({ type: 'cleanup-failed', inputFile: audioFile, error: error.message });
      }
    }
  }

  async processAllFiles(inputFiles) {
    const audioFiles = inputFiles ?? await this.getAudioFiles();

    if (audioFiles.length === 0) {
      return [];
    }

    this.onProgress({ type: 'batch-started', count: audioFiles.length });

    const outputCounts = audioFiles.reduce((counts, audioFile) => {
      const outputFile = `${path.parse(audioFile).name}.txt`.normalize('NFC').toLowerCase();
      return { ...counts, [outputFile]: (counts[outputFile] || 0) + 1 };
    }, {});

    // 라이브러리가 전역 작업 폴더를 바꾸므로 입력을 순서대로 처리합니다.
    const results = await audioFiles.reduce(async (pendingResults, audioFile) => {
      const previousResults = await pendingResults;
      const outputFile = `${path.parse(audioFile).name}.txt`;
      if (outputCounts[outputFile.normalize('NFC').toLowerCase()] > 1) {
        return [...previousResults, {
          success: false,
          inputFile: audioFile,
          error: `출력 파일 이름이 겹칩니다: ${outputFile}. 입력 파일의 이름을 서로 다르게 지정해 주세요.`,
        }];
      }
      const result = await this.convertToText(audioFile);
      return [...previousResults, result];
    }, Promise.resolve([]));

    return results;
  }
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 공개 진입점에 전사 변환기를 한 번 등록합니다.
module.exports = { SpeechToTextConverter };
