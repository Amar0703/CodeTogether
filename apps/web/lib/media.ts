'use client';
import type { Socket } from 'socket.io-client';
import type {
  CallParticipant,
  CallJoined,
  CallSession,
  CallSignal,
  CallSnapshot,
  ClientEvents,
  IceConfiguration,
  MediaState,
  ServerEvents,
  RealtimeResult,
} from '@codetogether/contracts';
import { api } from './api';

type RoomSocket = Socket<ServerEvents, ClientEvents>;
export type PeerView = { participant: CallParticipant; stream: MediaStream; state: string };
export type MediaView = {
  state: string;
  active: boolean;
  error: string;
  local: MediaStream;
  media: MediaState;
  peers: PeerView[];
  turnConfigured?: boolean;
};
type Peer = PeerView & {
  pc: RTCPeerConnection;
  sequence: number;
  received: number;
  queue: Promise<void>;
  queued: number;
  makingOffer: boolean;
  ignoreOffer: boolean;
  candidates: Extract<CallSignal['signal'], { kind: 'candidate' }>[];
  ignored: Set<string>;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
};
const fragments = (sdp = '') => [...sdp.matchAll(/^a=ice-ufrag:(.+)$/gm)].map((m) => m[1].trim());
function unwrap<T>(result: RealtimeResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}
export function mediaError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError')
      return 'Microphone or camera permission was denied. Allow access in browser settings, then try again.';
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError')
      return 'The selected device is unavailable. Choose another device or join audio-only.';
    if (error.name === 'NotReadableError')
      return 'The device is busy or could not be opened. Close other apps using it and try again.';
  }
  return error instanceof Error ? error.message : 'Calling failed. Leave and join again.';
}

