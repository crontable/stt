const fs = require('fs-extra');
const assert = require('node:assert/strict');
const { execFile, fork, spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const executeFile = promisify(execFile);
const supportDirectory = path.resolve(__dirname, '..', 'test-support');
const harnessPath = path.join(supportDirectory, 'harness.cjs');
const preloadPath = path.join(supportDirectory, 'preload.cjs');

function delay(duration = 25) {
  return new Promise((resolve) => { setTimeout(resolve, duration); });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForExit(pid, attempts = 80) {
  if (!processExists(pid)) {
    return;
  }
  if (attempts === 0) {
    assert.fail(`검사에서 실행한 프로세스 ${pid}가 종료되지 않았습니다.`);
  }
  await delay();
  await waitForExit(pid, attempts - 1);
}

async function waitForFile(target, attempts = 160) {
  if (await fs.pathExists(target)) {
    return fs.readJson(target);
  }
  if (attempts === 0) {
    assert.fail(`검사 파일을 기다리는 시간이 지났습니다: ${target}`);
  }
  await delay();
  return waitForFile(target, attempts - 1);
}

async function stopRecordedProcesses(directory) {
  const names = (await fs.readdir(directory)).filter((name) => /^(engine|shell|leaf)-.*\.json$/.test(name));
  const records = await Promise.all(names.map((name) => fs.readJson(path.join(directory, name))));
  records.filter(({ pid }) => processExists(pid)).map(({ pid }) => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') {
        throw error;
      }
    }
    return pid;
  });
}

