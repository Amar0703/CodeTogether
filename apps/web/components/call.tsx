'use client';
import { useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { ClientEvents, ServerEvents } from '@codetogether/contracts';
import { RoomCall, type MediaView } from '../lib/media';

function Tile({
  name,
  stream,
  local = false,
  microphone,
  camera,
  state,
}: {
  name: string;
  stream: MediaStream;
  local?: boolean;
  microphone: boolean;
  camera: boolean;
  state: string;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const playback = useRef<HTMLAudioElement>(null);
  const audio = useRef<AudioContext | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    let disposed = false;
    const sound = playback.current;
    const update = () => {
      // An inactive video transceiver can leave video.play() pending in an
      // audio-only call. Give audio its own element, and never play it twice.
      element.srcObject = new MediaStream(stream.getVideoTracks());
      if (camera && stream.getVideoTracks().length) void element.play().catch(() => {});
      if (!local && sound && stream.getAudioTracks().length) {
        sound.srcObject = new MediaStream(stream.getAudioTracks());
        void sound
          .play()
          .then(() => {
            if (!disposed) setBlocked(audio.current?.state === 'suspended');
          })
          .catch(() => {
            if (!disposed) setBlocked(true);
          });
      }
    };
    update();
    stream.addEventListener('addtrack', update);
    stream.addEventListener('removetrack', update);
    return () => {
      disposed = true;
      stream.removeEventListener('addtrack', update);
      stream.removeEventListener('removetrack', update);
      element.pause();
      element.srcObject = null;
      if (sound) {
        sound.pause();
        sound.srcObject = null;
      }
    };
  }, [stream, camera, microphone, local]);
  useEffect(() => {
    if (!microphone) {
      setSpeaking(false);
      return;
    }
    let context: AudioContext | undefined,
      source: MediaStreamAudioSourceNode | undefined,
      analyser: AnalyserNode | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (context || !stream.getAudioTracks().length) return;
      try {
        context = new AudioContext();
        audio.current = context;
        source = context.createMediaStreamSource(stream);
        analyser = context.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const values = new Uint8Array(analyser.fftSize);
        timer = setInterval(() => {
          if (!analyser) return;
          analyser.getByteTimeDomainData(values);
          const energy = values.reduce((sum, v) => sum + (v - 128) ** 2, 0) / values.length;
          setSpeaking(energy > 14);
        }, 200);
        if (context.state === 'suspended') setBlocked(true);
      } catch {
        /* Calling still works when audio analysis is unsupported. */
      }
    };
    start();
    stream.addEventListener('addtrack', start);
    return () => {
      stream.removeEventListener('addtrack', start);
      clearInterval(timer);
      source?.disconnect();
      analyser?.disconnect();
      if (context) void context.close();
      audio.current = null;
    };
  }, [stream, microphone]);
  return (
    <article
      className={`call-tile ${speaking ? 'speaking' : ''}`}
      aria-label={`${name}, ${state}`}
      data-testid={local ? 'local-media' : 'remote-media'}
      data-state={state}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        muted
        aria-label={`${name} video`}
        className={camera ? '' : 'camera-hidden'}
      />
      <audio ref={playback} autoPlay muted={local} aria-label={`${name} audio`} />
      {!camera && (
        <div className="call-avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="call-caption">
        <strong>{name}</strong>
        <span>{state}</span>
        <span>
          {microphone ? 'Mic on' : 'Muted'} · {camera ? 'Camera on' : 'Camera off'}
          {speaking ? ' · Speaking' : ''}
        </span>
      </div>
      {blocked && (
        <button
          className="button small play-media"
          onClick={() => {
            if (camera) void video.current?.play().catch(() => {});
            void Promise.all([
              !local && playback.current?.srcObject ? playback.current.play() : undefined,
              audio.current?.resume(),
            ])
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true));
          }}
        >
          Enable audio playback
        </button>
      )}
    </article>
  );
}

