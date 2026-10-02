# 음성-텍스트 변환기 (Speech-to-Text Converter)

무료이고 API_KEY가 필요 없는 Node.js 기반 음성-텍스트 변환 프로그램입니다.
OpenAI Whisper 모델을 사용하여 로컬에서 실행됩니다.

기존 설치를 업그레이드하거나 다른 기기에서 준비하려면 [large-v3 업그레이드 방법](docs/large-v3-upgrade.md)을 따릅니다. 의존성 설치, 실행 엔진 빌드, 모델 준비, 실제 한국어 인식 확인을 순서대로 설명합니다.

## 특징

- ✅ **완전 무료** - API_KEY 불필요
- 🔒 **프라이버시 보호** - 로컬에서 실행, 외부 전송 없음
- 🎯 **간단한 사용법** - 파일을 넣고 명령어 하나로 실행
- 🌍 **다국어 지원** - 자동 언어 감지
- 📁 **배치 처리** - 여러 파일을 순서대로 변환

## 지원하는 파일 형식

`.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.mp4`, `.avi`, `.mov`

## 설치 방법

### 1. 사전 요구사항

Node.js 18.3 이상, pnpm 12.5.1, FFmpeg가 필요합니다. Node.js는 프로그램 실행과 모델 다운로드에, pnpm은 의존성 설치와 실행 명령 관리에, FFmpeg는 음성 형식 변환에 사용합니다.

```bash
# Node.js 버전 확인
node --version

# FFmpeg 설치 (macOS)
brew install ffmpeg

# FFmpeg 설치 (Ubuntu/Debian)
sudo apt update
sudo apt install ffmpeg

# FFmpeg 설치 (Windows)
# https://ffmpeg.org/download.html 에서 다운로드
```

### 2. 추가 요구사항 설치

실행 엔진을 빌드하려면 make와 CMake(프로젝트의 빌드 설정을 만드는 도구)가 필요합니다.

```bash
# macOS - Xcode Command Line Tools 설치 (make 포함)
xcode-select --install
brew install cmake
```

리눅스에서는 C/C++ 컴파일러와 빌드 도구가 필요합니다.

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install build-essential cmake

# CentOS/RHEL
sudo yum groupinstall "Development Tools"
sudo yum install cmake
```

### 3. Node.js 의존성 설치

pnpm이 없으면 macOS와 리눅스에서 아래 공식 설치 스크립트로 이 프로젝트가 사용하는 버전을 설치합니다. 설치가 끝나면 설치 도구가 안내한 대로 셸을 다시 열고 버전을 확인합니다.

```bash
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.5.1 sh -
pnpm --version
```

Windows에서는 PowerShell에서 같은 버전을 지정해 설치합니다.

```powershell
$env:PNPM_VERSION = '12.5.1'
Invoke-WebRequest https://get.pnpm.io/install.ps1 -UseBasicParsing | Invoke-Expression
pnpm --version
```

pnpm 버전 출력이 `12.5.1`인지 확인한 뒤 저장소 최상위 폴더에서 의존성을 설치합니다. pnpm 12의 독립 설치 방식은 Node.js 없이도 설치 도구를 실행할 수 있지만, 이 프로그램을 실행하려면 Node.js가 필요합니다. 설치 방식은 [pnpm 공식 설치 안내](https://github.com/pnpm/pnpm.io/blob/main/docs/installation.md)를 따릅니다.

```bash
pnpm install --frozen-lockfile
```

`package.json`의 `packageManager`는 pnpm 버전을 지정하고, `pnpm-lock.yaml`은 의존성 버전을 기록합니다. `--frozen-lockfile`은 기록된 버전을 바꾸지 않고 설치하므로 다른 기기에서도 같은 의존성을 사용합니다. 설정과 잠금 파일이 맞지 않으면 설치를 중단합니다.

### 4. Whisper 모델 다운로드

새로 설치한 환경에서는 먼저 아래 명령으로 음성 인식 실행 파일을 빌드합니다. 이미 실행 가능한 `whisper-cli`가 준비되어 있으면 빌드 명령은 생략합니다.

```bash
cmake -S node_modules/nodejs-whisper/cpp/whisper.cpp -B node_modules/nodejs-whisper/cpp/whisper.cpp/build
cmake --build node_modules/nodejs-whisper/cpp/whisper.cpp/build --config Release

