# Whisper large-v3로 업그레이드하기

이 문서는 한국어 정확도를 우선하는 다국어 `large-v3`를 다른 macOS 기기에서 준비하고, 실제 음성 인식까지 확인하는 절차를 설명합니다. 기존 `base` 사용자도 large-v3 변경이 포함된 코드로 이동한 뒤 같은 절차를 사용합니다.

## 1. 변경이 포함된 코드를 준비한다

이 절차는 large-v3 변경이 포함된 저장소에서 시작합니다. 로컬 커밋은 다른 기기의 원격 조회에 자동으로 나타나지 않습니다. 원격 저장소에서 코드를 받으려면 먼저 해당 변경이 원격에 반영되어 있어야 합니다.

저장소를 받은 위치로 이동합니다. `/실제/stt/경로`는 해당 기기의 경로로 바꿉니다.

```bash
cd /실제/stt/경로
git branch --show-current
```

이번 변경을 기록한 브랜치는 `feat/whisper-large-v3`입니다. 코드가 준비되었는지는 `index.js`에 `process.env.WHISPER_MODEL || 'large-v3'`가 있는지 확인합니다.

| Git에 기록되는 대상 | 다른 기기에서 준비할 대상 |
|---|---|
| `index.js`의 모델 선택·다운로드·검증 코드 | Node.js와 FFmpeg |
| `package-lock.json`의 의존성 버전 | `npm ci`로 설치하는 `node_modules` |
| README와 이 문서의 설치 절차 | CMake로 빌드하는 `whisper-cli`와 약 3.1GB 모델 |

모델과 실행 파일은 Git에서 제외되는 `node_modules` 안에 있습니다. 다른 기기에서는 각각 다운로드하고 빌드합니다.

## 2. 실행과 빌드에 필요한 도구를 확인한다

| 도구 | 역할 | 확인 명령 |
|---|---|---|
| Node.js 18 이상 | 프로그램을 실행하고 모델을 다운로드합니다. | `node --version` |
| Xcode Command Line Tools | C/C++ 실행 엔진을 컴파일합니다. | `xcode-select -p` |
| FFmpeg | 입력 음성을 16kHz WAV로 변환합니다. | `ffmpeg -version` |
| CMake | 실행 엔진의 빌드 설정을 만들고 빌드합니다. | `cmake --version` |

Xcode Command Line Tools가 설치되어 있지 않으면 아래 명령을 실행하고 설치를 마칩니다.

```bash
xcode-select --install
```

Homebrew가 설치된 macOS에서는 아래 명령으로 FFmpeg와 CMake를 설치할 수 있습니다.

```bash
brew install ffmpeg cmake
```

최초 모델 다운로드에는 인터넷 연결과 약 3.1GB의 모델 저장 공간이 필요합니다. 임시 다운로드 파일은 검증이 끝난 뒤 적용됩니다. 정상 모델을 교체하는 경우에는 기존 모델과 임시 파일을 함께 저장할 여유 공간이 필요합니다. 인식할 때 사용하는 메모리와 처리 시간은 기기와 음성 길이에 따라 달라집니다.

## 3. 의존성을 설치하고 실행 엔진을 빌드한다

새 기기에서는 저장소 최상위 폴더에서 아래 명령을 순서대로 실행합니다. `npm ci`는 `package-lock.json`에 기록된 버전으로 의존성을 설치합니다.

```bash
npm ci

cmake -S node_modules/nodejs-whisper/cpp/whisper.cpp -B node_modules/nodejs-whisper/cpp/whisper.cpp/build
cmake --build node_modules/nodejs-whisper/cpp/whisper.cpp/build --config Release
```

`npm ci`는 기존 `node_modules`를 지우고 다시 설치합니다. 그 안에 저장한 모델과 실행 파일도 함께 지워지므로 이후 모델 다운로드와 엔진 빌드가 다시 필요합니다. 기존 기기에서 의존성과 실행 엔진을 그대로 사용한다면 이 단계는 생략하고 4단계로 이동합니다.

macOS에서는 빌드 뒤 아래 경로에 실행 파일이 생성되어야 합니다. 연결 라이브러리가 인식 명령을 만들기 전에 이 파일을 찾으므로 모델 다운로드와 별도로 빌드해야 합니다.

```bash
test -x node_modules/nodejs-whisper/cpp/whisper.cpp/build/bin/whisper-cli
echo $?
```

출력값이 `0`이면 실행 권한이 있는 파일이 준비된 것입니다. CMake가 오류를 출력하거나 실행 파일이 없으면 빌드 오류를 해결한 뒤 다음 단계로 이동합니다.

## 4. 음성을 처리하지 않고 large-v3를 준비한다

