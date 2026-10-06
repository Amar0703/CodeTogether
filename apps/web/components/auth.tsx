'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Check, Code2, FileCode2 } from 'lucide-react';
import { api, message } from '../lib/api';
import { Brand, ErrorBanner } from './ui';
export function Auth() {
  const router = useRouter();
  const [signup, setSignup] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState('/');
  useEffect(() => {
    const path = new URLSearchParams(window.location.search).get('next');
    if (path && /^\/(join\/[a-f0-9]{64}|rooms\/[a-f0-9-]{36})$/.test(path)) setNext(path);
  }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const data = new FormData(event.currentTarget);
    try {
      await api(`/auth/${signup ? 'signup' : 'login'}`, 'POST', {
        email: data.get('email'),
        password: data.get('password'),
        ...(signup ? { name: data.get('name') } : {}),
      });
      router.replace(next);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <section className="auth-story">
        <Brand />
        <div className="story-content">
          <span className="eyebrow">
            <span className="status-dot" /> YOUR NEXT IDEA STARTS HERE
          </span>
          <h1>
            Good code.
            <br />
            Better together.
          </h1>
          <p>
            A little space for your next big idea. Bring your files, invite your people, and build
            something that matters.
          </p>
          <div className="code-art" aria-hidden="true">
            <div className="art-toolbar">
              <i />
              <i />
              <i />
              <span>
                <FileCode2 size={13} /> main.js
              </span>
            </div>
            <pre>
              <span className="code-comment">// Make room for possibility.</span>
              {'\n\n'}
              <span className="code-purple">const</span> workspace = {'{\n'}
              {'  '}idea: <span className="code-green">"something great"</span>,{'\n'}
              {'  '}team: [<span className="code-green">"you"</span>,{' '}
              <span className="code-green">"your people"</span>],{'\n'}
              {'  '}possibilities: <span className="code-orange">Infinity</span>
              {'\n};\n\n'}workspace.<span className="code-blue">build</span>();
            </pre>
            <div className="art-note">
              <Code2 size={18} /> A place to think. A place to build.
            </div>
          </div>
        </div>
        <div className="story-footer">A shared workspace. A common starting point.</div>
      </section>
      <section className="auth-form-wrap">
        <div className="mobile-brand">
          <Brand />
        </div>
        <div className="auth-form">
          <span className="eyebrow">LET’S GET BUILDING</span>
          <h2>{signup ? 'Find your starting point.' : 'Welcome back.'}</h2>
          <p className="muted">
            {signup
              ? 'Create an account and make room for your ideas.'
              : 'Your ideas are right where you left them.'}
          </p>
          <form onSubmit={submit}>
            <ErrorBanner error={error} />
            {signup && (
              <label>
                Your name
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  minLength={2}
                  maxLength={60}
                  required
                />
              </label>
            )}
            <label>
              Email address
              <input
                name="email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete={signup ? 'new-password' : 'current-password'}
                minLength={10}
                maxLength={128}
                placeholder={signup ? 'At least 10 characters' : 'Enter your password'}
                required
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? 'One moment…' : signup ? 'Create account' : 'Sign in'}
              <ArrowRight size={17} />
            </button>
          </form>
          <div className="auth-switch">
            {signup ? 'Already have an account?' : 'New around here?'}{' '}
            <button
              className="text-button"
              onClick={() => {
                setSignup(!signup);
                setError('');
              }}
            >
              {signup ? 'Sign in' : 'Create an account'}
            </button>
          </div>
          <div className="auth-benefit">
            <Check size={15} /> Your files, saved for your next session.
          </div>
        </div>
      </section>
    </main>
  );
}
