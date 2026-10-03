import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../..', import.meta.url));
const developmentHosts = Object.values(networkInterfaces()).flatMap((addresses) => addresses || [])
  .filter(({ internal }) => !internal)
  .map(({ address }) => address);

const nextConfig = {
  agentRules: false,
  // 같은 기기와 이 서버의 네트워크 주소에서 개발 화면 갱신을 허용합니다.
  allowedDevOrigins: ['localhost', '127.0.0.1', ...developmentHosts],
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
};

export default nextConfig;
