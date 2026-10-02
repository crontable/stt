const fs = require('fs-extra');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const CONVERTER_PATH = path.resolve(__dirname, '..', 'src', 'index.js');
const nativeRequire = createRequire(CONVERTER_PATH);

async function loadConverter(nodewhisper, filesystem = fs, runtimeProcess = process) {
  const converterModule = { exports: {} };
  const modules = { 'nodejs-whisper': { nodewhisper }, 'fs-extra': filesystem };
  const isolatedRequire = (name) => modules[name] || nativeRequire(name);
  const source = await fs.readFile(CONVERTER_PATH, 'utf8');

  vm.runInNewContext(source, {
    require: isolatedRequire,
    module: converterModule,
    process: runtimeProcess,
    console: {
      log() { assert.fail('공유 기능은 콘솔에 직접 출력하면 안 됩니다.'); },
      error() { assert.fail('공유 기능은 콘솔에 직접 출력하면 안 됩니다.'); },
    },
    setTimeout,
    __dirname: path.dirname(CONVERTER_PATH),
    __filename: CONVERTER_PATH,
  }, { filename: CONVERTER_PATH });

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
    await verify({
      ...fixture,
      converter: new Converter({ assetsDir: fixture.assets, outputDir: fixture.output }),
    });
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

test('공유 변환기는 입력·출력 폴더를 절대 경로로 명시해야 한다', async () => {
  const Converter = await loadConverter(async () => {});
  const absoluteDirectory = path.join(os.tmpdir(), 'stt-explicit-path');
  const invalidOptions = [
    undefined,
    { assetsDir: './assets', outputDir: absoluteDirectory },
    { assetsDir: absoluteDirectory, outputDir: './output' },
  ];

  invalidOptions.map((options) => assert.throws(() => new Converter(options), {
    message: '입력·출력 폴더의 절대 경로를 지정해 주세요.',
  }));
});

test('공유 변환기의 자료 경로와 기본 모델은 작업 폴더나 환경 변수에 의존하지 않는다', async () => {
  const assetsDir = path.join(os.tmpdir(), 'stt-injected-assets');
  const outputDir = path.join(os.tmpdir(), 'stt-injected-output');
  const Converter = await loadConverter(async () => {}, fs, {
    env: { WHISPER_MODEL: 'base' },
    cwd() { assert.fail('생성자는 작업 폴더를 읽어 자료 경로를 정하면 안 됩니다.'); },
  });

  const converter = new Converter({ assetsDir, outputDir });

  assert.equal(converter.assetsDir, assetsDir);
  assert.equal(converter.outputDir, outputDir);
  assert.equal(converter.modelName, 'large-v3');
  assert.equal(converter.libraryModelName, 'large');
});

test('공유 변환기는 명시한 모델과 진행 이벤트를 호출한 쪽에 전달한다', async () => {
  await withFixture(() => async () => {}, async ({ assets, output }) => {
    let events = [];
    const Converter = await loadConverter(async () => {});
    const converter = new Converter({
      assetsDir: assets,
      outputDir: output,
      modelName: 'base',
      onProgress: (event) => { events = [...events, event]; },
    });

    await converter.initialize();

    const initialized = events.find((event) => event.type === 'initialized');
    assert.equal(converter.modelName, 'base');
    assert.equal(converter.libraryModelName, 'base');
    assert.equal(initialized.modelName, 'base');
    assert.equal(initialized.assetsDir, assets);
    assert.equal(initialized.outputDir, output);
  });
});

test('공유 변환기의 상대 입력은 주입한 자료 폴더와 별개로 호출한 작업 폴더를 따른다', async () => {
  await withFixture(() => async () => {}, async ({ assets, engineDirectory, converter }) => {
    const inputName = 'caller.wav';
    const callerInput = path.join(engineDirectory, inputName);
    await fs.writeFile(callerInput, '호출한 작업 폴더의 입력');
    await fs.writeFile(path.join(assets, inputName), '기본 자료 폴더의 다른 입력');
    process.chdir(engineDirectory);

    const inputFiles = await converter.getInputFiles(inputName);

    assert.deepEqual(Array.from(inputFiles), [callerInput]);
    assert.equal(converter.assetsDir, assets);
  });
});

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

    const result = await new Converter({ assetsDir: assets, outputDir: output }).convertToText('recording.wav');

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
