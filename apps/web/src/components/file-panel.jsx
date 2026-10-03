import ElapsedTime from './elapsed-time';
import { FILE_ACCEPT, fileError, formatFileSize, SUPPORTED_EXTENSIONS } from '../client/file-input';

function UploadProgress({ progress, cancel }) {
  const percent = Math.floor((progress.loaded / progress.total) * 100);
  return (
    <div className="upload-progress">
      <div className="upload-status-row">
        <p role="status"><span className="activity-dot" aria-hidden="true" />{progress.sent ? '파일 전송이 끝났습니다. 서버의 저장·접수를 기다리고 있습니다.' : '파일을 서버로 올리고 있습니다.'}</p>
        <button className="button secondary" type="button" onClick={cancel}>업로드 취소</button>
      </div>
      <progress aria-label="파일 업로드 진행률" max={progress.total} value={progress.loaded} />
      <p className="upload-detail">{formatFileSize(progress.loaded)} / {formatFileSize(progress.total)} · {percent}% · 경과 <ElapsedTime startedAt={progress.startedAt} /></p>
      <p className="upload-help">대용량 파일은 업로드 준비와 전송에 시간이 걸릴 수 있습니다.</p>
    </div>
  );
}

export default function FilePanel({ file, picking, uploading, uploadProgress, notice, selectFile, beginPicking, cancelPicking, upload, cancel }) {
  const validationError = fileError(file);

  function attachCancelListener(input) {
    if (!input) {
      return undefined;
    }
    // React는 파일 입력의 cancel을 직접 듣지 않으므로 실제 입력 요소에 연결합니다.
    input.addEventListener('cancel', cancelPicking);
    return () => input.removeEventListener('cancel', cancelPicking);
  }

  return (
    <section className="panel" aria-labelledby="file-heading">
      <div className="panel-heading">
        <span className="step-number" aria-hidden="true">1</span>
        <h2 id="file-heading">음성 파일 선택</h2>
      </div>
      <label className={`file-picker${uploading ? ' is-disabled' : ''}`} htmlFor="audio-file">
        <span className="file-picker-icon" aria-hidden="true">↑</span>
        <span className="file-picker-text">
          <strong>{file ? '다른 파일 선택' : '파일 선택'}</strong>
          <span>이 기기에 있는 음성 또는 영상 파일 한 개</span>
        </span>
        <input
          id="audio-file"
          ref={attachCancelListener}
          type="file"
          accept={FILE_ACCEPT}
          disabled={uploading}
          aria-busy={picking}
          aria-describedby="file-formats file-limit file-validation file-picking"
          onClick={beginPicking}
          onChange={(event) => selectFile(event.target.files?.[0] ?? null)}
        />
      </label>
      <div className="file-help">
        <p id="file-formats">{SUPPORTED_EXTENSIONS.map((extension) => extension.toUpperCase()).join(' · ')}</p>
        <p id="file-limit">한 파일 최대 512 MiB · large-v3 모델</p>
      </div>
      {picking && <p id="file-picking" className="notice" role="status">파일 선택 반영을 기다리고 있습니다. 대용량 파일은 브라우저에 반영될 때까지 시간이 걸릴 수 있습니다.</p>}
      {file && (
        <div className="selected-file">
          <span className="filename">{file.name}</span>
          <span className="file-size">{formatFileSize(file.size)}</span>
        </div>
      )}
      <p id="file-validation" className="validation-message" role={validationError ? 'alert' : undefined}>
        {validationError}
      </p>
      {notice && <p className="notice" role="status">{notice}</p>}
      {uploading ? (
        <UploadProgress progress={uploadProgress} cancel={cancel} />
      ) : (
        <button className="button primary full-width" type="button" disabled={picking || !file || Boolean(validationError)} onClick={upload}>
          전사 시작
        </button>
      )}
    </section>
  );
}
