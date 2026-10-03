import assert from 'node:assert/strict';
import test from 'node:test';

import { createSegmentParser, MAX_UNFINISHED_LINE_BYTES, parseSegmentLine } from '../src/server/segment-parser.js';

test('한국어 구간과 줄바꿈을 여러 출력 조각에서 이어 읽는다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment) });
  parser.push({ stream: 'stdout', text: '[00:00:01.230 --> 00:00:02.450] 안녕' });
  parser.push({ stream: 'stdout', text: '하세요.\r\n[01:02:03.004 --> 01:02:04.005] 다음 문장\n' });
  assert.deepEqual(segments, [
    { startMs: 1230, endMs: 2450, text: '안녕하세요.' },
    { startMs: 3723004, endMs: 3724005, text: '다음 문장' },
  ]);
});

test('엔진 안내와 표준 오류 및 잘못된 시간과 빈 구간을 제외한다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment) });
  parser.push({ stream: 'stderr', text: '[00:00:00.000 --> 00:00:01.000] 오류 출력\n' });
  parser.push({ stream: 'stdout', text: [
    'whisper: 모델 준비',
    '[00:60:00.000 --> 00:60:01.000] 잘못된 분',
    '[00:00:02.000 --> 00:00:01.000] 뒤집힌 시간',
    '[00:00:00.000 --> 00:00:01.000]  ',
    '[00:00:00.000 --> 00:00:01.000] 제어\u0000문자',
    '[00:00:00.000 --> 00:00:01.000] 정상',
    '',
  ].join('\n') });
  assert.deepEqual(segments, [{ startMs: 0, endMs: 1000, text: '정상' }]);
  assert.equal(parseSegmentLine('[9999999999999:00:00.000 --> 9999999999999:00:01.000] 시간'), null);
});

test('출력이 끝나면 줄바꿈 없는 마지막 구간을 한 번 확정한다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment) });
  parser.push({ stream: 'stdout', text: '[00:00:00.000 --> 00:00:01.000] 마지막 문장' });
  assert.deepEqual(segments, []);
  parser.flush();
  parser.flush();
  assert.deepEqual(segments, [{ startMs: 0, endMs: 1000, text: '마지막 문장' }]);
});

test('미완성 줄 상한을 넘으면 그 줄을 버리고 다음 구간부터 다시 읽는다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment) });
  parser.push({ stream: 'stdout', text: '가'.repeat(Math.ceil(MAX_UNFINISHED_LINE_BYTES / 3)) });
  parser.push({ stream: 'stdout', text: '[00:00:00.000 --> 00:00:01.000] 같은 줄의 잔여 내용\n[00:00:01.000 --> 00:00:02.000] 복구\n' });
  assert.deepEqual(segments, [{ startMs: 1000, endMs: 2000, text: '복구' }]);
});

test('줄 상한은 한국어 UTF-8 바이트로 계산하고 초과한 완성 줄도 제외한다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment), maximumLineBytes: 40 });
  parser.push({ stream: 'stdout', text: '[00:00:00.000 --> 00:00:01.000] 가나다라마바\n[00:00:01.000 --> 00:00:02.000] 짧음\n' });
  assert.deepEqual(segments, [{ startMs: 1000, endMs: 2000, text: '짧음' }]);
});

test('같은 시작과 끝의 반복 원출력은 보존하고 조각난 Stdout 재출력 표식 뒤를 제외한다', () => {
  const segments = [];
  const parser = createSegmentParser({ onSegment: (segment) => segments.push(segment) });
  const line = '[00:02:42.820 --> 00:02:42.820] 반복되는 한국어 문장\n';
  parser.push({ stream: 'stdout', text: line + line });
  parser.push({ stream: 'stdout', text: 'Std' });
  parser.push({ stream: 'stdout', text: `out: ${line}` });
  parser.push({ stream: 'stdout', text: line });
  parser.flush();
  assert.deepEqual(segments, [
    { startMs: 162820, endMs: 162820, text: '반복되는 한국어 문장' },
    { startMs: 162820, endMs: 162820, text: '반복되는 한국어 문장' },
  ]);
});
