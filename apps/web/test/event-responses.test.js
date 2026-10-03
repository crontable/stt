import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createEventResponseTracker } from '../src/server/event-responses.js';

const EVENTS_URL = '/api/transcriptions/00000000-0000-0000-0000-000000000000/events';

function fixture(t) {
  const requestChannel = channel(`stt.test.event-responses.${randomUUID()}`);
  const tracker = createEventResponseTracker({ requestChannel });
  t.after(() => tracker.close());
  const publish = (response, url = EVENTS_URL, method = 'GET') => requestChannel.publish({ request: { url, method }, response });
  return { tracker, requestChannel, publish };
}

function responseFixture(options = {}) {
  const response = new EventEmitter();
  let destroyed = 0;
  Object.assign(response, {
    destroy: () => {
      destroyed += 1;
      response.emit('close');
      options.onDestroy?.();
    },
  });
  return { response, destroyed: () => destroyed };
}

test('SSE GET 응답만 추적하고 응답 완료와 연결 중단에 자신의 리스너를 해제한다', (t) => {
  const { publish, tracker } = fixture(t);
  const completed = responseFixture();
  const disconnected = responseFixture();
  const unrelated = responseFixture();
  publish(completed.response, `${EVENTS_URL}?조회=1`);
  publish(disconnected.response);
  publish(unrelated.response, '/api/health');
  publish(unrelated.response, EVENTS_URL, 'POST');
  assert.equal(completed.response.listenerCount('finish'), 1);
  assert.equal(disconnected.response.listenerCount('close'), 1);
  assert.equal(unrelated.response.listenerCount('close'), 0);
  completed.response.emit('finish');
  disconnected.response.emit('close');
  assert.equal(completed.response.listenerCount('close'), 0);
  assert.equal(disconnected.response.listenerCount('finish'), 0);
  tracker.close();
  assert.deepEqual([completed.destroyed(), disconnected.destroyed(), unrelated.destroyed()], [0, 0, 0]);
});

test('서버 종료는 자신의 미완료 SSE 응답만 닫고 후속 503 응답을 가로채지 않는다', (t) => {
  const { publish, tracker, requestChannel } = fixture(t);
  const active = responseFixture();
  const unrelated = responseFixture();
  const rejected = responseFixture();
  publish(active.response);
  publish(active.response);
  publish(unrelated.response, '/api/transcriptions/00000000-0000-0000-0000-000000000000/result');
  assert.equal(active.response.listenerCount('close'), 1);
  assert.equal(requestChannel.hasSubscribers, true);
  tracker.close();
  tracker.close();
  assert.equal(active.destroyed(), 1);
  assert.equal(unrelated.destroyed(), 0);
  assert.equal(active.response.listenerCount('close'), 0);
  assert.equal(requestChannel.hasSubscribers, false);
  publish(rejected.response);
  assert.equal(rejected.destroyed(), 0);
  assert.equal(rejected.response.listenerCount('close'), 0);
});

test('진단 콜백과 한 응답의 종료 오류가 다른 응답의 정리를 막지 않는다', (t) => {
  const { publish, tracker, requestChannel } = fixture(t);
  const broken = responseFixture({ onDestroy: () => { throw new Error('종료 오류'); } });
  const active = responseFixture();
  const request = Object.defineProperty({}, 'method', { get: () => { throw new Error('요청 조회 오류'); } });
  assert.doesNotThrow(() => requestChannel.publish({ request, response: broken.response }));
  publish(broken.response);
  publish(active.response);
  assert.doesNotThrow(() => tracker.close());
  assert.equal(broken.destroyed(), 1);
  assert.equal(active.destroyed(), 1);
});

test('읽기 스트림 오류가 진행 중 HTTP 쓰기를 기다려도 종료 시 응답을 직접 닫는다', async (t) => {
  const { publish, tracker } = fixture(t);
  let endWrite;
  let beginWrite;
  let controller;
  let writerAborted = false;
  const writing = new Promise((resolve) => { beginWrite = resolve; });
  const writeWait = new Promise((resolve) => { endWrite = resolve; });
  const active = responseFixture({ onDestroy: () => endWrite() });
  publish(active.response);
  const body = new ReadableStream({ start(value) { controller = value; value.enqueue(new Uint8Array(6 * 1024 * 1024)); } });
  const writer = new WritableStream({
    write: async () => { beginWrite(); await writeWait; },
    abort: () => { writerAborted = true; },
  });
  const piping = body.pipeTo(writer);
  await writing;
  controller.error(new DOMException('서버 종료', 'AbortError'));
  assert.equal(writerAborted, false);
  tracker.close();
  assert.equal(active.destroyed(), 1);
  await assert.rejects(piping, { name: 'AbortError' });
  assert.equal(writerAborted, true);
});