async function withFixture(verify, { mode = 'success', models = ['base'], environment = {} } = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stt-runner-regression-')));
  const fixture = {
    directory,
    assets: path.join(directory, 'assets'),
    output: path.join(directory, 'output'),
    engine: path.join(directory, 'engine'),
    scratch: path.join(directory, 'scratch'),
    env: {
      ...process.env,
      STT_FIXTURE_DIRECTORY: directory,
      TMPDIR: path.join(directory, 'scratch'),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(preloadPath)}`.trim(),
      ...environment,
    },
  };
  try {
    await Promise.all([fixture.assets, fixture.output, fixture.scratch, path.join(fixture.engine, 'models')].map((target) => fs.ensureDir(target)));
    const enginePath = path.join(fixture.engine, 'build', 'bin', 'whisper-cli');
    await fs.outputFile(enginePath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    await fs.writeFile(path.join(fixture.engine, 'models', 'download-ggml-model.sh'), '#!/bin/sh\nprintf "새 모델" > "$2/ggml-$1.bin"\n');
    await Promise.all(models.map((model) => fs.writeFile(path.join(fixture.engine, 'models', `ggml-${model}.bin`), '기존 모델')));
    await fs.writeJson(path.join(fixture.assets, 'recording.wav'), { mode, key: 'recording' });
    await fs.writeFile(path.join(fixture.output, 'recording.txt'), '기존 전사');
    await verify(fixture);
  } finally {
    await stopRecordedProcesses(directory);
    await fs.remove(directory);
  }
}

async function runHarness(fixture, request = {}) {
  const records = (await fs.readdir(fixture.directory)).filter((name) => /^(engine|shell|leaf)-.*\.json$/.test(name));
  await Promise.all(records.map((name) => fs.remove(path.join(fixture.directory, name))));
  const { stdout, stderr } = await executeFile(process.execPath, [harnessPath, JSON.stringify(request)], {
    cwd: fixture.directory,
    env: fixture.env,
    timeout: 12000,
  });
  assert.equal(stderr, '');
  return JSON.parse(stdout);
}

async function verifyJobCleanup(fixture, record) {
  assert.equal(await fs.pathExists(path.dirname(record.audioPath)), false, `음성 사본을 정리하지 못했습니다: ${record.audioPath}`);
  assert.equal(await fs.pathExists(record.temporaryDirectory), false, `작업 폴더를 정리하지 못했습니다: ${record.temporaryDirectory}`);
  const outputNames = await fs.readdir(fixture.output);
  assert.equal(outputNames.some((name) => name.endsWith('.tmp')), false);
  const modelNames = await fs.readdir(path.join(fixture.engine, 'models'));
  assert.equal(modelNames.some((name) => name.endsWith('.download') || name.endsWith('.stt-lock')), false);
  const lockDirectory = path.join(fixture.output, '.stt-locks');
  if (await fs.pathExists(lockDirectory)) {
    assert.deepEqual(await fs.readdir(lockDirectory), []);
  }
}

test('실제 자식 실행기는 부모의 작업 폴더·환경 변수를 보존하고 진행 상태와 엔진 출력을 따로 전달한다', async () => {
  await withFixture(async (fixture) => {
    const outcome = await runHarness(fixture);
    const record = await fs.readJson(path.join(fixture.directory, 'engine-recording.json'));
    assert.equal(outcome.status, 'fulfilled');
    assert.equal(outcome.cwdPreserved, true);
    assert.equal(outcome.environmentPreserved, true);
    assert.deepEqual(outcome.results, [{ success: true, inputFile: 'recording.wav', outputFile: 'recording.txt' }]);
    assert.equal(record.options.modelName, 'base');
    assert.equal(path.isAbsolute(record.audioPath), true);
    assert.notEqual(path.dirname(record.audioPath), fixture.assets);
    assert.equal(outcome.events.find(({ type }) => type === 'initialized').assetsDir, fixture.assets);
    assert.equal(outcome.events.find(({ type }) => type === 'initialized').outputDir, fixture.output);
    assert.equal(outcome.events.some(({ type }) => type === 'file-completed'), true);
    assert.equal(outcome.logs.some(({ stream, text }) => stream === 'stdout' && text.includes('엔진 표준 출력')), true);
    assert.equal(outcome.logs.some(({ stream, text }) => stream === 'stderr' && text.includes('엔진 오류 출력')), true);
    assert.deepEqual(await fs.readJson(path.join(fixture.assets, 'recording.wav')), { mode: 'success', key: 'recording' });
    assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), 'recording 한국어 전사\n');
    assert.equal(await fs.readFile(path.join(fixture.engine, 'models', 'ggml-base.bin'), 'utf8'), '기존 모델');
    await verifyJobCleanup(fixture, record);
  });
});

test('실제 자식의 전사 오류·비정상 종료·결과 없는 종료를 성공으로 처리하지 않고 기존 음성과 결과를 보존한다', async () => {
  await ['reject', 'exit-error', 'exit-empty'].reduce(async (previous, mode) => {
    await previous;
    await withFixture(async (fixture) => {
      const outcome = await runHarness(fixture);
      const record = await fs.readJson(path.join(fixture.directory, 'engine-recording.json'));
      if (mode === 'reject') {
        assert.equal(outcome.status, 'fulfilled');
        assert.equal(outcome.results[0].success, false);
        assert.equal(outcome.results[0].error, '모의 전사 엔진 실패');
      } else {
        assert.equal(outcome.status, 'rejected');
        assert.equal(typeof outcome.error.code, 'string');
      }
      assert.equal(outcome.cwdPreserved, true);
      assert.equal(outcome.environmentPreserved, true);
      assert.deepEqual(await fs.readJson(path.join(fixture.assets, 'recording.wav')), { mode, key: 'recording' });
      assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
      await verifyJobCleanup(fixture, record);
    }, { mode });
  }, Promise.resolve());
});

test('같은 결과 파일을 쓰는 두 작업은 자원 충돌을 알리고 다른 출력 폴더의 작업은 모델 준비 후 함께 실행된다', async () => {
  await withFixture(async (fixture) => {
    const collision = await runHarness(fixture, { action: 'parallel' });
    assert.equal(collision.second.status, 'rejected');
    assert.equal(collision.second.error.code, 'STT_RESOURCE_BUSY');
    assert.equal(collision.second.error.resourceKind, 'output');
    assert.equal(collision.first.error.code, 'STT_ABORTED', JSON.stringify(collision));
    await Promise.all([collision.record.pid, collision.leaf.pid].map((pid) => waitForExit(pid)));
    await verifyJobCleanup(fixture, collision.record);

    const secondOutput = path.join(fixture.directory, 'second-output');
    const secondInput = path.join(fixture.directory, 'second.wav');
    await fs.writeJson(secondInput, { mode: 'success', key: 'second' });
    const parallel = await runHarness(fixture, {
      action: 'parallel',
      secondOptions: { outputDir: secondOutput, inputPath: secondInput },
    });
    assert.equal(parallel.second.status, 'fulfilled');
    assert.equal(parallel.second.results[0].success, true);
    assert.equal(parallel.first.error.code, 'STT_ABORTED', JSON.stringify(parallel));
    assert.equal(await fs.readFile(path.join(secondOutput, 'second.txt'), 'utf8'), 'second 한국어 전사\n');
    assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
    await verifyJobCleanup(fixture, parallel.record);
  }, { mode: 'block' });
});

test('large와 large-v3는 같은 모델 준비 자원을 잠그고 취소하면 다운로드 사본과 잠금을 정리한다', async () => {
  await withFixture(async (fixture) => {
    const outcome = await runHarness(fixture, {
      action: 'model-conflict',
      modelName: 'large-v3',
      secondOptions: { outputDir: path.join(fixture.directory, 'second-output'), modelName: 'large' },
    });
    assert.equal(outcome.first.status, 'rejected');
    assert.equal(outcome.second.status, 'rejected');
    assert.equal(outcome.second.error.code, 'STT_RESOURCE_BUSY');
    assert.equal(outcome.second.error.resourceKind, 'model');
    const modelNames = await fs.readdir(path.join(fixture.engine, 'models'));
    assert.deepEqual(modelNames.filter((name) => name.endsWith('.bin')), ['ggml-base.bin']);
    assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
  }, { environment: { STT_FIXTURE_SLOW_DOWNLOAD: '1' } });
});

test('large-v3를 명시하면 자식에는 large 모델을 전달하고 준비를 마친 기존 모델은 병렬 전사 후에도 보존한다', async () => {
  await withFixture(async (fixture) => {
    const secondInput = path.join(fixture.directory, 'second.wav');
    await fs.writeJson(secondInput, { mode: 'success', key: 'second' });
    const outcome = await runHarness(fixture, {
      action: 'parallel',
      modelName: 'large-v3',
      secondOptions: { outputDir: path.join(fixture.directory, 'second-output'), inputPath: secondInput, modelName: 'large' },
    });
    assert.equal(outcome.second.status, 'fulfilled');
    assert.equal(outcome.record.options.modelName, 'large');
    assert.equal(await fs.readFile(path.join(fixture.engine, 'models', 'ggml-large.bin'), 'utf8'), '기존 모델');
    await verifyJobCleanup(fixture, outcome.record);
  }, { mode: 'block', models: ['large'], environment: { STT_FIXTURE_VALID_LARGE: '1' } });
});

test('모델 교체 다운로드를 취소하면 실제 다운로드 사본만 삭제하고 기존 모델과 전사를 보존한다', async () => {
  await withFixture(async (fixture) => {
    const outcome = await runHarness(fixture, { action: 'download-cancel', modelName: 'large-v3' });
    assert.equal(outcome.status, 'rejected');
    assert.equal(outcome.error.code, 'STT_ABORTED');
    assert.equal(outcome.downloads.length, 1);
    assert.equal(await fs.readFile(path.join(fixture.engine, 'models', 'ggml-large.bin'), 'utf8'), '기존 모델');
    const modelEntries = await fs.readdir(path.join(fixture.engine, 'models'));
    assert.deepEqual(modelEntries.filter((name) => name !== 'download-ggml-model.sh'), ['ggml-large.bin']);
    assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
  }, { models: ['large'], environment: { STT_FIXTURE_SLOW_DOWNLOAD: '1' } });
});

test('AbortSignal로 취소하면 실제 Node 자식·셸·종료 신호를 무시하는 손자까지 종료하고 임시 파일을 정리한다', async () => {
  await ['block', 'pending'].reduce(async (previous, mode) => {
    await previous;
    await withFixture(async (fixture) => {
      const outcome = await runHarness(fixture, { action: 'cancel' });
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.error.code, 'STT_ABORTED', JSON.stringify(outcome));
      await Promise.all([outcome.record.pid, outcome.shell.pid, outcome.leaf.pid].map((pid) => waitForExit(pid)));
      await verifyJobCleanup(fixture, outcome.record);
      assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
      if (mode === 'pending') {
        const { filePath } = await fs.readJson(path.join(fixture.directory, 'pending.json'));
        assert.equal(await fs.pathExists(filePath), false);
      }
    }, { mode });
  }, Promise.resolve());
});

test('실제 CLI에 SIGINT를 보내면 전사 자손과 임시 파일을 정리한 뒤 종료한다', async () => {
  await withFixture(async (fixture) => {
    const cliPath = path.join(fixture.directory, 'apps', 'cli', 'src', 'index.js');
    const sourceCli = path.resolve(__dirname, '..', '..', '..', 'apps', 'cli', 'src', 'index.js');
    await fs.copy(sourceCli, cliPath);
    const parent = spawn(process.execPath, [cliPath], {
      cwd: fixture.directory,
      env: { ...fixture.env, WHISPER_MODEL: 'base' },
      stdio: 'ignore',
    });
    const ended = new Promise((resolve) => { parent.once('exit', (code, signal) => resolve({ code, signal })); });
    try {
      const [record, shell, leaf] = await Promise.all(['engine', 'shell', 'leaf'].map((kind) => (
        waitForFile(path.join(fixture.directory, `${kind}-recording.json`))
      )));
      parent.kill('SIGINT');
      const outcome = await ended;
      assert.ok(outcome.signal === 'SIGINT' || outcome.code === 130, JSON.stringify(outcome));
      await Promise.all([record.pid, shell.pid, leaf.pid].map((pid) => waitForExit(pid)));
      await verifyJobCleanup(fixture, record);
      assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL');
        await ended;
      }
    }
  }, { mode: 'block' });
});

test('공개 실행기를 직접 호출한 부모의 SIGTERM은 전사 자손과 임시 파일·잠금을 정리한 뒤 전달된다', async () => {
  await withFixture(async (fixture) => {
    const parent = fork(harnessPath, [JSON.stringify({ action: 'waiting' })], {
      cwd: fixture.directory,
      env: fixture.env,
      silent: true,
    });
    const ready = new Promise((resolve, reject) => {
      parent.once('message', resolve);
      parent.once('error', reject);
      parent.once('exit', (code, signal) => reject(new Error(`검사 준비 전에 부모가 종료됐습니다: ${code}, ${signal}`)));
    });
    const ended = new Promise((resolve) => { parent.once('exit', (code, signal) => resolve({ code, signal })); });
    let readyTimer;
    try {
      const timeout = new Promise((resolve, reject) => {
        readyTimer = setTimeout(() => reject(new Error('공개 실행기 검사 준비 시간이 지났습니다.')), 5000);
      });
      const message = await Promise.race([ready, timeout]);
      assert.equal(message.type, 'ready');
      parent.kill('SIGTERM');
      const outcome = await ended;
      assert.ok(outcome.signal === 'SIGTERM' || outcome.code === 143, JSON.stringify(outcome));
      await Promise.all([message.record.pid, message.shell.pid, message.leaf.pid].map((pid) => waitForExit(pid)));
      await verifyJobCleanup(fixture, message.record);
      assert.deepEqual(await fs.readdir(fixture.scratch), []);
      assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
    } finally {
      clearTimeout(readyTimer);
      if (parent.exitCode === null && parent.signalCode === null) {
        parent.kill('SIGKILL');
        await ended;
      }
    }
  }, { mode: 'block' });
});

test('비동기 진행·로그 알림이 실패하면 공개 실행기는 오류를 반환하고 작업 자원을 정리한다', async () => {
  await ['progress', 'log', 'input-list'].reduce(async (previous, channel) => {
    await previous;
    await withFixture(async (fixture) => {
      const outcome = await runHarness(fixture, { action: 'callback-failure', channel });
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.error.code, 'STT_CALLBACK_FAILED', JSON.stringify(outcome));
      assert.match(outcome.error.message, /비동기 전사 알림 처리 실패/);
      assert.equal(outcome.cwdPreserved, true);
      assert.equal(outcome.environmentPreserved, true);
      assert.deepEqual(await fs.readdir(fixture.scratch), []);
      const lockDirectory = path.join(fixture.output, '.stt-locks');
      if (channel === 'input-list') {
        assert.equal(await fs.pathExists(lockDirectory), false);
      } else {
        assert.deepEqual(await fs.readdir(lockDirectory), []);
      }
      assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
      const records = (await fs.readdir(fixture.directory)).filter((name) => /^(engine|shell|leaf)-.*\.json$/.test(name));
      if (channel === 'input-list') {
        assert.deepEqual(records, []);
        const modelEntries = await fs.readdir(path.join(fixture.engine, 'models'));
        assert.equal(modelEntries.some((name) => name.endsWith('.stt-lock')), false);
      }
      await Promise.all(records.map(async (name) => {
        const { pid } = await fs.readJson(path.join(fixture.directory, name));
        await waitForExit(pid);
      }));
    }, {
      mode: 'block',
      environment: channel === 'input-list' ? { STT_FIXTURE_FAIL_INPUT_LIST: '1' } : {},
    });
  }, Promise.resolve());
});

test('신규 비 large 모델의 준비를 마친 뒤 음성 인식이 실패해도 준비한 모델과 기존 전사를 보존한다', async () => {
  await withFixture(async (fixture) => {
    const outcome = await runHarness(fixture, { modelName: 'tiny' });
    const record = await fs.readJson(path.join(fixture.directory, 'engine-recording.json'));
    assert.equal(outcome.status, 'fulfilled');
    assert.equal(outcome.results[0].success, false);
    assert.equal(outcome.results[0].error, '모의 전사 엔진 실패');
    assert.equal(record.options.modelName, 'tiny');
    assert.equal(record.options.autoDownloadModelName, undefined);
    assert.equal(await fs.readFile(path.join(fixture.engine, 'models', 'ggml-tiny.bin'), 'utf8'), '새 모델');
    assert.equal(await fs.readFile(path.join(fixture.engine, 'models', 'ggml-base.bin'), 'utf8'), '기존 모델');
    assert.equal(await fs.readFile(path.join(fixture.output, 'recording.txt'), 'utf8'), '기존 전사');
    await verifyJobCleanup(fixture, record);
  }, { mode: 'reject' });
});
