/*
  ClipGen AI · Phase 1 · audio loudness analysis (the FOUNDATION for future highlight detection).

  WHAT THIS DOES (and nothing more):
    - reads the audio track with FFmpeg.wasm in 5-minute chunks (8 kHz mono, 16-bit) so memory stays small
      even for hours-long streams, and the video file is never copied (it is mounted read-only)
    - measures RMS and peak loudness for every 0.5 s window, in dBFS
    - summarises it (average / background / loudest level) and lists the loudest moments

  WHAT THIS DOES NOT DO:
    - it does not understand gameplay, speech or excitement. "Loudest moments" are just loudness peaks.
    - it does not detect highlights. That is a later phase and will be built on top of this data.

  The maths (first half of the file) is pure and has no browser dependencies, so it can be tested in isolation.
*/

import { createEngine } from './ffmpeg-engine.js';

export const ANALYSIS_VERSION = 1;
export const WINDOW_SEC = 0.5;       // one loudness value per 0.5 s
export const SAMPLE_RATE = 8000;     // analysis sample rate (plenty for loudness; keeps memory tiny)
export const CHUNK_SEC = 300;        // extract 5 minutes of audio per FFmpeg run
export const QUIET_DB = -55;         // below this a window counts as "quiet"
const COPY_LIMIT_BYTES = 300 * 1000 * 1000;   // only used if mounting fails

/* ======================= pure maths ======================= */

export function toDb(x) { return x > 1e-5 ? Math.max(-90, 20 * Math.log10(x)) : -90; }
const round = (v, d) => { const f = Math.pow(10, d); return Math.round(v * f) / f; };

/** RMS + peak (dBFS) for nWin consecutive windows of winSamples samples. Windows past the end of the data read -90 dB. */
export function measureWindows(pcm, winSamples, nWin) {
  const rms = new Float32Array(nWin);
  const peak = new Float32Array(nWin);
  for (let w = 0; w < nWin; w++) {
    const s = w * winSamples;
    const e = Math.min(pcm.length, s + winSamples);
    if (e <= s) { rms[w] = -90; peak[w] = -90; continue; }
    let sum = 0, pk = 0;
    for (let i = s; i < e; i++) {
      const v = pcm[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
    }
    rms[w] = toDb(Math.sqrt(sum / (e - s)) / 32768);
    peak[w] = toDb(pk / 32768);
  }
  return { rms, peak };
}

/** How many windows to keep from one extracted chunk, and whether it was the last (short) one. */
export function planWindows(sampleCount, winSamples, expectedWin) {
  const full = Math.floor(sampleCount / winSamples);
  if (full >= expectedWin - 1) return { n: expectedWin, last: false };
  const rest = sampleCount - full * winSamples;
  return { n: full + (rest >= winSamples / 4 ? 1 : 0), last: true };
}

export function concatFloat32(parts) {
  let n = 0;
  parts.forEach((p) => { n += p.length; });
  const out = new Float32Array(n);
  let o = 0;
  parts.forEach((p) => { out.set(p, o); o += p.length; });
  return out;
}

/** Summary numbers for the UI. All levels in dBFS. "background" = median window level. */
export function summarize(rmsDb, windowSec) {
  const n = rmsDb.length;
  if (!n) return null;
  const sorted = Float32Array.from(rmsDb).sort();
  const q = (p) => sorted[Math.min(n - 1, Math.floor(p * (n - 1)))];
  let pSum = 0, maxDb = -90, quiet = 0;
  for (let i = 0; i < n; i++) {
    const v = rmsDb[i];
    pSum += Math.pow(10, v / 10);
    if (v > maxDb) maxDb = v;
    if (v < QUIET_DB) quiet++;
  }
  return {
    windows: n,
    durationSec: round(n * windowSec, 1),
    meanDb: round(10 * Math.log10(pSum / n), 1),
    medianDb: round(q(0.5), 1),
    p10Db: round(q(0.1), 1),
    p90Db: round(q(0.9), 1),
    maxDb: round(maxDb, 1),
    quietShare: round(quiet / n, 3)
  };
}

/**
 * The loudest moments: local peaks of the 3-second energy average that stand out above the clip's own
 * background level, at least 20 s apart. This is a plain loudness statistic - NOT highlight detection.
 */
export function findLoudMoments(rmsDb, windowSec, opts) {
  const o = Object.assign({ smoothSec: 3, minSepSec: 20, maxCount: 8, minAboveDb: 6, absFloorDb: -50 }, opts || {});
  const n = rmsDb.length;
  if (n < 4) return [];
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + Math.pow(10, rmsDb[i] / 10);
  const k = Math.max(1, Math.round(o.smoothSec / windowSec));
  const half = k >> 1;
  const smooth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half), b = Math.min(n, i + half + 1);
    smooth[i] = 10 * Math.log10(Math.max(1e-9, (prefix[b] - prefix[a]) / (b - a)));
  }
  const baseline = Float32Array.from(smooth).sort()[Math.floor((n - 1) / 2)];
  const cands = [];
  for (let i = 0; i < n; i++) {
    const s = smooth[i];
    if (s < baseline + o.minAboveDb || s < o.absFloorDb) continue;
    if (i > 0 && s < smooth[i - 1]) continue;
    if (i < n - 1 && s < smooth[i + 1]) continue;
    cands.push(i);
  }
  cands.sort((x, y) => smooth[y] - smooth[x]);
  const minSepWin = Math.round(o.minSepSec / windowSec);
  const picked = [];
  for (const i of cands) {
    if (picked.length >= o.maxCount) break;
    if (picked.every((j) => Math.abs(j - i) >= minSepWin)) picked.push(i);
  }
  return picked.map((i) => {
    let best = i;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (rmsDb[j] > rmsDb[best]) best = j;
    return {
      timeSec: round((best + 0.5) * windowSec, 1),
      levelDb: round(smooth[i], 1),
      aboveBackgroundDb: round(smooth[i] - baseline, 1),
      peakRmsDb: round(rmsDb[best], 1)
    };
  });
}

