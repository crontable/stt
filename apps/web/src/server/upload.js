import { open } from 'node:fs/promises';
import path from 'node:path';

import { createWebError } from './responses.js';

export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.mp4', '.avi', '.mov'];

function validateLength(request, maximumBytes) {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximumBytes)) {
    throw createWebError('STT_UPLOAD_TOO_LARGE', 413);
  }
}

function validateBody(request) {
  const contentType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/octet-stream' || !request.body) {
    throw createWebError('STT_INVALID_BODY', 400);
  }
}

export function uploadDetails(request, maximumBytes = MAX_UPLOAD_BYTES) {
  const name = new URL(request.url).searchParams.get('name');
  const invalidName = [!name?.trim(), /[\\/]/u.test(name || ''), /\p{Cc}/u.test(name || '')].some(Boolean);
  if (invalidName) {
    throw createWebError('STT_INVALID_NAME', 400);
  }
  const extension = path.extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(extension)) {
    throw createWebError('STT_UNSUPPORTED_FORMAT', 415);
  }
  validateBody(request);
  validateLength(request, maximumBytes);
  return { name, extension };
}

function assertNotAborted(signal) {
  if (signal.aborted) {
    throw createWebError('STT_ABORTED', 400);
  }
}

async function cancelUploadSource(body) {
  try {
    await body.cancel();
  } catch {
    // 연결이 이미 끊겨도 부분 파일 정리와 취소 상태는 유지합니다.
  }
}

export async function saveUpload({ request, inputPath, signal, maximumBytes, onSourceCleanup = () => {} }) {
  assertNotAborted(signal);
  const handle = await open(inputPath, 'wx');
  let receivedBytes = 0;
  const destination = new WritableStream({
    async write(chunk) {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maximumBytes) {
        return;
      }
      await handle.writeFile(chunk);
    },
  });
  try {
    // 상한을 넘으면 디스크 쓰기를 멈추고 남은 입력을 버려 HTTP 요청을 끝낸 뒤 413을 보냅니다.
    // 쓰기 또는 버리기가 끝난 뒤 다음 조각을 받아 전체 파일을 메모리에 모으지 않습니다.
    await request.body.pipeTo(destination, { preventCancel: true, signal });
    assertNotAborted(signal);
    if (receivedBytes > maximumBytes) {
      throw createWebError('STT_UPLOAD_TOO_LARGE', 413);
    }
    if (!receivedBytes) {
      throw createWebError('STT_EMPTY_UPLOAD', 400);
    }
    return receivedBytes;
  } catch (error) {
    if (signal.aborted) {
      // 미완료 Node HTTP 입력의 취소 Promise는 연결을 닫아도 끝나지 않을 수 있습니다.
      // 취소를 시작하고 Connection:close 응답 뒤 after 경계에서 입력 정리를 마칩니다.
      cancelUploadSource(request.body);
      onSourceCleanup();
    }
    assertNotAborted(signal);
    throw error.status ? error : createWebError('STT_UPLOAD_FAILED', 500, error);
  } finally {
    await handle.close();
  }
}
