const { SpeechToTextConverter } = require('./converter');
const { runTranscription } = require('./runner');

// eslint-disable-next-line no-restricted-syntax -- CommonJS 공개 진입점에 공유 전사 API를 한 번 등록합니다.
module.exports = { SpeechToTextConverter, runTranscription };
