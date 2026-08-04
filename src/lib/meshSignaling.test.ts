// Regression tests for two connection-reliability bugs found in a live
// two-browser audit (2026-08-04):
//
// 1. "hello" was a one-shot setTimeout with no retry. If the announce was
//    lost to a subscribe race or any transient hiccup, two peers could sit
//    in the same room forever, both showing "alone", with no way to recover
//    short of a full page reload. Reproduced live against the production
//    signaling server (wss://turn.0docker.com/ws): two tabs joined the same
//    room and never found each other until one of them left and rejoined.
//
// 2. On RTCPeerConnection connectionState "failed", the peer was torn down
//    immediately with no ICE-restart attempt, so any transient network blip
//    permanently ended that leg of the call.
//
// These tests exercise Mesh's protocol logic against fake WebSocket/
// RTCPeerConnection implementations — no real network or media needed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MeshEvent } from "./meshSignaling";

vi.mock("./turnConfig", () => ({
  fetchIceServers: vi.fn(async () => ({
    iceServers: [],
    hasRelay: false,
    fetchedAt: 0,
  })),
  loadSignalingUrl: vi.fn(() => "wss://fake-signaling.test/ws"),
}));

// ---- Fake signaling bus + WebSocket -------------------------------------

type BusMessage = { topic: string; data: unknown };

class FakeBus {
  subscribers = new Map<string, Set<FakeWebSocket>>();
  log: BusMessage[] = [];
  /** When >0, the next N "hello" publishes are silently dropped (simulates
   * a lost/raced announce — the exact failure mode reproduced live). */
  dropNextHellos = 0;
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;
  private listeners: Record<string, Array<(ev: any) => void>> = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(
    public url: string,
    private bus: FakeBus,
  ) {
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.listeners.open.forEach((cb) => cb({}));
    });
  }

  addEventListener(type: string, cb: (ev: any) => void) {
    this.listeners[type].push(cb);
  }

  send(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.type === "subscribe") {
      for (const topic of msg.topics as string[]) {
        if (!this.bus.subscribers.has(topic)) this.bus.subscribers.set(topic, new Set());
        this.bus.subscribers.get(topic)!.add(this);
      }
    } else if (msg.type === "unsubscribe") {
      for (const topic of msg.topics as string[]) {
        this.bus.subscribers.get(topic)?.delete(this);
      }
    } else if (msg.type === "publish") {
      const data = msg.data as { kind?: string };
      if (data?.kind === "hello" && this.bus.dropNextHellos > 0) {
        this.bus.dropNextHellos--;
        return; // simulate the lost/raced announce
      }
      this.bus.log.push({ topic: msg.topic, data: msg.data });
      const subs = this.bus.subscribers.get(msg.topic);
      subs?.forEach((sock) => {
        if (sock === this) return; // real server does not echo to the sender
        sock.listeners.message.forEach((cb) => cb({ data: raw }));
      });
    }
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.listeners.close.forEach((cb) => cb({ code: 1000 }));
  }
}

// ---- Fake RTCPeerConnection ------------------------------------------

class FakeDataChannel {
  readyState: "connecting" | "open" | "closed" = "open";
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send() {
    /* not exercised by these tests */
  }
}

let pcSeq = 0;

class FakeRTCPeerConnection {
  readonly __id = ++pcSeq;
  connectionState: RTCPeerConnectionState = "new";
  onicecandidate: ((ev: { candidate: any }) => void) | null = null;
  ontrack: ((ev: any) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((ev: { channel: FakeDataChannel }) => void) | null = null;
  closed = false;
  restartIceCalls = 0;

  constructor(_config: unknown) {}

  addTrack(_track: unknown, _stream: unknown) {}

  createDataChannel(_label: string) {
    return new FakeDataChannel();
  }

  async createOffer(_opts?: unknown) {
    return { type: "offer", sdp: `offer-${this.__id}-${Math.random()}` };
  }

  async createAnswer() {
    return { type: "answer", sdp: `answer-${this.__id}-${Math.random()}` };
  }

  async setLocalDescription(_desc: unknown) {
    queueMicrotask(() => {
      this.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: "fake" }) } });
      this.onicecandidate?.({ candidate: null });
    });
  }

  async setRemoteDescription(_desc: unknown) {}

  async addIceCandidate(_c: unknown) {}

  restartIce() {
    this.restartIceCalls++;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }

  /** Test-only helper simulating the browser flipping connection state. */
  __setState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

