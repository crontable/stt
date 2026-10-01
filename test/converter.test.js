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
  const extension = path.extname(audioPath).toLowerCase();
  return extension === '.wav'
    ? `${audioPath}.txt`
    : path.join(path.dirname(audioPath), `${path.basename(audioPath, extension)}.wav.txt`);
}

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
