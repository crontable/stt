export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerJobShutdown } = await import('./server/transcription-jobs.js');
    registerJobShutdown();
  }
}
