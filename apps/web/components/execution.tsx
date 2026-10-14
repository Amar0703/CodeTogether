'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  executionLanguage,
  executionEventSchema,
  type ExecutionLanguage,
  type ExecutionView,
  type ExecutionHistory,
  type RoomFile,
  type Role,
} from '@codetogether/contracts';
import type { CollaborativeDocument, DocumentStatus } from '../lib/document';
import type { useRoomRealtime } from '../lib/realtime';
import { api, message } from '../lib/api';

const labels = { javascript: 'JavaScript', python: 'Python', cpp: 'C++' };
export function ExecutionPanel({
  roomId,
  file,
  document,
  documentStatus,
  role,
  accountId,
  realtime,
  removed,
}: {
  roomId: string;
  file?: RoomFile;
  document?: CollaborativeDocument;
  documentStatus: DocumentStatus;
  role: Role;
  accountId: string;
  realtime: ReturnType<typeof useRoomRealtime>;
  removed: boolean;
}) {
  const [open, setOpen] = useState(false),
    [stdin, setStdin] = useState('');
  const [language, setLanguage] = useState<ExecutionLanguage>('javascript');
  const [available, setAvailable] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ExecutionView[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExecutionView>();
  const selection = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const retry = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const generation = useRef(0);
  const olderLoaded = useRef(false);
  useEffect(() => {
    setLanguage(executionLanguage(file?.name ?? '') ?? 'javascript');
  }, [file?.name]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  const mergeSelected = useCallback((row: ExecutionView) => {
    if (!mounted.current || selection.current !== row.id) return;
    setSelected((prev) => (prev?.id === row.id && prev.revision > row.revision ? prev : row));
  }, []);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const [health, page] = await Promise.all([
      api<{ available: boolean }>('/executions/health'),
      api<ExecutionHistory>(`/rooms/${roomId}/executions`),
    ]);
    if (!mounted.current || epoch !== generation.current) return;
    setAvailable(health.available);
    setHistory((prev) => {
      const merged = new Map([...prev, ...page.executions].map((r) => [r.id, r]));
      return [...merged.values()]
        .sort((a, b) => (BigInt(a.sequence) > BigInt(b.sequence) ? -1 : 1))
        .slice(0, 100);
    });
    if (!olderLoaded.current) setCursor(page.nextCursor);
    if (!selection.current && page.executions[0]) selection.current = page.executions[0].id;
    if (selection.current) {
      const { execution } = await api<{ execution: ExecutionView }>(
        `/rooms/${roomId}/executions/${selection.current}`,
      );
      if (mounted.current && epoch === generation.current) mergeSelected(execution);
    }
  }, [roomId, mergeSelected]);
  useEffect(() => {
    if (removed) {
      generation.current++;
      selection.current = undefined;
      retry.current = undefined;
      setHistory([]);
      setCursor(null);
      setSelected(undefined);
      setAvailable(false);
      return;
    }
    let active = false;
    const load = () => {
      if (active) return;
      active = true;
      void refresh()
        .catch((e) => {
          if (mounted.current) {
            setAvailable(false);
            setError(message(e));
          }
        })
        .finally(() => {
          active = false;
        });
    };
    load();
    const timer = setInterval(load, open ? 3000 : 15000);
    // Volatile events may be lost. The durable refetch is also used after reconnect.
    let invalidation: ReturnType<typeof setTimeout> | undefined;
    const event = (input: unknown) => {
      const parsed = executionEventSchema.safeParse(input);
      if (!parsed.success || parsed.data.roomId !== roomId) return;
      const e = parsed.data;
      setSelected((prev) => {
        if (!prev || prev.id !== e.executionId || e.revision <= prev.revision) return prev;
        if (e.chunk && (e.attempt !== prev.attempt || e.chunk.sequence !== prev.chunks.length + 1))
          return prev;
        return {
          ...prev,
          status: e.status,
          attempt: e.attempt,
          revision: e.revision,
          truncated: e.truncated,
          chunks: e.chunk ? [...prev.chunks, e.chunk] : prev.chunks,
        };
      });
      if (!e.chunk && !invalidation)
        invalidation = setTimeout(() => {
          invalidation = undefined;
          load();
        }, 500);
    };
    realtime.socket?.on('execution:event', event);
    return () => {
      clearInterval(timer);
      clearTimeout(invalidation);
      realtime.socket?.off('execution:event', event);
    };
  }, [roomId, realtime.socket, realtime.status, refresh, removed, open]);
  async function run() {
    if (!document || !file || removed) return;
    const epoch = generation.current;
    setBusy(true);
    setError('');
    try {
      const source = document.confirmedSource();
      const bytes = new TextEncoder().encode(source);
      if (bytes.length > 65536) throw new Error('Source exceeds the 64 KiB execution limit.');
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      const { file: saved } = await api<{ file: RoomFile }>(`/files/${file.id}`);
      // Verify the visible confirmed snapshot against the current authoritative projection.
      if (saved.content !== source)
        throw new Error('The file changed while preparing Run. Wait for Saved and retry.');
      const fingerprint = JSON.stringify([file.id, hash, saved.version, language, stdin]);
      if (retry.current?.fingerprint !== fingerprint)
        retry.current = { fingerprint, key: crypto.randomUUID() };
      const { execution } = await api<{ execution: ExecutionView }>(
        `/rooms/${roomId}/executions`,
        'POST',
        {
          fileId: file.id,
          sourceHash: hash,
          version: saved.version,
          language,
          stdin,
          idempotencyKey: retry.current.key,
        },
      );
      if (!mounted.current || epoch !== generation.current) return;
      retry.current = undefined;
      selection.current = execution.id;
      mergeSelected(execution);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }
  const canRun =
    !removed &&
    role !== 'VIEWER' &&
    available &&
    !!file &&
    executionLanguage(file.name) === language &&
    documentStatus.ready &&
    !documentStatus.pending &&
    !documentStatus.blocked &&
    realtime.status === 'Connected';
  const canCancel =
    selected &&
    ['QUEUED', 'RUNNING'].includes(selected.status) &&
    (role === 'OWNER' || selected.userId === accountId);
  return (
    <section className="execution-panel" aria-label="Code execution">
      <button
        className="execution-toggle"
        aria-expanded={open}
        aria-controls="execution-controls"
        onClick={() => setOpen(!open)}
      >
        {open ? '▾' : '▸'} Run code & execution history{' '}
        {selected ? `· ${selected.status.toLowerCase()}` : ''}
      </button>
      {open && (
        <div id="execution-controls" className="execution-body">
          {!available && (
            <p role="status">Execution unavailable. Redis and an isolated worker must be ready.</p>
          )}
          {role === 'VIEWER' && (
            <p>Viewer access: observe results; owners and editors can run code.</p>
          )}
          <div className="execution-actions">
            <label>
              Language
              <select
                aria-label="Execution language"
                value={language}
                onChange={(e) => setLanguage(e.target.value as ExecutionLanguage)}
              >
                {Object.entries(labels).map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary small"
              disabled={!canRun || busy}
              onClick={() => void run()}
            >
              Run
            </button>
            {canCancel && (
              <button
                className="button small"
                disabled={busy || removed}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await api<{ execution: ExecutionView }>(
                      `/rooms/${roomId}/executions/${selected.id}/cancel`,
                      'POST',
                    );
                    mergeSelected(r.execution);
                  } catch (e) {
                    setError(message(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Cancel run
              </button>
            )}
          </div>
          {file && executionLanguage(file.name) !== language && (
            <p>Select a language matching a supported file extension: .js, .py or .cpp.</p>
          )}
          {documentStatus.pending && (
            <p>Wait for Saved before running. Unconfirmed offline drafts cannot run.</p>
          )}
          <label>
            Standard input
            <textarea
              aria-label="Execution stdin"
              value={stdin}
              onChange={(e) => setStdin(e.target.value)}
              maxLength={16384}
              rows={2}
              placeholder="Optional input · 16 KiB UTF-8 maximum"
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <label>
            Room execution history
            <select
              aria-label="Execution history"
              value={selected?.id ?? ''}
              onChange={async (e) => {
                if (!e.target.value) return;
                selection.current = e.target.value;
                try {
                  const r = await api<{ execution: ExecutionView }>(
                    `/rooms/${roomId}/executions/${e.target.value}`,
                  );
                  mergeSelected(r.execution);
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              <option value="">Choose a run</option>
              {history.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.filename} · {row.submitter} · {row.status} ·{' '}
                  {new Date(row.createdAt).toLocaleTimeString()}
                </option>
              ))}
            </select>
          </label>
          {cursor && (
            <button
              className="button small"
              onClick={async () => {
                const epoch = generation.current;
                try {
                  const page = await api<ExecutionHistory>(
                    `/rooms/${roomId}/executions?before=${cursor}`,
                  );
                  if (!mounted.current || epoch !== generation.current) return;
                  olderLoaded.current = true;
                  setHistory((prev) => [...prev, ...page.executions].slice(-100));
                  setCursor(page.nextCursor);
                } catch (e) {
                  setError(message(e));
                }
              }}
            >
              Older executions
            </button>
          )}
          {selected && (
            <div className="execution-result" data-testid="execution-result">
              <p role="status">
                <strong>{selected.status}</strong>
                {selected.failure
                  ? ` · ${selected.failure.replaceAll('_', ' ').toLowerCase()}`
                  : ''}
                {selected.durationMs !== null ? ` · ${selected.durationMs} ms` : ''}
                {selected.exitCode !== null ? ` · exit ${selected.exitCode}` : ''}
              </p>
              <p>
                {selected.submitter} · {selected.filename} · version {selected.version} ·{' '}
                {selected.language}
                <br />
                SHA-256 <code>{selected.sourceHash}</code>
              </p>
              <pre aria-label="Execution output" tabIndex={0}>
                {selected.chunks.map((chunk) => (
                  <span key={chunk.sequence} className={chunk.stream === 'stderr' ? 'stderr' : ''}>
                    {`[${chunk.stream}] `}
                    {chunk.text}
                  </span>
                ))}
              </pre>
              {selected.truncated && <p>Output truncated at the execution limit.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
