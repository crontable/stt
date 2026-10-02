const fs = require('fs-extra');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const INDEX_PATH = path.resolve(__dirname, '..', 'index.js');
const nativeRequire = createRequire(INDEX_PATH);

async function loadConverter(nodewhisper, filesystem = fs) {
  const converterModule = { exports: {} };
  const modules = { 'nodejs-whisper': { nodewhisper }, 'fs-extra': filesystem };
  const isolatedRequire = (name) => modules[name] || nativeRequire(name);
  const source = await fs.readFile(INDEX_PATH, 'utf8');

  vm.runInNewContext(source, {
    require: isolatedRequire,
    module: converterModule,
    process,
    console: { log() {}, error() {} },
    setTimeout,
    __dirname: path.dirname(INDEX_PATH),
    __filename: INDEX_PATH,
  }, { filename: INDEX_PATH });

  return converterModule.exports.SpeechToTextConverter;
}

async function withFixture(createEngine, verify) {
  const originalDirectory = process.cwd();
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stt-regression-')));
  const fixture = {
    directory,
    assets: path.join(directory, 'assets'),
    output: path.join(directory, 'output'),
    engineDirectory: path.join(directory, 'engine'),
  };

  try {
    await Promise.all([fixture.assets, fixture.output, fixture.engineDirectory].map((target) => fs.ensureDir(target)));
    const Converter = await loadConverter(createEngine(fixture));
    process.chdir(directory);
    await verify({ ...fixture, converter: new Converter() });
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

async function runCli(args, nodewhisper, modelName = 'base') {
  const cliModule = { exports: {} };
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
  const isolatedRequire = (name) => modules[name] || nativeRequire(name);
  Object.defineProperty(isolatedRequire, 'main', { value: cliModule });
  const cliProcess = {
    argv: ['node', INDEX_PATH, ...args],
    env: { ...process.env, WHISPER_MODEL: modelName },
    pid: process.pid,
    cwd: () => process.cwd(),
    chdir: (directory) => process.chdir(directory),
  };
  Object.defineProperty(cliProcess, 'exitCode', { set: complete });
  const captureLog = (...values) => {
    const message = values.join(' ');
    logs = [...logs, message];
    if (message.includes('모든 파일의 변환이 완료되었습니다!') || message.includes('사용법:')) {
      complete(undefined);
    }
  };
  const timeout = setTimeout(() => rejectCompletion(new Error('CLI가 제한 시간 안에 완료되지 않았습니다.')), 3000);

  try {
    vm.runInNewContext(await fs.readFile(INDEX_PATH, 'utf8'), {
      require: isolatedRequire,
      module: cliModule,
      process: cliProcess,
      console: { log: captureLog, error: captureLog },
      setTimeout,
      __dirname: path.dirname(INDEX_PATH),
      __filename: INDEX_PATH,
    }, { filename: INDEX_PATH });

    const exitCode = await completion;
    return { exitCode, logs, modelChecks, directoryCreations };
  } finally {
    clearTimeout(timeout);
  }
}

test('16kHz와 44.1kHz WAV 원본은 엔진이 임시 파일을 바꾸고 삭제해도 보존된다', async () => {
  await [16000, 44100].reduce(async (previous, sampleRate) => {
    await previous;
    let engineInput;
    const originalBytes = wavBytes(sampleRate);

    await withFixture(() => async (audioPath, options) => {
      engineInput = audioPath;
      assert.equal(path.isAbsolute(audioPath), true);
      assert.equal(path.basename(audioPath), 'source.wav');
      assert.deepEqual(await fs.readFile(audioPath), originalBytes);
      assert.equal(options.whisperOptions.outputInText, true);
      await fs.writeFile(audioPath, '엔진이 만든 변환용 WAV');
      await fs.remove(audioPath);
      await fs.writeFile(transcriptPath(audioPath), '한국어 전사 결과\n');
    }, async ({ assets, output, converter }) => {
      const originalPath = path.join(assets, 'original.wav');
      await fs.writeFile(originalPath, originalBytes);

      const result = await converter.convertToText('original.wav');

      assert.equal(result.success, true);
      assert.notEqual(engineInput, originalPath);
      assert.deepEqual(await fs.readFile(originalPath), originalBytes);
      assert.equal(await fs.readFile(path.join(output, 'original.txt'), 'utf8'), '한국어 전사 결과\n');
      assert.equal(await fs.pathExists(path.dirname(engineInput)), false);
    });
  }, Promise.resolve());
});

test('MP3를 변환할 때 같은 이름의 원본 WAV도 보존한다', async () => {
  const originalMp3 = Buffer.from('원본 MP3 바이트');
  const originalWav = wavBytes(44100);
  let engineInput;

  await withFixture(() => async (audioPath) => {
    engineInput = audioPath;
    assert.equal(path.basename(audioPath), 'source.mp3');
    assert.deepEqual(await fs.readFile(audioPath), originalMp3);
    const generatedWav = path.join(path.dirname(audioPath), 'source.wav');
    await fs.writeFile(generatedWav, '변환용 WAV');
    await fs.remove(generatedWav);
    await fs.writeFile(transcriptPath(audioPath), 'MP3 전사 결과');
  }, async ({ assets, converter }) => {
    await fs.writeFile(path.join(assets, 'meeting.mp3'), originalMp3);
    await fs.writeFile(path.join(assets, 'meeting.wav'), originalWav);

    const result = await converter.convertToText('meeting.mp3');

    assert.equal(result.success, true);
    assert.deepEqual(await fs.readFile(path.join(assets, 'meeting.mp3')), originalMp3);
    assert.deepEqual(await fs.readFile(path.join(assets, 'meeting.wav')), originalWav);
    assert.equal(await fs.pathExists(path.dirname(engineInput)), false);
  });
});

test('입력 이름과 작업 폴더가 달라도 고정 임시 경로를 쓰고 실제 output 파일을 만든다', async () => {
  const inputName = '발언 " 검토.MP3';
  const transcription = '첫 번째 문장입니다.\n두 번째 문장입니다.\n';

  await withFixture(({ engineDirectory }) => async (audioPath) => {
    assert.equal(path.isAbsolute(audioPath), true);
    assert.equal(path.basename(audioPath), 'source.mp3');
    await fs.writeFile(transcriptPath(audioPath), transcription);
    process.chdir(engineDirectory);
  }, async ({ directory, assets, output, engineDirectory, converter }) => {
    await fs.writeFile(path.join(assets, inputName), '원본 MP3');
    process.chdir(engineDirectory);

    const result = await converter.convertToText(inputName);

    assert.equal(result.success, true);
    assert.equal(result.outputFile, '발언 " 검토.txt');
    assert.equal(await fs.readFile(path.join(output, result.outputFile), 'utf8'), transcription);
    assert.equal(process.cwd(), engineDirectory);
    assert.equal(await fs.pathExists(path.join(directory, 'assets', inputName)), true);
  });
});

test('전사 파일이 없거나 비어 있으면 실패로 반환하고 기존 결과는 보존한다', async () => {
  await [undefined, '', ' \n\t '].reduce(async (previous, content) => {
    await previous;
    let engineInput;

    await withFixture(() => async (audioPath) => {
      engineInput = audioPath;
      if (content !== undefined) {
        await fs.writeFile(transcriptPath(audioPath), content);
      }
    }, async ({ assets, output, converter }) => {
      await fs.writeFile(path.join(assets, 'recording.wav'), wavBytes(16000));
      const previousOutput = path.join(output, 'recording.txt');
      await fs.writeFile(previousOutput, '이전에 확보한 전사');

      const result = await converter.convertToText('recording.wav');

      assert.equal(result.success, false);
      assert.equal(result.inputFile, 'recording.wav');
      assert.equal(typeof result.error, 'string');
      assert.ok(result.error.length > 0);
      assert.equal(await fs.readFile(previousOutput, 'utf8'), '이전에 확보한 전사');
      assert.equal(await fs.pathExists(path.dirname(engineInput)), false);
    });
  }, Promise.resolve());
});

test('최종 결과 파일을 교체하지 못하면 실패로 반환하고 기존 결과를 보존한다', async () => {
  await withFixture(() => async () => {}, async ({ assets, output }) => {
    await fs.writeFile(path.join(assets, 'recording.wav'), wavBytes(16000));
    await fs.writeFile(path.join(output, 'recording.txt'), '기존 결과');
    const Converter = await loadConverter(async (audioPath) => {
      await fs.writeFile(transcriptPath(audioPath), '새 전사');
    }, {
      ...fs,
      async rename() {
        throw new Error('결과 파일 교체 실패');
      },
    });

    const result = await new Converter().convertToText('recording.wav');

    assert.equal(result.success, false);
    assert.equal(result.error, '결과 파일 교체 실패');
    assert.equal(await fs.readFile(path.join(output, 'recording.txt'), 'utf8'), '기존 결과');
    assert.deepEqual(await fs.readdir(output), ['recording.txt']);
  });
});

test('엔진 오류가 발생해도 작업 폴더를 복구하고 임시 파일을 삭제한다', async () => {
  let engineInput;

  await withFixture(({ engineDirectory }) => async (audioPath) => {
    engineInput = audioPath;
    process.chdir(engineDirectory);
    throw new Error('인식 엔진 오류');
  }, async ({ directory, assets, output, converter }) => {
    const originalPath = path.join(assets, 'failed.wav');
    const originalBytes = wavBytes(16000);
    await fs.writeFile(originalPath, originalBytes);

    const result = await converter.convertToText('failed.wav');

    assert.equal(result.success, false);
    assert.equal(result.error, '인식 엔진 오류');
    assert.equal(process.cwd(), directory);
    assert.deepEqual(await fs.readFile(originalPath), originalBytes);
    assert.equal(await fs.pathExists(path.dirname(engineInput)), false);
    assert.equal(await fs.pathExists(path.join(output, 'failed.txt')), false);
  });
});

test('엔진이 작업 폴더를 바꾸어도 두 입력을 순서대로 처리하고 결과를 반환한다', async () => {
  let engineInputs = [];

  await withFixture(({ engineDirectory }) => async (audioPath) => {
    assert.equal(engineInputs.length === 0 || await fs.pathExists(path.dirname(engineInputs[0])) === false, true);
    engineInputs = [...engineInputs, audioPath];
    const content = await fs.readFile(audioPath, 'utf8');
    await fs.writeFile(transcriptPath(audioPath), `${content}의 전사`);
    process.chdir(engineDirectory);
  }, async ({ directory, assets, output, converter }) => {
    await fs.writeFile(path.join(assets, 'a.wav'), '첫 음성');
    await fs.writeFile(path.join(assets, 'b.mp3'), '둘째 음성');

    const results = await converter.processAllFiles();

    assert.equal(results.length, 2);
    assert.deepEqual(Array.from(results, (result) => result.success), [true, true]);
    assert.equal(engineInputs.length, 2);
    assert.notEqual(path.dirname(engineInputs[0]), path.dirname(engineInputs[1]));
    assert.equal(await fs.readFile(path.join(output, 'a.txt'), 'utf8'), '첫 음성의 전사');
    assert.equal(await fs.readFile(path.join(output, 'b.txt'), 'utf8'), '둘째 음성의 전사');
    assert.equal(process.cwd(), directory);
    assert.deepEqual(await Promise.all(engineInputs.map((input) => fs.pathExists(path.dirname(input)))), [false, false]);
  });
});

test('첫 입력이 실패해도 다음 입력을 처리하고 실패 정보를 반환한다', async () => {
  await withFixture(({ engineDirectory }) => async (audioPath) => {
    const content = await fs.readFile(audioPath, 'utf8');
    process.chdir(engineDirectory);
    if (content === '실패할 음성') {
      throw new Error('첫 입력 인식 실패');
    }
    await fs.writeFile(transcriptPath(audioPath), '다음 입력 전사');
  }, async ({ directory, assets, output, converter }) => {
    await fs.writeFile(path.join(assets, 'a.wav'), '실패할 음성');
    await fs.writeFile(path.join(assets, 'b.mp3'), '성공할 음성');

    const results = await converter.processAllFiles();

    assert.equal(results.length, 2);
    assert.deepEqual(Array.from(results, (result) => result.success), [false, true]);
    assert.equal(results[0].inputFile, 'a.wav');
    assert.equal(results[0].error, '첫 입력 인식 실패');
    assert.equal(await fs.pathExists(path.join(output, 'a.txt')), false);
    assert.equal(await fs.readFile(path.join(output, 'b.txt'), 'utf8'), '다음 입력 전사');
    assert.equal(process.cwd(), directory);
  });
});

[
  { description: '확장자만 다른 이름', inputNames: ['same.wav', 'same.mp3'], outputName: 'same.txt' },
  { description: '대소문자가 다른 이름', inputNames: ['Meeting.wav', 'meeting.mp3'], outputName: 'Meeting.txt' },
  {
    description: '한글의 조합 형태가 다른 이름',
    inputNames: [`${'녹음'.normalize('NFC')}.wav`, `${'녹음'.normalize('NFD')}.mp3`],
    outputName: '녹음.txt',
  },
].map(({ description, inputNames, outputName }) => test(`결과 이름이 충돌하면 두 입력을 실패로 표시하고 기존 전사를 보존한다: ${description}`, async () => {
  let engineCalls = [];

  await withFixture(() => async (audioPath) => {
    engineCalls = [...engineCalls, audioPath];
    await fs.writeFile(transcriptPath(audioPath), '충돌하지 않는 입력의 전사');
  }, async ({ assets, output, converter }) => {
    await Promise.all(inputNames.map((name, index) => fs.writeFile(path.join(assets, name), `${index}번째 원본`)));
    await fs.writeFile(path.join(assets, 'unique.wav'), '다른 원본');
    await fs.writeFile(path.join(output, outputName), '기존 결과');

    const results = await converter.processAllFiles();
    const collisionKey = path.parse(inputNames[0]).name.normalize('NFC').toLowerCase();
    const collisions = Array.from(results).filter((result) => path.parse(result.inputFile).name.normalize('NFC').toLowerCase() === collisionKey);
    const successful = Array.from(results).filter((result) => result.success);

    assert.equal(results.length, 3);
    assert.equal(collisions.length, 2);
    assert.equal(collisions.every((result) => result.success === false && typeof result.error === 'string'), true);
    assert.equal(successful.length, 1);
    assert.equal(successful[0].inputFile, 'unique.wav');
    assert.equal(engineCalls.length, 1);
    assert.equal(await fs.readFile(path.join(output, outputName), 'utf8'), '기존 결과');
    assert.equal(await fs.readFile(path.join(output, 'unique.txt'), 'utf8'), '충돌하지 않는 입력의 전사');
    assert.deepEqual(await Promise.all(inputNames.map((name) => fs.readFile(path.join(assets, name), 'utf8'))), ['0번째 원본', '1번째 원본']);
  });
}));

test('입력 폴더를 읽지 못한 오류는 파일 없음으로 숨기지 않는다', async () => {
  await withFixture(() => async () => {
    assert.fail('폴더를 읽지 못했을 때 엔진을 실행하면 안 됩니다.');
  }, async ({ assets, converter }) => {
    await fs.remove(assets);
    await assert.rejects(() => converter.getAudioFiles(), { code: 'ENOENT' });
  });
});

test('입력 파일이 없으면 빈 처리 결과를 반환한다', async () => {
  await withFixture(() => async () => {
    assert.fail('입력이 없을 때 엔진을 실행하면 안 됩니다.');
  }, async ({ converter }) => {
    const results = await converter.processAllFiles();
    assert.deepEqual(Array.from(results), []);
  });
});

test('직접 실행한 CLI는 파일 변환 실패를 종료 코드 1로 알리고 전체 완료를 표시하지 않는다', async () => {
  await withFixture(() => async () => {}, async ({ assets }) => {
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
  await withFixture(() => async () => {}, async ({ directory, assets, output }) => {
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
  await withFixture(() => async () => {}, async ({ directory, assets, output }) => {
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
  await withFixture(() => async () => {}, async ({ directory, output }) => {
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
  await withFixture(() => async () => {}, async ({ directory }) => {
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
