'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type {
  ChatHistory,
  ChatMessage,
  ClientEvents,
  Presence,
  RoomEvent,
  ServerEvents,
} from '@codetogether/contracts';
import { api, message } from './api';

export type ConnectionState =
  'Connecting' | 'Connected' | 'Reconnecting' | 'Offline' | 'Access removed';
type Pending = {
  clientMessageId: string;
  body: string;
  state: 'Sending' | 'Failed';
  error?: string;
};
export function useRoomRealtime(
  roomId: string,
  enabled: boolean,
  onSync: (event?: RoomEvent) => Promise<unknown>,
  onRevoked: (reason: string) => void,
) {
  const [status, setStatus] = useState<ConnectionState>('Connecting');
  const [online, setOnline] = useState<Presence['members']>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const socketRef = useRef<Socket<ServerEvents, ClientEvents> | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  // Only advance once catch-up succeeds. Live messages arriving during a failed history
  // request must not move the next reconnect past an unseen gap.
  const recoveredCursor = useRef<string | undefined>(undefined);
  const callbacks = useRef({ onSync, onRevoked });
  useEffect(() => {
    callbacks.current = { onSync, onRevoked };
  }, [onSync, onRevoked]);
  const merge = useCallback((incoming: ChatMessage[]) => {
    const map = new Map(messagesRef.current.map((m) => [m.id, m]));
    incoming.forEach((m) => map.set(m.id, m));
    const next = [...map.values()].sort((a, b) =>
      BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1,
    );
    messagesRef.current = next;
    setMessages(next);
    setPending((rows) =>
      rows.filter((row) => !incoming.some((m) => m.clientMessageId === row.clientMessageId)),
    );
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false,
      joinedBefore = false,
      revoked = false,
      generation = 0;
    let synchronized = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const endpoint =
      process.env.NEXT_PUBLIC_REALTIME_URL ??
      (process.env.NODE_ENV !== 'production' ? 'http://localhost:4000' : '');
    if (!endpoint) {
      setStatus('Offline');
      setError('Realtime is not configured for this deployment.');
      return;
    }
    const socket: Socket<ServerEvents, ClientEvents> = io(endpoint, {
      transports: ['websocket'],
      autoConnect: false,
      reconnection: false,
      timeout: 10_000,
    });
    socketRef.current = socket;
    const schedule = () => {
      if (disposed || revoked || retry) return;
      retry = setTimeout(
        () => {
          retry = undefined;
          void connect();
        },
        3000 + Math.random() * 2000,
      );
    };
    const connect = async () => {
      if (disposed || revoked || socket.connected) return;
      setStatus(navigator.onLine ? (joinedBefore ? 'Reconnecting' : 'Connecting') : 'Offline');
      try {
        const { ticket } = await api<{ ticket: string }>('/realtime/ticket', 'POST');
        if (disposed || revoked) return;
        socket.auth = { ticket };
        socket.connect();
      } catch (err) {
        if (!disposed) {
          setStatus('Offline');
          setError(message(err));
          schedule();
        }
      }
    };
    socket.on('connect', () => {
      const current = ++generation;
      // Capture the last received message BEFORE new live broadcasts can advance it.
      synchronized = false;
      const after = recoveredCursor.current;
      socket.timeout(10_000).emit('room:join', { roomId }, async (err, result) => {
        if (disposed || current !== generation) return;
        if (err || !result?.ok) {
          if (result && !result.ok && result.error.code === 'ROOM_NOT_FOUND') {
            revoked = true;
            setStatus('Access removed');
            callbacks.current.onRevoked(result.error.message);
          } else
            setError(
              err
                ? 'Could not join. Reconnecting…'
                : result && !result.ok
                  ? result.error.message
                  : 'Could not join.',
            );
          socket.disconnect();
          schedule();
          return;
        }
        setOnline(result.data.members);
        try {
          let cursor = after;
          do {
            const history = await api<ChatHistory>(
              `/rooms/${roomId}/messages${cursor ? `?after=${cursor}` : ''}`,
            );
            if (disposed || current !== generation) return;
            merge(history.messages);
            if (!after) setBefore(history.nextCursor);
            cursor = after ? (history.nextCursor ?? undefined) : undefined;
          } while (cursor);
          await callbacks.current.onSync();
          if (disposed || current !== generation) return;
          joinedBefore = true;
          synchronized = true;
          recoveredCursor.current = messagesRef.current.at(-1)?.sequence;
          setStatus('Connected');
          setError('');
        } catch (err) {
          setError(message(err));
          socket.disconnect();
          schedule();
        }
      });
    });
    socket.on('presence:update', (value) => {
      if (value.roomId === roomId) setOnline(value.members);
    });
    socket.on('chat:message', (value) => {
      if (value.roomId === roomId) {
        merge([value]);
        if (synchronized) recoveredCursor.current = messagesRef.current.at(-1)?.sequence;
      }
    });
    socket.on('room:event', (event) => {
      if (event.roomId === roomId)
        void callbacks.current.onSync(event).catch((err) => setError(message(err)));
    });
    socket.on('room:revoked', (value) => {
      if (value.roomId !== roomId) return;
      revoked = true;
      setStatus('Access removed');
      setOnline([]);
      setError(value.reason);
      callbacks.current.onRevoked(value.reason);
      socket.disconnect();
    });
    socket.on('disconnect', () => {
      synchronized = false;
      generation++;
      setOnline([]);
      setPending((rows) =>
        rows.map((row) => ({
          ...row,
          state: 'Failed',
          error: 'Connection lost. Retry when connected.',
        })),
      );
      if (!revoked) {
        setStatus(navigator.onLine ? 'Reconnecting' : 'Offline');
        schedule();
      }
    });
    socket.on('connect_error', () => {
      setStatus('Offline');
      setError('Realtime is unavailable. Retrying automatically…');
      schedule();
    });
    const offline = () => {
      setStatus('Offline');
      socket.disconnect();
    };
    const onlineAgain = () => {
      clearTimeout(retry);
      retry = undefined;
      void connect();
    };
    window.addEventListener('offline', offline);
    window.addEventListener('online', onlineAgain);
    void connect();
    return () => {
      disposed = true;
      generation++;
      clearTimeout(retry);
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', onlineAgain);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId, enabled, merge]);
  const send = async (body: string, clientMessageId = crypto.randomUUID()) => {
    setPending((rows) => [
      ...rows.filter((row) => row.clientMessageId !== clientMessageId),
      { body, clientMessageId, state: 'Sending' },
    ]);
    const socket = socketRef.current;
    if (!socket?.connected || status !== 'Connected') {
      setPending((rows) =>
        rows.map((row) =>
          row.clientMessageId === clientMessageId
            ? { ...row, state: 'Failed', error: 'You are offline. Retry when connected.' }
            : row,
        ),
      );
      return;
    }
    socket.timeout(10_000).emit('chat:send', { roomId, body, clientMessageId }, (err, result) => {
      if (!err && result?.ok) {
        merge([result.data]);
        return;
      }
      // A broadcast may already have confirmed delivery before the ack was lost.
      if (messagesRef.current.some((m) => m.clientMessageId === clientMessageId)) return;
      setPending((rows) =>
        rows.map((row) =>
          row.clientMessageId === clientMessageId
            ? {
                ...row,
                state: 'Failed',
                error: err
                  ? 'Delivery was not confirmed. Retry safely.'
                  : result && !result.ok
                    ? result.error.message
                    : 'Send failed.',
              }
            : row,
        ),
      );
    });
  };
  const loadOlder = async () => {
    if (!before || loading) return;
    setLoading(true);
    try {
      const history = await api<ChatHistory>(`/rooms/${roomId}/messages?before=${before}`);
      merge(history.messages);
      setBefore(history.nextCursor);
      setError('');
    } catch (err) {
      setError(message(err));
    } finally {
      setLoading(false);
    }
  };
  return { status, online, messages, pending, error, before, loading, loadOlder, send };
}
