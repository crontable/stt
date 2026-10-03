import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { createWebError, publicError, validateJobId } from './responses.js';
import { MAX_UPLOAD_BYTES, saveUpload, uploadDetails } from './upload.js';

const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];

function createUploadGate() {
  let settle;
  const promise = new Promise((resolve) => { settle = resolve; });
  return { promise, settle };
}

function findJob(context, id) {
  validateJobId(id);
  const job = context.jobs.get(id);
  if (!job) {
    throw createWebError('STT_JOB_NOT_FOUND', 404);
  }
  return job;
}

function updateRecord(context, id, values) {
  const job = context.jobs.get(id);
  if (!Object.entries(values).some(([key, value]) => job.record[key] !== value)) {
    return job.record;
  }
  const record = { ...job.record, ...values, updatedAt: new Date().toISOString() };
  context.jobs.set(id, { ...job, record });
  return record;
}

function reserveJob(context, details) {
  const admissionFailure = [
    { violated: context.control.get('stopping'), code: 'STT_WEB_SHUTTING_DOWN', status: 503 },
    { violated: Boolean(context.control.get('activeId')), code: 'STT_WEB_BUSY', status: 409 },
  ].find(({ violated }) => violated);
  if (admissionFailure) {
    throw createWebError(admissionFailure.code, admissionFailure.status);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  const uploadDir = path.join(context.options.assetsDir, id);
  const outputDir = path.join(context.options.outputDir, id);
  const record = {
    id,
    name: details.name,
    size: 0,
    model: 'large-v3',
    status: 'accepted',
    stage: 'preparing',
    createdAt: now,
    updatedAt: now,
    statusUrl: `/api/transcriptions/${id}`,
    cancelUrl: `/api/transcriptions/${id}/cancel`,
    resultUrl: null,
    error: null,
    cleanupRequired: false,
  };
  const job = {
    record,
    uploadDir,
    outputDir,
    inputPath: path.join(uploadDir, `input${details.extension}`),
    controller: new AbortController(),
    executionPromise: null,
    uploadGate: createUploadGate(),
    sourceCleanups: new Set(),
  };
  context.control.set('activeId', id);
  context.jobs.set(id, job);
  return job;
}

async function removeJobFiles(job, preserveOutput) {
  await rm(job.uploadDir, { recursive: true, force: true });
  if (!preserveOutput) {
    await rm(job.outputDir, { recursive: true, force: true });
  }
}

function reportFailure(context, id, error) {
  context.options.logger.error('웹 전사 작업에서 오류가 발생했습니다.', { id, error });
}

async function finishJob(context, id, outcome) {
  const job = context.jobs.get(id);
  updateRecord(context, id, { stage: 'cleaning' });
  let failure = outcome.error;
  if (failure?.code !== 'STT_PROCESS_CLEANUP_FAILED') {
    try {
      await removeJobFiles(job, outcome.status === 'succeeded');
      if (!job.sourceCleanups.size) {
        context.control.set('activeId', null);
      }
    } catch (error) {
      failure = createWebError('STT_UPLOAD_CLEANUP_FAILED', 500, error);
      reportFailure(context, id, failure);
    }
  }
  const cleanupRequired = ['STT_PROCESS_CLEANUP_FAILED', 'STT_UPLOAD_CLEANUP_FAILED'].includes(failure?.code);
  return updateRecord(context, id, {
    status: cleanupRequired ? 'failed' : outcome.status,
    stage: 'complete',
    cleanupRequired,
    error: failure ? publicError(failure, 'STT_TRANSCRIPTION_FAILED') : null,
    resultUrl: outcome.status === 'succeeded' && !failure ? `${job.record.statusUrl}/result` : null,
  });
}

function receiveProgress(context, id, event) {
  const job = context.jobs.get(id);
  const stage = [
    { matches: job.controller.signal.aborted, value: 'cleaning' },
    { matches: ['file-completed', 'file-failed', 'cleanup-failed'].includes(event.type), value: 'cleaning' },
    { matches: event.type === 'file-started', value: 'transcribing' },
  ].find(({ matches }) => matches)?.value;
  if (stage) {
    updateRecord(context, id, { stage });
  }
}

async function transcribe(context, id) {
  const job = context.jobs.get(id);
  if (job.controller.signal.aborted) {
    throw createWebError('STT_ABORTED');
  }
  const results = await context.options.runner({
    assetsDir: job.uploadDir,
    outputDir: job.outputDir,
    inputPath: job.inputPath,
    modelName: job.record.model,
    signal: job.controller.signal,
    onProgress: (event) => receiveProgress(context, id, event),
  });
  updateRecord(context, id, { stage: 'cleaning' });
  if (job.controller.signal.aborted) {
    throw createWebError('STT_ABORTED');
  }
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.success !== true) {
    throw createWebError('STT_TRANSCRIPTION_FAILED', 500, results);
  }
  let text;
  try {
    text = await readFile(path.join(job.outputDir, 'input.txt'), 'utf8');
  } catch (error) {
    throw createWebError('STT_RESULT_UNAVAILABLE', 500, error);
  }
  if (!text.trim()) {
    throw createWebError('STT_TRANSCRIPTION_FAILED');
  }
}

