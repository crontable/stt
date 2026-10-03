const { execFile, spawn, spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const { createExecutionError } = require('./errors');

const executeFile = promisify(execFile);

function sendGroupSignal(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function activeGroupMembers(pid) {
  const { stdout } = await executeFile('ps', ['-axo', 'pid=,pgid=,stat=']);
  return stdout.trim().split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => Number(fields[1]) === pid && !fields[2].startsWith('Z'))
    .map((fields) => Number(fields[0]));
}

async function signalActiveGroup(pid, signal) {
  if ((await activeGroupMembers(pid)).length === 0) {
    return false;
  }
  try {
    return sendGroupSignal(pid, signal);
  } catch (error) {
    // 조회와 신호 사이에 마지막 멤버가 종료됐는지 실제 그룹 상태로 확인합니다.
    if ((await activeGroupMembers(pid)).length === 0) {
      return false;
    }
    throw error;
  }
}

async function waitForGroupExit(pid, attempts = 15) {
  if ((await activeGroupMembers(pid)).length === 0) {
    return;
  }
  if (attempts === 0) {
    throw createExecutionError('STT_PROCESS_CLEANUP_FAILED', '전사 작업의 하위 프로세스가 종료되지 않았습니다.', { pid });
  }
  await delay(100);
  await waitForGroupExit(pid, attempts - 1);
}

async function terminateWindowsTree(pid) {
  const code = await new Promise((resolve, reject) => {
    const command = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    command.once('error', reject);
    command.once('exit', resolve);
  });
  if (code !== 0 || processExists(pid)) {
    throw createExecutionError('STT_PROCESS_CLEANUP_FAILED', '전사 작업의 하위 프로세스를 종료하지 못했습니다.', { pid });
  }
}

async function terminateProcessTree(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    await terminateWindowsTree(pid);
    return;
  }
  if (await signalActiveGroup(pid, 'SIGTERM')) {
    await delay(250);
    await signalActiveGroup(pid, 'SIGKILL');
    await waitForGroupExit(pid);
  }
}

function terminateProcessTreeOnExit(pid) {
  if (!pid) {
    return;
  }
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    sendGroupSignal(pid, 'SIGKILL');
  } catch {
    // 종료 시에는 비동기 정리를 기다릴 수 없으므로 소유한 그룹에만 종료 신호를 보냅니다.
  }
}

// eslint-disable-next-line no-restricted-syntax -- CommonJS 진입점에 작업 프로세스 종료 함수를 한 번 등록합니다.
module.exports = { terminateProcessTree, terminateProcessTreeOnExit };