/** Reads duration / audio / video facts out of the log of `ffmpeg -i file` (which exits with code 1; that is normal). */
export function parseProbe(lines) {
  const t = (lines || []).join('\n');
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const audio = /Stream #\d+:\d+[^\n]*?Audio:\s*([^\n]*)/.exec(t);
  const video = /Stream #\d+:\d+[^\n]*?Video:\s*(\w+)[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(t);
  return {
    durationSec: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    hasAudio: !!audio,
    audioCodec: audio ? (/^(\w+)/.exec(audio[1]) || [])[1] || null : null,
    audioHz: audio ? Number((/(\d+) Hz/.exec(audio[1]) || [])[1]) || null : null,
    hasVideo: !!video,
    videoCodec: video ? video[1] : null,
    width: video ? Number(video[2]) : null,
    height: video ? Number(video[3]) : null
  };
}

/* ======================= analysis job ======================= */

const testOpts = () => (typeof window !== 'undefined' && window.__CLIPGEN_TEST__) || {};
const errMsg = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };

/**
 * Starts an analysis of the audio in `source` (a File or Blob). Returns { promise, cancel }.
 * onProgress({ phase, fraction (0..1 | null), text })   onLog(line)
 * Resolves with { status: 'ready', ... } or { status: 'no-audio', probe }. Rejects with Error (err.cancelled === true if cancelled).
 */
