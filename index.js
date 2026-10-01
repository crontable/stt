const fs = require('fs-extra');
const path = require('path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
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

// 디렉터리 설정
const ASSETS_DIR = './assets';
const OUTPUT_DIR = './output';

// 지원하는 오디오 파일 확장자
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.avi', '.mov'];

class SpeechToTextConverter {
  constructor() {
    this.modelName = process.env.WHISPER_MODEL || 'large-v3';
    this.libraryModelName = this.modelName === 'large-v3' ? 'large' : this.modelName;
    this.assetsDir = path.resolve(ASSETS_DIR);
    this.outputDir = path.resolve(OUTPUT_DIR);
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

    console.log('📥 정식 large-v3 모델을 다운로드합니다. 파일 크기는 약 3.1GB입니다.');
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
      console.log('✅ large-v3 모델 다운로드와 파일 검증을 완료했습니다.');
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

      console.log('🎤 음성-텍스트 변환 프로그램이 시작되었습니다.');
      console.log(`🧠 Whisper 모델: ${this.libraryModelName === 'large' ? 'large-v3' : this.modelName}`);
      console.log(`📁 음성 파일 디렉터리: ${this.assetsDir}`);
      console.log(`📄 출력 디렉터리: ${this.outputDir}`);
    } catch (error) {
      console.error('❌ 초기화 중 오류가 발생했습니다:', error.message);
      throw error;
    }
  }

  async getAudioFiles() {
    try {
      const files = await fs.readdir(this.assetsDir);
      const audioFiles = files.filter((file) => {
        const ext = path.extname(file).toLowerCase();
        return SUPPORTED_EXTENSIONS.includes(ext);
      });

      if (audioFiles.length === 0) {
        console.log('⚠️  assets/ 디렉터리에 음성 파일이 없습니다.');
        console.log(`지원되는 파일 형식: ${SUPPORTED_EXTENSIONS.join(', ')}`);
        return [];
      }

      return audioFiles;
    } catch (error) {
      console.error('❌ 파일 목록을 가져오는 중 오류가 발생했습니다:', error.message);
      throw error;
    }
  }

  async convertToText(audioFile) {
    let temporaryDir;
    let pendingOutputPath;
    try {
      const audioPath = path.join(this.assetsDir, audioFile);
      const fileName = path.parse(audioFile).name;
      const outputPath = path.join(this.outputDir, `${fileName}.txt`);

      console.log(`🔄 변환 중: ${audioFile}`);

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

      console.log(`✅ 변환 완료: ${audioFile} -> ${outputPath}`);
      return { success: true, inputFile: audioFile, outputFile: `${fileName}.txt` };
    } catch (error) {
      console.error(`❌ ${audioFile} 변환 중 오류:`, error.message);
      return { success: false, inputFile: audioFile, error: error.message };
    } finally {
      try {
        await Promise.all([temporaryDir, pendingOutputPath].filter(Boolean).map((temporaryPath) => fs.remove(temporaryPath)));
      } catch (error) {
        console.error(`❌ ${audioFile}의 임시 파일을 정리하지 못했습니다:`, error.message);
      }
    }
  }

  async processAllFiles() {
    const audioFiles = await this.getAudioFiles();

    if (audioFiles.length === 0) {
      return [];
    }

    console.log(`\n📋 총 ${audioFiles.length}개의 음성 파일을 발견했습니다.`);

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

    // 결과 요약
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    console.log('\n📊 변환 결과');
    console.log(`✅ 성공: ${successful.length}개`);
    if (failed.length > 0) {
      console.log(`❌ 실패: ${failed.length}개`);
      console.log(failed.map((f) => `   - ${f.inputFile}: ${f.error}`).join('\n'));
    }

    if (successful.length > 0) {
      console.log('\n📄 생성된 텍스트 파일');
      console.log(successful.map((s) => `   - ${path.join(this.outputDir, s.outputFile)}`).join('\n'));
    }
    return results;
  }
}

// 메인 실행 함수
async function main() {
  try {
    const converter = new SpeechToTextConverter();
    await converter.initialize();
    const results = await converter.processAllFiles();
    const failedCount = results.filter((result) => !result.success).length;
    if (failedCount > 0) {
      process.exitCode = 1;
      console.error(`\n❌ ${failedCount}개 파일의 변환에 실패했습니다. 오류를 확인해 주세요.`);
      return;
    }
    if (results.length > 0) {
      console.log('\n🎉 모든 파일의 변환이 완료되었습니다!');
    }
  } catch (error) {
    console.error('❌ 프로그램 실행 중 오류가 발생했습니다:', error.message);
    process.exitCode = 1;
  }
}

// 스크립트가 직접 실행될 때만 main 함수 실행
if (require.main === module) {
  main();
}

module.exports = { SpeechToTextConverter };
