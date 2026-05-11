# PocketTalkie

Encrypted push-to-talk rooms in the browser. Hold space (or the big red button) to talk. Mesh up to ~6 peers. QR to invite. No signup, no backend, ephemeral.

→ <https://baditaflorin.github.io/pockettalkie/>

## What it is

A peer-to-peer walkie-talkie built as a single static site. Audio flows directly between browsers over WebRTC (SRTP/DTLS-encrypted by default). The signaling server only sees opaque pub/sub blobs scoped to a room code.

- **Push-to-talk** — desktop: hold `Space`. Mobile: tap and hold the on-screen button. Tracks are muted (`track.enabled = false`) until you press.
- **Full audio mesh** — each peer holds an `RTCPeerConnection` to every other peer. Good for ~6 peers; degrades on weak networks beyond that.
- **Encryption** — WebRTC's DTLS-SRTP is the floor (peer-to-peer encrypted, decrypted only at endpoints). The TURN relay sees encrypted bytes only.
- **Rooms** — 7-char room code in the URL hash. QR for one-tap mobile join.

## How to join

1. Open the URL.
2. Tap **Start a new room** or enter / scan a room code.
3. Grant microphone permission.
4. Share the QR. When someone else joins, press and hold to transmit.

## Self-hosted infrastructure

PocketTalkie has no backend of its own. It uses the maintainer's three-service WebRTC stack on a single Hetzner VPS at `turn.0docker.com`:

| Repo                                                                   | Endpoint                               | Purpose                                                                 |
| ---------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| [signaling-server](https://github.com/baditaflorin/signaling-server)   | `wss://turn.0docker.com/ws`            | y-webrtc protocol WebSocket fan-out (PocketTalkie speaks this directly) |
| [turn-token-server](https://github.com/baditaflorin/turn-token-server) | `https://turn.0docker.com/credentials` | HMAC TURN creds, 1-hour TTL                                             |
| [coturn-hetzner](https://github.com/baditaflorin/coturn-hetzner)       | `turn:turn.0docker.com:3479`           | TURN relay                                                              |

The **Settings** panel lets you point at your own deployment. If TURN is unreachable, the app falls back to STUN-only and warns you (works for ~70% of NAT pairs; mobile carrier cross-NAT typically needs TURN).

See [docs/self-hosted-infra.md](docs-src/self-hosted-infra.md) for the full integration pattern.

## Threat model

Read [docs/privacy.md](docs-src/privacy.md). Summary:

- Anyone with the room code can join, hear, and transmit.
- The signaling server sees: room code, peer IDs (random UUIDs), SDP offers/answers, and ICE candidates. It does not see audio.
- The TURN relay (when used) sees: DTLS-encrypted RTP packets. It cannot decrypt them.
- There is no admin, no moderation, no recording, no logging on the maintainer's side.

## Architecture in 60 seconds

PocketTalkie does not use y-webrtc. It speaks the signaling server's pub/sub protocol directly because y-webrtc is data-channel-only and we need audio tracks.

```
WS pub/sub topic = "pockettalkie:<roomCode>"

peer A          signaling-server         peer B
  │                    │                    │
  │── subscribe ──────▶│                    │
  │                    │◀────── subscribe ──│
  │── publish hello ──▶│── hello ──────────▶│
  │                    │◀── publish hello ──│
  │     (A.id < B.id, so A offers)
  │── publish offer ──▶│── offer ──────────▶│
  │                    │◀── publish answer ─│
  │◀── answer ─────────│                    │
  │── publish ice ────▶│── ice ────────────▶│
  │                    │      (repeat)      │
  │═══════════ DTLS-SRTP audio ═════════════│
  │     (direct or TURN-relayed)            │
```

See [src/lib/meshSignaling.ts](src/lib/meshSignaling.ts).

## Develop

```
npm install
npm run dev
```

Open <http://localhost:5174>. Open in two browser windows to test mesh connect.

## Build for GitHub Pages

```
npm run build
```

Outputs to `docs/`. Commit and Pages serves. No GitHub Actions — `npm run smoke` is the local CI, gated by the pre-commit hook.

## Reference apps copied from

- [trust-no-one-anonymizer](https://github.com/baditaflorin/trust-no-one-anonymizer) — media stream handling.
- [anon-conf-poll](https://github.com/baditaflorin/anon-conf-poll) — `turnConfig.ts`, signaling URL handling, Settings pattern.

## License

MIT.
