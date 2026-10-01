const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('fs-extra');

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

test('생성된 전사 내용을 실제 output 파일에 저장한다', async () => {
  const transcription = '한국어 전사 결과입니다.\n';
  await withFixture(() => async (audioPath) => {
    await fs.writeFile(transcriptPath(audioPath), transcription);
  }, async ({ assets, output, converter }) => {
    await fs.writeFile(path.join(assets, 'recording.wav'), wavBytes(16000));
    const result = await converter.convertToText('recording.wav');
    assert.equal(result.success, true);
    assert.equal(result.outputFile, 'recording.txt');
    assert.equal(await fs.readFile(path.join(output, result.outputFile), 'utf8'), transcription);
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

test('엔진 오류가 발생해도 원본을 보존하고 임시 파일을 삭제한다', async () => {
  let engineInput;

  await withFixture(({ engineDirectory }) => async (audioPath) => {
    engineInput = audioPath;
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
