/*
  ClipGen AI · speech-caption test · caption maths (pure functions, no browser APIs).

  Input  : the words a speech recognizer returned, each with a start and end time (seconds, relative to the clip).
  Output : caption lines and an ASS subtitle script that FFmpeg's libass burns into the video.

  Nothing in this file invents words. If the recognizer returns no words, there are no captions.
  The same file is imported by the page and by the automated tests.
*/

export const OUT_W = 720;
export const OUT_H = 1280;

const NON_SPEECH = /^[\[(♪*<].*[\])♪*>]$/;      // "[BLANK_AUDIO]", "(music)", "♪ ♪", "*laughs*" …
const ONLY_PUNCT = /^[\s.,!?;:…\-–—"'“”‘’()]+$/;
const SENTENCE_END = /[.?!…]["'”’)]*$/;

export const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Turns recognizer chunks [{ text, timestamp: [start, end|null] }] into clean words [{ w, s, e }].
 * - removes non-speech markers, merges stray punctuation into the previous word
 * - repairs missing/invalid end times, keeps everything inside [0, duration] and in order
 */
export function normalizeWords(chunks, duration) {
  const dur = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const text = String((c && c.text) || '').replace(/\s+/g, ' ').trim();
    if (!text || NON_SPEECH.test(text)) continue;
    if (ONLY_PUNCT.test(text)) { if (out.length) out[out.length - 1].w += text; continue; }
    const ts = (c && c.timestamp) || [];
    let s = Number(ts[0]);
    let e = ts[1] === null || ts[1] === undefined ? NaN : Number(ts[1]);
    if (!Number.isFinite(s)) s = out.length ? out[out.length - 1].e : 0;
    out.push({ w: text, s, e });
  }
  for (let i = 0; i < out.length; i++) {
    const wd = out[i], prev = out[i - 1], next = out[i + 1];
    wd.s = Math.max(0, wd.s);
    if (prev) wd.s = Math.max(wd.s, prev.s);
    if (!Number.isFinite(wd.e) || wd.e <= wd.s) wd.e = next && Number.isFinite(next.s) && next.s > wd.s ? next.s : wd.s + 0.5;
    wd.e = Math.min(wd.e, dur);
    if (wd.e < wd.s + 0.05) wd.e = Math.min(dur, wd.s + 0.05);
  }
  const kept = out.filter((x) => x.s < dur && x.e > x.s);
  return kept.map((x) => ({ w: x.w, s: round2(x.s), e: round2(x.e) }));
}

/**
 * Groups words into short caption lines (good for a 9:16 screen).
 * A new line starts after a sentence end, a pause >= gapBreak, or when the line would get too long.
 */
export function groupWords(words, opts) {
  const o = Object.assign({ maxWords: 3, maxChars: 20, gapBreak: 0.6, minDur: 0.3, tail: 0.35 }, opts || {});
  const lines = [];
  let cur = null;
  const push = () => { if (cur && cur.words.length) lines.push(cur); cur = null; };
  for (const wd of words) {
    if (cur) {
      const last = cur.words[cur.words.length - 1];
      const chars = cur.words.reduce((a, x) => a + x.w.length, 0) + cur.words.length - 1;
      if (cur.words.length >= o.maxWords || chars + 1 + wd.w.length > o.maxChars || wd.s - last.e >= o.gapBreak) push();
    }
    if (!cur) cur = { start: wd.s, end: wd.e, words: [] };
    cur.words.push(wd);
    cur.end = Math.max(cur.end, wd.e);
    if (SENTENCE_END.test(wd.w)) push();
  }
  push();
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i], next = lines[i + 1];
    ln.end = Math.max(ln.end, ln.start + o.minDur);
    let end = ln.end + o.tail;
    if (next) end = Math.min(end, next.start);
    ln.end = round2(Math.max(end, ln.words[ln.words.length - 1].e));
    ln.start = round2(ln.start);
    ln.text = ln.words.map((x) => x.w).join(' ');
  }
  return lines;
}

export function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
}
const assEscape = (s) => String(s).replace(/[{}\\]/g, '').replace(/[\r\n]+/g, ' ');

