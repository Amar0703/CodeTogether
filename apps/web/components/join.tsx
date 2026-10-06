'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { api, ApiError, message } from '../lib/api';
import { Brand, ErrorBanner } from './ui';
export function Join({ token }: { token: string }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api('/auth/me')
      .then(() => setReady(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401)
          router.replace(`/login?next=${encodeURIComponent(`/join/${token}`)}`);
        else setError(message(err));
      });
  }, [router, token]);
  return (
    <main className="join-page">
      <Brand />
      <div className="join-card">
        <span className="eyebrow">BETTER TOGETHER</span>
        <h1>You’re invited.</h1>
        <p className="muted">A shared space for your next idea is waiting.</p>
        <ErrorBanner error={error} />
        <button
          className="button primary full"
          disabled={!ready || busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await api<{ roomId: string }>(`/invites/${token}/join`, 'POST');
              router.replace(`/rooms/${result.roomId}`);
            } catch (err) {
              setError(message(err));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Joining…' : !ready ? 'Checking your session…' : 'Accept invitation'}
        </button>
        <Link className="muted" href="/">
          Back to my rooms
        </Link>
      </div>
    </main>
  );
}
