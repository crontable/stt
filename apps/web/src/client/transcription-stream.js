const FINAL_STATUSES = ['succeeded', 'failed', 'cancelled'];

function validSegment(segment) {
  return segment && typeof segment.text === 'string'
    && Number.isFinite(segment.startMs) && segment.startMs >= 0
    && Number.isFinite(segment.endMs) && segment.endMs >= segment.startMs;
}

export function readTranscriptionEvent(type, data, jobId) {
  const value = JSON.parse(data);
  const receivedId = type === 'segment' ? value.jobId : value.job?.id;
  if (receivedId !== jobId) {
    return null;
  }
  const validations = [
    { violated: !Number.isSafeInteger(value.seq) || value.seq < 0 },
    { violated: type === 'segment' && !validSegment(value) },
    { violated: type === 'snapshot' && (!Array.isArray(value.segments) || !value.segments.every(validSegment)) },
    { violated: type === 'terminal' && !FINAL_STATUSES.includes(value.job.status) },
  ];
  if (validations.find(({ violated }) => violated)) {
    throw new Error('전사 이벤트의 내용을 읽지 못했습니다. 같은 작업을 다시 조회해 주세요.');
  }
  return { ...value, type };
}

export function createTranscript(jobId) {
  return { jobId, seq: -1, job: null, text: '' };
}

export function updateTranscript(transcript, event) {
  const eventJobId = event.type === 'segment' ? event.jobId : event.job.id;
  if (eventJobId !== transcript.jobId || event.seq <= transcript.seq) {
    return transcript;
  }
  const changes = {
    snapshot: () => ({ job: event.job, text: event.segments.map(({ text }) => text).join('\n') }),
    state: () => ({ job: event.job }),
    segment: () => ({ text: [transcript.text, event.text].filter(Boolean).join('\n') }),
    terminal: () => ({ job: event.job }),
  };
  return { ...transcript, ...changes[event.type](), seq: event.seq };
}

export function isFinalJob(job) {
  return FINAL_STATUSES.includes(job?.status);
}

const EVENT_TYPES = ['snapshot', 'state', 'segment', 'terminal'];

async function loadFinalResult(job, context) {
  if (job.status !== 'succeeded') {
    return;
  }
  context.callbacks.onResultLoading();
  try {
    const result = await context.loadResult(job.resultUrl, context.controller.signal);
    if (context.current()) {
      context.callbacks.onResult(job.id, result);
    }
  } catch (error) {
    if (context.current()) {
      context.callbacks.onError(context.formatError(error, '저장된 결과를 읽지 못했습니다. 같은 작업을 다시 조회해 주세요.'));
    }
  }
}

async function diagnoseClosedConnection(jobId, context) {
  try {
    const job = await context.loadJob(`/api/transcriptions/${encodeURIComponent(jobId)}`, { signal: context.controller.signal });
    if (!context.current()) {
      return;
    }
    context.callbacks.onJob(job);
    if (isFinalJob(job)) {
      await loadFinalResult(job, context);
      return;
    }
    context.callbacks.onError('전사 연결이 종료됐습니다. 같은 작업을 다시 조회해 주세요.');
  } catch (error) {
    if (context.current()) {
      context.callbacks.onError(context.formatError(error, '전사 연결을 확인하지 못했습니다. 서버 연결을 확인하고 같은 작업을 다시 조회해 주세요.'));
    }
  }
}

export function subscribeTranscription(jobId, callbacks, options = {}) {
  const controller = new AbortController();
  const eventsUrl = options.eventsUrl ?? `/api/transcriptions/${encodeURIComponent(jobId)}/events`;
  const source = (options.createSource ?? ((url) => new EventSource(url)))(eventsUrl);
  let transcript = createTranscript(jobId);
  let disposed = false;
  let finished = false;
  let diagnosed = false;
  const current = () => !disposed && !controller.signal.aborted && (options.isCurrent?.() ?? true);
  const context = {
    callbacks, controller, current,
    loadJob: options.loadJob,
    loadResult: options.loadResult,
    formatError: options.formatError ?? ((error, fallback) => fallback),
  };

  async function receive(type, message) {
    if (!current() || finished) {
      return;
    }
    try {
      const event = readTranscriptionEvent(type, message.data, jobId);
      if (!event) {
        return;
      }
      const next = updateTranscript(transcript, event);
      if (next === transcript) {
        return;
      }
      transcript = next;
      callbacks.onUpdate(next);
      if (isFinalJob(next.job)) {
        finished = true;
        source.close();
        callbacks.onConnection('finished');
        await loadFinalResult(next.job, context);
      }
    } catch {
      if (current()) {
        finished = true;
        source.close();
        callbacks.onConnection('closed');
        callbacks.onError('전사 이벤트를 읽지 못했습니다. 같은 작업을 다시 조회해 주세요.');
      }
    }
  }

  function opened() {
    if (current() && !finished) {
      callbacks.onConnection('connected');
    }
  }

  async function disconnected() {
    if (!current() || finished) {
      return;
    }
    if (source.readyState !== 2) {
      callbacks.onConnection('reconnecting');
      return;
    }
    if (diagnosed) {
      return;
    }
    diagnosed = true;
    finished = true;
    source.close();
    callbacks.onConnection('closed');
    await diagnoseClosedConnection(jobId, context);
  }

  const listeners = EVENT_TYPES.map((type) => [type, (message) => receive(type, message)]);
  listeners.forEach(([type, listener]) => source.addEventListener(type, listener));
  source.addEventListener('open', opened);
  source.addEventListener('error', disconnected);
  callbacks.onConnection('connecting');
  return () => {
    disposed = true;
    controller.abort();
    source.close();
    listeners.forEach(([type, listener]) => source.removeEventListener(type, listener));
    source.removeEventListener('open', opened);
    source.removeEventListener('error', disconnected);
  };
}
