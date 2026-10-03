const JOB_URL_EVENT = 'stt-job-url';

export function subscribeJobUrl(listener) {
  window.addEventListener('popstate', listener);
  window.addEventListener(JOB_URL_EVENT, listener);
  return () => {
    window.removeEventListener('popstate', listener);
    window.removeEventListener(JOB_URL_EVENT, listener);
  };
}

export function getJobId() {
  return new URL(window.location.href).searchParams.get('job') ?? '';
}

export function getServerJobId() {
  return '';
}

export function setJobId(id) {
  const url = new URL(window.location.href);
  if (id) {
    url.searchParams.set('job', id);
  } else {
    url.searchParams.delete('job');
  }
  window.history.replaceState(null, '', url);
  window.dispatchEvent(new Event(JOB_URL_EVENT));
}
