const fs = require('fs-extra');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');
const vm = require('node:vm');

const CLI_PATH = path.resolve(__dirname, '..', 'src', 'index.js');
const CONVERTER_PATH = path.resolve(__dirname, '..', '..', '..', 'packages', 'transcription', 'src', 'converter.js');
const nativeRequire = createRequire(CONVERTER_PATH);
const executeFile = promisify(execFile);

async function withFixture(verify) {
  const originalDirectory = process.cwd();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stt-cli-regression-')));
  const fixture = {
    directory,
    assets: path.join(directory, 'assets'),
    output: path.join(directory, 'output'),
    engineDirectory: path.join(directory, 'engine'),
  };

  try {
    await Promise.all([fixture.assets, fixture.output, fixture.engineDirectory].map((target) => fs.ensureDir(target)));
    process.chdir(directory);
    await verify(fixture);
  } finally {
    process.chdir(originalDirectory);
    await fs.remove(directory);
  }
}

function wavBytes(sampleRate) {
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4, 40);
  bytes.writeInt16LE(1234, 44);
  bytes.writeInt16LE(-1234, 46);
  return bytes;
}

function transcriptPath(audioPath) {
  return path.join(path.dirname(audioPath), 'source.wav.txt');
}

async function runCli(args, nodewhisper, modelName = 'base', repositoryDirectory = process.cwd()) {
  const cliModule = { exports: {} };
  const converterModule = { exports: {} };
  const entryPath = path.join(repositoryDirectory, 'apps', 'cli', 'src', 'index.js');
  let logs = [];
  let modelChecks = [];
  let directoryCreations = [];
  let complete;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    complete = resolve;
    rejectCompletion = reject;
  });
  const filesystem = {
    ...fs,
    async pathExists(target) {
      if (path.basename(target) === 'ggml-large.bin') {
        modelChecks = [...modelChecks, target];
        throw new Error('입력 검증 검사에서는 모델 준비를 실행하면 안 됩니다.');
      }
      return fs.pathExists(target);
    },
    async ensureDir(target) {
      directoryCreations = [...directoryCreations, target];
      return fs.ensureDir(target);
    },
  };
  const modules = { 'nodejs-whisper': { nodewhisper }, 'fs-extra': filesystem };
  const converterRequire = (name) => modules[name] || nativeRequire(name);
  const transcriptionModule = {
    async runTranscription(options) {
      const converter = new converterModule.exports.SpeechToTextConverter(options);
      const inputFiles = options.inputPath === undefined ? undefined : await converter.getInputFiles(options.inputPath);
      await converter.initialize();
      return converter.processAllFiles(inputFiles);
    },
  };
  const isolatedRequire = (name) => (name === '@stt/transcription'
    ? transcriptionModule
    : nativeRequire(name));
  Object.defineProperty(isolatedRequire, 'main', { value: cliModule });
  const captureLog = (...values) => {
    const message = values.join(' ');
    logs = [...logs, message];
    if (message.includes('모든 파일의 변환이 완료되었습니다!') || message.includes('사용법:')) {
      complete(undefined);
    }
  };
  const cliProcess = Object.assign(new EventEmitter(), {
    argv: ['node', entryPath, ...args],
    env: { ...process.env, WHISPER_MODEL: modelName },
    pid: process.pid,
    cwd: () => process.cwd(),
    chdir: (directory) => process.chdir(directory),
    stdout: { write: (message) => captureLog(message) },
    stderr: { write: (message) => captureLog(message) },
  });
  Object.defineProperty(cliProcess, 'exitCode', { set: complete });
  const timeout = setTimeout(() => rejectCompletion(new Error('CLI가 제한 시간 안에 완료되지 않았습니다.')), 3000);

  try {
    vm.runInNewContext(await fs.readFile(CONVERTER_PATH, 'utf8'), {
      require: converterRequire,
      module: converterModule,
      process: cliProcess,
      console: {
        log() { assert.fail('공유 기능은 콘솔에 직접 출력하면 안 됩니다.'); },
        error() { assert.fail('공유 기능은 콘솔에 직접 출력하면 안 됩니다.'); },
      },
      setTimeout,
      __dirname: path.dirname(CONVERTER_PATH),
      __filename: CONVERTER_PATH,
    }, { filename: CONVERTER_PATH });
    vm.runInNewContext(await fs.readFile(CLI_PATH, 'utf8'), {
      require: isolatedRequire,
      module: cliModule,
      process: cliProcess,
      console: { log: captureLog, error: captureLog },
      AbortController,
      setTimeout,
      __dirname: path.dirname(entryPath),
      __filename: entryPath,
    }, { filename: CLI_PATH });

    const exitCode = await completion;
    return { exitCode, logs, modelChecks, directoryCreations };
  } finally {
    clearTimeout(timeout);
  }
}

