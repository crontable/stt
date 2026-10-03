import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createJobManager } from '../src/server/job-manager.js';
import { errorResponse, validateJobId } from '../src/server/responses.js';
import { saveUpload } from '../src/server/upload.js';

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function requestFile(name = '한국어.WAV', body = new Uint8Array([1, 2, 3]), options = {}) {
  return new Request(`http://localhost/api/transcriptions?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/octet-stream', ...options.headers },
    duplex: 'half',
    ...options,
  });
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'stt-web-manager-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const assetsDir = path.join(root, 'assets');
  const outputDir = path.join(root, 'output');
  const runner = async (values) => {
    await writeFile(path.join(values.outputDir, 'input.txt'), '안녕하세요. 한국어 음성입니다.', 'utf8');
    return [{ success: true, inputFile: 'input.wav', outputFile: 'input.txt' }];
  };
  const manager = createJobManager({ assetsDir, outputDir, runner, logger: { error: () => {} }, ...options });
  return { root, assetsDir, outputDir, manager };
}

async function assertMissing(filePath) {
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
}

test('입력 이름과 형식을 확인하고 원시 오류를 응답에 노출하지 않는다', async (t) => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.accept(requestFile('')), { code: 'STT_INVALID_NAME', status: 400 });
  await assert.rejects(manager.accept(requestFile('../녹음.wav')), { code: 'STT_INVALID_NAME' });
  await assert.rejects(manager.accept(requestFile('녹음\u0000.wav')), { code: 'STT_INVALID_NAME' });
  await assert.rejects(manager.accept(requestFile('녹음.exe')), { code: 'STT_UNSUPPORTED_FORMAT', status: 415 });
  await assert.rejects(manager.accept(requestFile('녹음.wav', null)), { code: 'STT_INVALID_BODY' });
  const response = errorResponse(new Error('/secret/native/file: 엔진 오류'));
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'STT_WEB_FAILED');
  assert.doesNotMatch(body.error.message, /secret|native/u);
});

test('빈 파일과 헤더 상한을 거절하고 실제 스트림 바이트도 제한한다', async (t) => {
  const { manager, assetsDir } = await fixture(t, { maximumBytes: 4 });
  await assert.rejects(manager.accept(requestFile('empty.wav', new Uint8Array())), { code: 'STT_EMPTY_UPLOAD', status: 400 });
  await assert.rejects(manager.accept(requestFile('big.wav', new Uint8Array([1]), {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' },
  })), { code: 'STT_UPLOAD_TOO_LARGE', status: 413 });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4, 5]));
      controller.close();
    },
  });
  await assert.rejects(manager.accept(requestFile('stream.wav', body, {
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': '1' },
  })), { code: 'STT_UPLOAD_TOO_LARGE' });
  const admitted = await manager.accept(requestFile());
  assert.equal(admitted.size, 3);
  await manager.execute(admitted.id);
  await assertMissing(path.join(assetsDir, admitted.id));
});

test('업로드 저장 오류를 공개 안내로 바꾸고 다음 접수를 허용한다', async (t) => {
  const { manager } = await fixture(t);
  const stream = new ReadableStream({
    start(controller) {
      controller.error(Object.assign(new Error('/secret/storage/입력.wav'), { code: 'ENOSPC' }));
    },
  });
  let failure;
  try {
    await manager.accept(requestFile('broken.wav', stream));
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'STT_UPLOAD_FAILED');
  const body = await errorResponse(failure).json();
  assert.doesNotMatch(body.error.message, /secret|storage/u);
  const record = await manager.accept(requestFile());
  await manager.execute(record.id);
  assert.equal(manager.get(record.id).status, 'succeeded');
});

test('크기 초과 뒤 남은 입력을 버리고 HTTP 입력을 취소하지 않은 채 슬롯을 정리한다', async (t) => {
  const { manager } = await fixture(t, { maximumBytes: 4 });
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.enqueue(new Uint8Array([6, 7, 8]));
      controller.close();
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(manager.accept(requestFile('limit.wav', stream)), { code: 'STT_UPLOAD_TOO_LARGE', status: 413 });
  assert.equal(cancelled, false);
  assert.equal(stream.locked, false);
  const record = await manager.accept(requestFile());
  await manager.execute(record.id);
  assert.equal(manager.get(record.id).status, 'succeeded');
});

test('상한 초과 뒤 남은 바이트를 디스크에 쓰지 않고 정확히 상한인 파일은 받는다', async (t) => {
  const { root } = await fixture(t);
  const inputPath = path.join(root, 'limited.wav');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.enqueue(new Uint8Array([4, 5]));
      controller.enqueue(new Uint8Array([6, 7, 8]));
      controller.close();
    },
  });
  await assert.rejects(saveUpload({
    request: requestFile('limited.wav', stream),
    inputPath,
    signal: new AbortController().signal,
    maximumBytes: 4,
  }), { code: 'STT_UPLOAD_TOO_LARGE' });
  assert.deepEqual(await readFile(inputPath), Buffer.from([1, 2, 3]));
  const exactPath = path.join(root, 'exact.wav');
  assert.equal(await saveUpload({
    request: requestFile('exact.wav', new Uint8Array([1, 2, 3, 4])),
    inputPath: exactPath,
    signal: new AbortController().signal,
    maximumBytes: 4,
  }), 4);
  assert.equal((await stat(exactPath)).size, 4);
});

test('첫 비동기 처리 전에 업로드 슬롯과 Next 완료 흐름을 확보한다', async (t) => {
  const { manager } = await fixture(t);
  let streamController;
  let complete;
  const stream = new ReadableStream({ start(controller) { streamController = controller; } });
  const receiving = manager.accept(requestFile('first.wav', stream), (callback) => { complete = callback; });
  assert.equal(typeof complete, 'function');
  await assert.rejects(manager.accept(requestFile('second.wav')), { code: 'STT_WEB_BUSY', status: 409 });
  streamController.enqueue(new Uint8Array([7, 8]));
  streamController.close();
  const record = await receiving;
  assert.equal(record.status, 'accepted');
  await complete();
  assert.equal(manager.get(record.id).status, 'succeeded');
});

test('본문 저장 뒤 접수 응답 전 취소를 연결하고 after에서 요청 리스너와 슬롯을 정리한다', async (t) => {
  let runnerCalls = 0;
  const { manager, assetsDir, outputDir } = await fixture(t, {
    runner: async (values) => {
      runnerCalls += 1;
      await writeFile(path.join(values.outputDir, 'input.txt'), '정상 결과');
      return [{ success: true }];
    },
  });
  const controller = new AbortController();
  const request = requestFile('response-pending.wav', new Uint8Array([1, 2, 3]), { signal: controller.signal });
  let complete;
  const record = await manager.accept(request, (callback) => { complete = callback; });
  assert.equal(getEventListeners(request.signal, 'abort').length, 1);
  controller.abort();
  await complete();
  assert.equal(runnerCalls, 0);
  assert.equal(manager.get(record.id).status, 'cancelled');
  assert.equal(getEventListeners(request.signal, 'abort').length, 0);
  await assertMissing(path.join(assetsDir, record.id));
  await assertMissing(path.join(outputDir, record.id));

  const nextRequest = requestFile();
  let nextComplete;
  const nextRecord = await manager.accept(nextRequest, (callback) => { nextComplete = callback; });
  assert.equal(getEventListeners(nextRequest.signal, 'abort').length, 1);
  await nextComplete();
  assert.equal(manager.get(nextRecord.id).status, 'succeeded');
  assert.equal(runnerCalls, 1);
  assert.equal(getEventListeners(nextRequest.signal, 'abort').length, 0);
});

test('성공 결과와 원래 다운로드 이름을 보존하고 업로드를 지운다', async (t) => {
  const { manager, assetsDir, outputDir } = await fixture(t);
  const record = await manager.accept(requestFile('한국어 녹음.WAV'));
  assert.equal(record.model, 'large-v3');
  assert.equal(record.size, 3);
  assert.equal(Object.keys(record).some((key) => key.endsWith('Dir') || key.endsWith('Path')), false);
  const runningResult = await manager.execute(record.id);
  assert.equal(runningResult.status, 'succeeded');
  assert.equal(runningResult.stage, 'complete');
  assert.equal(runningResult.resultUrl, `/api/transcriptions/${record.id}/result`);
  assert.deepEqual(await manager.result(record.id), { text: '안녕하세요. 한국어 음성입니다.', name: '한국어 녹음.txt' });
  await assertMissing(path.join(assetsDir, record.id));
  assert.equal(await readFile(path.join(outputDir, record.id, 'input.txt'), 'utf8'), '안녕하세요. 한국어 음성입니다.');
  assert.equal(manager.cancel(record.id).status, 200);
  const next = await manager.accept(requestFile());
  await manager.execute(next.id);
});

test('파일 완료 이벤트 뒤에도 실행기 정리가 끝날 때까지 성공을 표시하지 않는다', async (t) => {
  const settled = deferred();
  const eventSent = deferred();
  const { manager } = await fixture(t, {
    runner: async ({ outputDir, onProgress }) => {
      onProgress({ type: 'initialized' });
      onProgress({ type: 'file-started' });
      await writeFile(path.join(outputDir, 'input.txt'), '완료된 텍스트');
      onProgress({ type: 'file-completed' });
      eventSent.resolve();
      await settled.promise;
      return [{ success: true }];
    },
  });
  const record = await manager.accept(requestFile());
  const execution = manager.execute(record.id);
  await eventSent.promise;
  assert.equal(manager.get(record.id).status, 'running');
  assert.equal(manager.get(record.id).stage, 'cleaning');
  await assert.rejects(manager.result(record.id), { code: 'STT_RESULT_NOT_READY', status: 409 });
  await assert.rejects(manager.accept(requestFile()), { code: 'STT_WEB_BUSY' });
  settled.resolve();
  await execution;
  assert.equal(manager.get(record.id).status, 'succeeded');
});

test('실패 배열과 빈 결과를 성공으로 처리하지 않는다', async (t) => {
  const failed = await fixture(t, { runner: async () => [{ success: false, error: '/secret/실패.log' }] });
  const failureRecord = await failed.manager.accept(requestFile());
  await failed.manager.execute(failureRecord.id);
  assert.equal(failed.manager.get(failureRecord.id).status, 'failed');
  assert.equal(failed.manager.get(failureRecord.id).error.code, 'STT_TRANSCRIPTION_FAILED');
  assert.doesNotMatch(failed.manager.get(failureRecord.id).error.message, /secret/u);
  await assertMissing(path.join(failed.assetsDir, failureRecord.id));
  const empty = await fixture(t, {
    runner: async ({ outputDir }) => {
      await writeFile(path.join(outputDir, 'input.txt'), ' \n');
      return [{ success: true }];
    },
  });
  const emptyRecord = await empty.manager.accept(requestFile());
  await empty.manager.execute(emptyRecord.id);
  assert.equal(empty.manager.get(emptyRecord.id).status, 'failed');
  await assertMissing(path.join(empty.outputDir, emptyRecord.id));
});

test('접수 뒤 취소는 자원 정리를 기다리고 슬롯을 유지한다', async (t) => {
  const started = deferred();
  const cleanup = deferred();
  const { manager, assetsDir } = await fixture(t, {
    runner: async ({ signal }) => {
      started.resolve(signal);
      await cleanup.promise;
      throw Object.assign(new Error('/secret/취소.log'), { code: 'STT_ABORTED' });
    },
  });
  const record = await manager.accept(requestFile());
  const execution = manager.execute(record.id);
  const signal = await started.promise;
  const cancellation = manager.cancel(record.id);
  assert.equal(cancellation.status, 202);
  assert.equal(cancellation.record.stage, 'cleaning');
  assert.equal(signal.aborted, true);
  assert.equal(manager.get(record.id).status, 'running');
  await assert.rejects(manager.accept(requestFile()), { code: 'STT_WEB_BUSY' });
  cleanup.resolve();
  await execution;
  assert.equal(manager.get(record.id).status, 'cancelled');
  await assertMissing(path.join(assetsDir, record.id));
});

test('실행 전 취소는 실행기를 시작하지 않고 업로드를 정리한다', async (t) => {
  const { manager, assetsDir } = await fixture(t, { runner: async () => { assert.fail('취소한 작업은 실행하면 안 됩니다.'); } });
  const record = await manager.accept(requestFile());
  manager.cancel(record.id);
  await manager.execute(record.id);
  assert.equal(manager.get(record.id).status, 'cancelled');
  await assertMissing(path.join(assetsDir, record.id));
});

test('하위 프로세스 정리 실패는 업로드와 잠금 및 슬롯을 보존한다', async (t) => {
  const { manager, assetsDir, outputDir } = await fixture(t, {
    runner: async (values) => {
      await writeFile(path.join(values.outputDir, '.owned.lock'), '프로세스 확인 필요');
      throw Object.assign(new Error('/secret/native/프로세스'), { code: 'STT_PROCESS_CLEANUP_FAILED' });
    },
  });
  const record = await manager.accept(requestFile());
  await manager.execute(record.id);
  const current = manager.get(record.id);
  assert.equal(current.status, 'failed');
  assert.equal(current.cleanupRequired, true);
  assert.equal(current.error.code, 'STT_PROCESS_CLEANUP_FAILED');
  assert.doesNotMatch(current.error.message, /secret|native/u);
  assert.equal((await stat(path.join(assetsDir, record.id, 'input.wav'))).size, 3);
  assert.equal(await readFile(path.join(outputDir, record.id, '.owned.lock'), 'utf8'), '프로세스 확인 필요');
  await assert.rejects(manager.accept(requestFile()), { code: 'STT_WEB_BUSY' });
});

test('업로드 중 연결 취소 뒤 부분 파일과 슬롯을 정리한다', async (t) => {
  const { manager, assetsDir } = await fixture(t);
  const signalController = new AbortController();
  const reading = deferred();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])); },
    pull() { reading.resolve(); },
  }, { highWaterMark: 0 });
  let complete;
  const receiving = manager.accept(requestFile('partial.wav', stream, { signal: signalController.signal }), (callback) => { complete = callback; });
  await reading.promise;
  signalController.abort();
  await assert.rejects(receiving, { code: 'STT_ABORTED' });
  await assert.rejects(manager.accept(requestFile()), { code: 'STT_WEB_BUSY' });
  await complete();
  const record = await manager.accept(requestFile());
  await manager.execute(record.id);
  await assertMissing(path.join(assetsDir, record.id));
});

test('서버 종료가 업로드 읽기 대기를 깨고 정리 완료 흐름을 끝낸다', async (t) => {
  const { manager } = await fixture(t);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); } });
  let complete;
  const receiving = manager.accept(requestFile('partial.wav', stream), (callback) => { complete = callback; });
  manager.shutdown();
  await assert.rejects(receiving, { code: 'STT_ABORTED' });
  await complete();
  await assert.rejects(manager.accept(requestFile()), { code: 'STT_WEB_SHUTTING_DOWN', status: 503 });
});

test('서버 중단 응답과 파일 정리를 끝내고 after는 미완료 입력 취소 Promise에 멈추지 않는다', async (t) => {
  const { manager, assetsDir } = await fixture(t);
  const reading = deferred();
  const sourceClosed = deferred();
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
    pull() { reading.resolve(); },
    cancel() { return sourceClosed.promise; },
  }, { highWaterMark: 0 });
  let complete;
  const receiving = manager.accept(requestFile('partial.wav', stream), (callback) => { complete = callback; });
  await reading.promise;
  manager.shutdown();
  let failure;
  try {
    await receiving;
  } catch (error) {
    failure = error;
  }
  assert.equal(failure.code, 'STT_ABORTED');
  assert.equal(errorResponse(failure).headers.get('connection'), 'close');
  assert.deepEqual(await readdir(assetsDir), []);
  await complete();
  sourceClosed.resolve();
});

test('작업 식별자와 결과 파일 오류를 구분하고 재시작 시 메모리 상태가 사라진다', async (t) => {
  const { manager, assetsDir, outputDir } = await fixture(t);
  assert.throws(() => validateJobId('invalid'), { code: 'STT_INVALID_ID', status: 400 });
  assert.throws(() => manager.get('00000000-0000-0000-0000-000000000000'), { code: 'STT_JOB_NOT_FOUND', status: 404 });
  const record = await manager.accept(requestFile());
  await manager.execute(record.id);
  const restarted = createJobManager({ assetsDir, outputDir, runner: async () => [] });
  assert.throws(() => restarted.get(record.id), { code: 'STT_JOB_NOT_FOUND' });
  assert.equal((await stat(path.join(outputDir, record.id, 'input.txt'))).isFile(), true);
  await rm(path.join(outputDir, record.id, 'input.txt'));
  await assert.rejects(manager.result(record.id), { code: 'STT_RESULT_UNAVAILABLE', status: 500 });
});

test('실제 로그의 구간을 전달하고 실행기와 파일 정리가 끝난 뒤 종료를 보낸다', async (t) => {
  const settled = deferred();
  const eventSent = deferred();
  const { manager, assetsDir } = await fixture(t, {
    runner: async ({ outputDir, onProgress, onLog }) => {
      onProgress({ type: 'file-started' });
      onLog({ stream: 'stdout', text: '[00:00:00.000 --> 00:00:01.000] 한국어 중간' });
      onLog({ stream: 'stdout', text: ' 문장\n[00:00:01.000 --> 00:00:02.000] 마지막 구간' });
      await writeFile(path.join(outputDir, 'input.txt'), '한국어 전체 결과');
      onProgress({ type: 'file-completed' });
      eventSent.resolve();
      await settled.promise;
      return [{ success: true }];
    },
  });
  const record = await manager.accept(requestFile());
  assert.equal(record.eventsUrl, `/api/transcriptions/${record.id}/events`);
  assert.equal(record.streamNotice, null);
  const events = [];
  const closeReasons = [];
  manager.subscribe(record.id, { onEvent: (event) => events.push(event), onClose: (reason) => closeReasons.push(reason) });
  const execution = manager.execute(record.id);
  await eventSent.promise;
  assert.deepEqual(events.filter(({ type }) => type === 'segment').map(({ data }) => data.text), ['한국어 중간 문장']);
  assert.equal(events.some(({ type }) => type === 'terminal'), false);
  assert.equal((await stat(path.join(assetsDir, record.id, 'input.wav'))).size, 3);
  settled.resolve();
  await execution;
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'terminal');
  assert.equal(terminal.data.job.status, 'succeeded');
  assert.equal(terminal.data.job.stage, 'complete');
  assert.deepEqual(events.filter(({ type }) => type === 'segment').map(({ data }) => data.text), ['한국어 중간 문장', '마지막 구간']);
  assert.deepEqual(closeReasons, ['terminal']);
  await assertMissing(path.join(assetsDir, record.id));
  assert.deepEqual(await manager.result(record.id), { text: '한국어 전체 결과', name: '한국어.txt' });
});

test('구독 중단은 전사를 유지하고 취소 요청은 구간을 보존한 채 정리 후 종료한다', async (t) => {
  const started = deferred();
  const settled = deferred();
  const { manager } = await fixture(t, {
    runner: async ({ signal, onLog }) => {
      onLog({ stream: 'stdout', text: '[00:00:00.000 --> 00:00:01.000] 취소 전 문장\n' });
      started.resolve(signal);
      await settled.promise;
      throw Object.assign(new Error('취소 요청'), { code: 'STT_ABORTED' });
    },
  });
  const record = await manager.accept(requestFile());
  const unsubscribe = manager.subscribe(record.id, { onEvent: () => {} });
  const execution = manager.execute(record.id);
  const signal = await started.promise;
  unsubscribe();
  assert.equal(signal.aborted, false);
  const restored = [];
  manager.subscribe(record.id, { onEvent: (event) => restored.push(event) });
  assert.deepEqual(restored[0].data.segments.map(({ text }) => text), ['취소 전 문장']);
  manager.cancel(record.id);
  assert.equal(signal.aborted, true);
  assert.equal(restored.some(({ type }) => type === 'terminal'), false);
  settled.resolve();
  await execution;
  assert.equal(restored.at(-1).type, 'terminal');
  assert.equal(restored.at(-1).data.job.status, 'cancelled');
});

test('서버 종료가 기존 구독을 먼저 닫고 새 구독은 503으로 거절한다', async (t) => {
  const started = deferred();
  const settled = deferred();
  const { manager } = await fixture(t, {
    runner: async ({ signal }) => {
      started.resolve(signal);
      await settled.promise;
      throw Object.assign(new Error('서버 종료'), { code: 'STT_ABORTED' });
    },
  });
  const record = await manager.accept(requestFile());
  const reasons = [];
  const execution = manager.execute(record.id);
  const signal = await started.promise;
  manager.subscribe(record.id, { onEvent: () => {}, onClose: (reason) => reasons.push({ reason, aborted: signal.aborted }) });
  manager.shutdown();
  assert.deepEqual(reasons, [{ reason: 'shutdown', aborted: false }]);
  assert.equal(signal.aborted, true);
  assert.throws(() => manager.subscribe(record.id, { onEvent: () => {} }), { code: 'STT_WEB_SHUTTING_DOWN', status: 503 });
  assert.throws(() => manager.subscribe('invalid', { onEvent: () => {} }), { code: 'STT_INVALID_ID', status: 400 });
  assert.throws(() => manager.subscribe('00000000-0000-0000-0000-000000000000', { onEvent: () => {} }), { code: 'STT_JOB_NOT_FOUND', status: 404 });
  settled.resolve();
  await execution;
  assert.equal(manager.get(record.id).status, 'cancelled');
  assert.equal(reasons.length, 1);
});
