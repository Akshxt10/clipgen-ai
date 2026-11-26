/*
  ClipGen AI · Phase 1 · step 1 (highlights) · loudness curve from the extracted audio (pure, no browser APIs).
  Same output shape as the backend's loudnessWindows(): { windowSec, rmsDb[], peakDb[] } in dBFS, so the
  tested scoring code in analyze.js can use it unchanged.
*/
export function loudnessFromPcm(pcm, rate = 16000, windowSec = 0.25) {
  const win = Math.max(1, Math.round(rate * windowSec));
  const rms = [], peak = [];
  for (let a = 0; a < pcm.length; a += win) {
    const b = Math.min(pcm.length, a + win);
    let acc = 0, pk = 0;
    for (let i = a; i < b; i++) { const v = pcm[i]; acc += v * v; const m = v < 0 ? -v : v; if (m > pk) pk = m; }
    const r = Math.sqrt(acc / (b - a));
    const db = (x) => Math.round((x > 1e-6 ? 20 * Math.log10(x) : -120) * 10) / 10;
    rms.push(db(r)); peak.push(db(pk));
  }
  return { windowSec, rmsDb: rms, peakDb: peak, samples: pcm.length };
}