test('새 CLI 진입점을 Node로 실행하면 공유 패키지를 불러와 도움말을 출력한다', async () => {
  await withFixture(async ({ directory }) => {
    const result = await executeFile(process.execPath, [CLI_PATH, '--help'], {
      cwd: directory,
      env: { ...process.env, WHISPER_MODEL: 'large-v3' },
    });

    assert.match(result.stdout, /사용법:/);
    assert.match(result.stdout, /--input, -i/);
    assert.equal(result.stderr, '');
    assert.doesNotMatch(result.stdout, /프로그램이 시작되었습니다|다운로드합니다/);
    assert.deepEqual(await fs.readdir(directory), ['assets', 'engine', 'output']);
  });
});

test('앱 폴더에서 CLI를 실행해도 저장소 루트의 자료와 결과 폴더를 사용한다', async () => {
  await withFixture(async ({ directory, assets, output }) => {
    const appDirectory = path.join(directory, 'apps', 'cli');
    let engineContents = [];
    await fs.ensureDir(appDirectory);
    await fs.writeFile(path.join(assets, 'root.wav'), '저장소 루트의 음성');
    await fs.outputFile(path.join(appDirectory, 'assets', 'wrong.wav'), '앱 폴더의 다른 음성');
    process.chdir(appDirectory);

    const result = await runCli([], async (audioPath) => {
      const content = await fs.readFile(audioPath, 'utf8');
      engineContents = [...engineContents, content];
      await fs.writeFile(transcriptPath(audioPath), '저장소 루트의 전사');
    }, 'base', directory);

    assert.equal(result.exitCode, undefined);
    assert.deepEqual(engineContents, ['저장소 루트의 음성']);
    assert.equal(await fs.readFile(path.join(output, 'root.txt'), 'utf8'), '저장소 루트의 전사');
    assert.equal(await fs.pathExists(path.join(appDirectory, 'output')), false);
    assert.deepEqual(result.directoryCreations, [assets, output]);
    assert.equal(process.cwd(), appDirectory);
  });
});

test('CLI의 상대 입력은 앱 폴더를 따르고 출력은 저장소 루트에 저장한다', async () => {
  await withFixture(async ({ directory, assets, output }) => {
    const appDirectory = path.join(directory, 'apps', 'cli');
    const inputName = 'caller.wav';
    const callerInput = path.join(appDirectory, inputName);
    let engineContents = [];
    await fs.outputFile(callerInput, 'CLI를 호출한 작업 폴더의 음성');
    await fs.writeFile(path.join(assets, inputName), '처리하면 안 되는 기본 음성');
    process.chdir(appDirectory);

    const result = await runCli(['--input', inputName], async (audioPath) => {
      engineContents = [...engineContents, await fs.readFile(audioPath, 'utf8')];
      await fs.writeFile(transcriptPath(audioPath), '상대 입력의 전사');
    }, 'base', directory);

    assert.equal(result.exitCode, undefined);
    assert.deepEqual(engineContents, ['CLI를 호출한 작업 폴더의 음성']);
    assert.equal(await fs.readFile(path.join(output, 'caller.txt'), 'utf8'), '상대 입력의 전사');
    assert.equal(await fs.readFile(callerInput, 'utf8'), 'CLI를 호출한 작업 폴더의 음성');
    assert.equal(await fs.pathExists(path.join(appDirectory, 'output')), false);
    assert.match(result.logs.join('\n'), /Whisper 모델: base/);
  });
});