/** ASS script with a word-by-word highlight (karaoke) for every line. */
export function buildAss(lines, o) {
  const opt = Object.assign({ family: 'Poppins', bold: true, fontSize: 60, marginV: 300 }, o || {});
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + OUT_W, 'PlayResY: ' + OUT_H, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Cap,' + opt.family + ',' + opt.fontSize + ',&H0000E5FF,&H00FFFFFF,&H00000000,&H80000000,' + (opt.bold ? -1 : 0) + ',0,0,0,100,100,0,0,1,5,2,2,50,50,' + opt.marginV + ',1', '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = lines.map((ln) => {
    const ws = ln.words;
    const text = ws.map((wd, i) => {
      const until = i < ws.length - 1 ? ws[i + 1].s : wd.e;
      const cs = Math.max(1, Math.round((until - wd.s) * 100));
      return '{\\k' + cs + '}' + assEscape(wd.w) + (i < ws.length - 1 ? ' ' : '');
    }).join('');
    return 'Dialogue: 0,' + assTime(ln.start) + ',' + assTime(ln.end) + ',Cap,,0,0,0,,{\\fad(80,80)}' + text;
  });
  return head.concat(events, ['']).join('\n');
}

/** A moment where a caption must be on screen, and (if possible) one where none should be. */
export function pickProbeTimes(lines, duration) {
  if (!lines.length) return { tWord: null, tGap: null };
  const longest = lines.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const tWord = round2(longest.start + (longest.end - longest.start) * 0.5);
  let tGap = null;
  if (lines[0].start >= 0.4) tGap = round2(lines[0].start / 2);
  for (let i = 0; tGap === null && i < lines.length - 1; i++) {
    if (lines[i + 1].start - lines[i].end >= 0.4) tGap = round2((lines[i].end + lines[i + 1].start) / 2);
  }
  const last = lines[lines.length - 1];
  if (tGap === null && duration - last.end >= 0.4) tGap = round2((last.end + duration) / 2);
  return { tWord, tGap };
}

/** Characters the bundled caption font (Latin letters) cannot draw. They would show as empty boxes. */
export function unsupportedChars(text) {
  const bad = new Set();
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c > 0x24f && !(c >= 0x2000 && c <= 0x206f) && !(c >= 0x20a0 && c <= 0x20cf)) bad.add(ch);
  }
  return [...bad];
}

const wordsOf = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
/** Word error rate (0 = perfect) between what was really said and what was recognized. */
export function wordErrorRate(reference, hypothesis) {
  const r = wordsOf(reference), h = wordsOf(hypothesis);
  if (!r.length) return null;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return +(prev[h.length] / r.length).toFixed(3);
}

/**
 * Do the recognized words sit on audible sound? pcm = mono Float32 at `rate` Hz.
 * Returns the share of words whose time span is clearly louder than the quietest part of the clip.
 * It cannot prove the words are right, only that the timestamps are not pointing at silence.
 */
export function syncCheck(pcm, rate, words) {
  const win = Math.max(1, Math.round(rate * 0.05));
  const n = Math.floor(pcm.length / win);
  if (n < 4 || !words.length) return { onSpeech: null, noiseDb: null, windows: n };
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = i * win; k < (i + 1) * win; k++) sum += pcm[k] * pcm[k];
    db[i] = 10 * Math.log10(sum / win + 1e-12);
  }
  const sorted = Array.from(db).sort((a, b) => a - b);
  const floor = sorted[Math.floor(n * 0.1)];
  const peak = sorted[Math.floor(n * 0.95)];
  if (peak - floor < 6) return { onSpeech: null, noiseDb: +floor.toFixed(1), windows: n, flat: true };
  const thr = floor + Math.min(6, (peak - floor) / 3);
  let on = 0;
  for (const wd of words) {
    const a = Math.max(0, Math.floor((wd.s / 0.05))), b = Math.min(n - 1, Math.max(a, Math.ceil(wd.e / 0.05) - 1));
    let loud = 0;
    for (let i = a; i <= b; i++) if (db[i] > thr) loud++;
    if (loud / (b - a + 1) >= 0.3) on++;
  }
  return { onSpeech: +(on / words.length).toFixed(2), noiseDb: +floor.toFixed(1), windows: n };
}

export function rmsDb(pcm) {
  if (!pcm.length) return -120;
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * pcm[i];
  return +(10 * Math.log10(s / pcm.length + 1e-12)).toFixed(1);
}
