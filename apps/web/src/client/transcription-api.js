export class ApiResponseError extends Error {}

async function responseError(response) {
  try {
    const body = await response.json();
    return body.error?.message ?? '서버가 요청을 처리하지 못했습니다. 잠시 후 다시 확인해 주세요.';
  } catch {
    return '서버 응답을 읽지 못했습니다. 연결 상태를 확인해 주세요.';
  }
}

export async function requestJob(url, options) {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  if (!response.ok) {
    throw new ApiResponseError(await responseError(response));
  }
  return response.json();
}

export async function requestResult(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal });
  if (!response.ok) {
    throw new ApiResponseError(await responseError(response));
  }
  return response.text();
}

export function connectionError(error, fallback) {
  return error instanceof ApiResponseError ? error.message : fallback;
}
