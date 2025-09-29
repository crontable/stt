# 음성-텍스트 변환기 (Speech-to-Text Converter)

무료이고 API_KEY가 필요 없는 Node.js 기반 음성-텍스트 변환 프로그램입니다.
OpenAI Whisper 모델을 사용하여 로컬에서 실행됩니다.

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

먼저 Python과 FFmpeg가 설치되어 있어야 합니다:

```bash
# Python 설치 확인
python3 --version

# FFmpeg 설치 (macOS)
brew install ffmpeg

# FFmpeg 설치 (Ubuntu/Debian)
sudo apt update
sudo apt install ffmpeg

# FFmpeg 설치 (Windows)
# https://ffmpeg.org/download.html 에서 다운로드
```

### 2. 추가 요구사항 설치

macOS에서는 make 도구가 필요합니다:

```bash
# macOS - Xcode Command Line Tools 설치 (make 포함)
xcode-select --install
```

Linux에서는 build tools가 필요합니다:

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install build-essential

# CentOS/RHEL
sudo yum groupinstall "Development Tools"
```

### 3. Node.js 의존성 설치

```bash
npm install
```

### 4. Whisper 모델 다운로드

```bash
# 기본 모델 다운로드 (최초 실행 시 필요)
npx nodejs-whisper download
```

## 사용 방법

### 1. 음성 파일 준비

`assets/` 디렉터리에 변환하고 싶은 음성 파일들을 넣습니다:

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

변환된 텍스트 파일들이 `output/` 디렉터리에 생성됩니다:

```
output/
├── recording1.txt
├── interview.txt
└── lecture.txt
```

## 모델 옵션

`index.js` 파일에서 Whisper 모델을 변경할 수 있습니다:

- `tiny` - 가장 빠름, 정확도 낮음 (~39MB)
- `tiny.en` - 영어 전용 tiny 모델
- `base` - 기본값, 균형적 (~74MB)
- `base.en` - 영어 전용 base 모델
- `small` - 더 정확함 (~244MB)
- `small.en` - 영어 전용 small 모델
- `medium` - 높은 정확도 (~769MB)
- `medium.en` - 영어 전용 medium 모델
- `large-v1` - 최고 정확도 v1 (~1550MB)
- `large` - 최고 정확도 (~1550MB)
- `large-v3-turbo` - 최신 고속 모델

```javascript
const result = await nodewhisper(audioPath, {
  modelName: 'base', // 여기서 변경
  autoDownloadModelName: 'base', // 자동 다운로드할 모델명
  // ...
});
```

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
# 수동으로 모델 다운로드
npx nodejs-whisper download --model base
```

### 메모리 부족 오류

더 작은 모델을 사용해보세요 (`tiny` 또는 `base`)

## 라이선스

MIT License