/** Owns media only. No Yjs state, cookies, persistence or socket reconnection machinery. */
export class RoomCall {
  private socket?: RoomSocket;
  private ready = false;
  private wanted = false;
  private generation = 0;
  private joining = false;
  private joinId?: string;
  private session?: CallSession;
  private revision = 0;
  private peers = new Map<string, Peer>();
  private ice?: IceConfiguration;
  private iceRequest?: AbortController;
  private renewal?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private offlineTimer?: ReturnType<typeof setTimeout>;
  private reconnects = 0;
  private deviceBusy = false;
  private destroyed = false;
  private view: MediaView = {
    state: 'Not in call',
    active: false,
    error: '',
    local: new MediaStream(),
    media: { microphone: false, camera: false },
    peers: [],
  };
  constructor(
    private roomId: string,
    private changed: (view: MediaView) => void,
  ) {}
  private publish() {
    if (!this.destroyed)
      this.changed({
        ...this.view,
        active: this.wanted,
        peers: [...this.peers.values()].map(({ participant, stream, state }) => ({
          participant,
          stream,
          state,
        })),
      });
  }
  private setError(error: unknown) {
    this.view.error = mediaError(error);
    this.publish();
  }
  connect(socket: RoomSocket | null, ready: boolean) {
    if (this.socket !== socket) {
      if (this.socket) {
        this.unbind();
        this.leave();
      }
      this.socket = socket ?? undefined;
      socket?.on('call:snapshot', this.snapshot);
      socket?.on('call:signal', this.signal);
      socket?.on('disconnect', this.disconnected);
      socket?.on('room:revoked', this.revoked);
    }
    this.ready = ready;
    if (ready && this.wanted && !this.session && !this.joining) void this.participate();
  }
  private revoked = () => {
    this.leave();
    this.view.error = 'Call ended because room access was removed.';
    this.publish();
  };
  private disconnected = (reason: string) => {
    if (!this.wanted) return;
    if (
      reason === 'io server disconnect' ||
      (reason === 'io client disconnect' && navigator.onLine && !this.ready)
    ) {
      this.leave();
      this.view.error = 'Call ended. Reconnect to the room and join again.';
      this.publish();
      return;
    }
    this.generation++;
    this.joining = false;
    this.session = undefined;
    this.joinId = undefined;
    this.ready = false;
    this.clearPeers();
    this.iceRequest?.abort();
    clearTimeout(this.renewal);
    clearInterval(this.heartbeat);
    this.view.state = 'Reconnecting';
    this.publish();
    clearTimeout(this.offlineTimer);
    this.offlineTimer = setTimeout(
      () => this.fail('Call recovery timed out. Join again when connected.'),
      30_000,
    );
  };
  async join(audioId: string, videoId: string, camera: boolean) {
    if (this.wanted || !this.ready || !this.socket?.connected) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      this.setError(new Error('Calling requires a supported browser on HTTPS or localhost.'));
      return;
    }
    this.wanted = true;
    this.reconnects = 0;
    const generation = ++this.generation;
    this.view.state = 'Connecting';
    this.view.error = '';
    this.publish();
    try {
      // Request each device separately: camera denial still permits an audio call.
      const audio = await navigator.mediaDevices.getUserMedia({
        audio: audioId ? { deviceId: { exact: audioId } } : true,
      });
      if (!this.current(generation)) {
        audio.getTracks().forEach((t) => t.stop());
        return;
      }
      this.install(audio.getAudioTracks()[0]);
      if (camera) {
        try {
          const video = await navigator.mediaDevices.getUserMedia({
            video: this.videoConstraints(videoId),
          });
          if (!this.current(generation)) {
            video.getTracks().forEach((t) => t.stop());
            return;
          }
          this.install(video.getVideoTracks()[0]);
        } catch (error) {
          if (this.current(generation)) this.setError(error);
        }
      }
      if (this.current(generation)) await this.participate();
    } catch (error) {
      if (this.current(generation)) this.fail(mediaError(error));
    }
  }
  private videoConstraints(id: string): MediaTrackConstraints {
    return {
      ...(id ? { deviceId: { exact: id } } : {}),
      width: { ideal: 640, max: 1280 },
      height: { ideal: 360, max: 720 },
      frameRate: { ideal: 20, max: 24 },
    };
  }
  private current(generation: number) {
    return this.wanted && !this.destroyed && this.generation === generation;
  }
  private async participate() {
    if (this.joining || !this.ready || !this.socket?.connected || !this.wanted) return;
    if (++this.reconnects > 4) {
      this.fail('Call reconnect limit reached. Join again to retry.');
      return;
    }
    this.joining = true;
    const generation = this.generation,
      socket = this.socket,
      joinId = crypto.randomUUID();
    this.joinId = joinId;
    try {
      const ice = await this.fetchIce();
      if (!this.current(generation)) return;
      this.ice = ice;
      this.view.turnConfigured = ice.turnConfigured;
      const result = unwrap<CallJoined>(
        await socket
          .timeout(8000)
          .emitWithAck('call:join', { roomId: this.roomId, joinId, media: this.view.media }),
      );
      if (!this.current(generation) || !socket.connected) {
        this.cancel(socket, joinId);
        return;
      }
      this.session = result.session;
      this.revision = 0;
      this.snapshot(result.snapshot);
      clearTimeout(this.offlineTimer);
      this.view.state = 'Connected';
      this.publish();
      this.scheduleRenewal();
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        void this.announce(true);
      }, 15_000);
    } catch (error) {
      this.cancel(socket, joinId);
      if (this.current(generation)) this.fail(mediaError(error));
    } finally {
      if (this.generation === generation) this.joining = false;
    }
  }
  private cancel(socket: RoomSocket, joinId: string) {
    if (socket.connected)
      socket.timeout(3000).emit('call:cancel', { roomId: this.roomId, joinId }, () => {});
  }
  private async fetchIce() {
    const controller = new AbortController();
    this.iceRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      return await api<IceConfiguration>(
        `/rooms/${this.roomId}/ice`,
        'POST',
        undefined,
        controller.signal,
      );
    } finally {
      clearTimeout(timeout);
      if (this.iceRequest === controller) this.iceRequest = undefined;
    }
  }
  private scheduleRenewal(attempt = 0) {
    clearTimeout(this.renewal);
    if (!this.ice || !this.session) return;
    const generation = this.generation;
    this.renewal = setTimeout(
      async () => {
        try {
          const ice = await this.fetchIce();
          if (!this.current(generation) || !this.session) return;
          this.ice = ice;
          for (const peer of this.peers.values())
            if (peer.pc.connectionState !== 'closed') {
              peer.pc.setConfiguration(ice);
              peer.pc.restartIce();
            }
          this.scheduleRenewal();
        } catch (error) {
          if (!this.current(generation)) return;
          if (attempt < 2) this.scheduleRenewal(attempt + 1);
          else this.fail(`Could not renew call connectivity credentials. ${mediaError(error)}`);
        }
      },
      attempt ? 5000 : Math.max(1000, Date.parse(this.ice.expiresAt) - Date.now() - 60_000),
    );
  }
  private snapshot = (snapshot: CallSnapshot) => {
    if (
      !this.session ||
      snapshot.roomId !== this.roomId ||
      snapshot.callId !== this.session.callId ||
      snapshot.revision <= this.revision
    )
      return;
    this.revision = snapshot.revision;
    if (!snapshot.participants.some((p) => p.id === this.session!.participantId)) {
      this.fail('Your call participation ended. Join again.');
      return;
    }
    const others = snapshot.participants.filter((p) => p.id !== this.session!.participantId);
    for (const [id, peer] of this.peers)
      if (!others.some((p) => p.id === id)) {
        this.closePeer(peer);
        this.peers.delete(id);
      }
    for (const participant of others) {
      const peer = this.peers.get(participant.id);
      if (peer) peer.participant = participant;
      else if (this.peers.size < 3) {
        try {
          this.createPeer(participant);
        } catch {
          this.fail(
            'This browser could not initialize media connectivity. Check ICE configuration and try again.',
          );
          return;
        }
      }
    }
    this.publish();
  };
  private live(peer: Peer) {
    return (
      this.wanted &&
      this.peers.get(peer.participant.id) === peer &&
      peer.pc.signalingState !== 'closed'
    );
  }
  private enqueue(peer: Peer, action: () => Promise<void>) {
    if (++peer.queued > 64) {
      peer.queued--;
      this.closePeer(peer);
      peer.state = 'Failed';
      this.view.error = 'Too many pending media messages. Leave and join again.';
      this.publish();
      return;
    }
    peer.queue = peer.queue
      .then(async () => {
        if (this.live(peer)) await action();
      })
      .catch(() => {
        if (this.live(peer)) this.recover(peer);
      })
      .finally(() => {
        peer.queued--;
      });
  }
  private createPeer(participant: CallParticipant) {
    const pc = new RTCPeerConnection(this.ice);
    const peer: Peer = {
      pc,
      participant,
      stream: new MediaStream(),
      state: 'Connecting',
      sequence: 0,
      received: 0,
      queue: Promise.resolve(),
      queued: 0,
      makingOffer: false,
      ignoreOffer: false,
      candidates: [],
      ignored: new Set(),
      retries: 0,
    };
    this.peers.set(participant.id, peer);
    for (const kind of ['audio', 'video'] as const) {
      const track = this.view.local.getTracks().find((t) => t.kind === kind);
      pc.addTransceiver(track ?? kind, { direction: 'sendrecv', streams: [this.view.local] });
    }
    pc.ontrack = ({ track }) => {
      if (this.live(peer)) {
        // New stream identity also updates the tile when tracks arrive after
        // its first render; manual addTrack does not fire a DOM addtrack event.
        peer.stream = new MediaStream([
          ...peer.stream.getTracks().filter((t) => t.id !== track.id),
          track,
        ]);
        this.publish();
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate?.candidate && candidate.usernameFragment && this.live(peer))
        this.send(peer, {
          kind: 'candidate',
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
          usernameFragment: candidate.usernameFragment,
        });
    };
    pc.onnegotiationneeded = () =>
      this.enqueue(peer, async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          if (this.live(peer) && pc.localDescription)
            this.send(peer, {
              kind: 'description',
              type: pc.localDescription.type as 'offer' | 'answer',
              sdp: pc.localDescription.sdp,
            });
        } finally {
          peer.makingOffer = false;
        }
      });
    pc.onconnectionstatechange = () => {
      if (!this.live(peer)) return;
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.timer);
        peer.timer = undefined;
        peer.state = 'Connected';
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        peer.state = 'Reconnecting';
        this.arm(peer, 5000);
      }
      this.publish();
    };
    this.arm(peer, 15_000);
  }
  private send(peer: Peer, signal: CallSignal['signal']) {
    if (!this.session || !this.socket?.connected || !this.live(peer)) return;
    const session = this.session;
    this.socket
      .timeout(8000)
      .emit(
        'call:signal',
        { ...session, to: peer.participant.id, sequence: ++peer.sequence, signal },
        (error, result) => {
          if (this.session !== session || !this.live(peer)) return;
          if (error || !result?.ok) {
            if (result && !result.ok && result.error.code === 'PEER_GONE') return;
            this.recover(peer);
          }
        },
      );
  }
  private signal = (data: CallSignal) => {
    if (
      !this.session ||
      data.roomId !== this.roomId ||
      data.callId !== this.session.callId ||
      data.to !== this.session.participantId
    )
      return;
    const peer = this.peers.get(data.participantId);
    if (!peer || data.sequence <= peer.received) return;
    peer.received = data.sequence;
    this.enqueue(peer, async () => {
      const pc = peer.pc,
        value = data.signal;
      if (value.kind === 'description') {
        const collision =
          value.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        const polite = this.session!.participantId.localeCompare(peer.participant.id) > 0;
        peer.ignoreOffer = !polite && collision;
        if (peer.ignoreOffer) {
          for (const fragment of fragments(value.sdp)) peer.ignored.add(fragment);
          while (peer.ignored.size > 8) peer.ignored.delete(peer.ignored.values().next().value!);
          return;
        }
        if (value.type === 'answer' && pc.signalingState !== 'have-local-offer') return;
        await pc.setRemoteDescription({ type: value.type, sdp: value.sdp });
        if (!this.live(peer)) return;
        const allowed = fragments(pc.remoteDescription?.sdp);
        // A rolled-back offer and its later answer can reuse ICE credentials.
        // Once accepted, those fragments must no longer be ignored.
        for (const fragment of allowed) peer.ignored.delete(fragment);
        const pending = peer.candidates;
        peer.candidates = [];
        for (const candidate of pending)
          if (allowed.includes(candidate.usernameFragment)) await pc.addIceCandidate(candidate);
        if (value.type === 'offer') {
          await pc.setLocalDescription();
          if (this.live(peer) && pc.localDescription)
            this.send(peer, { kind: 'description', type: 'answer', sdp: pc.localDescription.sdp });
        }
      } else {
        if (
          !peer.ignored.has(value.usernameFragment) &&
          fragments(pc.remoteDescription?.sdp).includes(value.usernameFragment)
        )
          await pc.addIceCandidate(value);
        else if (peer.candidates.length < 64) peer.candidates.push(value);
        else throw new Error('Candidate buffer exceeded');
      }
    });
  };
  private arm(peer: Peer, ms: number) {
    if (!peer.timer)
      peer.timer = setTimeout(() => {
        peer.timer = undefined;
        this.recover(peer);
      }, ms);
  }
  private recover(peer: Peer) {
    if (!this.live(peer) || peer.timer) return;
    if (peer.retries++ >= 2) {
      this.closePeer(peer);
      peer.state = 'Failed';
      this.view.error =
        'A peer could not connect. Check TURN configuration, then leave and join again.';
      this.publish();
      return;
    }
    peer.state = 'Reconnecting';
    peer.candidates = [];
    peer.pc.restartIce();
    this.arm(peer, 15_000);
    this.publish();
  }
  private install(track: MediaStreamTrack) {
    this.view.local.addTrack(track);
    this.view.local = new MediaStream(this.view.local.getTracks());
    track.onended = () => {
      if (this.view.local.getTracks().includes(track)) {
        void this.disable(track.kind as 'audio' | 'video');
        this.setError(
          new Error(
            `${track.kind === 'audio' ? 'Microphone' : 'Camera'} disconnected. Choose a device and enable it again.`,
          ),
        );
      }
    };
    this.view.media = {
      ...this.view.media,
      [track.kind === 'audio' ? 'microphone' : 'camera']: true,
    };
    this.publish();
  }
  private async announce(heartbeat = false) {
    if (!this.session || !this.socket?.connected) return;
    const session = this.session;
    try {
      unwrap(
        await this.socket
          .timeout(5000)
          .emitWithAck('call:state', { ...this.session, media: this.view.media }),
      );
    } catch (error) {
      if (this.wanted && this.session === session) {
        if (heartbeat) this.fail('Call participation could not be renewed. Join again.');
        else this.setError(error);
      }
    }
  }
  private async disable(kind: 'audio' | 'video') {
    const track = this.view.local.getTracks().find((t) => t.kind === kind);
    if (track) {
      track.onended = null;
      track.stop();
      this.view.local.removeTrack(track);
    }
    this.view.media = { ...this.view.media, [kind === 'audio' ? 'microphone' : 'camera']: false };
    await Promise.allSettled(
      [...this.peers.values()].map((peer) =>
        peer.pc
          .getTransceivers()
          .find((t) => t.receiver.track.kind === kind)
          ?.sender.replaceTrack(null),
      ),
    );
    this.publish();
    await this.announce();
  }
  async device(kind: 'audio' | 'video', enabled: boolean, id: string) {
    if (!this.wanted || this.deviceBusy) return;
    this.deviceBusy = true;
    const generation = this.generation;
    try {
      if (!enabled) {
        await this.disable(kind);
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia(
        kind === 'audio'
          ? { audio: id ? { deviceId: { exact: id } } : true }
          : { video: this.videoConstraints(id) },
      );
      if (!this.current(generation)) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const track = stream.getTracks()[0];
      const previous = this.view.local.getTracks().find((t) => t.kind === kind);
      const results = await Promise.allSettled(
        [...this.peers.values()]
          .filter((p) => this.live(p))
          .map((p) =>
            p.pc
              .getTransceivers()
              .find((t) => t.receiver.track.kind === kind)
              ?.sender.replaceTrack(track),
          ),
      );
      if (!this.current(generation)) {
        track.stop();
        return;
      }
      if (previous) {
        previous.onended = null;
        previous.stop();
        this.view.local.removeTrack(previous);
      }
      this.install(track);
      this.view.error = results.some((r) => r.status === 'rejected')
        ? 'A peer could not switch devices. Leave and join again.'
        : '';
      await this.announce();
    } catch (error) {
      if (this.current(generation)) this.setError(error);
    } finally {
      this.deviceBusy = false;
      this.publish();
    }
  }
  private closePeer(peer: Peer) {
    clearTimeout(peer.timer);
    peer.timer = undefined;
    peer.candidates = [];
    peer.ignored.clear();
    peer.pc.ontrack = null;
    peer.pc.onicecandidate = null;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    peer.stream.getTracks().forEach((t) => t.stop());
  }
  private clearPeers() {
    for (const peer of this.peers.values()) this.closePeer(peer);
    this.peers.clear();
  }
  leave() {
    this.wanted = false;
    this.iceRequest?.abort();
    this.generation++;
    this.joining = false;
    if (this.joinId && this.socket) this.cancel(this.socket, this.joinId);
    this.session = undefined;
    this.joinId = undefined;
    clearTimeout(this.renewal);
    clearInterval(this.heartbeat);
    clearTimeout(this.offlineTimer);
    this.clearPeers();
    this.view.local.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.view.local = new MediaStream();
    this.view.media = { microphone: false, camera: false };
    this.view.state = 'Not in call';
    this.publish();
  }
  private fail(message: string) {
    this.leave();
    this.view.state = 'Failed';
    this.view.error = message;
    this.publish();
  }
  private unbind() {
    this.socket?.off('call:snapshot', this.snapshot);
    this.socket?.off('call:signal', this.signal);
    this.socket?.off('disconnect', this.disconnected);
    this.socket?.off('room:revoked', this.revoked);
  }
  destroy() {
    this.leave();
    this.destroyed = true;
    this.unbind();
  }
}
