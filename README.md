# 음성-텍스트 변환기 (Speech-to-Text Converter)

무료이고 API_KEY가 필요 없는 Node.js 기반 음성-텍스트 변환 프로그램입니다.
OpenAI Whisper 모델을 사용하여 로컬에서 실행됩니다.

기존 설치를 업그레이드하거나 다른 기기에서 준비하려면 [large-v3 업그레이드 방법](docs/large-v3-upgrade.md)을 따릅니다. 의존성 설치, 실행 엔진 빌드, 모델 준비, 실제 한국어 인식 확인을 순서대로 설명합니다.

## 특징

- ✅ **완전 무료** - API_KEY 불필요
- 🔒 **프라이버시 보호** - 로컬에서 실행, 외부 전송 없음
- 🎯 **간단한 사용법** - 파일을 넣고 명령어 하나로 실행
- 🌍 **다국어 지원** - 자동 언어 감지
- 📁 **배치 처리** - 여러 파일 동시 변환

## 지원하는 파일 형식

`.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.mp4`, `.avi`, `.mov`

## 설치 방법

### 1. 사전 요구사항

Node.js 18 이상과 FFmpeg가 필요합니다. Node.js는 프로그램 실행과 모델 다운로드에, FFmpeg는 음성 형식 변환에 사용합니다.

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

```bash
npm install
```

### 4. Whisper 모델 다운로드

새로 설치한 환경에서는 먼저 아래 명령으로 음성 인식 실행 파일을 빌드합니다. 이미 실행 가능한 `whisper-cli`가 준비되어 있으면 빌드 명령은 생략합니다.

```bash
cmake -S node_modules/nodejs-whisper/cpp/whisper.cpp -B node_modules/nodejs-whisper/cpp/whisper.cpp/build
cmake --build node_modules/nodejs-whisper/cpp/whisper.cpp/build --config Release

# 최초 실행 시 정식 large-v3 모델을 자동으로 다운로드하고 검증합니다.
npm start
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
npm start
# 또는
node index.js
```

### 3. 결과 확인

결과는 `output/이름.txt`에서 확인합니다. 실제로 생성된 텍스트가 비어 있지 않고 결과 폴더에 저장되었을 때만 성공으로 표시합니다.

```
output/
├── recording1.txt
├── interview.txt
└── lecture.txt
```

인식이나 결과 저장에 실패하면 이전에 저장한 텍스트 파일을 보존합니다. 연속 처리 중 작업 폴더가 바뀌는 문제는 남아 있으므로 입력 한 개로 확인합니다.

한국어 인식 확인 절차는 [업그레이드 문서의 5단계](docs/large-v3-upgrade.md#5-한국어-음성의-사본-한-개로-인식을-확인한다)에 있습니다.

## 모델 옵션

기본 실행은 `large-v3`를 사용합니다. 다른 모델을 선택하려면 `WHISPER_MODEL` 환경 변수(이번 실행에 사용할 모델 이름)를 지정합니다. 실제 인식 모델과 자동 다운로드 모델이 같은 이름으로 선택됩니다.

```bash
# 한국어 정확도를 우선하는 기본 모델
npm start

# 처리 속도를 우선하는 모델
WHISPER_MODEL=large-v3-turbo npm start

# 이전에 사용하던 작은 모델
WHISPER_MODEL=base npm start
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
npm start
```

`large-v3`와 `large`는 매번 파일을 검증하므로, 잘못 저장된 기존 모델도 자동으로 다시 받습니다. 다른 모델의 다운로드는 연결 라이브러리가 처리합니다. `npx nodejs-whisper download`는 대화형 다운로드 도구이며 이 버전에서는 `--model` 인수를 읽지 않습니다.

### 메모리 부족 오류

실행할 모델을 더 작게 지정합니다.

```bash
WHISPER_MODEL=base npm start
```

## 라이선스

MIT License
