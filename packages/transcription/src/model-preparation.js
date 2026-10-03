const fs = require('fs-extra');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { MODEL_OBJECT, WHISPER_CPP_MAIN_PATH, WHISPER_CPP_PATH } = require('nodejs-whisper/dist/constants');

const { createExecutionError } = require('./errors');

function downloadModel(modelName, modelsDirectory) {
  const windows = process.platform === 'win32';
  const command = windows ? 'cmd.exe' : 'sh';
  const argumentsList = windows
    ? ['/d', '/c', 'download-ggml-model.cmd', modelName]
    : [path.join(modelsDirectory, 'download-ggml-model.sh'), modelName, modelsDirectory];
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { cwd: modelsDirectory, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0 && !signal) {
        resolve();
      } else {
        reject(createExecutionError('STT_MODEL_PREPARATION_FAILED', `모델 다운로드가 완료되지 않았습니다: ${modelName}`, { exitCode: code, signal }));
      }
    });
  });
}

async function verifyEngine() {
  const enginePath = path.resolve(WHISPER_CPP_PATH, WHISPER_CPP_MAIN_PATH);
  try {
    await fs.access(enginePath, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
  } catch (cause) {
    throw createExecutionError('STT_ENGINE_UNAVAILABLE', `Whisper 실행 파일을 사용할 수 없습니다. 설치 문서에 따라 엔진을 빌드해 주세요: ${enginePath}`, { cause, enginePath });
  }
}

async function prepareExecutionModel({ modelName, inputCount }) {
  const libraryModelName = modelName === 'large-v3' ? 'large' : modelName;
  const modelsDirectory = path.join(WHISPER_CPP_PATH, 'models');
  const modelPath = path.join(modelsDirectory, MODEL_OBJECT[libraryModelName]);
  const modelExists = await fs.pathExists(modelPath);
  if (inputCount === 0) {
    return modelExists;
  }

  // 전사 중 라이브러리가 공용 엔진을 자동 빌드하지 않도록 먼저 확인합니다.
  await verifyEngine();
  if (!modelExists) {
    await downloadModel(libraryModelName, modelsDirectory);
  }
  const modelInfo = await fs.stat(modelPath);
  if (!modelInfo.isFile() || modelInfo.size === 0) {
    throw createExecutionError('STT_MODEL_PREPARATION_FAILED', `모델 파일이 비어 있거나 일반 파일이 아닙니다: ${modelPath}`, { modelPath });
  }
  return true;
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 모델 준비 함수를 한 번 등록합니다.
module.exports = { prepareExecutionModel };
