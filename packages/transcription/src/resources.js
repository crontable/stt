const fs = require('fs-extra');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { MODEL_OBJECT, WHISPER_CPP_PATH } = require('nodejs-whisper/dist/constants');

const { createExecutionError } = require('./errors');

async function acquireLock(lockPath, { jobId, resourceKind, resource }) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
    await fs.writeFile(handle, JSON.stringify({ jobId, pid: process.pid, resourceKind, resource }));
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw createExecutionError('STT_RESOURCE_BUSY', `다른 전사 작업이 같은 자원을 사용하고 있습니다: ${resource}`, { resourceKind, resource });
    }
    if (handle !== undefined) {
      await fs.remove(lockPath);
    }
    throw error;
  } finally {
    if (handle !== undefined) {
      await fs.close(handle);
    }
  }

  return async () => {
    try {
      const owner = await fs.readJson(lockPath);
      if (owner.jobId === jobId) {
        await fs.remove(lockPath);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  };
}

function outputKeys(inputFiles) {
  const keys = inputFiles.map((inputFile) => `${path.parse(inputFile).name}.txt`.normalize('NFC').toLowerCase());
  const counts = keys.reduce((previous, key) => ({ ...previous, [key]: (previous[key] || 0) + 1 }), {});
  // 같은 배치 안의 중복 이름은 기존 변환기가 실패 결과로 반환합니다.
  return keys.filter((key) => counts[key] === 1);
}

async function reserveOutputs(outputDir, inputFiles, jobId) {
  await fs.ensureDir(outputDir);
  const realOutputDir = await fs.realpath(outputDir);
  const lockDirectory = path.join(realOutputDir, '.stt-locks');
  await fs.ensureDir(lockDirectory);
  let releases = [];
  try {
    await outputKeys(inputFiles).reduce(async (previous, key) => {
      await previous;
      const hash = createHash('sha256').update(key).digest('hex');
      const release = await acquireLock(path.join(lockDirectory, `${hash}.lock`), {
        jobId,
        resourceKind: 'output',
        resource: path.join(realOutputDir, key),
      });
      releases = [...releases, release];
    }, Promise.resolve());
  } catch (error) {
    await Promise.all(releases.map((release) => release()));
    throw error;
  }
  return { realOutputDir, releases };
}

async function reserveModel(modelName, jobId) {
  const libraryModelName = modelName === 'large-v3' ? 'large' : modelName;
  const modelFile = MODEL_OBJECT[libraryModelName];
  if (typeof modelFile !== 'string') {
    return undefined;
  }
  const modelPath = path.join(WHISPER_CPP_PATH, 'models', modelFile);
  const release = await acquireLock(`${modelPath}.stt-lock`, { jobId, resourceKind: 'model', resource: modelPath });
  try {
    const modelExisted = await fs.pathExists(modelPath);
    return { modelPath, modelExisted, usesAtomicDownload: libraryModelName === 'large', release };
  } catch (error) {
    await release();
    throw error;
  }
}

async function removeOwnedFiles({ temporaryRoot, realOutputDir, model, modelReady, childPid, jobId }) {
  const outputEntries = await fs.readdir(realOutputDir);
  const pendingFiles = outputEntries
    .filter((entry) => entry.startsWith(`.stt-${jobId}-`) && entry.endsWith('.tmp'))
    .map((entry) => path.join(realOutputDir, entry));
  const modelFiles = model ? [
    childPid ? `${model.modelPath}.${childPid}.download` : undefined,
    !model.usesAtomicDownload && !model.modelExisted && !modelReady ? model.modelPath : undefined,
  ].filter(Boolean) : [];
  await Promise.all([temporaryRoot, ...pendingFiles, ...modelFiles].filter(Boolean).map((entry) => fs.remove(entry)));
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 작업 자원 관리 함수를 한 번 등록합니다.
module.exports = { reserveOutputs, reserveModel, removeOwnedFiles };
