import Image from 'next/image';
import { useState } from 'react';

const TRANSCRIPTION_ANIMATIONS = ['wave', 'segments', 'echo'];

function animationSource(jobId) {
  // 작업 UUID의 무작위 부분을 사용하므로 구간 갱신과 재조회에서도 같은 동작을 유지합니다.
  const index = Number.parseInt(jobId.slice(0, 8), 16) % TRANSCRIPTION_ANIMATIONS.length;
  return `/animations/transcription-${TRANSCRIPTION_ANIMATIONS[index]}.svg`;
}

function resultPresentation(job, text, finalReady, resultError) {
  const active = ['accepted', 'running'].includes(job.status);
  const presentations = [
    { applies: active && !text, heading: '중간 전사 결과', message: '첫 전사 구간을 기다리고 있습니다. 완성되는 구간부터 여기에 표시합니다.' },
    { applies: active, heading: '중간 전사 결과', message: '새 구간이 완성되면 텍스트를 추가합니다.' },
    { applies: job.status === 'succeeded' && finalReady, heading: '전사 결과', message: '최종 파일의 전체 전사 결과입니다.' },
    { applies: Boolean(resultError), heading: '전사 결과 확인 필요', message: '최종 파일을 읽지 못했습니다. 위의 같은 작업 다시 조회 버튼으로 다시 읽을 수 있습니다. 표시된 텍스트는 받은 부분 결과입니다.' },
    { applies: job.status === 'succeeded', heading: '전사 결과 확인 중', message: '저장된 최종 결과를 읽고 있습니다. 받은 부분 텍스트는 유지합니다.' },
    { applies: true, heading: '미완료 전사 결과', message: text ? '작업이 완료되지 않았습니다. 아래 텍스트는 종료 전에 받은 부분 결과입니다.' : '작업이 끝나기 전에 받은 전사 텍스트가 없습니다.' },
  ];
  return { ...presentations.find(({ applies }) => applies), active };
}

export default function ResultPanel({ job, text, finalReady, resultError, reset }) {
  const [copyNotice, setCopyNotice] = useState(null);
  const { heading, message, active } = resultPresentation(job, text, finalReady, resultError);

  async function copy() {
    if (!window.isSecureContext || !navigator.clipboard?.writeText) {
      setCopyNotice('이 접속 주소에서는 자동 복사를 사용할 수 없습니다. 아래 결과를 선택해 직접 복사하거나 텍스트 파일을 내려받아 주세요.');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice('현재 표시된 텍스트를 복사했습니다.');
    } catch {
      setCopyNotice('브라우저가 자동 복사를 허용하지 않았습니다. 아래 결과를 선택해 직접 복사하거나 텍스트 파일을 내려받아 주세요.');
    }
  }

  function selectText(event) {
    event.currentTarget.form.elements.result.select();
    setCopyNotice('결과를 선택했습니다. 이 기기의 복사 명령을 사용해 주세요.');
  }

  return (
    <section className="panel result-panel" aria-labelledby="result-heading">
      <div className="panel-heading spaced">
        <h2 id="result-heading">{heading}</h2>
        <span className="result-format">텍스트</span>
      </div>
      <p id="result-status" role="status" className={active ? 'transcription-loading' : undefined}>
        {active && <Image src={animationSource(job.id)} width={120} height={40} alt="" unoptimized aria-hidden="true" />}
        <span className={active ? 'visually-hidden' : undefined}>{message}</span>
      </p>
        <form onSubmit={(event) => event.preventDefault()}>
          <label className="visually-hidden" htmlFor="transcription-result">전사된 텍스트</label>
          <textarea id="transcription-result" name="result" value={text} readOnly spellCheck={false} aria-describedby="result-status" />
          <div className="result-actions">
            <button className="button primary" type="button" onClick={copy} disabled={!text}>{finalReady ? '결과 복사' : '부분 결과 복사'}</button>
            {job.status === 'succeeded' && <a className="button secondary" href={job.resultUrl} download>텍스트 다운로드</a>}
            <button className="text-button" type="button" onClick={selectText} disabled={!text}>텍스트 선택</button>
          </div>
          {copyNotice && <p className="notice" role="status">{copyNotice}</p>}
        </form>
      <div className="result-footer">
        <p>결과를 다른 프로그램에 전달할 수 있습니다.</p>
        {job.status === 'succeeded' && !job.cleanupRequired && <button className="text-button" type="button" onClick={reset}>다음 파일 선택</button>}
      </div>
    </section>
  );
}
