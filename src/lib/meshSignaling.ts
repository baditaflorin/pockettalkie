// Mesh signaling over the y-webrtc pub/sub WebSocket protocol.
//
// Each peer subscribes to the room topic. They announce themselves with
// `hello`. The lower-peer-id side creates the offer to avoid glare. SDP and
// ICE are exchanged via addressed publish messages on the same topic.
//
// The signaling server (baditaflorin/signaling-server) treats `data` as
// opaque, so we can put any JSON in it.

import { fetchIceServers, loadSignalingUrl, type TurnState } from "./turnConfig";

type Json = unknown;

type WireMsg =
  | { type: "subscribe"; topics: string[] }
  | { type: "unsubscribe"; topics: string[] }
  | { type: "publish"; topic: string; data: Json }
  | { type: "ping" };

type InboundMsg = { type: "publish"; topic: string; data: Json } | { type: "pong" };

type PeerCmd =
  | { kind: "hello"; from: string }
  | { kind: "bye"; from: string }
  | { kind: "offer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | { kind: "answer"; from: string; to: string; sdp: RTCSessionDescriptionInit }
  | {
      kind: "ice";
      from: string;
      to: string;
      candidate: RTCIceCandidateInit | null;
    };

export type Peer = {
  id: string;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  audioEl: HTMLAudioElement;
  connectionState: RTCPeerConnectionState;
  remoteTalking: boolean;
};

export type MeshEvent =
  | { type: "peer-added"; peer: Peer }
  | { type: "peer-state"; peer: Peer }
  | { type: "peer-removed"; id: string }
  | { type: "remote-talking"; id: string; talking: boolean }
  | { type: "ws-open" }
  | { type: "ws-close"; code: number }
  | { type: "ws-error" };

export type MeshOptions = {
  roomCode: string;
  localStream: MediaStream;
  onEvent: (ev: MeshEvent) => void;
};

export class Mesh {
  private ws: WebSocket | null = null;
  private myId = crypto.randomUUID();
  private topic: string;
  private peers = new Map<string, Peer>();
  private turnState: TurnState | null = null;
  private destroyed = false;
  private signalingUrl: string;
  private opts: MeshOptions;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private dataChannels = new Map<string, RTCDataChannel>();
  private pendingIce = new Map<string, RTCIceCandidateInit[]>();
  private helloTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MeshOptions) {
    this.opts = opts;
    this.topic = `pockettalkie:${opts.roomCode}`;
    this.signalingUrl = loadSignalingUrl();
  }

  async start(): Promise<TurnState> {
    this.turnState = await fetchIceServers();
    this.connect();
    return this.turnState;
  }

  myPeerId(): string {
    return this.myId;
  }

  destroy() {
    this.destroyed = true;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    // Tell remaining peers we're leaving.
    try {
      this.publish({ kind: "bye", from: this.myId });
    } catch {
      /* noop */
    }
    this.peers.forEach((p) => p.pc.close());
    this.peers.clear();
    this.dataChannels.clear();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            type: "unsubscribe",
            topics: [this.topic],
          } satisfies WireMsg),
        );
      } catch {
        /* noop */
      }
      this.ws.close();
    }
    this.ws = null;
  }

  setLocalTrackEnabled(enabled: boolean) {
    this.opts.localStream.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
    // Announce talking state over the per-peer data channel so the UI on the
    // other side can highlight us even before audio frames arrive.
    const msg = JSON.stringify({ kind: "talking", value: enabled });
    this.dataChannels.forEach((ch) => {
      if (ch.readyState === "open") {
        try {
          ch.send(msg);
        } catch {
          /* noop */
        }
      }
    });
  }

  private connect() {
    if (this.destroyed) return;
    const ws = new WebSocket(this.signalingUrl);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectAttempts = 0;
      this.opts.onEvent({ type: "ws-open" });
      const sub: WireMsg = { type: "subscribe", topics: [this.topic] };
      ws.send(JSON.stringify(sub));
      this.helloTimer = setTimeout(() => {
        this.publish({ kind: "hello", from: this.myId });
      }, 200);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" } satisfies WireMsg));
        }
      }, 25_000);
    });

    ws.addEventListener("message", (ev) => {
      let msg: InboundMsg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (msg.type !== "publish") return;
      if (msg.topic !== this.topic) return;
      this.handlePeerCmd(msg.data as PeerCmd);
    });

    ws.addEventListener("close", (ev) => {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.opts.onEvent({ type: "ws-close", code: ev.code });
      if (this.destroyed) return;
      const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts++;
      setTimeout(() => {
        if (!this.destroyed) this.connect();
      }, delay);
    });

    ws.addEventListener("error", () => {
      this.opts.onEvent({ type: "ws-error" });
    });
  }

  private publish(data: PeerCmd) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const out: WireMsg = { type: "publish", topic: this.topic, data };
    ws.send(JSON.stringify(out));
  }

  private handlePeerCmd(cmd: PeerCmd) {
    if (!cmd || typeof cmd !== "object" || !("kind" in cmd)) return;
    switch (cmd.kind) {
      case "hello":
        if (cmd.from === this.myId) return;
        // A new peer announced. If our id is the lower one, we offer.
        if (this.myId < cmd.from) {
          this.ensurePeer(cmd.from, true);
        } else {
          // Re-announce so they see us and decide they should offer.
          this.publish({ kind: "hello", from: this.myId });
        }
        break;
      case "bye":
        this.removePeer(cmd.from);
        break;
      case "offer":
        if (cmd.to !== this.myId) return;
        void this.handleOffer(cmd.from, cmd.sdp);
        break;
      case "answer":
        if (cmd.to !== this.myId) return;
        void this.handleAnswer(cmd.from, cmd.sdp);
        break;
      case "ice":
        if (cmd.to !== this.myId) return;
        void this.handleIce(cmd.from, cmd.candidate);
        break;
    }
  }

  private ensurePeer(remoteId: string, initiator: boolean): Peer {
    let peer = this.peers.get(remoteId);
    if (peer) return peer;

    const pc = new RTCPeerConnection({
      iceServers: this.turnState?.iceServers ?? [],
    });

    const remoteStream = new MediaStream();
    const audioEl = new Audio();
    audioEl.autoplay = true;
    // playsInline is only on HTMLVideoElement in TS; Safari respects it on audio too.
    (audioEl as unknown as { playsInline: boolean }).playsInline = true;
    audioEl.srcObject = remoteStream;
    // Browsers gate autoplay; this resumes after a user gesture is observed.
    audioEl.play().catch(() => {});

    peer = {
      id: remoteId,
      pc,
      remoteStream,
      audioEl,
      connectionState: pc.connectionState,
      remoteTalking: false,
    };
    this.peers.set(remoteId, peer);

    // Add our local audio so the peer receives it when we PTT.
    this.opts.localStream.getAudioTracks().forEach((t) => {
      pc.addTrack(t, this.opts.localStream);
    });

    pc.ontrack = (ev) => {
      ev.streams[0]?.getTracks().forEach((tr) => remoteStream.addTrack(tr));
      // Also handle the case where streams[] is empty by adding the track.
      if (ev.streams.length === 0) {
        remoteStream.addTrack(ev.track);
      }
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) {
        this.publish({
          kind: "ice",
          from: this.myId,
          to: remoteId,
          candidate: null,
        });
        return;
      }
      this.publish({
        kind: "ice",
        from: this.myId,
        to: remoteId,
        candidate: ev.candidate.toJSON(),
      });
    };

    pc.onconnectionstatechange = () => {
      const p = this.peers.get(remoteId);
      if (!p) return;
      p.connectionState = pc.connectionState;
      this.opts.onEvent({ type: "peer-state", peer: p });
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.removePeer(remoteId);
      }
    };

    // Data channel for talking-state hints. The offerer creates it; the
    // answerer attaches via ondatachannel.
    if (initiator) {
      const ch = pc.createDataChannel("ptt", { ordered: true });
      this.attachDataChannel(remoteId, ch);
      void this.createOffer(remoteId);
    } else {
      pc.ondatachannel = (ev) => {
        this.attachDataChannel(remoteId, ev.channel);
      };
    }

    this.opts.onEvent({ type: "peer-added", peer });
    return peer;
  }

  private attachDataChannel(remoteId: string, ch: RTCDataChannel) {
    this.dataChannels.set(remoteId, ch);
    ch.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.kind === "talking") {
          const peer = this.peers.get(remoteId);
          if (peer) {
            peer.remoteTalking = !!msg.value;
            this.opts.onEvent({
              type: "remote-talking",
              id: remoteId,
              talking: peer.remoteTalking,
            });
          }
        }
      } catch {
        /* noop */
      }
    };
    ch.onclose = () => {
      this.dataChannels.delete(remoteId);
    };
  }

  private async createOffer(remoteId: string) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    try {
      const offer = await peer.pc.createOffer({ offerToReceiveAudio: true });
      await peer.pc.setLocalDescription(offer);
      this.publish({
        kind: "offer",
        from: this.myId,
        to: remoteId,
        sdp: offer,
      });
    } catch (err) {
      console.warn("[mesh] createOffer failed", err);
    }
  }

  private async handleOffer(remoteId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.ensurePeer(remoteId, false);
    try {
      await peer.pc.setRemoteDescription(sdp);
      // Drain any ICE candidates that arrived before the remote description.
      const pending = this.pendingIce.get(remoteId) ?? [];
      for (const c of pending) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch (err) {
          console.warn("[mesh] drained ICE failed", err);
        }
      }
      this.pendingIce.delete(remoteId);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.publish({
        kind: "answer",
        from: this.myId,
        to: remoteId,
        sdp: answer,
      });
    } catch (err) {
      console.warn("[mesh] handleOffer failed", err);
    }
  }

  private async handleAnswer(remoteId: string, sdp: RTCSessionDescriptionInit) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(sdp);
      const pending = this.pendingIce.get(remoteId) ?? [];
      for (const c of pending) {
        try {
          await peer.pc.addIceCandidate(c);
        } catch (err) {
          console.warn("[mesh] drained ICE failed", err);
        }
      }
      this.pendingIce.delete(remoteId);
    } catch (err) {
      console.warn("[mesh] handleAnswer failed", err);
    }
  }

  private async handleIce(remoteId: string, candidate: RTCIceCandidateInit | null) {
    const peer = this.peers.get(remoteId);
    if (!peer) return;
    if (candidate === null) return; // end-of-candidates marker
    if (!peer.pc.remoteDescription) {
      const queue = this.pendingIce.get(remoteId) ?? [];
      queue.push(candidate);
      this.pendingIce.set(remoteId, queue);
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      console.warn("[mesh] addIceCandidate failed", err);
    }
  }

  private removePeer(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.dataChannels.delete(id);
    this.pendingIce.delete(id);
    this.opts.onEvent({ type: "peer-removed", id });
  }
}