아래 명령은 `SpeechToTextConverter.initialize()`를 호출합니다. 이 함수는 선택한 모델을 준비하고 `assets`와 `output` 폴더를 생성합니다. 음성 인식을 호출하지 않으므로 기존 입력 파일은 처리하지 않습니다.

```bash
WHISPER_MODEL=large-v3 node <<'NODE'
const { SpeechToTextConverter } = require('./index.js');

async function main() {
  try {
    await new SpeechToTextConverter().initialize();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

main();
NODE
```

| 기존 모델 상태 | 프로그램이 수행하는 작업 |
|---|---|
| 모델 파일이 없음 | 정식 large-v3를 임시 파일로 다운로드하고 검증합니다. |
| 파일이 있으나 검증값이 다름 | 다시 다운로드하고 검증을 통과한 파일로 교체합니다. |
| 정식 large-v3의 검증값과 일치함 | 기존 파일을 사용합니다. |

준비가 끝나면 `🧠 Whisper 모델: large-v3`가 표시됩니다. 새로 다운로드했을 때는 다운로드와 파일 검증 완료 메시지도 표시됩니다.

### 모델 이름과 저장 경로

연결 라이브러리 `nodejs-whisper` 0.2.9는 `large-v3` 이름을 직접 받지 못하고 `large`를 `ggml-large.bin`에 연결합니다. 이 프로그램은 정식 배포 파일 `ggml-large-v3.bin`을 받아 아래 경로에 저장한 뒤, 라이브러리에 `large`를 전달합니다. 엔진은 파일 안의 구조를 읽으므로 실제로 사용하는 모델은 large-v3입니다.

```text
node_modules/nodejs-whisper/cpp/whisper.cpp/models/ggml-large.bin
```

정식 파일은 3,095,033,483바이트이며, 확인하는 SHA1 검증값은 `ad82bf6a9043ceed055076d0fd39f5f186ff8062`입니다. 파일의 내용을 스트림으로 읽어 검증하므로 모델 전체를 한 번에 메모리에 올리지 않습니다.

이전 다운로드로 `Entry not found` 같은 오류 응답이 저장되어 있어도 검증값이 다르므로 다시 받습니다. HTTP 오류, 전송 중단, 검증값 불일치가 발생하면 임시 파일을 정리하고 기존 파일을 보존합니다. 오류를 해결한 뒤 4단계를 다시 실행합니다.

## 5. 한국어 음성의 사본 한 개로 인식을 확인한다

프로그램은 임시 사본으로 음성을 처리하고 입력 파일을 보존합니다. 여러 입력이 있어도 순서대로 처리하며, 한 파일이 실패해도 다음 파일을 처리합니다. 아래 절차에서는 결과를 직접 대조하기 위해 한국어 음성 한 개를 사용합니다. `npm start`는 `assets`의 지원 형식 파일을 모두 처리합니다.

내용을 직접 대조할 수 있는 20~30초 한국어 녹음을 준비합니다. 아래 `/원본/음성파일.wav`는 실제 원본 경로로 바꿉니다.

```bash
cp "/원본/음성파일.wav" ./assets/large-v3-test.wav
WHISPER_MODEL=large-v3 npm start
```

| 확인 대상 | 기대하는 결과 |
|---|---|
| 프로그램의 모델 선택 | `Whisper 모델: large-v3` |
| 인식 엔진의 모델 읽기 | `type = 5 (large v3)` |
| 모델의 입력 구조 | `n_mels = 128` |
| 실제 텍스트 파일 | 녹음 내용에 대응하는 한국어 문장 |

로그의 공백 수는 달라도 됩니다. 모델 선택 메시지만으로는 음성 인식을 확인할 수 없으므로 엔진 로그와 실제 파일을 함께 확인합니다.

```bash
cat ./output/large-v3-test.txt
```

실제 결과는 `output/large-v3-test.txt`입니다. 인식 엔진이 텍스트를 생성하지 않았거나 텍스트가 비어 있거나 결과 저장에 실패하면 변환 실패로 표시합니다. 실패한 파일이 있으면 프로그램의 종료 코드는 `1`이며 기존 결과 파일은 보존됩니다.

이번 변경은 Apple Silicon macOS에서 정식 모델의 검증값, Metal 실행, 한국어 자동 감지, 생성된 한국어 텍스트를 확인했습니다. 새 기기의 성공 여부는 위 엔진 로그와 실제 결과 파일로 판단합니다.

## 참고 자료

- [Whisper 공식 모델 설명](https://github.com/openai/whisper#available-models-and-languages)
- [whisper.cpp 공식 모델 파일과 검증값](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)
- [이 저장소의 설치·실행 안내](../README.md)
