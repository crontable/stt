const { SpeechToTextConverter } = require('@stt/transcription');
const path = require('node:path');
const { parseArgs } = require('node:util');

const repositoryRoot = path.resolve(__dirname, '../../..');

const progressHandlers = {
  'model-download-started': () => console.log('📥 정식 large-v3 모델을 다운로드합니다. 파일 크기는 약 3.1GB입니다.'),
  'model-download-completed': () => console.log('✅ large-v3 모델 다운로드와 파일 검증을 완료했습니다.'),
  initialized: ({ modelName, assetsDir, outputDir }) => {
    console.log('🎤 음성-텍스트 변환 프로그램이 시작되었습니다.');
    console.log(`🧠 Whisper 모델: ${modelName}`);
    console.log(`📁 음성 파일 디렉터리: ${assetsDir}`);
    console.log(`📄 출력 디렉터리: ${outputDir}`);
  },
  'initialization-failed': ({ error }) => console.error('❌ 초기화 중 오류가 발생했습니다:', error),
  'inputs-empty': ({ directory, extensions }) => {
    console.log(`⚠️  ${directory} 디렉터리에 음성 파일이 없습니다.`);
    console.log(`지원되는 파일 형식: ${extensions.join(', ')}`);
  },
  'input-list-failed': ({ error }) => console.error('❌ 파일 목록을 가져오는 중 오류가 발생했습니다:', error),
  'file-started': ({ inputFile }) => console.log(`🔄 변환 중: ${inputFile}`),
  'file-completed': ({ inputFile, outputPath }) => console.log(`✅ 변환 완료: ${inputFile} -> ${outputPath}`),
  'file-failed': ({ inputFile, error }) => console.error(`❌ ${inputFile} 변환 중 오류:`, error),
  'cleanup-failed': ({ inputFile, error }) => console.error(`❌ ${inputFile}의 임시 파일을 정리하지 못했습니다:`, error),
  'batch-started': ({ count }) => console.log(`\n📋 총 ${count}개의 음성 파일을 발견했습니다.`),
};

function printProgress(event) {
  progressHandlers[event.type]?.(event);
}

function printSummary(results, outputDir) {
  const successful = results.filter((result) => result.success);
  const failed = results.filter((result) => !result.success);

  console.log('\n📊 변환 결과');
  console.log(`✅ 성공: ${successful.length}개`);
  if (failed.length > 0) {
    console.log(`❌ 실패: ${failed.length}개`);
    console.log(failed.map((result) => `   - ${result.inputFile}: ${result.error}`).join('\n'));
  }
  if (successful.length > 0) {
    console.log('\n📄 생성된 텍스트 파일');
    console.log(successful.map((result) => `   - ${path.join(outputDir, result.outputFile)}`).join('\n'));
  }
  return failed.length;
}

async function main() {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        input: { type: 'string', short: 'i' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      console.log([
        '사용법: pnpm start [--input <파일 또는 폴더 경로>]',
        '  --input, -i  지정한 파일 또는 폴더의 지원 파일을 전사합니다.',
        '  --help, -h   사용법을 표시합니다.',
        '도움말 실행: pnpm exec node apps/cli/src/index.js --help',
        '옵션을 생략하면 저장소 루트 assets/의 지원 파일을 처리합니다.',
        '상대 경로는 실행한 작업 폴더를 기준으로 해석하고 결과는 저장소 루트 output/에 저장합니다.',
      ].join('\n'));
      return;
    }
    const converter = new SpeechToTextConverter({
      assetsDir: path.join(repositoryRoot, 'assets'),
      outputDir: path.join(repositoryRoot, 'output'),
      modelName: process.env.WHISPER_MODEL || 'large-v3',
      onProgress: printProgress,
    });
    const inputFiles = values.input === undefined ? undefined : await converter.getInputFiles(values.input);
    await converter.initialize();
    const results = await converter.processAllFiles(inputFiles);
    if (results.length === 0) {
      return;
    }
    const failedCount = printSummary(results, converter.outputDir);
    if (failedCount > 0) {
      // eslint-disable-next-line no-restricted-syntax -- Node의 종료 상태를 기록하고 진행 중인 출력과 정리를 마친 뒤 종료합니다.
      process.exitCode = 1;
      console.error(`\n❌ ${failedCount}개 파일의 변환에 실패했습니다. 오류를 확인해 주세요.`);
      return;
    }
    console.log('\n🎉 모든 파일의 변환이 완료되었습니다!');
  } catch (error) {
    console.error('❌ 프로그램 실행 중 오류가 발생했습니다:', error.message);
    // eslint-disable-next-line no-restricted-syntax -- 초기화 실패도 Node의 종료 상태로 전달하고 진행 중인 출력과 정리를 마칩니다.
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}
