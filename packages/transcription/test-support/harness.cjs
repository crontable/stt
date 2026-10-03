const fs = require('fs-extra');
const path = require('node:path');

const { runTranscription } = require('../src');

const request = JSON.parse(process.argv[2]);
const directory = process.env.STT_FIXTURE_DIRECTORY;
const recordingNames = {
  engine: 'engine-recording.json',
  leaf: 'leaf-recording.json',
  shell: 'shell-recording.json',
};
const options = {
  assetsDir: path.join(directory, 'assets'),
  outputDir: path.join(directory, 'output'),
  modelName: request.modelName || 'base',
  ...request.options,
};
const previousDirectory = process.cwd();
const previousEnvironment = { ...process.env };

function pause(duration = 25) {
  return new Promise((resolve) => { setTimeout(resolve, duration); });
}

async function waitForFile(target, remaining = 120) {
  if (await fs.pathExists(target)) {
    return fs.readJson(target);
  }
  if (remaining === 0) {
    throw new Error(`검사 파일을 기다리는 시간이 지났습니다: ${target}`);
  }
  await pause();
  return waitForFile(target, remaining - 1);
}

function describeError(error) {
  return {
    message: error.message,
    code: error.code,
    resourceKind: error.resourceKind,
    resource: error.resource,
    cause: error.cause ? { message: error.cause.message, code: error.cause.code } : undefined,
    pid: error.pid,
  };
}

async function settled(pending) {
  try {
    return { status: 'fulfilled', results: await pending };
  } catch (error) {
    return { status: 'rejected', error: describeError(error) };
  }
}

async function single() {
  let events = [];
  let logs = [];
  const outcome = await settled(runTranscription({
    ...options,
    onProgress: (event) => { events = [...events, event]; },
    onLog: (event) => { logs = [...logs, event]; },
  }));
  return { ...outcome, events, logs };
}

async function cancel() {
  const controller = new AbortController();
  const completion = settled(runTranscription({ ...options, signal: controller.signal }));
  const record = await waitForFile(path.join(directory, recordingNames.engine));
  const leaf = await waitForFile(path.join(directory, recordingNames.leaf));
  const shell = await waitForFile(path.join(directory, recordingNames.shell));
  controller.abort();
  return { ...await completion, record, leaf, shell };
}

async function downloadCancel() {
  const controller = new AbortController();
  let downloads = [];
  const completion = settled(runTranscription({
    ...options,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.type === 'model-download-started') {
        setTimeout(async () => {
          downloads = (await fs.readdir(path.join(directory, 'engine', 'models'))).filter((name) => name.endsWith('.download'));
          controller.abort();
        }, 250);
      }
    },
  }));
  return { ...await completion, downloads };
}

async function parallel() {
  const controller = new AbortController();
  const completion = settled(runTranscription({ ...options, signal: controller.signal }));
  const record = await waitForFile(path.join(directory, recordingNames.engine));
  const leaf = await waitForFile(path.join(directory, recordingNames.leaf));
  const second = await settled(runTranscription({ ...options, ...request.secondOptions }));
  controller.abort();
  return { first: await completion, second, record, leaf };
}

async function modelConflict() {
  const controller = new AbortController();
  let accepted;
  const started = new Promise((resolve) => { accepted = resolve; });
  const completion = settled(runTranscription({
    ...options,
    signal: controller.signal,
    onProgress: (event) => {
      if (event.type === 'model-download-started') {
        accepted();
      }
    },
  }));
  await started;
  const second = await settled(runTranscription({ ...options, ...request.secondOptions }));
  controller.abort();
  return { first: await completion, second };
}

async function waiting() {
  const completion = settled(runTranscription(options));
  const record = await waitForFile(path.join(directory, recordingNames.engine));
  const leaf = await waitForFile(path.join(directory, recordingNames.leaf));
  const shell = await waitForFile(path.join(directory, recordingNames.shell));
  process.send({ type: 'ready', record, leaf, shell });
  return completion;
}

async function callbackFailure() {
  const failLater = async () => {
    await pause();
    throw new Error('비동기 전사 알림 처리 실패');
  };
  return settled(runTranscription({
    ...options,
    onProgress: async (event) => {
      const shouldFail = [
        request.channel === 'progress' && event.type === 'file-started',
        request.channel === 'input-list' && event.type === 'input-list-failed',
      ].some(Boolean);
      if (shouldFail) {
        await failLater();
      }
    },
    onLog: async (event) => {
      if (request.channel === 'log' && event.stream === 'stdout') {
        await failLater();
      }
    },
  }));
}

async function main() {
  const actions = {
    single,
    cancel,
    'download-cancel': downloadCancel,
    parallel,
    'model-conflict': modelConflict,
    waiting,
    'callback-failure': callbackFailure,
  };
  const result = await actions[request.action || 'single']();
  process.stdout.write(`${JSON.stringify({
    ...result,
    cwdPreserved: process.cwd() === previousDirectory,
    environmentPreserved: JSON.stringify(process.env) === JSON.stringify(previousEnvironment),
  })}\n`);
}

main();
