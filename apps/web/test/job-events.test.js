import assert from 'node:assert/strict';
import test from 'node:test';

import { createJobEvents, formatJobEvent, MAX_SUBSCRIBER_QUEUE_BYTES } from '../src/server/job-events.js';

function fixture(options = {}) {
  const job = new Map([['value', { id: 'job-id', status: 'running', stage: 'transcribing', streamNotice: null }]]);
  const notices = [];
  const events = createJobEvents({ getJob: () => job.get('value'), onLimit: (notice) => notices.push(notice), ...options });
  return { events, notices, job };
}

function collect(events, options = {}) {
  const received = [];
  const reasons = [];
  const unsubscribe = events.subscribe({ onEvent: (event) => received.push(event), onClose: (reason) => reasons.push(reason), ...options });
  return { received, reasons, unsubscribe };
}

function log(events, text, start = '00:00:00.000', end = '00:00:01.000') {
  events.log({ stream: 'stdout', text: `[${start} --> ${end}] ${text}\n` });
}

test('같은 시간과 문장의 엔진 구간도 각각 보존하고 라이브러리 재출력 블록만 제외한다', () => {
  const { events } = fixture();
  const { received } = collect(events);
  log(events, '한국어 문장');
  log(events, '다음 문장', '00:00:01.000', '00:00:02.000');
  log(events, '한국어 문장', '00:00:02.000', '00:00:03.000');
  log(events, '한국어 문장', '00:00:02.000', '00:00:03.000');
  events.log({ stream: 'stdout', text: 'Stdout: [00:00:00.000 --> 00:00:01.000] 한국어 문장\n[00:00:01.000 --> 00:00:02.000] 다음 문장\n[00:00:02.000 --> 00:00:03.000] 한국어 문장\n[00:00:02.000 --> 00:00:03.000] 한국어 문장\n' });
  assert.deepEqual(received.filter(({ type }) => type === 'segment').map(({ data }) => [data.seq, data.startMs, data.text]), [
    [1, 0, '한국어 문장'], [2, 1000, '다음 문장'], [3, 2000, '한국어 문장'], [4, 2000, '한국어 문장'],
  ]);
  assert.deepEqual(collect(events).received[0].data.segments.map(({ text }) => text), ['한국어 문장', '다음 문장', '한국어 문장', '한국어 문장']);
});

test('상태와 구간은 한 순번을 공유하고 유효한 마지막 순번 뒤만 다시 전송한다', () => {
  const { events, job } = fixture();
  events.state(job.get('value'));
  log(events, '첫 구간');
  events.state({ ...job.get('value'), stage: 'cleaning' });
  const replay = collect(events, { lastEventId: '1' }).received;
  assert.deepEqual(replay.map(({ type, data }) => [type, data.seq]), [['segment', 2], ['state', 3]]);
  assert.deepEqual(collect(events, { lastEventId: '3' }).received, []);
  assert.match(formatJobEvent(replay[0]), /^id: 2\nevent: segment\ndata: /u);
});

test('최근 기록 범위를 벗어나거나 잘못된 순번은 누적 스냅샷으로 복구한다', () => {
  const { events } = fixture({ replayLimit: 2 });
  ['첫째', '둘째', '셋째'].forEach((text, index) => log(events, text, `00:00:0${index}.000`, `00:00:0${index + 1}.000`));
  ['0', '-1', '4', 'x', '9007199254740992', undefined].forEach((lastEventId) => {
    const received = collect(events, { lastEventId }).received;
    assert.equal(received.length, 1);
    assert.equal(received[0].type, 'snapshot');
    assert.equal(received[0].data.seq, 3);
    assert.equal(received[0].data.segments.length, 3);
  });
  assert.deepEqual(collect(events, { lastEventId: '1' }).received.map(({ data }) => data.seq), [2, 3]);
});

test('재전송 프레임 합계가 대기 상한을 넘으면 큰 초기 스냅샷 한 번으로 복구한다', () => {
  const { events } = fixture();
  Array.from({ length: 24 }, (_, index) => index).forEach((index) => {
    log(events, '가'.repeat(15000), `00:00:${String(index).padStart(2, '0')}.000`, `00:00:${String(index + 1).padStart(2, '0')}.000`);
  });
  const received = collect(events, { lastEventId: '0' }).received;
  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'snapshot');
  assert.equal(received[0].data.segments.length, 24);
  assert.ok(Buffer.byteLength(formatJobEvent(received[0]), 'utf8') > MAX_SUBSCRIBER_QUEUE_BYTES);
});

test('중간 한국어 텍스트 상한을 넘으면 한 번 안내하고 이후 구간 보관을 멈춘다', () => {
  const { events, notices } = fixture({ maximumTextBytes: 6 });
  log(events, '가나');
  log(events, '다', '00:00:01.000', '00:00:02.000');
  log(events, '라', '00:00:02.000', '00:00:03.000');
  assert.equal(notices.length, 1);
  assert.match(notices[0], /전체 전사는 계속/u);
  assert.deepEqual(collect(events).received[0].data.segments, [{ startMs: 0, endMs: 1000, text: '가나' }]);
});

test('전송과 종료 콜백 오류는 다른 구독과 음성 구간 처리를 막지 않는다', () => {
  const { events } = fixture();
  const reasons = [];
  events.subscribe({ onEvent: () => { throw new Error('전송 오류'); }, onClose: (reason) => { reasons.push(reason); throw new Error('닫기 오류'); } });
  const active = collect(events);
  assert.doesNotThrow(() => log(events, '전사는 계속'));
  assert.deepEqual(reasons, ['error']);
  assert.equal(active.received.at(-1).type, 'segment');
  assert.doesNotThrow(() => events.close());
  assert.deepEqual(active.reasons, ['shutdown']);
});

test('완료한 작업은 현재 누적 스냅샷과 같은 순번의 종료를 보내고 종료까지 구독을 유지한다', () => {
  const { events, job } = fixture();
  log(events, '완료 전 구간');
  const terminal = { ...job.get('value'), status: 'succeeded', stage: 'complete' };
  job.set('value', terminal);
  events.terminal(terminal);
  const active = collect(events, { lastEventId: '0' });
  assert.deepEqual(active.received.map(({ type, data }) => [type, data.seq]), [['snapshot', 2], ['terminal', 2]]);
  assert.deepEqual(active.reasons, ['terminal']);
  events.close();
  assert.deepEqual(active.reasons, ['terminal', 'shutdown']);
  active.unsubscribe();
});

test('구독 해제는 그 구독만 닫고 같은 작업의 후속 구간과 새 구독을 유지한다', () => {
  const { events } = fixture();
  const first = collect(events);
  first.unsubscribe();
  log(events, '다시 연결');
  assert.equal(first.received.length, 1);
  assert.deepEqual(collect(events).received[0].data.segments, [{ startMs: 0, endMs: 1000, text: '다시 연결' }]);
});
