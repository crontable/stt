const SIGNALS = ['SIGINT', 'SIGTERM'];

let activeJobs = [];
let installedHandlers = [];
let shuttingDown = false;

function removeInstalledHandlers() {
  installedHandlers.map(({ signal, handler }) => process.removeListener(signal, handler));
  installedHandlers = [];
}

async function handleDefaultSignal(signal) {
  const ownHandler = installedHandlers.find((entry) => entry.signal === signal)?.handler;
  const applicationHandlers = process.listeners(signal).filter((handler) => handler !== ownHandler);
  if (shuttingDown || applicationHandlers.length > 0) {
    return;
  }
  shuttingDown = true;
  const jobs = activeJobs;
  jobs.map(({ controller }) => controller.abort());
  await Promise.all(jobs.map(({ completion }) => completion));
  removeInstalledHandlers();
  process.kill(process.pid, signal);
}

function installDefaultHandlers() {
  SIGNALS.map((signal) => {
    if (process.listenerCount(signal) === 0) {
      const handler = () => handleDefaultSignal(signal);
      process.on(signal, handler);
      installedHandlers = [...installedHandlers, { signal, handler }];
    }
    return signal;
  });
}

function registerJob(signal) {
  const controller = new AbortController();
  const relayAbort = () => controller.abort();
  signal?.addEventListener('abort', relayAbort, { once: true });
  if (signal?.aborted || shuttingDown) {
    controller.abort();
  }
  let complete;
  const completion = new Promise((resolve) => { complete = resolve; });
  const job = { controller, completion };
  activeJobs = [...activeJobs, job];
  installDefaultHandlers();
  return {
    signal: controller.signal,
    finish() {
      activeJobs = activeJobs.filter((entry) => entry !== job);
      signal?.removeEventListener('abort', relayAbort);
      complete();
      if (activeJobs.length === 0) {
        removeInstalledHandlers();
      }
    },
  };
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 호출한 프로세스의 기본 종료 정리를 한 번 등록합니다.
module.exports = { registerJob };
