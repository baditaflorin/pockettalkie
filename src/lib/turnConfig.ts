// Self-hosted WebRTC infrastructure config — copy of the canonical pattern
// from baditaflorin/anon-conf-poll. STORAGE_PREFIX is per-app.

const STORAGE_PREFIX = "pockettalkie";

const DEFAULT_TURN_TOKEN_URL = "https://turn.0docker.com/credentials";
const DEFAULT_SIGNALING_URL = "wss://turn.0docker.com/ws";

const DEAD_SIGNALING_URLS = new Set([
  "wss://signaling.yjs.dev",
  "ws://signaling.yjs.dev",
  "wss://y-webrtc-signaling-eu.herokuapp.com",
  "wss://y-webrtc-signaling-us.herokuapp.com",
]);

export const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

type TurnCredentialResponse = {
  username: string;
  password: string;
  ttl: number;
  uris: string[];
};

export function loadTurnTokenUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_TURN_TOKEN_URL;
  const stored = localStorage.getItem(`${STORAGE_PREFIX}:turnTokenUrl`);
  if (stored !== null) return stored;
  const env = (import.meta as ImportMeta).env?.VITE_TURN_TOKEN_URL as string | undefined;
  return env ?? DEFAULT_TURN_TOKEN_URL;
}

export function saveTurnTokenUrl(url: string): void {
  const trimmed = url.trim();
  if (trimmed === DEFAULT_TURN_TOKEN_URL) {
    localStorage.removeItem(`${STORAGE_PREFIX}:turnTokenUrl`);
  } else {
    localStorage.setItem(`${STORAGE_PREFIX}:turnTokenUrl`, trimmed);
  }
}

export function loadSignalingUrl(): string {
  if (typeof localStorage === "undefined") return DEFAULT_SIGNALING_URL;
  const stored = localStorage.getItem(`${STORAGE_PREFIX}:signalingUrl`) ?? "";
  if (stored && DEAD_SIGNALING_URLS.has(stored)) {
    localStorage.removeItem(`${STORAGE_PREFIX}:signalingUrl`);
  } else if (stored) {
    return stored;
  }
  const envUrl =
    ((import.meta as ImportMeta).env?.VITE_WEBRTC_SIGNALING as string | undefined) ??
    DEFAULT_SIGNALING_URL;
  return envUrl;
}

export function saveSignalingUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || trimmed === DEFAULT_SIGNALING_URL) {
    localStorage.removeItem(`${STORAGE_PREFIX}:signalingUrl`);
  } else {
    localStorage.setItem(`${STORAGE_PREFIX}:signalingUrl`, trimmed);
  }
}

export const DEFAULTS = {
  signalingUrl: DEFAULT_SIGNALING_URL,
  turnTokenUrl: DEFAULT_TURN_TOKEN_URL,
};

export type TurnState = {
  iceServers: RTCIceServer[];
  hasRelay: boolean;
  fetchedAt: number;
  error?: string;
};

export async function fetchIceServers(): Promise<TurnState> {
  const tokenUrl = loadTurnTokenUrl();
  if (!tokenUrl) {
    return { iceServers: STUN_SERVERS, hasRelay: false, fetchedAt: Date.now() };
  }
  try {
    const res = await fetch(tokenUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cred = (await res.json()) as TurnCredentialResponse;
    if (!Array.isArray(cred.uris) || cred.uris.length === 0) {
      throw new Error("token server returned no TURN URIs");
    }
    const iceServers: RTCIceServer[] = [
      ...STUN_SERVERS,
      ...cred.uris.map((u) => ({
        urls: u,
        username: cred.username,
        credential: cred.password,
      })),
    ];
    return { iceServers, hasRelay: true, fetchedAt: Date.now() };
  } catch (err) {
    console.warn("[turn] credential fetch failed, falling back to STUN-only:", err);
    return {
      iceServers: STUN_SERVERS,
      hasRelay: false,
      fetchedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