async function performJob(context, id) {
  updateRecord(context, id, { status: 'running' });
  let outcome;
  try {
    await transcribe(context, id);
    outcome = { status: 'succeeded' };
  } catch (error) {
    reportFailure(context, id, error);
    outcome = { status: error.code === 'STT_ABORTED' ? 'cancelled' : 'failed', error };
  }
  return finishJob(context, id, outcome);
}

function executeJob(context, id) {
  const job = findJob(context, id);
  if (job.executionPromise) {
    return job.executionPromise;
  }
  if (TERMINAL_STATUSES.includes(job.record.status)) {
    return Promise.resolve(job.record);
  }
  const executionPromise = performJob(context, id);
  context.jobs.set(id, { ...context.jobs.get(id), executionPromise });
  return executionPromise;
}

async function acceptUpload(context, request, schedule) {
  const details = uploadDetails(request, context.options.maximumBytes);
  // 첫 비동기 처리 전에 슬롯을 확보하므로 동시에 들어온 요청도 서로 겹치지 않습니다.
  const job = reserveJob(context, details);
  const id = job.record.id;
  let admitted = false;
  const onDisconnect = () => job.controller.abort();
  request.signal.addEventListener('abort', onDisconnect, { once: true });
  if (request.signal.aborted) {
    job.controller.abort();
  }
  try {
    // 업로드 중 서버가 종료되어도 Next가 부분 파일 정리까지 기다리도록 먼저 등록합니다.
    schedule(async () => {
      try {
        // 응답 전 연결 중단을 작업에 전달한 뒤 HTTP 리스너를 분리합니다.
        request.signal.removeEventListener('abort', onDisconnect);
        if (request.signal.aborted) {
          job.controller.abort();
        }
        const uploaded = await job.uploadGate.promise;
        if (uploaded) {
          await executeJob(context, id);
        }
        // after는 HTTP 응답 종료 뒤 실행하므로 Connection:close 입력 정리까지 슬롯을 유지합니다.
        const cleanupRequired = context.jobs.get(id)?.record.cleanupRequired;
        if (!uploaded && !cleanupRequired && context.control.get('activeId') === id) {
          context.control.set('activeId', null);
        }
      } finally {
        request.signal.removeEventListener('abort', onDisconnect);
      }
    });
    await mkdir(job.uploadDir, { recursive: true });
    await mkdir(job.outputDir, { recursive: true });
    const size = await saveUpload({
      request,
      inputPath: job.inputPath,
      signal: job.controller.signal,
      maximumBytes: context.options.maximumBytes,
      onSourceCleanup: () => job.sourceCleanups.add(true),
    });
    admitted = true;
    return updateRecord(context, id, { size });
  } catch (error) {
    const failure = error.status ? error : createWebError('STT_UPLOAD_FAILED', 500, error);
    reportFailure(context, id, failure);
    const record = await finishJob(context, id, { status: 'failed', error: failure });
    if (!record.cleanupRequired) {
      context.jobs.delete(id);
    }
    throw record.cleanupRequired ? createWebError('STT_UPLOAD_CLEANUP_FAILED') : failure;
  } finally {
    if (!admitted) {
      request.signal.removeEventListener('abort', onDisconnect);
    }
    job.uploadGate.settle(admitted);
  }
}

function cancelJob(context, id) {
  const job = findJob(context, id);
  if (TERMINAL_STATUSES.includes(job.record.status)) {
    return { record: job.record, status: 200 };
  }
  job.controller.abort();
  return { record: updateRecord(context, id, { stage: 'cleaning' }), status: 202 };
}

async function readResult(context, id) {
  const job = findJob(context, id);
  if (job.record.status !== 'succeeded') {
    throw createWebError('STT_RESULT_NOT_READY', 409);
  }
  try {
    const text = await readFile(path.join(job.outputDir, 'input.txt'), 'utf8');
    if (!text.trim()) {
      throw createWebError('STT_RESULT_UNAVAILABLE');
    }
    const name = `${path.parse(job.record.name).name}.txt`;
    return { text, name };
  } catch (error) {
    reportFailure(context, id, error);
    throw createWebError('STT_RESULT_UNAVAILABLE', 500, error);
  }
}

export function createJobManager({ assetsDir, outputDir, runner, maximumBytes = MAX_UPLOAD_BYTES, logger = console }) {
  const context = {
    jobs: new Map(),
    control: new Map([['activeId', null], ['stopping', false]]),
    options: { assetsDir, outputDir, runner, maximumBytes, logger },
  };
  return {
    accept: (request, schedule = () => {}) => acceptUpload(context, request, schedule),
    get: (id) => findJob(context, id).record,
    execute: (id) => executeJob(context, id),
    cancel: (id) => cancelJob(context, id),
    result: (id) => readResult(context, id),
    shutdown: () => {
      context.control.set('stopping', true);
      const active = context.jobs.get(context.control.get('activeId'));
      if (active) {
        active.controller.abort();
        updateRecord(context, active.record.id, { stage: 'cleaning' });
      }
    },
  };
}