# 최초 실행 시 정식 large-v3 모델을 자동으로 다운로드하고 검증합니다.
pnpm start
```

기본 모델은 한국어 정확도를 우선하는 다국어 `large-v3`입니다. 모델 파일은 약 3.1GB이며, 최초 다운로드에는 인터넷 연결이 필요합니다. 다운로드 후 음성 인식은 로컬에서 실행됩니다.

설치된 `nodejs-whisper` 0.2.9는 `large`라는 이름을 실제 배포 파일 이름과 다르게 연결합니다. 이 프로그램은 정식 `ggml-large-v3.bin`을 받아 라이브러리가 읽는 `ggml-large.bin` 경로에 저장합니다. 파일의 SHA1 검증값이 공식 값과 일치할 때만 적용하고, 오류 응답이나 불완전한 다운로드는 모델로 적용하지 않습니다.

## 사용 방법

### 1. 음성 파일 준비

`assets/` 디렉터리에 변환할 음성 파일을 넣습니다. 프로그램은 임시 사본을 처리하므로 입력 파일을 덮어쓰거나 삭제하지 않습니다.

```
assets/
├── recording1.mp3
├── interview.wav
└── lecture.m4a
```

### 2. 변환 실행

```bash
pnpm start
# 또는
node index.js
```

`assets/` 밖의 파일이나 폴더를 선택하려면 `--input` 또는 `-i` 옵션을 사용합니다. 실행 예시, 경로 해석, 결과 저장과 오류 처리는 [CLI 입력 경로 지정 방법](docs/명령줄-입력-경로-지정.md)에 설명합니다.

### 3. 결과 확인

결과는 `output/이름.txt`에서 확인합니다. 실제로 생성된 텍스트가 비어 있지 않고 결과 폴더에 저장되었을 때만 성공으로 표시합니다.

```
output/
├── recording1.txt
├── interview.txt
└── lecture.txt
```

한 파일이 실패해도 나머지 입력은 계속 처리합니다. 실패한 파일과 이유를 마지막에 표시하며, 실패가 있으면 종료 코드가 `1`입니다. 인식이나 결과 저장에 실패하면 이전에 저장한 텍스트 파일을 보존합니다.

`meeting.mp3`와 `meeting.wav`처럼 같은 결과 이름을 만드는 입력은 덮어쓰기를 막기 위해 모두 실패로 표시합니다. 대소문자나 한글의 유니코드 표현만 다른 이름도 충돌로 처리합니다. 입력 이름을 서로 다르게 지정한 뒤 다시 실행합니다.

한국어 인식 확인 절차는 [업그레이드 문서의 5단계](docs/large-v3-upgrade.md#5-한국어-음성의-사본-한-개로-인식을-확인한다)에 있습니다.

## 모델 옵션

기본 실행은 `large-v3`를 사용합니다. 다른 모델을 선택하려면 `WHISPER_MODEL` 환경 변수(이번 실행에 사용할 모델 이름)를 지정합니다. 실제 인식 모델과 자동 다운로드 모델이 같은 이름으로 선택됩니다.

```bash
# 한국어 정확도를 우선하는 기본 모델
pnpm start

# 처리 속도를 우선하는 모델
WHISPER_MODEL=large-v3-turbo pnpm start

# 이전에 사용하던 작은 모델
WHISPER_MODEL=base pnpm start
```

| 모델 이름 | 언어 | 모델 파일 크기 | 용도 |
|---|---|---|---|
| `tiny`, `tiny.en` | 다국어, 영어 전용 | 약 75MiB | 빠른 처리 |
| `base`, `base.en` | 다국어, 영어 전용 | 약 142MiB | 적은 자원 사용 |
| `small`, `small.en` | 다국어, 영어 전용 | 약 466MiB | 속도와 정확도 고려 |
| `medium`, `medium.en` | 다국어, 영어 전용 | 약 1.5GiB | 상위 모델보다 적은 자원 사용 |
| `large-v1` | 다국어 | 약 2.9GiB | 이전 large 모델 |
| `large-v3`, `large` | 다국어 | 약 2.9GiB | 현재 기본값, 한국어 정확도 우선 |
| `large-v3-turbo` | 다국어 | 약 1.5GiB | large-v3보다 빠른 처리 |

이 프로그램에서 `large`는 검증된 `large-v3`를 사용합니다. `.en`이 붙은 모델은 영어 전용입니다. 큰 모델은 작은 모델보다 메모리를 더 사용하고 처리 시간이 길어집니다. 실제 정확도와 처리 시간은 녹음 상태와 컴퓨터에 따라 달라집니다.

모델 구성과 속도·정확도의 관계는 [Whisper 공식 설명](https://github.com/openai/whisper#available-models-and-languages), 파일 크기와 검증값은 [whisper.cpp 공식 모델 목록](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)을 따릅니다.

## 문제 해결

### Build Tools 관련 오류

```bash
# macOS - Xcode Command Line Tools 확인
xcode-select -p

