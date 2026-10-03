'use client';

import { useTranscription } from '../client/use-transcription';
import FilePanel from '../components/file-panel';
import JobPanel from '../components/job-panel';
import ResultPanel from '../components/result-panel';

export default function Page() {
  const transcription = useTranscription();
  const job = transcription.job?.id === transcription.jobId ? transcription.job : null;
  return (
    <main className="workspace">
      <header className="page-header">
        <p className="eyebrow">STT <span aria-hidden="true">/</span> LARGE-V3</p>
        <h1>음성 파일을 텍스트로</h1>
        <p className="page-description">파일 한 개를 올리고, 전사 결과를 확인하세요.</p>
      </header>
      {transcription.jobId ? (
        <JobPanel
          job={job}
          jobId={transcription.jobId}
          lookupError={transcription.lookupError}
          notice={transcription.notice}
          cancelling={transcription.cancelling}
          cancelRequested={transcription.cancelRequested}
          cancel={transcription.cancel}
          retry={transcription.retry}
          reset={transcription.reset}
        />
      ) : (
        <FilePanel
          file={transcription.file}
          picking={transcription.picking}
          uploading={Boolean(transcription.uploadController)}
          uploadProgress={transcription.uploadProgress}
          notice={transcription.notice}
          selectFile={transcription.selectFile}
          beginPicking={transcription.beginPicking}
          cancelPicking={transcription.cancelPicking}
          upload={transcription.upload}
          cancel={transcription.cancel}
        />
      )}
      {job && (
        <ResultPanel
          key={job.id}
          job={job}
          text={transcription.result ?? transcription.partialText}
          finalReady={transcription.result !== null}
          resultError={job.status === 'succeeded' && transcription.lookupError}
          reset={transcription.reset}
        />
      )}
      <footer className="page-footer">
        <p>서버에서 한 작업씩 처리합니다. 실행 중인 작업은 주소를 통해 다시 조회할 수 있습니다.</p>
        <p>서버를 재시작하면 이전 작업은 조회할 수 없습니다. 완료한 텍스트 파일은 서버에 보관됩니다.</p>
      </footer>
    </main>
  );
}