test('직접 실행한 CLI는 파일 변환 실패를 종료 코드 1로 알리고 전체 완료를 표시하지 않는다', async () => {
  await withFixture(async ({ assets }) => {
    await fs.writeFile(path.join(assets, 'failed.wav'), wavBytes(16000));
    const result = await runCli([], async () => { throw new Error('파일 변환 실패'); });

    assert.equal(result.exitCode, 1);
    assert.match(result.logs.join('\n'), /실패/);
    assert.doesNotMatch(result.logs.join('\n'), /모든 (?:작업이 완료|파일의 변환이 완료)/);
  });
});

[
  { description: '절대 경로와 긴 옵션', option: '--input', relative: false, name: '외부 녹음.MP3' },
  { description: '상대 경로와 짧은 옵션', option: '-i', relative: true, name: '상대 녹음.WAV' },
].map(({ description, option, relative, name }) => test(`CLI에서 지정한 외부 파일만 처리하고 원본을 보존한다: ${description}`, async () => {
  await withFixture(async ({ directory, assets, output }) => {
    const originalBytes = Buffer.from('지정한 외부 음성 원본');
    const inputPath = path.join(directory, '외부 음성 폴더', name);
    let engineInputs = [];
    await fs.outputFile(inputPath, originalBytes);
    await fs.writeFile(path.join(assets, 'other.wav'), '지정하지 않은 기본 음성');
    const argument = relative ? path.relative(directory, inputPath) : inputPath;

    const result = await runCli([option, argument], async (audioPath) => {
      engineInputs = [...engineInputs, audioPath];
      assert.equal(path.basename(audioPath), `source${path.extname(name).toLowerCase()}`);
      assert.deepEqual(await fs.readFile(audioPath), originalBytes);
      await fs.writeFile(audioPath, '엔진이 수정한 임시 사본');
      await fs.remove(audioPath);
      await fs.writeFile(transcriptPath(audioPath), '외부 파일의 전사');
    });

    assert.equal(result.exitCode, undefined);
    assert.equal(engineInputs.length, 1);
    assert.notEqual(engineInputs[0], inputPath);
    assert.deepEqual(await fs.readFile(inputPath), originalBytes);
    assert.equal(await fs.readFile(path.join(output, `${path.parse(name).name}.txt`), 'utf8'), '외부 파일의 전사');
    assert.equal(await fs.pathExists(path.join(output, 'other.txt')), false);
    assert.equal(await fs.pathExists(path.dirname(engineInputs[0])), false);
    assert.match(result.logs.join('\n'), /모든 파일의 변환이 완료/);
  });
}));

test('CLI에서 외부 폴더를 지정하면 바로 아래 지원 파일만 처리한다', async () => {
  await withFixture(async ({ directory, assets, output }) => {
    const inputDirectory = path.join(directory, '외부 폴더');
    let engineContents = [];
    await fs.outputFile(path.join(inputDirectory, 'a.WAV'), '첫 외부 음성');
    await fs.writeFile(path.join(inputDirectory, 'b.mp3'), '둘째 외부 음성');
    await fs.writeFile(path.join(inputDirectory, 'notes.txt'), '지원하지 않는 파일');
    await fs.outputFile(path.join(inputDirectory, 'nested.wav', 'inner.mp3'), '하위 폴더의 음성');
    await fs.writeFile(path.join(assets, 'other.wav'), '기본 폴더의 음성');

    const result = await runCli(['--input', inputDirectory], async (audioPath) => {
      const content = await fs.readFile(audioPath, 'utf8');
      engineContents = [...engineContents, content];
      await fs.writeFile(transcriptPath(audioPath), `${content}의 전사`);
    });

    assert.equal(result.exitCode, undefined);
    assert.deepEqual(engineContents, ['첫 외부 음성', '둘째 외부 음성']);
    assert.deepEqual(await fs.readdir(output), ['a.txt', 'b.txt']);
    assert.equal(await fs.readFile(path.join(output, 'a.txt'), 'utf8'), '첫 외부 음성의 전사');
    assert.equal(await fs.readFile(path.join(output, 'b.txt'), 'utf8'), '둘째 외부 음성의 전사');
    assert.equal(await fs.readFile(path.join(inputDirectory, 'nested.wav', 'inner.mp3'), 'utf8'), '하위 폴더의 음성');
  });
});