class FakeMediaStream {
  private tracks: Array<{ enabled: boolean; kind: string }> = [];
  addTrack(t: { enabled: boolean; kind: string }) {
    this.tracks.push(t);
  }
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
}

class FakeAudio {
  autoplay = false;
  srcObject: unknown = null;
  play() {
    return Promise.resolve();
  }
}

function makeLocalStream(): any {
  const stream = new FakeMediaStream();
  stream.addTrack({ enabled: true, kind: "audio" });
  return stream;
}

// ---- Test setup ---------------------------------------------------------

let bus: FakeBus;

beforeEach(() => {
  bus = new FakeBus();
  pcSeq = 0;
  vi.stubGlobal(
    "WebSocket",
    class extends FakeWebSocket {
      constructor(url: string) {
        super(url, bus);
      }
    },
  );
  vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
  vi.stubGlobal("MediaStream", FakeMediaStream);
  vi.stubGlobal("Audio", FakeAudio);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function settle(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("Mesh peer discovery", () => {
  it("recovers via periodic re-hello when the first announce is lost", async () => {
    const { Mesh } = await import("./meshSignaling");

    const eventsA: MeshEvent[] = [];
    const eventsB: MeshEvent[] = [];
    const meshA = new Mesh({
      roomCode: "TEST",
      localStream: makeLocalStream(),
      onEvent: (e) => eventsA.push(e),
    });

    await meshA.start();
    await settle(250); // A's one-shot hello fires; no one else subscribed yet.

    // B's *only* announce attempt (the old one-shot hello) gets lost —
    // exactly the race reproduced live against the production signaling
    // server.
    bus.dropNextHellos = 1;
    const meshB = new Mesh({
      roomCode: "TEST",
      localStream: makeLocalStream(),
      onEvent: (e) => eventsB.push(e),
    });
    await meshB.start();
    await settle(250);

    expect(eventsA.some((e) => e.type === "peer-added")).toBe(false);
    expect(eventsB.some((e) => e.type === "peer-added")).toBe(false);

    // Fast-forward to B's next periodic re-announce — this one is not
    // dropped, so discovery should now succeed.
    await settle(4_100);

    expect(eventsA.some((e) => e.type === "peer-added")).toBe(true);
    expect(eventsB.some((e) => e.type === "peer-added")).toBe(true);
  });
});

describe("Mesh reconnection on ICE failure", () => {
  it("attempts an ICE restart before dropping a failed peer, and only removes it after repeated failures", async () => {
    // Force a deterministic initiator: the first Mesh constructed gets the
    // lexicographically-lower id, so it is always the offerer for this pair.
    const uuidSpy = vi.spyOn(crypto, "randomUUID");
    uuidSpy
      .mockReturnValueOnce("aaaaaaaa-0000-0000-0000-000000000000" as any)
      .mockReturnValueOnce("bbbbbbbb-0000-0000-0000-000000000000" as any);

    const { Mesh } = await import("./meshSignaling");

    const eventsA: MeshEvent[] = [];
    const meshA = new Mesh({
      roomCode: "TEST",
      localStream: makeLocalStream(),
      onEvent: (e) => eventsA.push(e),
    });
    const meshB = new Mesh({
      roomCode: "TEST",
      localStream: makeLocalStream(),
      onEvent: () => {},
    });

    await meshA.start();
    await meshB.start();
    await settle(250);

    const added = eventsA.find((e) => e.type === "peer-added");
    expect(added).toBeDefined();
    const pc = (added as Extract<MeshEvent, { type: "peer-added" }>).peer
      .pc as unknown as FakeRTCPeerConnection;

    const offersBefore = () =>
      bus.log.filter((m) => (m.data as any)?.kind === "offer").length;

    // Fail 3 times (MAX_ICE_RESTART_ATTEMPTS) — each should trigger a
    // restart, not a removal.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = offersBefore();
      pc.__setState("failed");
      await settle(0);
      expect(pc.restartIceCalls).toBe(attempt);
      expect(offersBefore()).toBe(before + 1);
      expect(eventsA.some((e) => e.type === "peer-removed")).toBe(false);
    }

    // The 4th consecutive failure exhausts the retry budget — now it
    // should give up and remove the peer.
    pc.__setState("failed");
    await settle(0);
    expect(pc.restartIceCalls).toBe(3); // no further restart attempted
    expect(eventsA.some((e) => e.type === "peer-removed")).toBe(true);
    expect(pc.closed).toBe(true);
  });
});
