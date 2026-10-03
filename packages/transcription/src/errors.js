function createExecutionError(code, message, details = {}) {
  return Object.assign(new Error(message), { ...details, code });
}

function createAbortError() {
  return createExecutionError('STT_ABORTED', '전사 작업이 취소되었습니다.');
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 오류 생성 함수를 한 번 등록합니다.
module.exports = { createExecutionError, createAbortError };