test('CLI에서 외부 폴더의 결과 이름이 충돌하면 기존 전사를 보존하고 실패로 종료한다', async () => {
  await withFixture(async ({ directory, output }) => {
    const inputDirectory = path.join(directory, '외부 폴더');
    let engineContents = [];
    await fs.outputFile(path.join(inputDirectory, 'same.wav'), '첫 충돌 음성');
    await fs.writeFile(path.join(inputDirectory, 'same.mp3'), '둘째 충돌 음성');
    await fs.writeFile(path.join(inputDirectory, 'unique.wav'), '고유한 음성');
    await fs.writeFile(path.join(output, 'same.txt'), '기존 전사');

    const result = await runCli(['-i', inputDirectory], async (audioPath) => {
      const content = await fs.readFile(audioPath, 'utf8');
      engineContents = [...engineContents, content];
      await fs.writeFile(transcriptPath(audioPath), '고유한 음성의 전사');
    });

    assert.equal(result.exitCode, 1);
    assert.deepEqual(engineContents, ['고유한 음성']);
    assert.equal(await fs.readFile(path.join(output, 'same.txt'), 'utf8'), '기존 전사');
    assert.equal(await fs.readFile(path.join(output, 'unique.txt'), 'utf8'), '고유한 음성의 전사');
    assert.match(result.logs.join('\n'), /출력 파일 이름이 겹칩니다/);
    assert.match(result.logs.join('\n'), /2개 파일의 변환에 실패/);
    assert.doesNotMatch(result.logs.join('\n'), /모든 파일의 변환이 완료/);
  });
});

[
  { description: '존재하지 않는 경로', args: ['--input', 'missing.wav'], message: /ENOENT/ },
  { description: '지원하지 않는 파일 형식', args: ['--input', 'notes.txt'], message: /지원하지 않는 입력 파일 형식/ },
  { description: '옵션 값 누락', args: ['--input'], message: /argument|value/i },
  { description: '빈 입력 값', args: ['--input', ''], message: /경로를 지정/ },
  { description: '잘못된 옵션', args: ['--unknown'], message: /unknown option/i },
].map(({ description, args, message }) => test(`CLI 입력 오류는 모델 준비와 엔진 실행 전에 실패로 종료한다: ${description}`, async () => {
  await withFixture(async ({ directory }) => {
    let engineCalls = 0;
    await fs.writeFile(path.join(directory, 'notes.txt'), '지원하지 않는 입력');

    const result = await runCli(args, async () => {
      engineCalls += 1;
      assert.fail('입력 오류가 있으면 엔진을 실행하면 안 됩니다.');
    }, 'large-v3');

    assert.equal(result.exitCode, 1);
    assert.equal(engineCalls, 0);
    assert.deepEqual(result.modelChecks, []);
    assert.deepEqual(result.directoryCreations, []);
    assert.match(result.logs.join('\n'), message);
    assert.doesNotMatch(result.logs.join('\n'), /프로그램이 시작되었습니다|모든 파일의 변환이 완료/);
  });
}));

['--help', '-h'].map((option) => test(`CLI 도움말은 모델 준비와 엔진 실행 없이 사용법을 출력한다: ${option}`, async () => {
  let engineCalls = 0;
  const result = await runCli([option], async () => {
    engineCalls += 1;
    assert.fail('도움말을 표시할 때 엔진을 실행하면 안 됩니다.');
  }, 'large-v3');

  assert.equal(result.exitCode, undefined);
  assert.equal(engineCalls, 0);
  assert.deepEqual(result.modelChecks, []);
  assert.deepEqual(result.directoryCreations, []);
  assert.match(result.logs.join('\n'), /사용법:/);
  assert.match(result.logs.join('\n'), /--input, -i/);
  assert.doesNotMatch(result.logs.join('\n'), /프로그램이 시작되었습니다/);
}));
