const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeRoomCode(len = 7): string {
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

export function normalizeRoomCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 16);
}

export function readRoomFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  const r = params.get("r");
  if (!r) return null;
  const cleaned = normalizeRoomCode(r);
  return cleaned.length >= 4 ? cleaned : null;
}

export function readPasswordFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const hash = window.location.hash.replace(/^#/, "");
  const params = new URLSearchParams(hash);
  return params.get("k") || null;
}

export function buildShareUrl(roomCode: string, password?: string): string {
  const base = `${window.location.origin}${window.location.pathname}`;
  const params = new URLSearchParams();
  params.set("r", roomCode);
  if (password) params.set("k", password);
  return `${base}#${params.toString()}`;
}

export function writeUrlHash(roomCode: string, password?: string): void {
  const params = new URLSearchParams();
  params.set("r", roomCode);
  if (password) params.set("k", password);
  const next = `#${params.toString()}`;
  if (window.location.hash !== next) {
    history.replaceState(null, "", next);
  }
}
