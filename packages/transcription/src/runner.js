const fs = require('fs-extra');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const { SpeechToTextConverter } = require('./converter');
const { createAbortError, createExecutionError } = require('./errors');
const { registerJob } = require('./parent-lifecycle');
const { terminateProcessTree, terminateProcessTreeOnExit } = require('./process-tree');
const { reserveOutputs, reserveModel, removeOwnedFiles } = require('./resources');

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

async function invokeUserCallback(callback, value) {
  try {
    await callback(value);
  } catch (cause) {
    throw createExecutionError('STT_CALLBACK_FAILED', `전사 진행 알림을 처리하지 못했습니다: ${cause.message}`, { cause });
  }
}

function startChild(temporaryRoot) {
  return fork(path.join(__dirname, 'worker.js'), [], {
    cwd: temporaryRoot,
    detached: process.platform !== 'win32',
    execArgv: [],
    env: { ...process.env, TMPDIR: temporaryRoot, TEMP: temporaryRoot, TMP: temporaryRoot },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

function completedResults({ outcome, results, failure, expectedExitCode }) {
  if (failure) {
    throw failure;
  }
  const code = process.platform === 'win32' ? expectedExitCode : outcome.code;
  const interrupted = process.platform !== 'win32' && Boolean(outcome.exitSignal);
  const incomplete = [code !== 0, interrupted, results === undefined].some(Boolean);
  if (incomplete) {
    throw createExecutionError('STT_WORKER_EXIT', '전사 작업이 정상적으로 완료되지 않았습니다.', { exitCode: outcome.code, exitSignal: outcome.exitSignal });
  }
  return results;
}

async function monitorChild({ child, message, onProgress, onLog, onModelReady, signal }) {
  let results;
  let failure;
  let cleanupFailure;
  let expectedExitCode;
  let messageQueue = Promise.resolve();
  let termination;
  const stopTree = async () => {
    try {
      await terminateProcessTree(child.pid);
    } catch (error) {
      cleanupFailure = createExecutionError('STT_PROCESS_CLEANUP_FAILED', '전사 작업의 하위 프로세스 종료를 확인하지 못했습니다.', { cause: error, pid: child.pid });
    }
  };
  const requestStop = () => {
    termination = termination || stopTree();
    return termination;
  };
  const recordFailure = (error) => {
    failure = failure || error;
    requestStop();
  };
  const invokeCallback = async (callback, value) => {
    try {
      await invokeUserCallback(callback, value);
    } catch (error) {
      recordFailure(error);
    }
  };
  const handlers = {
    progress: ({ event }) => invokeCallback(onProgress, event),
    log: ({ event }) => invokeCallback(onLog, event),
    'model-ready': async () => {
      await onModelReady();
      child.send({ type: 'model-ready-ack' }, (error) => {
        if (error) {
          recordFailure(error);
        }
      });
    },
    'ready-to-exit': (payload) => {
      expectedExitCode = payload.exitCode;
      requestStop();
    },
    result: (payload) => {
      if (!Array.isArray(payload.results)) {
        throw createExecutionError('STT_WORKER_PROTOCOL_ERROR', '전사 작업이 올바른 결과 목록을 반환하지 않았습니다.');
      }
      results = payload.results;
    },
    error: (payload) => {
      failure = failure || createExecutionError(payload.error.code || 'STT_WORKER_FAILED', payload.error.message);
    },
  };
  const receiveMessage = async (previous, payload) => {
    await previous;
    try {
      await handlers[payload.type]?.(payload);
    } catch (error) {
      recordFailure(error);
    }
  };
  const onMessage = (payload) => { messageQueue = receiveMessage(messageQueue, payload); };
  const onAbort = () => recordFailure(createAbortError());
  const onParentExit = () => terminateProcessTreeOnExit(child.pid);
  const closePromise = new Promise((resolve) => { child.once('close', resolve); });
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, exitSignal) => resolve({ code, exitSignal }));
    child.once('error', (error) => {
      recordFailure(error);
      resolve({ code: undefined, exitSignal: undefined });
    });
  });

  child.on('message', onMessage);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text) => onMessage({ type: 'log', event: { stream: 'stdout', text } }));
  child.stderr.on('data', (text) => onMessage({ type: 'log', event: { stream: 'stderr', text } }));
  process.once('exit', onParentExit);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    throwIfAborted(signal);
    child.send(message, (error) => {
      if (error) {
        recordFailure(error);
      }
    });
    const outcome = await exitPromise;
    // exit 뒤에 자손이 파이프를 붙잡아도 먼저 종료하므로 close를 기다리며 멈추지 않습니다.
    await requestStop();
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    await closePromise;
    await messageQueue;
    return completedResults({ outcome, results, failure, expectedExitCode });
  } catch (error) {
    await requestStop();
    if (cleanupFailure) {
      throw cleanupFailure;
    }
    await exitPromise;
    await closePromise;
    await messageQueue;
    throw failure || error;
  } finally {
    process.removeListener('exit', onParentExit);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function resolveInputs({ converter, assetsDir, inputPath }) {
  // 입력 오류는 모델 다운로드나 별도 프로세스 실행에 앞서 확인합니다.
  if (inputPath !== undefined) {
    return converter.getInputFiles(inputPath);
  }
  await fs.ensureDir(assetsDir);
  return converter.getAudioFiles();
}

async function cleanupJob({ preserveResources, outputs, model, ...ownedFiles }) {
  if (preserveResources) {
    return;
  }
  try {
    await removeOwnedFiles({ ...ownedFiles, realOutputDir: outputs.realOutputDir, model });
  } finally {
    await Promise.all([...outputs.releases, model?.release].filter(Boolean).map((release) => release()));
  }
}

async function executeTranscription({ assetsDir, outputDir, modelName = 'large-v3', inputPath, onProgress = () => {}, onLog = () => {}, signal }) {
  throwIfAborted(signal);
  let inputListFailure;
  const converter = new SpeechToTextConverter({
    assetsDir,
    outputDir,
    modelName,
    onProgress: (event) => {
      if (event.type === 'input-list-failed') {
        inputListFailure = event;
      }
    },
  });
  let files;
  try {
    files = await resolveInputs({ converter, assetsDir, inputPath });
  } catch (error) {
    if (inputListFailure) {
      await invokeUserCallback(onProgress, inputListFailure);
    }
    throw error;
  }
  throwIfAborted(signal);
  const jobId = randomUUID();
  const outputs = await reserveOutputs(outputDir, files, jobId);
  let model;
  let temporaryRoot;
  let childPid;
  let modelReady = false;
  let preserveResources = false;
  try {
    model = await reserveModel(modelName, jobId);
    throwIfAborted(signal);
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `stt-job-${jobId}-`));
    throwIfAborted(signal);
    const child = startChild(temporaryRoot);
    childPid = child.pid;
    return await monitorChild({
      child,
      message: { jobId, assetsDir, outputDir, modelName, inputFiles: files, modelExisted: model?.modelExisted, inputDirectory: inputPath === undefined ? assetsDir : path.resolve(inputPath) },
      onProgress,
      onLog,
      signal,
      onModelReady: async () => {
        modelReady = true;
        await model?.release();
      },
    });
  } catch (error) {
    preserveResources = error.code === 'STT_PROCESS_CLEANUP_FAILED';
    throw error;
  } finally {
    await cleanupJob({ preserveResources, outputs, model, temporaryRoot, modelReady, childPid, jobId });
  }
}

async function runTranscription(options = {}) {
  const lifecycle = registerJob(options.signal);
  try {
    return await executeTranscription({ ...options, signal: lifecycle.signal });
  } finally {
    lifecycle.finish();
  }
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 별도 프로세스 전사 함수를 한 번 등록합니다.
module.exports = { runTranscription };
