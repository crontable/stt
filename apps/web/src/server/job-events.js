import { createSegmentParser } from './segment-parser.js';

export const MAX_INTERMEDIATE_TEXT_BYTES = 16 * 1024 * 1024;
export const REPLAY_EVENT_LIMIT = 1000;
export const MAX_SUBSCRIBER_QUEUE_BYTES = 1024 * 1024;
const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];
const STREAM_LIMIT_NOTICE = '중간 표시의 보관 상한에 도달했습니다. 전체 전사는 계속하며 완료한 텍스트 파일로 전체 결과를 제공합니다.';

export function formatJobEvent({ type, data }) {
  return `id: ${data.seq}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function closeSubscriber(subscribers, key, reason) {
  const subscriber = subscribers.get(key);
  subscribers.delete(key);
  try {
    subscriber?.onClose(reason);
  } catch {
    // 브라우저의 전송·종료 오류는 전사 실행기의 오류로 전달하지 않습니다.
  }
}

function deliver(subscribers, key, event) {
  try {
    subscribers.get(key)?.onEvent(event);
  } catch {
    closeSubscriber(subscribers, key, 'error');
  }
}

function finishSubscriber(subscribers, key) {
  try {
    subscribers.get(key)?.onClose('terminal');
  } catch {
    closeSubscriber(subscribers, key, 'error');
  }
}

function validReplayPosition(lastEventId, sequence, events) {
  const valid = typeof lastEventId === 'string' && /^\d+$/u.test(lastEventId);
  const value = valid ? Number(lastEventId) : NaN;
  const firstSequence = events[0]?.data.seq ?? sequence + 1;
  return Number.isSafeInteger(value) && value <= sequence && value >= firstSequence - 1 ? value : null;
}

function initialEvents({ lastEventId, sequence, events, job, segments }) {
  const terminal = TERMINAL_STATUSES.includes(job.status);
  const position = terminal ? null : validReplayPosition(lastEventId, sequence, events);
  if (position !== null) {
    const replay = events.filter((event) => event.data.seq > position);
    const bytes = replay.reduce((total, event) => total + Buffer.byteLength(formatJobEvent(event), 'utf8'), 0);
    if (bytes <= MAX_SUBSCRIBER_QUEUE_BYTES) {
      return replay;
    }
  }
  const snapshot = { type: 'snapshot', data: { job, segments, seq: sequence } };
  return terminal ? [snapshot, { type: 'terminal', data: { job, seq: sequence } }] : [snapshot];
}

export function createJobEvents({ getJob, onLimit, maximumTextBytes = MAX_INTERMEDIATE_TEXT_BYTES, replayLimit = REPLAY_EVENT_LIMIT }) {
  const subscribers = new Map();
  const segmentMap = new Map();
  let sequence = 0;
  let events = [];
  let textBytes = 0;
  let limited = false;
  const publish = (type, data) => {
    sequence += 1;
    const event = { type, data: { ...data, seq: sequence } };
    events = [...events, event].slice(-replayLimit);
    [...subscribers.keys()].forEach((key) => deliver(subscribers, key, event));
  };
  const appendSegment = (segment) => {
    if (limited) {
      return;
    }
    const additionalBytes = Buffer.byteLength(segment.text, 'utf8');
    if (textBytes + additionalBytes > maximumTextBytes) {
      limited = true;
      onLimit(STREAM_LIMIT_NOTICE);
      return;
    }
    textBytes += additionalBytes;
    // 엔진의 원출력은 시간과 문장이 같아도 각 구간을 발생 순서대로 보존합니다.
    segmentMap.set(segmentMap.size, segment);
    publish('segment', { jobId: getJob().id, ...segment });
  };
  const parser = createSegmentParser({ onSegment: appendSegment });
  const closeSubscribers = (reason) => {
    [...subscribers.keys()].forEach((key) => closeSubscriber(subscribers, key, reason));
  };
  return {
    log: (event) => parser.push(event),
    flush: () => parser.flush(),
    state: (job) => publish('state', { job }),
    terminal: (job) => {
      publish('terminal', { job });
      // 느린 최종 응답도 서버 종료 때 닫을 수 있도록 실제 전송 종료까지 구독을 유지합니다.
      [...subscribers.keys()].forEach((key) => finishSubscriber(subscribers, key));
    },
    close: (reason = 'shutdown') => closeSubscribers(reason),
    subscribe: ({ lastEventId, onEvent, onClose = () => {} }) => {
      const key = Symbol('subscription');
      const job = getJob();
      const initial = initialEvents({ lastEventId, sequence, events, job, segments: [...segmentMap.values()] });
      // 등록과 초기 전송 사이에 비동기 대기를 두지 않아 현재 순번과 누적 상태를 함께 제공합니다.
      subscribers.set(key, { onEvent, onClose });
      initial.forEach((event) => deliver(subscribers, key, event));
      if (TERMINAL_STATUSES.includes(job.status)) {
        finishSubscriber(subscribers, key);
      }
      return () => { subscribers.delete(key); };
    },
  };
}
