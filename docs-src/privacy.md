# Privacy & threat model

PocketTalkie is anonymous and ephemeral by design. No signup, no identity persisted across sessions. Audio flows peer-to-peer, never through a server that can decrypt it.

## What peers in your room hear

- Your microphone, in real time, whenever you press push-to-talk.
- There is no "leader" or "host" — every peer can transmit to every other peer.

There is no privacy _within_ a room. If you don't want someone to hear you, don't share the room code with them.

## What the signaling server sees

The signaling server (`wss://turn.0docker.com/ws` by default) is a generic pub/sub:

- The room topic — `pockettalkie:<roomCode>`.
- For each peer: SDP offers, SDP answers, and ICE candidates (these contain peer IP candidates and DTLS fingerprints).
- A random UUID per peer per session.

It does **not** see audio. Audio never crosses the signaling server.

The signaling server does not log message bodies. The maintainer does not run any analytics.

## What the TURN relay sees

The TURN relay (`turn:turn.0docker.com:3479` by default) handles ~30–50% of cross-NAT connections that can't establish a direct peer link. When it relays:

- It sees the source and destination IPs and ports.
- It sees DTLS-encrypted SRTP packets. It cannot decrypt the audio.

If you require zero metadata at the TURN relay, point Settings at your own coturn deployment.

## What the network sees

- Your link to the signaling server: TLS-encrypted WebSocket (`wss://`).
- Peer-to-peer audio: DTLS-SRTP — the standard WebRTC security profile. Audio is encrypted between the two browser endpoints with ephemeral DTLS keys exchanged in-SDP.
- An eavesdropper between two peers sees an encrypted packet stream and learns nothing about the audio content.

DTLS-SRTP protects payload confidentiality but not metadata: an observer at the TURN relay can see _when_ you are transmitting (packet timing). PocketTalkie does not currently send constant-rate cover traffic.

## What we do not do

- No service worker — hard refresh always gets the latest code.
- No localStorage of audio or transcripts.
- No third-party analytics. No Sentry. No telemetry.
- No identity persisted across sessions. Your peer ID is a random UUID regenerated every page load.
- No recording. Audio is not buffered to disk anywhere in the pipeline.

## Encryption details

- **Signaling:** TLS to `wss://turn.0docker.com/ws`. SDP and ICE blobs travel inside this TLS channel.
- **Media:** DTLS-SRTP, ECDHE on the curve advertised in the SDP, AES-128-GCM SRTP profile in modern browsers.
- **TURN:** if used, the TURN relay sees the same DTLS-SRTP packets it cannot decrypt.

There is no application-layer encryption on top of DTLS-SRTP in the current build. DTLS-SRTP is sufficient for the "the signaling/TURN operator cannot eavesdrop" property, but it is not double-ratchet — if an endpoint is compromised, the session key is too.

## Caveats

- The room code is in your URL hash. URL hashes are not sent to servers, but browser sync features (Chrome Sync, iCloud Tabs) may sync your URL across your own devices.
- Anyone with the room code can transmit. There is no permission to "raise hand" — anyone may speak.
- Mesh topology means that with N peers, each peer uploads N-1 streams. Beyond ~6 peers the lowest-bandwidth peer will start dropping audio.
