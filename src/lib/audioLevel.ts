// Lightweight RMS level meter on a MediaStream. Returns 0..1 via a callback.
// Uses a single shared AudioContext to avoid per-peer allocation.

let sharedCtx: AudioContext | null = null;
function ctx() {
  if (!sharedCtx) {
    sharedCtx = new AudioContext();
  }
  if (sharedCtx.state === "suspended") {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

export type LevelMeter = {
  stop: () => void;
};

export function attachLevelMeter(
  stream: MediaStream,
  onLevel: (rms: number) => void,
): LevelMeter {
  const audioCtx = ctx();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  const data = new Uint8Array(analyser.fftSize);
  let raf = 0;
  let stopped = false;

  const loop = () => {
    if (stopped) return;
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    onLevel(Math.min(1, rms * 2));
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
    },
  };
}
