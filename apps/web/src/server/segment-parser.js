const TIMESTAMP_LINE = /^\s*\[(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})\s*-->\s*(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})\]\s*(.*?)\s*$/u;

export const MAX_UNFINISHED_LINE_BYTES = 64 * 1024;

function milliseconds(values) {
  const [hours, minutes, seconds, remainder] = values.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + remainder;
}

export function parseSegmentLine(line) {
  const match = TIMESTAMP_LINE.exec(line);
  if (!match) {
    return null;
  }
  const startMs = milliseconds(match.slice(1, 5));
  const endMs = milliseconds(match.slice(5, 9));
  const text = match[9].trim();
  const invalid = [
    !Number.isSafeInteger(startMs),
    !Number.isSafeInteger(endMs),
    endMs < startMs,
    !text,
    /\p{Cc}/u.test(text),
  ].some(Boolean);
  return invalid ? null : { startMs, endMs, text };
}

export function createSegmentParser({ onSegment, maximumLineBytes = MAX_UNFINISHED_LINE_BYTES }) {
  let pending = '';
  let discarding = false;
  let replaying = false;
  const consumeLine = (line, complete) => {
    if (replaying) {
      return;
    }
    if (discarding) {
      discarding = !complete;
      return;
    }
    const combined = pending + line;
    pending = '';
    // 단일 파일 실행 뒤 라이브러리가 stdout 전체를 다시 출력하는 블록은 제외합니다.
    if (combined.startsWith('Stdout:')) {
      replaying = true;
      return;
    }
    if (Buffer.byteLength(combined, 'utf8') > maximumLineBytes) {
      discarding = !complete;
      return;
    }
    if (complete) {
      const segment = parseSegmentLine(combined);
      if (segment) {
        onSegment(segment);
      }
    } else {
      pending = combined;
    }
  };
  return {
    push: ({ stream, text }) => {
      if (stream !== 'stdout' || typeof text !== 'string') {
        return;
      }
      const lines = text.split('\n');
      lines.forEach((line, index) => consumeLine(line, index < lines.length - 1));
    },
    flush: () => {
      consumeLine('', true);
      pending = '';
      discarding = false;
    },
  };
}
