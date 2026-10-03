export const SUPPORTED_EXTENSIONS = ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'mp4', 'avi', 'mov'];
export const MAX_FILE_SIZE = 512 * 1024 * 1024;
export const FILE_ACCEPT = SUPPORTED_EXTENSIONS.map((extension) => `.${extension}`).join(',');

export function fileError(file) {
  if (!file) {
    return null;
  }

  const extension = file.name.split('.').at(-1).toLowerCase();
  const rules = [
    { violated: !SUPPORTED_EXTENSIONS.includes(extension), message: '지원하는 음성·영상 형식의 파일을 선택해 주세요.' },
    { violated: file.size === 0, message: '내용이 없는 파일입니다. 다른 파일을 선택해 주세요.' },
    { violated: file.size > MAX_FILE_SIZE, message: '파일은 512 MiB 이하로 선택해 주세요.' },
  ];
  return rules.find(({ violated }) => violated)?.message ?? null;
}

export function formatFileSize(size) {
  const unit = size >= 1024 * 1024 ? { divisor: 1024 * 1024, name: 'MiB' } : { divisor: 1024, name: 'KiB' };
  const value = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 1 }).format(size / unit.divisor);
  return `${value} ${unit.name}`;
}