export function CallPanel({
  roomId,
  socket,
  ready,
  revoked,
}: {
  roomId: string;
  socket: Socket<ServerEvents, ClientEvents> | null;
  ready: boolean;
  revoked: boolean;
}) {
  const controller = useRef<RoomCall | null>(null);
  const [view, setView] = useState<MediaView>();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [audioId, setAudioId] = useState(''),
    [videoId, setVideoId] = useState('');
  const [camera, setCamera] = useState(false);
  const [controlsBusy, setControlsBusy] = useState(false);
  useEffect(() => {
    const call = new RoomCall(roomId, setView);
    controller.current = call;
    const exit = () => call.leave();
    window.addEventListener('pagehide', exit);
    return () => {
      window.removeEventListener('pagehide', exit);
      call.destroy();
      controller.current = null;
    };
  }, [roomId]);
  useEffect(() => {
    controller.current?.connect(socket, ready);
    if (revoked) controller.current?.leave();
  }, [roomId, socket, ready, revoked]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void navigator.mediaDevices
        ?.enumerateDevices()
        .then((list) => {
          if (!cancelled) setDevices(list);
        })
        .catch(() => {});
    };
    // Enumeration does not request permission. Labels become available after explicit Join.
    refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener('devicechange', refresh);
    };
  }, [view?.active, view?.media.microphone, view?.media.camera]);
  const device = async (kind: 'audio' | 'video', enabled: boolean, id: string) => {
    setControlsBusy(true);
    try {
      await controller.current?.device(kind, enabled, id);
    } finally {
      setControlsBusy(false);
    }
  };
  return (
    <section className="room-call" aria-label="Room call">
      <div className="call-heading">
        <strong>
          Room call <span>up to 4</span>
        </strong>
        <span role="status" data-testid="call-status">
          {view?.state ?? 'Not in call'}
        </span>
        {view?.active ? (
          <button className="button small danger-text" onClick={() => controller.current?.leave()}>
            Leave call
          </button>
        ) : (
          <button
            className="button primary small"
            disabled={!ready || revoked}
            onClick={() => void controller.current?.join(audioId, videoId, camera)}
          >
            Join call
          </button>
        )}
      </div>
      {view?.error && (
        <p className="call-error" role="alert">
          {view.error}
        </p>
      )}
      {view?.turnConfigured === false && (
        <p className="call-warning">
          TURN is not configured. Calls across different networks may fail.
        </p>
      )}
      <div className="call-controls">
        {view?.active ? (
          <>
            <button
              className="button small"
              disabled={controlsBusy}
              aria-pressed={!view.media.microphone}
              onClick={() => void device('audio', !view.media.microphone, audioId)}
            >
              {view.media.microphone ? 'Mute microphone' : 'Unmute microphone'}
            </button>
            <button
              className="button small"
              disabled={controlsBusy}
              aria-pressed={view.media.camera}
              onClick={() => void device('video', !view.media.camera, videoId)}
            >
              {view.media.camera ? 'Turn camera off' : 'Turn camera on'}
            </button>
          </>
        ) : (
          <label className="call-camera-option">
            <input type="checkbox" checked={camera} onChange={(e) => setCamera(e.target.checked)} />
            Join with camera
          </label>
        )}
        <label>
          Microphone
          <select
            aria-label="Microphone device"
            value={audioId}
            disabled={controlsBusy}
            onChange={(e) => {
              setAudioId(e.target.value);
              if (view?.active && view.media.microphone) void device('audio', true, e.target.value);
            }}
          >
            <option value="">System default</option>
            {devices
              .filter((d) => d.kind === 'audioinput' && d.deviceId)
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        <label>
          Camera
          <select
            aria-label="Camera device"
            value={videoId}
            disabled={controlsBusy}
            onChange={(e) => {
              setVideoId(e.target.value);
              if (view?.active && view.media.camera) void device('video', true, e.target.value);
            }}
          >
            <option value="">System default</option>
            {devices
              .filter((d) => d.kind === 'videoinput' && d.deviceId)
              .map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
      </div>
      {view?.active ? (
        <div className="call-tiles">
          <Tile
            name="You"
            local
            stream={view.local}
            microphone={view.media.microphone}
            camera={view.media.camera}
            state={view.state}
          />
          {view.peers.map((peer) => (
            <Tile
              key={peer.participant.id}
              name={peer.participant.name}
              stream={peer.stream}
              {...peer.participant.media}
              state={peer.state}
            />
          ))}
        </div>
      ) : (
        <p className="call-hint">
          Join when you’re ready to talk. Devices are off until you join. Each tab uses a separate
          call slot.
        </p>
      )}
    </section>
  );
}
