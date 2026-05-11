import { useState } from "react";
import { makeRoomCode, normalizeRoomCode } from "../lib/room";
import { QRScanner } from "../lib/qr";

export function JoinScreen({ onJoin }: { onJoin: (code: string) => void }) {
  const [code, setCode] = useState("");
  const [scanning, setScanning] = useState(false);

  function startNew() {
    onJoin(makeRoomCode());
  }
  function joinExisting() {
    const cleaned = normalizeRoomCode(code);
    if (cleaned.length < 4) return;
    onJoin(cleaned);
  }
  function handleScan(text: string) {
    setScanning(false);
    try {
      const url = new URL(text);
      const hash = url.hash.replace(/^#/, "");
      const params = new URLSearchParams(hash);
      const r = params.get("r");
      if (r) {
        onJoin(normalizeRoomCode(r));
        return;
      }
    } catch {
      /* not a URL */
    }
    const cleaned = normalizeRoomCode(text);
    if (cleaned.length >= 4) onJoin(cleaned);
  }

  return (
    <div className="app-shell" style={{ justifyContent: "center" }}>
      <div className="panel">
        <h1 style={{ margin: 0, fontSize: 22 }}>📻 PocketTalkie</h1>
        <small style={{ color: "var(--fg-dim)" }}>
          Encrypted push-to-talk rooms. No signup, no backend. Hold space (or tap and hold
          the button) to talk.
        </small>

        <button className="primary" onClick={startNew}>
          Start a new room
        </button>

        <div className="row" style={{ gap: 8, display: "flex" }}>
          <input
            placeholder="or enter room code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && joinExisting()}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <button onClick={joinExisting} disabled={normalizeRoomCode(code).length < 4}>
            Join
          </button>
        </div>

        <button onClick={() => setScanning(true)}>📷 Scan QR</button>
      </div>

      {scanning && <QRScanner onResult={handleScan} onClose={() => setScanning(false)} />}
    </div>
  );
}
