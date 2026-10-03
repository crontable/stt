import { loadEnvFile } from 'node:process';

// Next가 CLI 옵션을 자식에게 전달하기 전에 개발 부모의 종료 대기를 설정합니다.
loadEnvFile(new URL('../.env.development', import.meta.url));
await import('next/dist/bin/next');
