# Self-hosted infrastructure

PocketTalkie is a static site. Signaling and TURN relay are provided by three independently deployable open-source services on a single Hetzner VPS at `turn.0docker.com`.

```
┌───────────────────────────────┐
│ PocketTalkie (this app)       │
│ GitHub Pages, no backend      │
└──────────┬─────────┬──────────┘
           │         │
   wss://  │         │ https://
  signaling│         │ TURN creds
           ▼         ▼
   ┌──────────┐  ┌──────────┐    turn:3479
   │signaling │  │turn-token│  ┌───────────┐
   │ -server  │  │ -server  │  │  coturn   │
   └──────────┘  └────┬─────┘  │ -hetzner  │
                      │HMAC    └───────────┘
                      └─shared secret──┘
```

## Services

| Repo                                                                                | Endpoint                               | What it does                                                                                                                                       |
| ----------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [baditaflorin/signaling-server](https://github.com/baditaflorin/signaling-server)   | `wss://turn.0docker.com/ws`            | Generic pub/sub fan-out (the y-webrtc protocol). Subscribers to a topic see every other subscriber's publishes. Inspects nothing inside `data`.    |
| [baditaflorin/turn-token-server](https://github.com/baditaflorin/turn-token-server) | `https://turn.0docker.com/credentials` | Issues HMAC-SHA1 TURN credentials with a 1-hour TTL. The TURN_SECRET never leaves the server. Returns `{username, password, ttl, uris}`.           |
| [baditaflorin/coturn-hetzner](https://github.com/baditaflorin/coturn-hetzner)       | `turn:turn.0docker.com:3479` UDP/TCP   | The actual TURN relay. `coturn 4.6` in Docker with `--use-auth-secret` validating creds against the same HMAC secret. UDP relay ports 49152–65535. |

All three have `/health`, Prometheus `/metrics`, nginx example configs, and bootstrap scripts. ~4 €/month on a single CX22 VPS.

## How PocketTalkie uses the stack

PocketTalkie does **not** use y-webrtc (which is data-channel only). It speaks the signaling-server pub/sub protocol directly so it can negotiate audio tracks.

```ts
// see src/lib/meshSignaling.ts
ws.send({ type: "subscribe", topics: [`pockettalkie:${roomCode}`] });
ws.send({ type: "publish",  topic: ..., data: { kind: "hello", from: myId } });
ws.send({ type: "publish",  topic: ..., data: { kind: "offer", from, to, sdp } });
ws.send({ type: "publish",  topic: ..., data: { kind: "answer", from, to, sdp } });
ws.send({ type: "publish",  topic: ..., data: { kind: "ice",    from, to, candidate } });
```

TURN credentials are fetched from `/credentials` **before** the first `RTCPeerConnection` is constructed, so every SDP carries relay candidates. (If we constructed peers with STUN-only first and upgraded later, cross-NAT calls would silently fail on the first try — see the "Gotchas" section of the [stack doc](https://github.com/baditaflorin/anon-conf-poll/blob/main/docs/self-hosted-webrtc-stack.md).)

## How to use your own deployment

Open Settings. Two fields, both backed by `localStorage`:

- `pockettalkie:signalingUrl` — defaults to `wss://turn.0docker.com/ws`
- `pockettalkie:turnTokenUrl` — defaults to `https://turn.0docker.com/credentials`

Override and reload.

Build-time defaults:

```sh
VITE_WEBRTC_SIGNALING=wss://your.example/ws \
VITE_TURN_TOKEN_URL=https://your.example/credentials \
  npm run build
```

## Fallback behaviour

If TURN credentials fetch fails or is empty, PocketTalkie falls back to STUN-only and shows a warning banner. STUN-only works for ~70% of NAT pairs; mobile carrier cross-NAT typically requires TURN.

If signaling is unreachable, peers cannot discover each other and the app exponentially-backs-off-and-retries. There is no fallback signaling. Point Settings at a working server.

## Reference apps on the same stack

- [anon-conf-poll](https://github.com/baditaflorin/anon-conf-poll) — anonymous live polling with Semaphore proofs.
- [cursorparty](https://github.com/baditaflorin/cursorparty) — shared cursors + sticky notes (sibling app).
- [tagboard](https://github.com/baditaflorin/tagboard) — AprilTag-anchored AR sticky notes (sibling app).
- [trust-no-one-anonymizer](https://github.com/baditaflorin/trust-no-one-anonymizer) — anonymized video calls via manual SDP paste.
