import { useEffect, useState } from 'react';

export default function ElapsedTime({ startedAt, finishedAt }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finishedAt) {
      return undefined;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [finishedAt]);
  const seconds = Math.max(0, Math.floor(((finishedAt ? Date.parse(finishedAt) : now) - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return <span>{minutes > 0 ? `${minutes}분 ` : ''}{seconds % 60}초</span>;
}
