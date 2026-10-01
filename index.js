const fs = require('fs-extra');
const path = require('path');
const { createHash } = require('node:crypto');
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
      await fs.ensureDir(ASSETS_DIR);
      await fs.ensureDir(OUTPUT_DIR);

      console.log('🎤 음성-텍스트 변환 프로그램이 시작되었습니다.');
      console.log(`🧠 Whisper 모델: ${this.libraryModelName === 'large' ? 'large-v3' : this.modelName}`);
      console.log(`📁 음성 파일 디렉터리: ${ASSETS_DIR}`);
      console.log(`📄 출력 디렉터리: ${OUTPUT_DIR}`);
    } catch (error) {
      console.error('❌ 초기화 중 오류가 발생했습니다:', error.message);
      throw error;
    }
  }

  async getAudioFiles() {
    try {
      const files = await fs.readdir(ASSETS_DIR);
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
      return [];
    }
  }

  async convertToText(audioFile) {
    try {
      const audioPath = path.resolve(ASSETS_DIR, audioFile);
      const fileName = path.parse(audioFile).name;
      const outputPath = path.join(OUTPUT_DIR, `${fileName}.txt`);

      console.log(`🔄 변환 중: ${audioFile}`);

      // 텍스트 파일이 생성될 경로 미리 계산
      const expectedTxtFile = path.join(OUTPUT_DIR, `${fileName}.wav.txt`);

      // nodejs-whisper를 사용하여 음성을 텍스트로 변환
      await nodewhisper(audioPath, {
        modelName: this.libraryModelName,
        // large-v3는 위에서 검증했으므로 라이브러리의 large 다운로드를 건너뜁니다.
        autoDownloadModelName: this.libraryModelName === 'large' ? undefined : this.libraryModelName,
        removeWavFileAfterTranscription: true, // 변환 후 wav 파일 삭제 (설정 유지)
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

      // 잠시 대기 후 텍스트 파일 확인 (파일 시스템 동기화 대기)
      await new Promise((resolve) => setTimeout(resolve, 1000));

      console.log(`✅ 변환 완료: ${audioFile} -> ${fileName}.txt`);
      return { success: true, inputFile: audioFile, outputFile: `${fileName}.txt` };
    } catch (error) {
      console.error(`❌ ${audioFile} 변환 중 오류:`, error.message);
      return { success: false, inputFile: audioFile, error: error.message };
    }
  }

  async processAllFiles() {
    const audioFiles = await this.getAudioFiles();

    if (audioFiles.length === 0) {
      return;
    }

    console.log(`\n📋 총 ${audioFiles.length}개의 음성 파일을 발견했습니다.`);

    const results = [];

    for (const audioFile of audioFiles) {
      const result = await this.convertToText(audioFile);
      results.push(result);
    }

    // 결과 요약
    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    console.log('\n📊 변환 결과:');
    console.log(`✅ 성공: ${successful.length}개`);
    if (failed.length > 0) {
      console.log(`❌ 실패: ${failed.length}개`);
      failed.forEach((f) => {
        console.log(`   - ${f.inputFile}: ${f.error}`);
      });
    }

    if (successful.length > 0) {
      console.log('\n📄 생성된 텍스트 파일:');
      successful.forEach((s) => {
        console.log(`   - ${s.outputFile}`);
      });
    }
  }
}

// 메인 실행 함수
async function main() {
  try {
    const converter = new SpeechToTextConverter();
    await converter.initialize();
    await converter.processAllFiles();

    console.log('\n🎉 모든 작업이 완료되었습니다!');
  } catch (error) {
    console.error('❌ 프로그램 실행 중 오류가 발생했습니다:', error.message);
    process.exit(1);
  }
}

// 스크립트가 직접 실행될 때만 main 함수 실행
if (require.main === module) {
  main();
}

module.exports = { SpeechToTextConverter };
