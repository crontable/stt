const fs = require('fs-extra');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');

const loadModule = Module._load;
const fixtureDirectory = process.env.STT_FIXTURE_DIRECTORY;
const engineDirectory = path.join(fixtureDirectory, 'engine');
const largeChecksum = 'ad82bf6a9043ceed055076d0fd39f5f186ff8062';

function fixtureHash(algorithm, ...options) {
  const hash = crypto.createHash(algorithm, ...options);
  if (algorithm === 'sha1' && process.env.STT_FIXTURE_VALID_LARGE === '1') {
    Object.defineProperty(hash, 'digest', { value: () => largeChecksum });
  }
  return hash;
}

async function holdProcessTree(key) {
  const child = spawn('/bin/sh', ['-c', '"$STT_FIXTURE_NODE" "$STT_FIXTURE_LEAF" & wait'], {
    env: {
      ...process.env,
      STT_FIXTURE_NODE: process.execPath,
      STT_FIXTURE_LEAF: path.join(__dirname, 'leaf.cjs'),
      STT_FIXTURE_LEAF_RECORD: path.join(fixtureDirectory, `leaf-${key}.json`),
    },
    stdio: 'ignore',
  });
  await fs.writeJson(path.join(fixtureDirectory, `shell-${key}.json`), { pid: child.pid });
  await new Promise(() => {});
}

async function nodewhisper(audioPath, options) {
  const input = JSON.parse(await fs.readFile(audioPath, 'utf8'));
  const key = input.key || 'recording';
  await fs.writeJson(path.join(fixtureDirectory, `engine-${key}.json`), {
    pid: process.pid,
    audioPath,
    options,
    cwd: process.cwd(),
    temporaryDirectory: process.env.TMPDIR,
  });
  process.stdout.write(`엔진 표준 출력 ${key}\n`);
  process.stderr.write(`엔진 오류 출력 ${key}\n`);
  process.chdir(engineDirectory);
  if (input.mode === 'pending') {
    Object.assign(process.env, { STT_FIXTURE_PENDING: key });
  }

  const actions = {
    block: () => holdProcessTree(key),
    reject: () => { throw new Error('모의 전사 엔진 실패'); },
    'exit-error': () => process.exit(7),
    'exit-empty': () => process.exit(0),
    success: async () => {
      await fs.remove(audioPath);
      await fs.writeFile(path.join(path.dirname(audioPath), 'source.wav.txt'), `${key} 한국어 전사\n`);
    },
  };
  await (actions[input.mode] || actions.success)();
}

async function outputFile(filePath, ...options) {
  await fs.outputFile(filePath, ...options);
  if (process.env.STT_FIXTURE_PENDING && path.basename(filePath).startsWith('.stt-')) {
    await fs.writeJson(path.join(fixtureDirectory, 'pending.json'), { filePath });
    await holdProcessTree(process.env.STT_FIXTURE_PENDING);
  }
}

async function readdir(directory, ...options) {
  if (process.env.STT_FIXTURE_FAIL_INPUT_LIST === '1' && directory === path.join(fixtureDirectory, 'assets')) {
    throw Object.assign(new Error('모의 입력 목록 읽기 실패'), { code: 'EACCES' });
  }
  return fs.readdir(directory, ...options);
}

function loadFixture(name, parent, isMain) {
  if (name === 'nodejs-whisper') {
    return { nodewhisper };
  }
  if (name === 'nodejs-whisper/dist/constants') {
    return {
      MODELS_LIST: ['base', 'tiny', 'large'],
      MODEL_OBJECT: { base: 'ggml-base.bin', tiny: 'ggml-tiny.bin', large: 'ggml-large.bin' },
      WHISPER_CPP_PATH: engineDirectory,
      WHISPER_CPP_MAIN_PATH: path.join(engineDirectory, 'build', 'bin', 'whisper-cli'),
    };
  }
  if (name === '@stt/transcription') {
    return loadModule.call(this, path.resolve(__dirname, '..', 'src'), parent, isMain);
  }
  if (name === 'node:crypto') {
    return { ...crypto, createHash: fixtureHash };
  }
  if (name === 'fs-extra') {
    return { ...fs, outputFile, readdir };
  }
  return loadModule.call(this, name, parent, isMain);
}

// eslint-disable-next-line no-restricted-syntax -- 별도 검사 프로세스에서만 전사 라이브러리와 모델 경로를 모의 구현으로 치환합니다.
Module._load = loadFixture;

if (process.env.STT_FIXTURE_SLOW_DOWNLOAD === '1') {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({
      ok: true,
      body: new ReadableStream({
        async pull(controller) {
          await new Promise((resolve) => { setTimeout(resolve, 100); });
          controller.enqueue(new Uint8Array(4096));
        },
      }),
    }),
  });
}
