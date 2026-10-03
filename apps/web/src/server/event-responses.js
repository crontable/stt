import { channel } from 'node:diagnostics_channel';

const REQUEST_START_CHANNEL = channel('http.server.request.start');
const EVENTS_PATH = /^\/api\/transcriptions\/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\/events(?:\?.*)?$/iu;

export function createEventResponseTracker({ requestChannel = REQUEST_START_CHANNEL } = {}) {
  const responses = new Map();
  let closed = false;
  const observe = ({ request, response }) => {
    try {
      if (closed || request.method !== 'GET' || !EVENTS_PATH.test(request.url) || responses.has(response)) {
        return;
      }
      const release = () => {
        responses.delete(response);
        response.off('finish', release);
        response.off('close', release);
      };
      responses.set(response, release);
      response.once('finish', release);
      response.once('close', release);
    } catch {
      // 진단 채널의 콜백 오류가 HTTP 요청이나 음성 전사를 중단하지 않도록 분리합니다.
    }
  };
  requestChannel.subscribe(observe);
  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      requestChannel.unsubscribe(observe);
      [...responses.entries()].forEach(([response, release]) => {
        release();
        try {
          // 읽기 큐가 닫혀도 HTTP 쓰기는 drain을 기다릴 수 있으므로 응답의 소켓까지 닫습니다.
          response.destroy();
        } catch {
          // 한 연결의 종료 오류가 나머지 SSE 연결과 전사 정리를 막지 않도록 분리합니다.
        }
      });
    },
  };
}
