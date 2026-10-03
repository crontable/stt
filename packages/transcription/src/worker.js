const { SpeechToTextConverter } = require('./converter');
const { prepareExecutionModel } = require('./model-preparation');

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    process.send(message, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function acknowledgeModelReady() {
  const acknowledged = new Promise((resolve, reject) => {
    process.once('message', (message) => {
      if (message.type === 'model-ready-ack') {
        resolve();
      } else {
        reject(new Error('모델 준비 완료 확인 메시지가 올바르지 않습니다.'));
      }
    });
  });
  await sendMessage({ type: 'model-ready' });
  await acknowledged;
}

async function executeJob({ jobId, assetsDir, outputDir, modelName, inputFiles, inputDirectory }) {
  const onProgress = (event) => process.send({ type: 'progress', event });
  const converter = new SpeechToTextConverter({ assetsDir, outputDir, modelName, onProgress, jobId });
  await converter.initialize();
  const modelReady = await prepareExecutionModel({ modelName, inputCount: inputFiles.length });
  Object.assign(converter, { modelPrepared: modelReady });
  if (modelReady) {
    await acknowledgeModelReady();
  }
  if (inputFiles.length === 0) {
    // 목록을 부모에서 확보했으므로 빈 입력 안내만 기존 변환기를 통해 전달합니다.
    await converter.getAudioFiles(inputDirectory);
  }
  return converter.processAllFiles(inputFiles);
}

async function main(message) {
  let exitCode = 0;
  try {
    const results = await executeJob(message);
    await sendMessage({ type: 'result', results });
  } catch (error) {
    await sendMessage({ type: 'error', error: { message: error.message, code: error.code } });
    exitCode = 1;
  }
  if (process.platform === 'win32') {
    // taskkill이 작업 PID로 자손을 찾을 수 있도록 부모의 종료 처리까지 살아 있습니다.
    process.on('message', () => {});
    await sendMessage({ type: 'ready-to-exit', exitCode });
    return;
  }
  // eslint-disable-next-line no-restricted-syntax -- 결과를 부모에 전달한 뒤 자식의 종료 상태로도 성공·실패를 기록합니다.
  process.exitCode = exitCode;
  process.disconnect();
}

process.once('message', main);
