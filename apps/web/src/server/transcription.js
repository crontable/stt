import 'server-only';

import path from 'node:path';

// Next의 소스 변환을 거치지 않고 원래 CommonJS 파일과 작업 프로세스 경로를 유지합니다.
const { createRequire } = process.getBuiltinModule('node:module');
const requireFromWeb = createRequire(path.join(process.cwd(), 'package.json'));
const { runTranscription } = requireFromWeb('@stt/transcription');

export { runTranscription };
