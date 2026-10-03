const ERROR_MESSAGES = {
  STT_INVALID_NAME: '파일 이름이 비어 있거나 사용할 수 없는 문자가 있습니다.',
  STT_UNSUPPORTED_FORMAT: '지원하는 음성 또는 영상 파일을 선택해 주세요.',
  STT_INVALID_BODY: '파일 내용을 바이너리 형식으로 보내 주세요.',
  STT_EMPTY_UPLOAD: '내용이 없는 파일은 전사할 수 없습니다.',
  STT_UPLOAD_TOO_LARGE: '파일 크기가 512MiB 상한을 넘었습니다.',
  STT_WEB_BUSY: '다른 웹 작업이 진행 중입니다. 작업이 끝난 뒤 다시 시작해 주세요.',
  STT_WEB_SHUTTING_DOWN: '서버가 종료 중입니다. 서버를 다시 실행한 뒤 이용해 주세요.',
  STT_INVALID_ID: '작업 식별자의 형식이 올바르지 않습니다.',
  STT_JOB_NOT_FOUND: '작업을 찾을 수 없습니다. 서버가 재시작되면 이전 작업은 조회할 수 없습니다.',
  STT_RESULT_NOT_READY: '성공한 작업의 결과만 내려받을 수 있습니다.',
  STT_RESULT_UNAVAILABLE: '저장된 결과를 읽지 못했습니다. 서버의 결과 파일을 확인해 주세요.',
  STT_ABORTED: '작업을 취소했습니다.',
  STT_RESOURCE_BUSY: '다른 전사가 같은 자원을 사용 중입니다. 해당 작업이 끝난 뒤 다시 시작해 주세요.',
  STT_ENGINE_UNAVAILABLE: '음성 인식 엔진을 준비하지 못했습니다. 서버의 엔진 설치 상태를 확인해 주세요.',
  STT_MODEL_PREPARATION_FAILED: '음성 인식 모델을 준비하지 못했습니다. 서버의 모델과 네트워크 상태를 확인해 주세요.',
  STT_TRANSCRIPTION_FAILED: '음성을 전사하지 못했습니다. 파일 상태와 서버 기록을 확인해 주세요.',
  STT_PROCESS_CLEANUP_FAILED: '하위 프로세스 종료를 확인하지 못했습니다. 운영자가 종료 상태를 확인할 때까지 새 작업을 시작할 수 없습니다.',
  STT_UPLOAD_CLEANUP_FAILED: '업로드 자료를 정리하지 못했습니다. 운영자가 서버의 파일 상태를 확인해야 합니다.',
  STT_UPLOAD_FAILED: '파일을 저장하지 못했습니다. 서버의 저장 공간과 연결 상태를 확인해 주세요.',
  STT_WEB_FAILED: '요청을 처리하지 못했습니다. 서버 기록을 확인해 주세요.',
};

export function createWebError(code, status, cause) {
  return Object.assign(new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES.STT_WEB_FAILED), {
    code,
    status: status || 500,
    cause,
  });
}

export function publicError(error, fallback = 'STT_WEB_FAILED') {
  const code = Object.hasOwn(ERROR_MESSAGES, error?.code) ? error.code : fallback;
  return { code, message: ERROR_MESSAGES[code] };
}

export function jsonResponse(value, status = 200, headers = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function errorResponse(error) {
  const headers = ['STT_ABORTED', 'STT_WEB_SHUTTING_DOWN'].includes(error.code) ? { Connection: 'close' } : {};
  return jsonResponse({ error: publicError(error) }, error.status || 500, headers);
}

export function validateJobId(id) {
  const valid = typeof id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id);
  if (!valid) {
    throw createWebError('STT_INVALID_ID', 400);
  }
  return id;
}
