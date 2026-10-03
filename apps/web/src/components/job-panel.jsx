import ElapsedTime from './elapsed-time';
import { formatFileSize } from '../client/file-input';

const STATUS_LABELS = {
  accepted: '접수 완료',
  running: '처리 중',
  succeeded: '전사 완료',
  failed: '전사 실패',
  cancelled: '취소 완료',
};
const STAGE_LABELS = {
  preparing: '모델과 음성 파일을 준비하고 있습니다.',
  transcribing: '음성을 텍스트로 옮기고 있습니다.',
  cleaning: '전사 프로세스와 업로드 파일을 정리하고 있습니다.',
};
const TERMINAL_MESSAGES = {
  succeeded: '전사와 자원 정리가 끝났습니다. 아래에서 결과를 확인할 수 있습니다.',
  cancelled: '취소와 자원 정리가 끝났습니다. 다른 파일을 선택할 수 있습니다.',
  failed: '전사를 마치지 못했습니다. 아래 안내를 확인해 주세요.',
};

function LookupError({ message, retry }) {
  return (
    <div className="notice error" role="alert">
      <p>{message}</p>
      <button className="button secondary" type="button" onClick={retry}>같은 작업 다시 조회</button>
    </div>
  );
}

function JobPlaceholder({ jobId, lookupError, retry, reset }) {
  return (
    <section className="panel" aria-labelledby="job-heading">
      <h2 id="job-heading">작업 조회</h2>
      {lookupError ? <LookupError message={lookupError} retry={retry} /> : <p role="status">기존 작업의 상태를 불러오고 있습니다.</p>}
      <p className="job-id">작업 번호 {jobId}</p>
      {lookupError && <button className="text-button" type="button" onClick={reset}>새 파일 선택으로 돌아가기</button>}
    </section>
  );
}

function jobPresentation(job, cancelRequested) {
  const active = ['accepted', 'running'].includes(job.status);
  const label = job.cleanupRequired ? '정리 확인 필요' : STATUS_LABELS[job.status];
  const message = job.cleanupRequired
    ? '작업 자원을 모두 정리하지 못했습니다. 운영자가 아래 오류에 따라 서버 상태를 확인할 때까지 새 작업을 시작할 수 없습니다.'
    : STAGE_LABELS[active ? job.stage : ''] ?? TERMINAL_MESSAGES[job.status];
  if (active && cancelRequested) {
    return { active, label: '취소 정리 중', message: '취소를 접수했습니다. 프로세스와 파일 정리가 끝날 때까지 기다려 주세요.' };
  }
  return { active, label, message };
}

function JobActions({ job, active, cancelling, cancelRequested, cancel, reset }) {
  const cleaning = cancelling || cancelRequested || job.stage === 'cleaning';
  if (active) {
    const cleaningLabel = cancelRequested ? '취소 정리 중' : '정리 중';
    const buttonLabel = [
      { applies: cancelling, label: '취소 요청 중' },
      { applies: cleaning, label: cleaningLabel },
      { applies: true, label: '전사 취소' },
    ].find(({ applies }) => applies).label;
    return <button className="button secondary" type="button" onClick={cancel} disabled={cleaning}>{buttonLabel}</button>;
  }
  if (job.cleanupRequired || job.status === 'succeeded') {
    return null;
  }
  return <button className="button secondary" type="button" onClick={reset}>다른 파일 선택</button>;
}

export default function JobPanel({ job, jobId, lookupError, notice, cancelling, cancelRequested, cancel, retry, reset }) {
  if (!job) {
    return <JobPlaceholder jobId={jobId} lookupError={lookupError} retry={retry} reset={reset} />;
  }
  const { active, label, message } = jobPresentation(job, cancelRequested);
  return (
    <section className="panel" aria-labelledby="job-heading">
      <div className="panel-heading spaced">
        <h2 id="job-heading">현재 작업</h2>
        <span className={`status-badge status-${job.status}`}>{label}</span>
      </div>
      <p className="job-filename">{job.name}</p>
      <div className="job-details">
        <span>{formatFileSize(job.size)}</span>
        <span>{job.model}</span>
        <span>경과 <ElapsedTime startedAt={job.createdAt} finishedAt={active ? null : job.updatedAt} /></span>
      </div>
      <p className="stage-message" role="status">{active && <span className="activity-dot" aria-hidden="true" />}{message}</p>
      {job.error && <p className="notice error" role="alert">{job.error.message}</p>}
      {job.streamNotice && <p className="notice" role="status">{job.streamNotice}</p>}
      {lookupError && <LookupError message={lookupError} retry={retry} />}
      {notice && <p className="notice" role="status">{notice}</p>}
      <JobActions job={job} active={active} cancelling={cancelling} cancelRequested={cancelRequested} cancel={cancel} reset={reset} />
      <p className="job-id">작업 번호 {job.id}</p>
    </section>
  );
}
