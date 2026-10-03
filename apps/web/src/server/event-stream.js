import { formatJobEvent, MAX_SUBSCRIBER_QUEUE_BYTES } from './job-events.js';

export const SSE_HEARTBEAT_MILLISECONDS = 15 * 1000;

function createFrameQueue({ maximumQueueBytes, onOverflow, onEnded }) {
  let controller;
  let frames = [];
  let queuedBytes = 0;
  let waiting = false;
  let ended = false;
  let closed = false;
  let initialSnapshotAllowed = true;
  const flush = () => {
    if (closed) {
      return;
    }
    if (waiting && frames.length) {
      const [frame, ...remaining] = frames;
      frames = remaining;
      queuedBytes -= frame.initial ? 0 : frame.bytes.byteLength;
      waiting = false;
      try {
        controller.enqueue(frame.bytes);
      } catch {
        onOverflow('disconnect');
        return;
      }
    }
    if (ended && !frames.length) {
      closed = true;
      try {
        controller.close();
      } finally {
        onEnded();
      }
    }
  };
  const pushFrame = (bytes, initial = false) => {
    if (closed || ended) {
      return;
    }
    if (!initial && queuedBytes + bytes.byteLength > maximumQueueBytes) {
      onOverflow('overflow');
      return;
    }
    queuedBytes += initial ? 0 : bytes.byteLength;
    frames = [...frames, { bytes, initial }];
    flush();
  };
  return {
    start: (value) => { controller = value; },
    pull: () => { waiting = true; flush(); },
    push: (event) => {
      const initial = initialSnapshotAllowed && event.type === 'snapshot';
      initialSnapshotAllowed = false;
      pushFrame(Buffer.from(formatJobEvent(event), 'utf8'), initial);
    },
    heartbeat: () => pushFrame(Buffer.from(': keep-alive\n\n', 'utf8')),
    finish: (reason) => {
      if (closed) {
        return;
      }
      if (reason === 'terminal') {
        ended = true;
        flush();
        return;
      }
      closed = true;
      frames = [];
      queuedBytes = 0;
      if (reason !== 'cancel') {
        controller.error(new DOMException('전사 이벤트 연결을 닫았습니다.', 'AbortError'));
      }
    },
  };
}

export function createJobEventStream({ manager, id, lastEventId, signal, heartbeatMilliseconds = SSE_HEARTBEAT_MILLISECONDS, maximumQueueBytes = MAX_SUBSCRIBER_QUEUE_BYTES }) {
  let unsubscribe = () => {};
  let heartbeat;
  let closed = false;
  let finishing = false;
  let queue;
  let onAbort;
  const dispose = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', onAbort);
    unsubscribe();
  };
  const stop = (reason) => {
    if (closed) {
      return;
    }
    if (reason === 'terminal') {
      finishing = true;
      clearInterval(heartbeat);
      queue.finish(reason);
      return;
    }
    try {
      queue.finish(reason);
    } finally {
      dispose();
    }
  };
  onAbort = () => stop('disconnect');
  queue = createFrameQueue({ maximumQueueBytes, onOverflow: stop, onEnded: dispose });
  const stream = new ReadableStream({
    start: queue.start,
    pull: queue.pull,
    cancel: () => stop('cancel'),
  }, { highWaterMark: 0 });
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    // 동기 초기 알림에서 종료돼도 반환된 구독 해제 함수를 실행합니다.
    unsubscribe = manager.subscribe(id, { lastEventId, onEvent: queue.push, onClose: stop });
    if (closed) {
      unsubscribe();
    } else if (!finishing) {
      heartbeat = setInterval(queue.heartbeat, heartbeatMilliseconds);
      heartbeat.unref?.();
    }
    if (signal?.aborted) {
      stop('disconnect');
    }
    return stream;
  } catch (error) {
    stop('error');
    throw error;
  }
}
