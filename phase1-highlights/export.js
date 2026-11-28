/*
  ClipGen AI · Phase 1 · highlights · export of chosen clips (pure logic, no browser APIs).

  A chosen highlight becomes a vertical 9:16 MP4 (720×1280, H.264/AAC) with the recognized words burned in.
  Nothing here is new technology: the crop/scale filter, the encoder settings and the caption builder are the ones of the
  speech-caption test that PASSED on an iPhone (../phase0-speech/). A test keeps the filter and encoder arguments identical.

  What this file adds is only the arithmetic that was missing:
    - clipWindow          the exact source window of a clip (never past the analysed part of the video)
    - buildClipCaptions   the recognized words INSIDE the clip, shifted so the clip starts at 0 s (no caption before or after its speech)
    - exportArgs          the FFmpeg arguments (same as the passed export, with the clip's start and length)
    - parseProbe/judgeOutput  does the finished file really have the right size, codecs and length
    - runExportQueue      one clip at a time; a failed clip does not stop the others; cancel stops cleanly
*/
import { OUT_W, OUT_H, groupWords, buildAss, pickProbeTimes, unsupportedChars } from '../phase0-speech/captions.js';

export { OUT_W, OUT_H };

/* The same crop (centre 9:16) + scale as phase0-speech/app.js. tests/export.test.mjs fails if either copy changes. */
export const VF_BASE = "crop=w='min(iw,trunc(ih*9/16/2)*2)':h='min(ih,trunc(iw*16/9/2)*2)',scale=" + OUT_W + ':' + OUT_H + ':flags=bicubic,setsar=1';
export const VF_ASS = VF_BASE + ',subtitles=filename=/sub.ass:fontsdir=/fonts,format=yuv420p';
export const VF_PLAIN = VF_BASE + ',format=yuv420p';

const round3 = (x) => Math.round(x * 1000) / 1000;
const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

/**
 * Where in the source file a clip lives.
 * clip.start/end are seconds INSIDE the analysed part; analysisStart is where that part begins in the file; analysisDur is its real length.
 * Returns { relStart, relEnd, absStart, absEnd, len, ok }. absEnd never exceeds the end of the analysed audio.
 */
export function clipWindow(clip, analysisStart, analysisDur) {
  const base = Number.isFinite(analysisStart) ? Math.max(0, analysisStart) : 0;
  const total = Number.isFinite(analysisDur) ? analysisDur : Infinity;
  const relStart = round3(clamp(Number(clip.start) || 0, 0, total));
  const wantEnd = Math.min(Number(clip.end) || 0, total);
  const len = Math.floor(Math.max(0, wantEnd - relStart) * 1000) / 1000;          // floor: never one millisecond past the requested end
  return { relStart, relEnd: round3(relStart + len), absStart: round3(base + relStart), absEnd: round3(base + relStart + len), len, ok: len >= 1 };
}

/**
 * The recognized words that belong to a clip, on the CLIP's own clock (0 = first frame of the exported video).
 * words are on the analysis clock ({ w, s, e } in seconds). A word belongs to the clip when its middle lies inside it,
 * so a word is never captioned in a clip that does not contain most of it. Times are clamped to [0, len].
 */
export function captionWordsForClip(words, win) {
  const out = [];
  for (const wd of Array.isArray(words) ? words : []) {
    if (!wd || !Number.isFinite(wd.s) || !Number.isFinite(wd.e)) continue;
    const mid = (wd.s + wd.e) / 2;
    if (mid < win.relStart || mid >= win.relEnd) continue;
    const s = clamp(wd.s - win.relStart, 0, win.len);
    let e = clamp(wd.e - win.relStart, 0, win.len);
    if (e <= s) e = Math.min(win.len, s + 0.05);
    if (e <= s) continue;
    out.push({ w: wd.w, s: round2(s), e: round2(e) });
  }
  return out;
}

/**
 * Caption lines + ASS script for one clip. Nothing is invented: no words in the clip → no captions (ass = null).
 * Every line is clamped inside [0, len], so no caption can outlive the clip.
 */
export function buildClipCaptions(words, win, opts) {
  const cw = captionWordsForClip(words, win);
  const lines = groupWords(cw, opts && opts.group).map((ln) => {
    const start = round2(clamp(ln.start, 0, win.len)), end = round2(clamp(ln.end, 0, win.len));
    return Object.assign({}, ln, { start, end });
  }).filter((ln) => ln.end - ln.start >= 0.05);
  const ass = lines.length ? buildAss(lines, opts && opts.ass) : null;
  return { words: cw, lines, ass, probe: pickProbeTimes(lines, win.len), unsupported: unsupportedChars(cw.map((x) => x.w).join(' ')), len: win.len };
}