export function startAnalysis(source, options) {
  const o = Object.assign({ durationHint: null, onProgress: () => {}, onLog: () => {}, chunkSec: CHUNK_SEC }, options || {});
  const chunkSec = testOpts().chunkSec || o.chunkSec;
  let cancelled = false;
  let engine = null;

  const cancel = () => { cancelled = true; if (engine) { try { engine.terminate(); } catch (_) { /* ignore */ } } };
  const checkCancel = () => { if (cancelled) { const e = new Error('Cancelled'); e.cancelled = true; throw e; } };

  const promise = (async () => {
    const t0 = performance.now();
    let capture = null;
    const onLog = (line) => { if (capture) capture.push(line); o.onLog(line); };

    o.onProgress({ phase: 'engine', fraction: null, text: 'Preparing the audio engine …' });
    try {
      engine = await createEngine({
        onLog,
        onProgress: () => {},
        onStatus: (s) => o.onProgress({ phase: 'engine', fraction: s.fraction, text: s.text })
      });
      checkCancel();

      const exec = async (args) => {
        capture = [];
        let ret;
        try { ret = await engine.exec(args); } catch (e) { capture = null; throw e; }
        const lines = capture; capture = null;
        return { ret, lines };
      };

      // mount the file read-only (no copy). Copy into memory only if mounting is impossible and the file is small.
      let input, mode = 'mounted';
      try {
        await engine.mkdir('/mnt');
        await engine.mount('/mnt', { blobs: [{ name: 'input_media', data: source }] });
        input = '/mnt/input_media';
      } catch (e) {
        o.onLog('[audio] mount failed: ' + errMsg(e));
        if (source.size > COPY_LIMIT_BYTES) throw new Error('The browser could not open the file directly (' + errMsg(e) + ') and it is too large to copy into memory safely.');
        o.onProgress({ phase: 'read', fraction: null, text: 'Copying the video into memory …' });
        await engine.writeFile('input_media', new Uint8Array(await source.arrayBuffer()));
        input = 'input_media';
        mode = 'copied';
      }
      checkCancel();

      // probe: duration + is there an audio track?
      o.onProgress({ phase: 'probe', fraction: null, text: 'Reading file information …' });
      const probeRun = await exec(['-hide_banner', '-i', input]);   // exit code 1 is normal (no output file given)
      const probe = parseProbe(probeRun.lines);
      if (!probe.hasAudio) {
        return { status: 'no-audio', probe, engine: engine.name, mode, ms: performance.now() - t0 };
      }
      const duration = probe.durationSec || o.durationHint;
      if (!duration || !isFinite(duration) || duration <= 0) throw new Error('Could not determine the video duration.');
      checkCancel();

      const winSamples = Math.round(SAMPLE_RATE * WINDOW_SEC);
      const expectedWin = Math.round(chunkSec / WINDOW_SEC);
      const rmsParts = [], peakParts = [];
      const chunkTotal = Math.ceil(duration / chunkSec);

      for (let ci = 0; ci < chunkTotal; ci++) {
        const start = ci * chunkSec;
        o.onProgress({ phase: 'analyze', fraction: ci / chunkTotal, text: 'Analyzing audio … part ' + (ci + 1) + ' of ' + chunkTotal, chunk: ci + 1, chunks: chunkTotal });
        const r = await exec(['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-t', String(chunkSec), '-i', input,
          '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-acodec', 'pcm_s16le', '-f', 's16le', '-y', 'a.pcm']);
        checkCancel();
        if (r.ret !== 0) throw new Error('FFmpeg could not read the audio (exit code ' + r.ret + ').\n' + r.lines.filter((l) => l && l.trim()).slice(-6).join('\n'));
        let bytes;
        try { bytes = await engine.readFile('a.pcm'); }
        catch (e) { if (ci > 0) break; throw new Error('No audio was decoded from the file (' + errMsg(e) + ').'); }
        try { await engine.deleteFile('a.pcm'); } catch (_) { /* ignore */ }
        checkCancel();
        if (!bytes || bytes.byteLength < 2) { if (ci > 0) break; throw new Error('The audio track decoded to nothing.'); }
        const u8 = (bytes.byteOffset % 2 === 0) ? bytes : bytes.slice();
        const pcm = new Int16Array(u8.buffer, u8.byteOffset, u8.byteLength >> 1);
        const plan = planWindows(pcm.length, winSamples, expectedWin);
        if (plan.n > 0) {
          const m = measureWindows(pcm, winSamples, plan.n);
          rmsParts.push(m.rms);
          peakParts.push(m.peak);
        }
        if (plan.last) break;
      }

      const rmsDb = concatFloat32(rmsParts);
      const peakDb = concatFloat32(peakParts);
      if (!rmsDb.length) throw new Error('No audio samples were decoded.');
      o.onProgress({ phase: 'finish', fraction: 1, text: 'Finishing …' });

      return {
        status: 'ready',
        version: ANALYSIS_VERSION,
        windowSec: WINDOW_SEC,
        sampleRate: SAMPLE_RATE,
        chunkSec,
        durationSec: round(duration, 2),
        windows: rmsDb.length,
        rmsDb,
        peakDb,
        stats: summarize(rmsDb, WINDOW_SEC),
        moments: findLoudMoments(rmsDb, WINDOW_SEC),
        probe,
        engine: engine.name,
        mode,
        ms: Math.round(performance.now() - t0),
        analyzedAt: Date.now()
      };
    } catch (e) {
      if (cancelled) { const c = new Error('Cancelled'); c.cancelled = true; throw c; }
      throw e;
    } finally {
      if (engine) { try { engine.terminate(); } catch (_) { /* ignore */ } engine = null; }   // frees the WebAssembly memory
    }
  })();

  return { promise, cancel };
}
