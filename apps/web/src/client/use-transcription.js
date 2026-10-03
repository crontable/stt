'use client';

import { useEffect, useReducer, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

import { fileError } from './file-input';
import { getJobId, getServerJobId, setJobId, subscribeJobUrl } from './job-url';
import { connectionError, requestJob, requestResult } from './transcription-api';
import { subscribeTranscription } from './transcription-stream';
import { uploadFile } from './upload-file';

const INITIAL_STATE = {
  file: null,
  picking: false,
  uploadController: null,
  uploadProgress: null,
  job: null,
  result: null,
  partialText: '',
  connection: 'idle',
  notice: null,
  lookupError: null,
  cancelling: false,
  cancelRequested: false,
  retryVersion: 0,
};

function jobUpdate(state, job) {
  const sameJob = state.job?.id === job.id;
  return {
    job,
    lookupError: null,
    notice: sameJob ? state.notice : null,
    result: sameJob ? state.result : null,
    partialText: sameJob ? state.partialText : '',
    cancelling: sameJob && state.cancelling,
    cancelRequested: sameJob && ['accepted', 'running'].includes(job.status) && state.cancelRequested,
  };
}

function reducer(state, action) {
  const updates = {
    picking: () => ({ picking: action.value }),
    select: () => ({ file: action.file, picking: false, notice: null }),
    upload: () => ({ uploadController: action.controller, uploadProgress: action.progress, notice: null, lookupError: null }),
    uploadProgress: () => (state.uploadController === action.controller ? { uploadProgress: { ...state.uploadProgress, ...action.progress } } : {}),
    uploadDone: () => (state.uploadController === action.controller ? { uploadController: null, uploadProgress: null } : {}),
    job: () => jobUpdate(state, action.job),
    stream: () => ({ ...jobUpdate(state, action.transcript.job), partialText: action.transcript.text }),
    result: () => (state.job?.id === action.id ? { result: action.result } : {}),
    resultLoading: () => ({ result: null }),
    connection: () => ({
      connection: action.value,
      lookupError: action.value === 'reconnecting'
        ? '전사 연결이 끊겨 다시 연결하고 있습니다. 이미 받은 텍스트는 유지됩니다.' : null,
    }),
    notice: () => ({ notice: action.message }),
    lookupError: () => ({ lookupError: action.message }),
    cancelling: () => ({ cancelling: action.value }),
    cancelRequested: () => ({ cancelRequested: action.value }),
    retry: () => ({ lookupError: null, retryVersion: state.retryVersion + 1 }),
    reset: () => INITIAL_STATE,
  };
  return { ...state, ...updates[action.type]() };
}

export function useTranscription() {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const jobId = useSyncExternalStore(subscribeJobUrl, getJobId, getServerJobId);
  const eventsUrl = state.job?.id === jobId && state.job.eventsUrl
    ? state.job.eventsUrl : `/api/transcriptions/${encodeURIComponent(jobId)}/events`;

  useEffect(() => {
    if (!jobId) {
      return undefined;
    }
    return subscribeTranscription(jobId, {
      onUpdate: (transcript) => dispatch({ type: 'stream', transcript }),
      onJob: (job) => dispatch({ type: 'job', job }),
      onResult: (id, result) => dispatch({ type: 'result', id, result }),
      onResultLoading: () => dispatch({ type: 'resultLoading' }),
      onConnection: (value) => dispatch({ type: 'connection', value }),
      onError: (message) => dispatch({ type: 'lookupError', message }),
    }, {
      isCurrent: () => getJobId() === jobId,
      eventsUrl,
      loadJob: requestJob,
      loadResult: requestResult,
      formatError: connectionError,
    });
  }, [eventsUrl, jobId, state.retryVersion]);

  async function upload() {
    if (!state.file || fileError(state.file) || state.picking || state.uploadController || jobId) {
      return;
    }
    const controller = new AbortController();
    // 파일 전송 API가 시작되기 전에 업로드 상태와 취소 버튼을 DOM에 반영합니다.
    flushSync(() => dispatch({
      type: 'upload',
      controller,
      progress: { loaded: 0, total: state.file.size, sent: false, startedAt: new Date().toISOString() },
    }));
    try {
      const job = await uploadFile(state.file, controller.signal, (progress) => {
        if (getJobId() === jobId) {
          dispatch({ type: 'uploadProgress', controller, progress });
        }
      });
      if (getJobId() === jobId) {
        dispatch({ type: 'job', job });
        setJobId(job.id);
      }
    } catch (error) {
      if (getJobId() === jobId) {
        dispatch({
          type: 'notice',
          message: controller.signal.aborted
            ? '업로드를 취소했습니다. 서버가 받은 부분 파일을 정리합니다.'
            : connectionError(error, '파일을 올리지 못했습니다. 서버 연결을 확인하고 다시 시작해 주세요.'),
        });
      }
    } finally {
      dispatch({ type: 'uploadDone', controller });
    }
  }

  async function cancel() {
    if (state.uploadController) {
      state.uploadController.abort();
      return;
    }
    if (!jobId || state.cancelling) {
      return;
    }
    dispatch({ type: 'cancelling', value: true });
    dispatch({ type: 'notice', message: null });
    try {
      const job = await requestJob(`/api/transcriptions/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
      if (getJobId() === jobId) {
        dispatch({ type: 'job', job });
        dispatch({ type: 'cancelRequested', value: ['accepted', 'running'].includes(job.status) });
        if (!['connected', 'connecting', 'reconnecting'].includes(state.connection)) {
          dispatch({ type: 'retry' });
        }
      }
    } catch (error) {
      if (getJobId() === jobId) {
        dispatch({ type: 'notice', message: connectionError(error, '취소를 요청하지 못했습니다. 서버 연결을 확인한 뒤 다시 요청해 주세요.') });
      }
    } finally {
      if (getJobId() === jobId) {
        dispatch({ type: 'cancelling', value: false });
      }
    }
  }

  function reset() {
    if (state.uploadController || ['accepted', 'running'].includes(state.job?.status)) {
      return;
    }
    setJobId('');
    dispatch({ type: 'reset' });
  }

  function beginPicking() {
    // 기본 파일 선택 창이 열리기 전에 선택 대기 안내를 DOM에 반영합니다.
    flushSync(() => dispatch({ type: 'picking', value: true }));
  }

  return {
    ...state,
    jobId,
    selectFile: (file) => dispatch({ type: 'select', file }),
    beginPicking,
    cancelPicking: () => dispatch({ type: 'picking', value: false }),
    retry: () => dispatch({ type: 'retry' }),
    upload,
    cancel,
    reset,
  };
}
