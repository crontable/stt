import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { createTranscript, readTranscriptionEvent, subscribeTranscription, updateTranscript } from '../src/client/transcription-stream.js';

const JOB_ID = '54b56efa-b855-46d9-b2bc-41e15e66997f';

function job(status = 'running') {
  return { id: JOB_ID, status, stage: status === 'running' ? 'transcribing' : 'complete', resultUrl: '/final.txt' };
}

function segment(seq, text = '한국어 구간') {
  return { jobId: JOB_ID, seq, startMs: 0, endMs: 1000, text };
}

function snapshot(seq = 0, status = 'running', segments = []) {
  return { job: job(status), segments, seq };
}

function fakeSource() {
  const target = new EventTarget();
  let readyState = 0;
  let closeCount = 0;
  Object.defineProperty(target, 'readyState', { get: () => readyState });
  return Object.assign(target, {
    close() { readyState = 2; closeCount += 1; },
    closeCount: () => closeCount,
    open() { readyState = 1; target.dispatchEvent(new Event('open')); },
    reconnect() { readyState = 0; target.dispatchEvent(new Event('error')); },
    disconnect() { readyState = 2; target.dispatchEvent(new Event('error')); },
    emit(type, value) { target.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) })); },
  });
}

function fixture(options = {}) {
  const source = fakeSource();
  const { loadJob, loadResult, ...sourceOptions } = options;
  let entries = [];
  let jobCalls = 0;
  let resultCalls = 0;
  const record = (type, value) => { entries = [...entries, { type, value }]; };
  const callbacks = {
    onUpdate: (value) => record('update', value),
    onJob: (value) => record('job', value),
    onResult: (id, text) => record('result', { id, text }),
    onResultLoading: () => record('loading'),
    onConnection: (value) => record('connection', value),
    onError: (value) => record('error', value),
  };
  const cleanup = subscribeTranscription(JOB_ID, callbacks, {
    createSource: () => source,
    loadJob: async (...args) => { jobCalls += 1; return loadJob ? loadJob(...args) : job(); },
    loadResult: async (...args) => { resultCalls += 1; return loadResult ? loadResult(...args) : '최종 전체 텍스트'; },
    formatError: (error, fallback) => (error.publicMessage ?? fallback),
    ...sourceOptions,
  });
  return {
    source, cleanup,
    entries: (type) => entries.filter((entry) => entry.type === type).map(({ value }) => value),
    jobCalls: () => jobCalls,
    resultCalls: () => resultCalls,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

test('순번 0의 초기 상태와 누적 구간을 받아 중복·과거·다른 작업 이벤트를 무시한다', () => {
  const initial = createTranscript(JOB_ID);
  const empty = updateTranscript(initial, { type: 'snapshot', ...snapshot() });
  assert.equal(empty.seq, 0);
  assert.equal(empty.text, '');
  const first = updateTranscript(empty, { type: 'segment', ...segment(1, '첫 문장') });
  assert.equal(first.text, '첫 문장');
  assert.equal(updateTranscript(first, { type: 'segment', ...segment(1) }), first);
  assert.equal(updateTranscript(first, { type: 'state', job: job(), seq: 0 }), first);
  assert.equal(updateTranscript(first, { type: 'segment', ...segment(2), jobId: 'other' }), first);
  const recovered = updateTranscript(first, { type: 'snapshot', ...snapshot(8, 'running', [segment(1, '복구 문장'), segment(7, '새 문장')]) });
  assert.equal(recovered.text, '복구 문장\n새 문장');
});

test('잘못된 시간·순번·누적 배열을 거절하고 다른 작업의 메시지를 반영하지 않는다', () => {
  assert.equal(readTranscriptionEvent('segment', JSON.stringify({ ...segment(1), jobId: 'other' }), JOB_ID), null);
  assert.throws(() => readTranscriptionEvent('segment', JSON.stringify({ ...segment(1), endMs: -1 }), JOB_ID));
  assert.throws(() => readTranscriptionEvent('state', JSON.stringify({ job: job(), seq: '2' }), JOB_ID));
  assert.throws(() => readTranscriptionEvent('snapshot', JSON.stringify({ ...snapshot(), segments: null }), JOB_ID));
  assert.throws(() => readTranscriptionEvent('terminal', JSON.stringify({ job: job(), seq: 3 }), JOB_ID));
});

test('부분 결과를 즉시 반영하고 자동 재연결 동안 조회 요청 없이 받은 문장을 유지한다', async (t) => {
  const { source, cleanup, entries, jobCalls, resultCalls } = fixture();
  t.after(cleanup);
  source.open();
  source.emit('snapshot', snapshot());
  source.emit('segment', segment(1, '첫 문장'));
  source.reconnect();
  await setImmediate();
  assert.equal(entries('update').at(-1).text, '첫 문장');
  assert.equal(entries('connection').at(-1), 'reconnecting');
  assert.equal(jobCalls(), 0);
  assert.equal(resultCalls(), 0);
  source.open();
  source.emit('segment', segment(1, '첫 문장'));
  source.emit('segment', segment(2, '둘째 문장'));
  assert.equal(entries('update').length, 3);
  assert.equal(entries('update').at(-1).text, '첫 문장\n둘째 문장');
});

test('성공 시 연결을 먼저 닫고 최종 파일을 한 번 읽어 부분 결과와 맞춘다', async (t) => {
  const completed = deferred();
  const values = fixture({ loadResult: async () => completed.promise });
  t.after(values.cleanup);
  values.source.emit('snapshot', snapshot());
  values.source.emit('segment', segment(1, '일부 결과'));
  values.source.emit('terminal', { job: job('succeeded'), seq: 2 });
  assert.equal(values.source.closeCount(), 1);
  assert.equal(values.entries('loading').length, 1);
  assert.deepEqual(values.entries('result'), []);
  completed.resolve('교정된 최종 전체 결과');
  await setImmediate();
  assert.deepEqual(values.entries('result'), [{ id: JOB_ID, text: '교정된 최종 전체 결과' }]);
  values.source.emit('terminal', { job: job('succeeded'), seq: 2 });
  assert.equal(values.entries('loading').length, 1);
});

test('종료 작업의 snapshot과 같은 순번 terminal에서 최종 결과를 중복으로 읽지 않는다', async (t) => {
  const values = fixture();
  t.after(values.cleanup);
  values.source.emit('snapshot', snapshot(9, 'succeeded', [segment(2, '누적 결과')]));
  values.source.emit('terminal', { job: job('succeeded'), seq: 9 });
  await setImmediate();
  assert.equal(values.resultCalls(), 1);
  assert.equal(values.entries('update').at(-1).text, '누적 결과');
  assert.equal(values.source.closeCount(), 1);
});

test('실패·취소 종료 시 부분 결과를 유지하고 최종 파일을 요청하지 않는다', async (t) => {
  const failed = fixture();
  const cancelled = fixture();
  t.after(failed.cleanup);
  t.after(cancelled.cleanup);
  [failed, cancelled].forEach((values) => {
    values.source.emit('snapshot', snapshot());
    values.source.emit('segment', segment(1, '중간 결과'));
  });
  failed.source.emit('terminal', { job: job('failed'), seq: 2 });
  cancelled.source.emit('terminal', { job: job('cancelled'), seq: 2 });
  await setImmediate();
  [failed, cancelled].forEach((values) => {
    assert.equal(values.resultCalls(), 0);
    assert.equal(values.entries('update').at(-1).text, '중간 결과');
    assert.equal(values.source.closeCount(), 1);
  });
});

test('영구 종료한 연결은 한 번만 진단하며 반복 오류가 조회를 늘리지 않는다', async (t) => {
  const values = fixture();
  t.after(values.cleanup);
  values.source.emit('snapshot', snapshot());
  values.source.emit('segment', segment(1));
  values.source.disconnect();
  values.source.disconnect();
  await setImmediate();
  values.source.disconnect();
  await setImmediate();
  assert.equal(values.jobCalls(), 1);
  assert.equal(values.resultCalls(), 0);
  assert.match(values.entries('error').at(-1), /같은 작업/u);
  assert.equal(values.entries('update').at(-1).text, '한국어 구간');
});

test('연결 종료 뒤 서버의 작업 없음 안내를 전달한다', async (t) => {
  const values = fixture({ loadJob: async () => { throw Object.assign(new Error(), { publicMessage: '작업을 찾을 수 없습니다.' }); } });
  t.after(values.cleanup);
  values.source.disconnect();
  await setImmediate();
  assert.equal(values.entries('error').at(-1), '작업을 찾을 수 없습니다.');
});

test('구독 정리 시 결과 읽기를 중단하고 이전 연결의 뒤늦은 응답과 이벤트를 무시한다', async () => {
  const completed = deferred();
  let signal;
  const values = fixture({ loadResult: async (url, currentSignal) => { signal = currentSignal; return completed.promise; } });
  values.source.emit('snapshot', snapshot(2, 'succeeded'));
  values.cleanup();
  assert.equal(signal.aborted, true);
  ['snapshot', 'state', 'segment', 'terminal', 'open', 'error'].forEach((type) => {
    assert.equal(getEventListeners(values.source, type).length, 0);
  });
  completed.resolve('뒤늦은 결과');
  values.source.emit('snapshot', snapshot(3));
  await setImmediate();
  assert.deepEqual(values.entries('result'), []);
  assert.equal(values.entries('update').length, 1);
});

test('최종 결과 읽기 실패 뒤 같은 작업의 새 구독으로 결과를 다시 읽는다', async (t) => {
  const first = fixture({ loadResult: async () => { throw new Error('연결 중단'); } });
  t.after(first.cleanup);
  first.source.emit('snapshot', snapshot(5, 'succeeded', [segment(1, '보존할 부분') ]));
  await setImmediate();
  assert.match(first.entries('error').at(-1), /저장된 결과/u);
  assert.equal(first.entries('update').at(-1).text, '보존할 부분');
  const retry = fixture();
  t.after(retry.cleanup);
  retry.source.emit('snapshot', snapshot(5, 'succeeded', [segment(1, '보존할 부분')]));
  await setImmediate();
  assert.equal(retry.resultCalls(), 1);
  assert.equal(retry.entries('result').at(-1).text, '최종 전체 텍스트');
});

test('주소의 작업이 달라진 뒤 들어온 이벤트와 최종 결과가 화면 상태를 바꾸지 않는다', async (t) => {
  let current = true;
  const completed = deferred();
  const values = fixture({ isCurrent: () => current, loadResult: async () => completed.promise });
  t.after(values.cleanup);
  values.source.emit('snapshot', snapshot(1, 'succeeded'));
  current = false;
  completed.resolve('이전 작업 결과');
  values.source.emit('segment', segment(2));
  await setImmediate();
  assert.deepEqual(values.entries('result'), []);
  assert.equal(values.entries('update').length, 1);
});
