import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { JoinScreen } from "./components/JoinScreen";
import { ShareCard } from "./components/ShareCard";
import { Settings } from "./components/Settings";
import { makeLocalUser, type LocalUser } from "./lib/identity";
import { buildShareUrl, readRoomFromUrl, writeUrlHash } from "./lib/room";
import { Mesh, type MeshEvent, type Peer } from "./lib/meshSignaling";
import { attachLevelMeter } from "./lib/audioLevel";

type Status = "idle" | "mic-pending" | "connecting" | "alone" | "online";

type RemotePeerView = {
  id: string;
  state: RTCPeerConnectionState;
  level: number;
  talking: boolean;
};

export default function App() {
  const [user] = useState<LocalUser>(() => makeLocalUser());
  const [roomCode, setRoomCode] = useState<string | null>(() => readRoomFromUrl());
  const [status, setStatus] = useState<Status>("idle");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [transmitting, setTransmitting] = useState(false);
  const [muted, setMuted] = useState(false);
  const [peers, setPeers] = useState<Map<string, RemotePeerView>>(new Map());
  const [showShare, setShowShare] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [turnWarning, setTurnWarning] = useState<string | null>(null);
  const [localLevel, setLocalLevel] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);

  const meshRef = useRef<Mesh | null>(null);
  const peerMetersRef = useRef<Map<string, () => void>>(new Map());
  const localMeterRef = useRef<(() => void) | null>(null);

  // Acquire mic once roomCode is set.
  useEffect(() => {
    if (!roomCode) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    setStatus("mic-pending");
    setMicError(null);
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        // Start muted (PTT idle).
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        setLocalStream(stream);
        setStatus("connecting");

        // Attach local level meter to visualise mic activity even while muted.
        const meter = attachLevelMeter(stream, (lvl) => setLocalLevel(lvl));
        localMeterRef.current = meter.stop;
      } catch (err) {
        setMicError(err instanceof Error ? err.message : String(err));
        setStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      localMeterRef.current?.();
      localMeterRef.current = null;
      setLocalStream(null);
    };
  }, [roomCode]);

  // Start mesh once we have stream + roomCode.
  useEffect(() => {
    if (!roomCode || !localStream) return;
    const mesh = new Mesh({
      roomCode,
      localStream,
      onEvent: handleEvent,
    });
    meshRef.current = mesh;
    writeUrlHash(roomCode);
    mesh
      .start()
      .then((turnState) => {
        if (!turnState.hasRelay) {
          setTurnWarning(
            "TURN relay unavailable — falling back to STUN only. Cross-NAT voice may fail.",
          );
        }
      })
      .catch((err) => {
        console.error("[mesh] start failed", err);
      });

    function handleEvent(ev: MeshEvent) {
      switch (ev.type) {
        case "ws-open":
          setWsConnected(true);
          break;
        case "ws-close":
        case "ws-error":
          setWsConnected(false);
          break;
        case "peer-added":
          attachPeerMeter(ev.peer);
          setPeers((m) => {
            const next = new Map(m);
            next.set(ev.peer.id, {
              id: ev.peer.id,
              state: ev.peer.connectionState,
              level: 0,
              talking: false,
            });
            return next;
          });
          break;
        case "peer-state":
          setPeers((m) => {
            const existing = m.get(ev.peer.id);
            if (!existing) return m;
            const next = new Map(m);
            next.set(ev.peer.id, { ...existing, state: ev.peer.connectionState });
            return next;
          });
          break;
        case "peer-removed":
          detachPeerMeter(ev.id);
          setPeers((m) => {
            if (!m.has(ev.id)) return m;
            const next = new Map(m);
            next.delete(ev.id);
            return next;
          });
          break;
        case "remote-talking":
          setPeers((m) => {
            const existing = m.get(ev.id);
            if (!existing) return m;
            const next = new Map(m);
            next.set(ev.id, { ...existing, talking: ev.talking });
            return next;
          });
          break;
      }
    }

    function attachPeerMeter(peer: Peer) {
      const m = attachLevelMeter(peer.remoteStream, (lvl) => {
        setPeers((map) => {
          const existing = map.get(peer.id);
          if (!existing) return map;
          if (Math.abs(existing.level - lvl) < 0.02) return map;
          const next = new Map(map);
          next.set(peer.id, { ...existing, level: lvl });
          return next;
        });
      });
      peerMetersRef.current.set(peer.id, m.stop);
    }
    function detachPeerMeter(id: string) {
      const stop = peerMetersRef.current.get(id);
      if (stop) stop();
      peerMetersRef.current.delete(id);
    }

    return () => {
      mesh.destroy();
      meshRef.current = null;
      peerMetersRef.current.forEach((stop) => stop());
      peerMetersRef.current.clear();
    };
  }, [roomCode, localStream]);

  // Derive status display.
  useEffect(() => {
    if (status === "mic-pending" || status === "idle") return;
    setStatus(peers.size > 0 ? "online" : wsConnected ? "alone" : "connecting");
  }, [peers, wsConnected, status]);

  // PTT controls. Spacebar (desktop) + pointerdown on button (mobile).
  const startTalking = useCallback(() => {
    if (muted || !meshRef.current) return;
    setTransmitting(true);
    meshRef.current.setLocalTrackEnabled(true);
  }, [muted]);
  const stopTalking = useCallback(() => {
    setTransmitting(false);
    meshRef.current?.setLocalTrackEnabled(false);
  }, []);

  useEffect(() => {
    function onDown(e: KeyboardEvent) {
      if (e.code === "Space" && !e.repeat) {
        e.preventDefault();
        startTalking();
      }
    }
    function onUp(e: KeyboardEvent) {
      if (e.code === "Space") {
        e.preventDefault();
        stopTalking();
      }
    }
    function onBlur() {
      stopTalking();
    }
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [startTalking, stopTalking]);

  const shareUrl = useMemo(() => (roomCode ? buildShareUrl(roomCode) : ""), [roomCode]);

  function leave() {
    setRoomCode(null);
    setPeers(new Map());
    setTransmitting(false);
    setMuted(false);
    setTurnWarning(null);
    history.replaceState(null, "", window.location.pathname);
  }

  function toggleMute() {
    setMuted((m) => {
      const next = !m;
      if (next && transmitting) {
        meshRef.current?.setLocalTrackEnabled(false);
        setTransmitting(false);
      }
      return next;
    });
  }

  if (!roomCode) {
    return (
      <>
        <JoinScreen onJoin={setRoomCode} />
        <button
          onClick={() => setShowSettings(true)}
          style={{ position: "fixed", bottom: 12, right: 12 }}
        >
          ⚙ Settings
        </button>
        {showSettings && <Settings onClose={() => setShowSettings(false)} />}
      </>
    );
  }

  return (
    <>
      <div className="app-shell">
        <div className="topbar">
          <h1>
            📻 <span>PocketTalkie</span>
          </h1>
          <div className="status-row">
            <span
              className={`status-dot ${
                status === "online"
                  ? "ok"
                  : status === "alone"
                    ? "warn"
                    : status === "connecting" || status === "mic-pending"
                      ? "warn"
                      : "bad"
              }`}
            />
            <span style={{ color: "var(--fg-dim)" }}>
              {status === "online"
                ? `${peers.size} peer${peers.size === 1 ? "" : "s"}`
                : status === "alone"
                  ? "alone"
                  : status === "connecting"
                    ? "connecting…"
                    : status === "mic-pending"
                      ? "mic…"
                      : "idle"}
            </span>
          </div>
        </div>

        <div className="panel" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, color: "var(--fg-dim)" }}>room</div>
            <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: 2 }}>
              {roomCode}
            </div>
            <div style={{ fontSize: 11, color: user.color, marginTop: 2 }}>
              you: {user.name}
            </div>
          </div>
          <button onClick={() => setShowShare(true)}>📤 Share</button>
        </div>

        {micError && (
          <div className="warning-banner">
            Microphone error: {micError}. Reload and grant mic permission.
          </div>
        )}
        {turnWarning && <div className="warning-banner">{turnWarning}</div>}

        <button
          className={`ptt-big ${transmitting ? "transmitting" : ""} ${
            muted ? "muted" : ""
          }`}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            startTalking();
          }}
          onPointerUp={(e) => {
            try {
              (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
              /* noop */
            }
            stopTalking();
          }}
          onPointerCancel={() => stopTalking()}
          onPointerLeave={() => stopTalking()}
          disabled={muted || !localStream}
        >
          {muted ? "MUTED" : transmitting ? "ON AIR" : "PUSH TO TALK"}
          <small>{muted ? "tap mute to re-enable" : "hold • space on desktop"}</small>
        </button>

        <div className="panel" style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>your mic</div>
            <div
              className="vu"
              style={{
                height: 6,
                background: "var(--border)",
                borderRadius: 3,
                overflow: "hidden",
                marginTop: 4,
              }}
            >
              <div
                style={{
                  width: `${Math.round(localLevel * 100)}%`,
                  height: "100%",
                  background: transmitting ? "var(--ok)" : "var(--fg-dim)",
                  transition: "width 0.05s linear",
                }}
              />
            </div>
          </div>
          <button onClick={toggleMute}>{muted ? "🔇 muted" : "🔈 mute"}</button>
        </div>

        <div className="panel">
          <div style={{ fontSize: 12, color: "var(--fg-dim)" }}>peers in room</div>
          {peers.size === 0 ? (
            <div style={{ fontSize: 13, color: "var(--fg-dim)" }}>
              no one else here yet. share the QR or code.
            </div>
          ) : (
            <div className="peer-list">
              {[...peers.values()].map((p) => (
                <div
                  key={p.id}
                  className={`peer-row ${p.talking || p.level > 0.05 ? "talking" : ""}`}
                >
                  <span>{p.id.slice(0, 6)}</span>
                  <div className="vu">
                    <div
                      className="vu-fill"
                      style={{ width: `${Math.round(p.level * 100)}%` }}
                    />
                  </div>
                  <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{p.state}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "space-between",
          }}
        >
          <button onClick={leave}>← Leave</button>
          <button onClick={() => setShowSettings(true)}>⚙ Settings</button>
        </div>
      </div>

      {showShare && (
        <ShareCard
          url={shareUrl}
          roomCode={roomCode}
          onClose={() => setShowShare(false)}
        />
      )}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </>
  );
}
