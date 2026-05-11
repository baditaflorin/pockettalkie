import { useState } from "react";
import { QRImage } from "../lib/qr";

export function ShareCard({
  url,
  roomCode,
  onClose,
}: {
  url: string;
  roomCode: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* noop */
    }
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Invite</h2>
          <button onClick={onClose}>close</button>
        </div>
        <div className="qr-block">
          <QRImage text={url} size={240} />
          <div className="url">{url}</div>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <small>
            Code: <strong style={{ color: "var(--fg)" }}>{roomCode}</strong>
          </small>
          <button className="primary" onClick={copy}>
            {copied ? "copied" : "Copy link"}
          </button>
        </div>
      </div>
    </div>
  );
}
