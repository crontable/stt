import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import test from 'node:test';

import { createJobEventStream, SSE_HEARTBEAT_MILLISECONDS } from '../src/server/event-stream.js';
import { createJobEvents, MAX_SUBSCRIBER_QUEUE_BYTES } from '../src/server/job-events.js';

function fixture(status = 'running') {
  const record = new Map([['value', { id: 'job-id', status, stage: status === 'running' ? 'transcribing' : 'complete' }]]);
  let unsubscribeCount = 0;
  const closedReasons = [];
  const events = createJobEvents({ getJob: () => record.get('value'), onLimit: () => {} });
  const manager = {
    subscribe: (id, options) => {
      assert.equal(id, 'job-id');
      const unsubscribe = events.subscribe({ ...options, onClose: (reason) => { closedReasons.push(reason); options.onClose(reason); } });
      return () => { unsubscribeCount += 1; unsubscribe(); };
    },
  };
  const controller = new AbortController();
  const stream = (options = {}) => createJobEventStream({ manager, id: 'job-id', signal: controller.signal, ...options });
  return { events, record, closedReasons, controller, stream, unsubscribeCount: () => unsubscribeCount };
}

function log(events, text, second = 0) {
  const stamp = String(second).padStart(2, '0');
  const endStamp = String(second + 1).padStart(2, '0');
  events.log({ stream: 'stdout', text: `[00:00:${stamp}.000 --> 00:00:${endStamp}.000] ${text}\n` });
}

function decodeFrame(result) {
  assert.equal(result.done, false);
  return new TextDecoder().decode(result.value);
}

test('스냅샷과 구간을 SSE 프레임으로 보내고 읽기 취소는 구독만 해제한다', async () => {
  const values = fixture();
  const reader = values.stream().getReader();
  assert.match(decodeFrame(await reader.read()), /^id: 0\nevent: snapshot\ndata: /u);
  const next = reader.read();
  log(values.events, '한국어 중간 문장');
  assert.match(decodeFrame(await next), /event: segment\ndata: .*한국어 중간 문장/u);
  await reader.cancel();
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
  log(values.events, '전사를 계속', 1);
  values.events.close();
  assert.deepEqual(values.closedReasons, []);
});

test('초기 스냅샷이 일반 대기 상한보다 커도 한 번 전송하고 새 구간을 받는다', async () => {
  const values = fixture();
  Array.from({ length: 24 }, (_, index) => index).forEach((index) => log(values.events, '가'.repeat(15000), index));
  const reader = values.stream({ lastEventId: '0' }).getReader();
  const initial = await reader.read();
  assert.ok(initial.value.byteLength > MAX_SUBSCRIBER_QUEUE_BYTES);
  assert.match(decodeFrame(initial), /event: snapshot/u);
  assert.equal(values.unsubscribeCount(), 0);
  const next = reader.read();
  log(values.events, '새 구간', 24);
  assert.match(decodeFrame(await next), /event: segment/u);
  await reader.cancel();
  assert.equal(values.unsubscribeCount(), 1);
});

test('느린 연결의 후속 프레임 상한 초과는 연결을 닫고 재연결 스냅샷으로 복구한다', async () => {
  const values = fixture();
  const reader = values.stream({ maximumQueueBytes: 200 }).getReader();
  ['첫째', '둘째', '셋째'].forEach((text, index) => log(values.events, text, index));
  await assert.rejects(reader.read(), { name: 'AbortError' });
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
  const recovered = values.stream().getReader();
  assert.match(decodeFrame(await recovered.read()), /첫째.*둘째.*셋째/u);
  await recovered.cancel();
  assert.equal(values.unsubscribeCount(), 2);
});

test('완료 프레임을 모두 읽으면 구독과 요청 리스너를 해제하고 스트림을 닫는다', async () => {
  const values = fixture('succeeded');
  const reader = values.stream().getReader();
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 1);
  assert.equal(values.unsubscribeCount(), 0);
  const snapshot = decodeFrame(await reader.read());
  const terminal = decodeFrame(await reader.read());
  assert.match(snapshot, /^id: 0\nevent: snapshot/u);
  assert.match(terminal, /^id: 0\nevent: terminal/u);
  assert.equal((await reader.read()).done, true);
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
  values.events.close();
  assert.deepEqual(values.closedReasons, ['terminal']);
});

test('읽지 않은 초기 완료 스냅샷도 서버 종료가 즉시 닫고 구독을 해제한다', async () => {
  const values = fixture('succeeded');
  const reader = values.stream().getReader();
  values.events.close();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
  assert.deepEqual(values.closedReasons, ['terminal', 'shutdown']);
});

test('종료 알림 뒤 프레임이 남아 있어도 요청 중단이 연결을 닫는다', async () => {
  const values = fixture();
  const reader = values.stream().getReader();
  log(values.events, '마지막 구간');
  const completed = { ...values.record.get('value'), status: 'succeeded', stage: 'complete' };
  values.record.set('value', completed);
  values.events.terminal(completed);
  assert.deepEqual(values.closedReasons, ['terminal']);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 1);
  values.controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
});

test('15초마다 순번 없는 연결 유지 주석을 보내고 취소 후 타이머를 해제한다', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const values = fixture();
  const reader = values.stream().getReader();
  await reader.read();
  const next = reader.read();
  t.mock.timers.tick(SSE_HEARTBEAT_MILLISECONDS);
  assert.equal(decodeFrame(await next), ': keep-alive\n\n');
  await reader.cancel();
  assert.doesNotThrow(() => t.mock.timers.tick(SSE_HEARTBEAT_MILLISECONDS * 100));
  assert.equal(values.unsubscribeCount(), 1);
});

test('이미 중단된 요청과 구독 등록 오류에도 요청 리스너를 남기지 않는다', async () => {
  const values = fixture();
  values.controller.abort();
  const reader = values.stream().getReader();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  assert.equal(values.unsubscribeCount(), 1);
  assert.equal(getEventListeners(values.controller.signal, 'abort').length, 0);
  const controller = new AbortController();
  assert.throws(() => createJobEventStream({
    manager: { subscribe: () => { throw new Error('구독 거절'); } }, id: 'job-id', signal: controller.signal,
  }), /구독 거절/u);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
