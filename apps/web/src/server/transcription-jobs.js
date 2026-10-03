import 'server-only';

import path from 'node:path';

import { createEventResponseTracker } from './event-responses.js';
import { createJobManager } from './job-manager.js';
import { runTranscription } from './transcription.js';

const MANAGER_KEY = Symbol.for('stt.web.transcription.manager');
const SIGNALS_KEY = Symbol.for('stt.web.transcription.signals');

export function getJobManager() {
  if (!globalThis[MANAGER_KEY]) {
    // 제공하는 pnpm 명령은 apps/web에서 실행하므로 모든 HTTP 모듈이 같은 루트를 사용합니다.
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    const manager = createJobManager({
      assetsDir: path.join(workspaceRoot, 'assets/web-jobs'),
      outputDir: path.join(workspaceRoot, 'output/web-jobs'),
      runner: runTranscription,
    });
    Object.defineProperty(globalThis, MANAGER_KEY, { value: manager });
  }
  return globalThis[MANAGER_KEY];
}

export function registerJobShutdown() {
  const manager = getJobManager();
  if (!globalThis[SIGNALS_KEY]) {
    const eventResponses = createEventResponseTracker();
    const shutdown = () => {
      eventResponses.close();
      manager.shutdown();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    Object.defineProperty(globalThis, SIGNALS_KEY, { value: true });
  }
}
