'use client';
import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';
import type { useRoomRealtime } from '../lib/realtime';

export function Chat({ realtime }: { realtime: ReturnType<typeof useRoomRealtime> }) {
  const [body, setBody] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  useEffect(() => {
    if (nearBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [realtime.messages, realtime.pending]);
  return (
    <section className="room-chat" aria-label="Room chat">
      <div className="panel-heading">
        <span>ROOM CHAT</span>
        <span className="chat-caption">Saved to room</span>
      </div>
      {realtime.error && (
        <p className="chat-error" role="alert">
          {realtime.error}
        </p>
      )}
      <div
        className="chat-messages"
        ref={list}
        role="log"
        aria-label="Messages"
        aria-live="polite"
        onScroll={() => {
          const el = list.current!;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {realtime.before && (
          <button
            className="button small"
            disabled={realtime.loading}
            onClick={() => {
              nearBottom.current = false;
              void realtime.loadOlder();
            }}
          >
            {realtime.loading ? 'Loading…' : 'Load older messages'}
          </button>
        )}
        {!realtime.messages.length && !realtime.pending.length && (
          <p className="chat-empty">
            Share a thought, ask a question.
            <br />
            Your conversation stays with this room.
          </p>
        )}
        {realtime.messages.map((item) => (
          <article className="chat-message" key={item.id}>
            <div>
              <strong>{item.sender.name}</strong>
              <time dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>
                {new Date(item.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </div>
            <p>{item.body}</p>
          </article>
        ))}
        {realtime.pending.map((item) => (
          <article className="chat-message pending" key={item.clientMessageId}>
            <div>
              <strong>You</strong>
              <span>{item.state === 'Sending' ? 'Sending…' : 'Failed to send'}</span>
            </div>
            <p>{item.body}</p>
            {item.state === 'Failed' && (
              <>
                <small>{item.error}</small>
                <button
                  className="button small"
                  disabled={realtime.status !== 'Connected'}
                  onClick={() => void realtime.send(item.body, item.clientMessageId)}
                >
                  Retry message
                </button>
              </>
            )}
          </article>
        ))}
      </div>
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          const text = body.trim();
          if (!text) return;
          nearBottom.current = true;
          void realtime.send(text);
          setBody('');
        }}
      >
        <label htmlFor="chat-body">Message your room</label>
        <textarea
          id="chat-body"
          placeholder="Write a message…"
          value={body}
          maxLength={2000}
          rows={2}
          disabled={realtime.status === 'Access removed'}
          onChange={(event) => setBody(event.target.value)}
        />
        <div>
          <small>{body.length}/2000 · All members can chat</small>
          <button
            className="button primary small"
            disabled={!body.trim() || realtime.status === 'Access removed'}
          >
            <Send size={14} /> Send
          </button>
        </div>
      </form>
    </section>
  );
}