# Linux - build-essential 확인
gcc --version
make --version
```

### FFmpeg 관련 오류

```bash
# FFmpeg 설치 확인
ffmpeg -version
```

### 모델 다운로드 오류

```bash
# large-v3 다운로드 또는 검증에 실패하면 다시 실행합니다.
pnpm start
```

`large-v3`와 `large`는 매번 파일을 검증하므로, 잘못 저장된 기존 모델도 자동으로 다시 받습니다. 다른 모델의 다운로드는 연결 라이브러리가 처리합니다. `pnpm exec nodejs-whisper download`는 설치된 라이브러리의 대화형 다운로드 도구이며 이 버전에서는 `--model` 인수를 읽지 않습니다.

### 메모리 부족 오류

실행할 모델을 더 작게 지정합니다.

```bash
WHISPER_MODEL=base pnpm start
```

## 개발 검사

ESLint는 JavaScript 코드의 오류와 코드 규약 위반을 실행 전에 검사합니다. `lift`의 루트 Airbnb 기본 규칙과 웹의 선언형 처리·코드 품질 규칙을 가져왔습니다. 설정은 저장소 최상위의 `eslint.config.mjs`에 있으며 실행 코드, 테스트, 설정 파일을 함께 검사합니다.

```bash
# 오류와 경고가 모두 없어야 통과합니다.
pnpm lint

# 자동으로 고칠 수 있는 항목을 수정한 뒤 검사합니다.
pnpm lint:fix

# 기존 음성 변환 동작을 확인합니다.
pnpm test
```

ESLint 개발 검사에는 Node.js `^18.18.0`, `^20.9.0` 또는 `>=21.1.0`이 필요합니다. ESLint와 플러그인은 개발 의존성으로 설치하며, 음성 인식에는 기존 런타임 의존성을 사용합니다.

| 검사 기준 | 적용 내용 |
|---|---|
| 선언형 처리 | 루프, 객체·배열의 직접 대입, 매개변수 변경, 증감 연산을 검사합니다. 프로젝트 지침에 따라 Promise의 `.then()`·`.catch()` 체이닝도 금지합니다. |
| 코드 품질 | 복잡도 10, 중첩 3, 매개변수 5개, 함수 120줄, 파일 600줄을 기준으로 검사합니다. 경고도 실패로 처리하므로 목표값을 넘기면 통과하지 못합니다. |
| 중복과 모듈 | 규칙의 검사 대상인 10자 이상 문자열이 세 번 이상 반복되는지, 모듈 경로와 불러오는 순서가 올바른지 검사합니다. |
| 검사 예외 | 예외 주석에는 한국어 사유를 적습니다. 사용하지 않는 예외 주석도 오류로 처리합니다. 테스트는 `lift`와 같이 문자열 중복과 길이·복잡도 기준에서 제외합니다. |

Node의 종료 코드와 CommonJS 공개 함수 지정, 테스트의 직접 실행 판별은 해당 대입 한 줄에만 사유를 적어 유지합니다. ESLint 설정에서 사용하는 내장 규칙 경로도 기본 모듈 해석기가 찾지 못하는 한 줄에만 예외를 둡니다.

Airbnb 설정은 `lift`와 같이 ESLint 9의 `FlatCompat`로 불러옵니다. Airbnb가 선언한 ESLint 지원 범위는 7·8이므로 설치 시 peer 의존성 경고가 발생합니다. 이 프로젝트는 실제 사용 버전을 잠금 파일에 기록하고 `pnpm lint`로 설정 실행을 확인합니다.

참고 저장소와 같은 ESLint 9.39.4를 사용합니다. ESLint 9 계열은 2026년 8월 6일 공식 지원이 종료됐으며 이후 유지보수 업데이트를 받지 않습니다. 지원 상태는 [ESLint 공식 안내](https://eslint.org/version-support/)에서 확인할 수 있습니다.

## 라이선스

MIT License