/** FFmpeg arguments: the same as the passed speech-caption export (phase0-speech/app.js), with this clip's start and length. */
export function exportArgs(o) {
  return ['-hide_banner', '-ss', String(o.absStart), '-i', o.input, '-t', String(o.len), '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn',
    '-vf', o.captions ? VF_ASS : VF_PLAIN, '-r', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-y', o.out];
}

/** Reads what FFmpeg prints for `ffmpeg -i file` (no output file). */
export function parseProbe(lines) {
  const t = (lines || []).join('\n');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const dim = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(t);
  const vc = /Video:\s*(\w+)/.exec(t), ac = /Audio:\s*(\w+)/.exec(t);
  return { duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null, width: dim ? Number(dim[1]) : null, height: dim ? Number(dim[2]) : null, vcodec: vc ? vc[1] : null, acodec: ac ? ac[1] : null };
}

/** Is the finished file what was asked for? problems = the clip must NOT be offered; warnings = offered, but said out loud. */
export function judgeOutput(info, len, bytes) {
  const problems = [];
  if (!(bytes >= 10000)) problems.push('the file is missing or too small (' + (bytes || 0) + ' bytes)');
  if (info.width !== OUT_W || info.height !== OUT_H) problems.push('size is ' + (info.width || '?') + '×' + (info.height || '?') + ', not ' + OUT_W + '×' + OUT_H);
  if (info.vcodec !== 'h264') problems.push('video is ' + (info.vcodec || 'unknown') + ', not H.264');
  if (info.acodec !== 'aac') problems.push(info.acodec ? 'audio is ' + info.acodec + ', not AAC' : 'the file has no audio');
  if (info.duration === null) problems.push('its length could not be read');
  else if (info.duration > len + 0.25) problems.push('it is ' + info.duration.toFixed(2) + ' s long, longer than the requested ' + len.toFixed(2) + ' s');
  else if (info.duration < len - 0.6) problems.push('it is only ' + info.duration.toFixed(2) + ' s long, shorter than the requested ' + len.toFixed(2) + ' s');
  return { ok: problems.length === 0, problems };
}

/**
 * Are the captions visible in the exported frame? The page compares the exported frame with the same moment of the source (same crop, no captions).
 * a / b = { band, outside, bandPixels, outsidePixels }: how many pixels differ inside the caption band and everywhere else.
 * Captions only add difference inside the band. If the rest of the picture also differs a lot (the picture moves between the two frames,
 * so they cannot be compared exactly) the check says 'unclear' instead of guessing. Returns 'yes' | 'no' | 'unclear'.
 */
export const BAND = { from: 0.58, to: 0.82 };              // share of the frame height where the captions are drawn (bottom-aligned, 300 px margin)
export function captionVisibility(word, gap) {
  const moving = (m) => m && m.outsidePixels > 0 && m.outside / m.outsidePixels > 0.03;
  if (moving(word) || moving(gap)) return 'unclear';
  return word.band >= 600 && (!gap || word.band > gap.band * 3 + 300) ? 'yes' : 'no';
}

/** FFmpeg prints "time=00:00:05.12" while encoding. Returns 0..0.99 of the clip, or null for any other line. */
export function progressFromLog(line, len) {
  const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(line || ''));
  if (!m || !(len > 0)) return null;
  return clamp((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / len, 0, 0.99);
}

/** A file name that is safe on iPhone, Windows and Android and says what it is. */
export function safeFileName(sourceName, n, win) {
  const base = String(sourceName || 'video').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'video';
  const t = (s) => Math.floor(s / 60) + 'm' + String(Math.floor(s % 60)).padStart(2, '0') + 's';
  return 'clipgen_' + base + '_clip' + n + '_' + t(win.absStart) + '-' + t(win.absEnd) + '.mp4';
}

/**
 * Exports the given items ONE AT A TIME.
 *   exportOne(item, { index, total }) -> result      (does its own set-up and clean-up; throws on failure; throws Error('Cancelled') when cancelled)
 *   isCancelled() -> boolean
 *   onState(item, state, info)       state: 'working' | 'done' | 'failed' | 'cancelled' | 'skipped'
 * A failed clip does not stop the others. A failure marked err.fatal (for example the video engine cannot start at all) stops the rest,
 * which are reported as 'skipped'. Cancelling keeps every clip already finished and discards the one in progress.
 */
export async function runExportQueue(o) {
  const items = o.items, out = { done: [], failed: [], cancelled: [], skipped: [] };
  const rest = (from, state, note) => { for (let j = from; j < items.length; j++) { out[state].push(items[j]); o.onState(items[j], state, { note }); } };
  for (let i = 0; i < items.length; i++) {
    if (o.isCancelled()) { rest(i, 'cancelled', 'Cancelled before it started.'); break; }
    const it = items[i];
    o.onState(it, 'working', { index: i, total: items.length });
    try {
      const value = await o.exportOne(it, { index: i, total: items.length });
      out.done.push(it); o.onState(it, 'done', { value });
    } catch (e) {
      const m = e && e.message ? e.message : String(e);
      if (o.isCancelled() || m === 'Cancelled') { out.cancelled.push(it); o.onState(it, 'cancelled', { note: 'Cancelled. This clip was not kept.' }); rest(i + 1, 'cancelled', 'Cancelled before it started.'); break; }
      out.failed.push(it); o.onState(it, 'failed', { error: m });
      if (e && e.fatal) { rest(i + 1, 'skipped', 'Not tried: the video engine could not start.'); break; }
    }
  }
  return out;
}
