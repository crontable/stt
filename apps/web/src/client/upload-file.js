import { ApiResponseError } from './transcription-api';

function parseUploadResponse(request) {
  const body = JSON.parse(request.responseText);
  if (request.status < 200 || request.status >= 300) {
    throw new ApiResponseError(body.error?.message ?? '서버가 파일을 접수하지 못했습니다. 잠시 후 다시 확인해 주세요.');
  }
  return body;
}

export function uploadFile(file, signal, onProgress) {
  // XHR의 전송량·종료 이벤트를 Promise 하나로 연결해 호출하는 쪽이 await로 기다리게 합니다.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;

    function finish(callback, value) {
      if (settled) {
        return;
      }
      settled = true;
      // eslint-disable-next-line no-use-before-define -- 종료 함수는 아래 중단 콜백과 서로 연결되며 모든 이벤트 등록 뒤에 실행됩니다.
      signal.removeEventListener('abort', abort);
      callback(value);
    }

    function abort() {
      request.abort();
      finish(reject, new DOMException('업로드를 취소했습니다.', 'AbortError'));
    }

    request.upload.addEventListener('progress', (event) => {
      if (!settled && !signal.aborted) {
        onProgress({ loaded: Math.min(event.loaded, file.size), total: file.size, sent: event.loaded >= file.size });
      }
    });
    request.upload.addEventListener('load', () => {
      if (!settled && !signal.aborted) {
        onProgress({ loaded: file.size, total: file.size, sent: true });
      }
    });
    request.addEventListener('load', () => {
      try {
        finish(resolve, parseUploadResponse(request));
      } catch (error) {
        finish(reject, error);
      }
    });
    request.addEventListener('error', () => finish(reject, new TypeError('파일 전송 중 연결이 끊겼습니다.')));
    request.addEventListener('abort', () => finish(reject, new DOMException('업로드를 취소했습니다.', 'AbortError')));
    request.open('POST', `/api/transcriptions?name=${encodeURIComponent(file.name)}`);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      request.send(file);
    } catch (error) {
      finish(reject, error);
    }
  });
}
