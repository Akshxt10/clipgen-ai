/*
  ClipGen AI backend · moment analysis and clip selection.

  Inputs are REAL signals measured from the video: the transcript words with timestamps, the loudness curve of the
  actual audio, and the scene cuts of the actual picture. Nothing is random; the same input gives the same output.

  1. sentences   words → speech units (sentence ends, long pauses)
  2. candidates  every run of whole units whose length is within [min, max]
  3. features    audio energy/peaks/variation, speech rate/density, opening hook, questions, emotion, surprise, humour,
                 information, storytelling, scene activity, completeness (does it end at a sentence + pause?)
  4. score       weighted blend → 0–100 "engagement potential"; the strongest signals become labels + reasons
  5. selection   best first; no overlaps, no near-duplicate text, minimum gaps; stricter/looser by "intensity"
  6. boundaries  cut at pauses, never inside a word, small lead-in / tail
  Without a transcript (no speech or no recognizer) it falls back to audio + scene signals only and says so.
*/
import { HOOK_STARTS, HOOK_WORDS, EMOTION, SURPRISE, SURPRISE_PHRASES, FUNNY, LAUGH_MARKERS, INFO, STORY, STORY_PHRASES, NUMBER, CONTINUATION_START, STOPWORDS, normWord } from './lexicon.js';
import { clamp, round } from './util-lite.js';

export const PLATFORM_PRESETS = {
  shorts: { label: 'YouTube Shorts', min: 20, max: 58, aspect: '9:16' },
  tiktok: { label: 'TikTok', min: 15, max: 60, aspect: '9:16' },
  reels: { label: 'Instagram Reels', min: 15, max: 60, aspect: '9:16' },
  youtube: { label: 'YouTube (landscape)', min: 45, max: 180, aspect: '16:9' },
  square: { label: 'Square post', min: 15, max: 60, aspect: '1:1' },
  custom: { label: 'Custom', min: 15, max: 60, aspect: '9:16' }
};

export const INTENSITY = {
  conservative: { minScore: 55, gap: 4, overlap: 0, sim: 0.45 },
  balanced: { minScore: 38, gap: 2, overlap: 0, sim: 0.55 },
  aggressive: { minScore: 22, gap: 1, overlap: 0.1, sim: 0.7 }
};

export function normalizeSettings(raw, duration) {
  const s = raw || {};
  const platform = PLATFORM_PRESETS[s.platform] ? s.platform : 'shorts';
  const pre = PLATFORM_PRESETS[platform];
  const num = (v, d, a, b) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, a, b) : d; };
  let min = num(s.minDuration, pre.min, 5, 600), max = num(s.maxDuration, pre.max, 5, 900);
  if (max < min) { const t = min; min = max; max = t; }
  if (max - min < 3) max = min + 3;
  if (duration && duration < max) { max = Math.max(3, duration); if (min > max) min = Math.max(1, max - 1); }
  return {
    numClips: Math.round(num(s.numClips, 5, 1, 20)),
    minDuration: round(min, 1), maxDuration: round(max, 1),
    platform,
    aspect: ['9:16', '16:9', '1:1'].includes(s.aspect) ? s.aspect : pre.aspect,
    captionStyle: typeof s.captionStyle === 'string' ? s.captionStyle.slice(0, 24) : 'pop',
    captions: s.captions !== false,
    hook: ['balanced', 'strong', 'question', 'off'].includes(s.hook) ? s.hook : 'balanced',
    language: /^(auto|[a-z]{2,3})$/.test(s.language || '') ? s.language : 'auto',
    intensity: INTENSITY[s.intensity] ? s.intensity : 'balanced',
    reframe: ['smart', 'center', 'blur'].includes(s.reframe) ? s.reframe : 'smart',
    keywords: (Array.isArray(s.keywords) ? s.keywords : String(s.keywords || '').split(',')).map((k) => String(k).trim().slice(0, 40)).filter(Boolean).slice(0, 40)
  };
}

/* ---------- 1. sentences ---------- */
const SENT_END = /[.!?…。！？]["')\]]*$/;
export function buildUnits(words) {
  const units = [];
  let first = -1;
  const close = (last) => {
    if (first < 0) return;
    const ws = words.slice(first, last + 1);
    const text = ws.map((x) => x.w).join(' ');
    units.push({ i0: first, i1: last, s: ws[0].s, e: ws[ws.length - 1].e, n: ws.length, text, question: /\?["')\]]*$/.test(text), exclaim: /!["')\]]*$/.test(text), terminal: SENT_END.test(text) });
    first = -1;
  };
  for (let i = 0; i < words.length; i++) {
    if (first >= 0) {
      const gap = words[i].s - words[i - 1].e, n = i - first;
      if (gap >= 0.8 || (n >= 28 && gap >= 0.3) || (words[i].e - words[first].s > 14 && gap >= 0.25)) close(i - 1);
    }
    if (first < 0) first = i;
    if (SENT_END.test(words[i].w)) close(i);
  }
  close(words.length - 1);
  return units;
}

/* units from audio activity only (fallback when there is no transcript) */
export function buildAudioUnits(loud, duration) {
  const { windowSec, rmsDb } = loud;
  if (!rmsDb.length) return [];
  const sorted = [...rmsDb].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const thr = Math.max(floor + 8, -55);
  const units = [];
  let start = null, quiet = 0;
  const minQuiet = Math.ceil(0.7 / windowSec);
  for (let i = 0; i <= rmsDb.length; i++) {
    const active = i < rmsDb.length && rmsDb[i] > thr;
    if (active) { if (start === null) start = i; quiet = 0; }
    else if (start !== null) { quiet++; if (quiet >= minQuiet || i === rmsDb.length) { const end = i - quiet + 1; if ((end - start) * windowSec >= 1) units.push({ i0: -1, i1: -1, s: start * windowSec, e: Math.min(duration, end * windowSec), n: 0, text: '', question: false, exclaim: false, terminal: true }); start = null; quiet = 0; } }
  }
  return units;
}

/* ---------- helpers ---------- */
const sortedCopy = (a) => Float64Array.from(a).sort();
function rankIn(sorted, x) {   // fraction of values <= x
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= x) lo = m + 1; else hi = m; }
  return sorted.length ? lo / sorted.length : 0;
}
function countIn(sortedTimes, a, b) {
  let lo = 0, hi = sortedTimes.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sortedTimes[m] < a) lo = m + 1; else hi = m; }
  let c = 0; for (let i = lo; i < sortedTimes.length && sortedTimes[i] < b; i++) c++;
  return c;
}
const cleanTok = (s) => normWord(s);

function unitCues(u, words) {
  const ws = u.i0 >= 0 ? words.slice(u.i0, u.i1 + 1) : [];
  let emotion = 0, surprise = 0, funny = 0, info = 0, story = 0, num = 0, hookw = 0;
  for (const w of ws) {
    const t = cleanTok(w.w);
    if (EMOTION.has(t)) emotion++;
    if (SURPRISE.has(t)) surprise++;
    if (FUNNY.has(t)) funny++;
    if (INFO.has(t)) info++;
    if (STORY.has(t)) story++;
    if (HOOK_WORDS.has(t)) hookw++;
    if (/\d/.test(w.w)) num++;
  }
  const text = u.text;
  for (const re of SURPRISE_PHRASES) if (re.test(text)) surprise += 2;
  for (const re of STORY_PHRASES) if (re.test(text)) story += 2;
  if (LAUGH_MARKERS.test(text)) funny += 3;
  if (NUMBER.test(text)) num = Math.max(num, 1);
  const ex = (text.match(/!/g) || []).length;
  return { emotion: emotion + ex * 0.7, surprise, funny, info: info + num, story, ex, hookw, num };
}

/* how hook-like is the opening unit (0..1) */
function hookStrength(u, cues) {
  if (!u.text) return 0;
  let h = 0;
  if (HOOK_STARTS.some((re) => re.test(u.text.trim()))) h += 0.55;
  if (u.question) h += 0.3;
  if (cues.hookw) h += Math.min(0.25, cues.hookw * 0.15);
  if (cues.num) h += 0.1;
  if (cues.surprise) h += 0.15;
  if (u.exclaim) h += 0.1;
  if (u.n >= 3 && u.n <= 14) h += 0.15;        // short, punchy first line
  if (CONTINUATION_START.test(u.text.trim())) h -= 0.3;   // starts mid-thought
  return clamp(h, 0, 1);
}

/* ---------- 2–4. candidates + features + scoring ---------- */
export function scoreCandidates({ units, words, loudness, scenes, duration, settings }) {
  const hasText = words && words.length > 0;
  const { windowSec, rmsDb } = loudness;
  const nW = rmsDb.length;
  const speech = (() => { const s = sortedCopy(rmsDb); return Math.max(s[Math.floor(s.length * 0.25)] || -60, -60) + 6; })();
  const cues = units.map((u) => unitCues(u, words || []));
  const sceneSorted = sortedCopy(scenes || []);
  const min = settings.minDuration, max = settings.maxDuration, ideal = min + 0.45 * (max - min);
  const raw = [];

  for (let i = 0; i < units.length; i++) {
    let words_n = 0, emo = 0, sur = 0, fun = 0, inf = 0, sto = 0, ex = 0, question = false, answered = false;
    let sum = 0, sum2 = 0, cnt = 0, mx = -120, speechW = 0, wp = Math.max(0, Math.floor(units[i].s / windowSec));
    for (let j = i; j < units.length; j++) {
      const u = units[j];
      const dur = u.e - units[i].s;
      if (dur > max + 0.01) break;
      words_n += u.n; emo += cues[j].emotion; sur += cues[j].surprise; fun += cues[j].funny; inf += cues[j].info; sto += cues[j].story; ex += cues[j].ex;
      if (j === i && u.question) question = true;
      if (question && j > i) answered = true;
      const wEnd = Math.min(nW, Math.ceil(u.e / windowSec));
      for (; wp < wEnd; wp++) { const v = rmsDb[wp]; sum += v; sum2 += v * v; cnt++; if (v > mx) mx = v; if (v > speech) speechW++; }
      if (dur < min) continue;
      const mean = cnt ? sum / cnt : -120;
      const sd = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 0;
      const next = units[j + 1];
      const tail = next ? next.s - u.e : 1.5;
      const cutCount = countIn(sceneSorted, units[i].s, u.e);
      raw.push({
        i, j, s: units[i].s, e: u.e, dur,
        mean, peak: mx, sd, wps: hasText ? words_n / Math.max(1, dur) : 0, density: cnt ? speechW / cnt : 0,
        emo, sur, fun, inf, sto, ex, words_n, question, answered, scenesPerMin: cutCount / Math.max(1, dur) * 60,
        complete: (u.terminal ? 0.6 : 0.25) + (tail >= 0.5 ? 0.4 : tail >= 0.25 ? 0.2 : 0), contStart: hasText && CONTINUATION_START.test(units[i].text.trim())
      });
    }
  }
  if (!raw.length) return [];

  const sMean = sortedCopy(raw.map((r) => r.mean)), sPeak = sortedCopy(raw.map((r) => r.peak)), sSd = sortedCopy(raw.map((r) => r.sd));
  const sWps = sortedCopy(raw.map((r) => r.wps)), sScene = sortedCopy(raw.map((r) => r.scenesPerMin));
  const hookW = settings.hook === 'off' ? 0 : settings.hook === 'strong' ? 0.24 : settings.hook === 'question' ? 0.16 : 0.13;
  const qW = settings.hook === 'question' ? 0.12 : 0.03;
  const W = hasText
    ? { energy: 0.18, peak: 0.08, variation: 0.06, rate: 0.09, density: 0.06, hook: hookW, question: qW, cue: 0.13, info: 0.07, story: 0.05, scene: 0.04, complete: 0.10, fit: 0.04 }
    : { energy: 0.34, peak: 0.16, variation: 0.14, rate: 0, density: 0.12, hook: 0, question: 0, cue: 0, info: 0, story: 0, scene: 0.14, complete: 0.06, fit: 0.04 };
  const wsum = Object.values(W).reduce((a, b) => a + b, 0);

  return raw.map((r) => {
    const per10 = (x) => (r.words_n ? x / (r.words_n / 10) : 0);
    const f = {
      energy: rankIn(sMean, r.mean), peak: rankIn(sPeak, r.peak), variation: rankIn(sSd, r.sd),
      rate: rankIn(sWps, r.wps), density: r.density,
      hook: hasText ? hookStrength(units[r.i], cues[r.i]) : 0,
      question: r.question ? (r.answered ? 1 : 0.6) : 0,
      emotion: clamp(per10(r.emo) / 1.2, 0, 1), surprise: clamp(per10(r.sur) / 0.8, 0, 1), funny: clamp(per10(r.fun) / 0.6, 0, 1),
      info: clamp(per10(r.inf) / 2.2, 0, 1), story: clamp(per10(r.sto) / 1.6, 0, 1),
      scene: rankIn(sScene, r.scenesPerMin), complete: clamp(r.complete - (r.contStart ? 0.35 : 0), 0, 1),
      fit: clamp(1 - Math.abs(r.dur - ideal) / Math.max(1, (max - min)), 0, 1)
    };
    f.cue = Math.max(f.emotion, f.surprise, f.funny);
    let total = 0;
    for (const k of Object.keys(W)) total += (W[k] || 0) * (f[k] || 0);
    r.f = f; r.score = round(clamp(total / wsum, 0, 1) * 100, 1);
    return r;
  });
}

/* labels + human-readable reasons derived from the measured features */
export function explain(c, units, words, hasText) {
  const f = c.f, cats = [], reasons = [];
  if (hasText && f.hook >= 0.55) { cats.push('Hook'); reasons.push('Strong opening line: “' + units[c.i].text.slice(0, 90) + (units[c.i].text.length > 90 ? '…' : '') + '”'); }
  if (hasText && f.question >= 0.6) { cats.push('Question'); reasons.push(f.question === 1 ? 'Poses a question and answers it within the clip' : 'Opens with a question'); }
  if (f.funny >= 0.45) { cats.push('Funny'); reasons.push('Humour or laughter cues in the speech'); }
  if (f.surprise >= 0.45) { cats.push('Surprising'); reasons.push('Surprise / disbelief wording'); }
  if (f.emotion >= 0.5) { cats.push('Emotional'); reasons.push('Emotionally charged wording'); }
  if (f.info >= 0.55) { cats.push('Informative'); reasons.push('Dense with explanations, steps or figures'); }
  if (f.story >= 0.5) { cats.push('Story'); reasons.push('Narrative storytelling structure'); }
  if (f.energy >= 0.85 || f.peak >= 0.9) { cats.push('Energetic'); reasons.push('Loud, energetic delivery (top ' + Math.max(5, Math.round((1 - Math.max(f.energy, f.peak)) * 100)) + '% of this video)'); }
  if (f.scene >= 0.85) reasons.push('Lots of visual changes (scene cuts)');
  if (f.complete >= 0.9) reasons.push('Starts and ends cleanly on a sentence and a pause');
  if (!cats.length) cats.push(hasText ? 'Highlight' : 'Active moment');
  if (!reasons.length) reasons.push('Best overall balance of audio energy and speech among the candidates');
  return { categories: [...new Set(cats)].slice(0, 3), reasons: reasons.slice(0, 4) };
}

/* ---------- 5–6. selection + cutting points ---------- */
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };
function tokenSet(text) { return new Set(String(text).toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length > 2 && !STOPWORDS.has(t))); }

export function refineBounds(c, units, words, duration) {
  let s = units[c.i].s, e = units[c.j].e;
  if (words && words.length) {
    const a = units[c.i].i0, b = units[c.j].i1;
    const prevEnd = a > 0 ? words[a - 1].e : 0, nextStart = b + 1 < words.length ? words[b + 1].s : duration;
    s = Math.max(prevEnd + Math.min(0.15, (words[a].s - prevEnd) / 2), words[a].s - 0.3, 0);
    e = Math.min(nextStart - Math.min(0.1, (nextStart - words[b].e) / 2), words[b].e + 0.45, duration);
    if (e < words[b].e) e = words[b].e;
  } else { s = Math.max(0, s - 0.2); e = Math.min(duration, e + 0.3); }
  return { start: round(s, 2), end: round(e, 2) };
}

export function selectClips(cands, { units, words, duration, settings }) {
  const hasText = words && words.length > 0;
  const prof = INTENSITY[settings.intensity];
  const ordered = [...cands].sort((a, b) => b.score - a.score || a.s - b.s);
  const chosen = [], rest = [];
  const taken = [];
  const maxPool = settings.numClips + 24;
  for (const c of ordered) {
    if (chosen.length + rest.length >= maxPool) break;
    if (c.score < prof.minScore) break;
    const text = hasText ? units.slice(c.i, c.j + 1).map((u) => u.text).join(' ') : '';
    const toks = tokenSet(text);
    let clash = false;
    for (const t of taken) {
      const ov = Math.min(c.e, t.e) - Math.max(c.s, t.s);
      const shorter = Math.min(c.e - c.s, t.e - t.s);
      if (ov > prof.overlap * shorter) { clash = true; break; }
      if (Math.max(0, Math.max(c.s, t.s) - Math.min(c.e, t.e)) < prof.gap && ov > -prof.gap) { clash = true; break; }
      if (hasText && jaccard(toks, t.toks) > prof.sim) { clash = true; break; }
    }
    if (clash) continue;
    taken.push({ s: c.s, e: c.e, toks });
    (chosen.length < settings.numClips ? chosen : rest).push(c);
  }
  const build = (c, idx) => {
    const b = refineBounds(c, units, words, duration);
    const ex = explain(c, units, words, hasText);
    const text = hasText ? units.slice(c.i, c.j + 1).map((u) => u.text).join(' ') : '';
    return {
      id: 'c' + (idx + 1), rank: idx + 1, start: b.start, end: b.end, duration: round(b.end - b.start, 2), score: c.score,
      categories: ex.categories, reasons: ex.reasons,
      title: hasText ? titleFrom(units[c.i].text) : 'Moment at ' + clock(b.start),
      transcript: text, hook: hasText ? units[c.i].text : '',
      signals: Object.fromEntries(Object.entries(c.f).map(([k, v]) => [k, round(v, 2)])), seed: { i: c.i, j: c.j }
    };
  };
  const clips = chosen.map(build);
  const pool = rest.map((c, k) => build(c, settings.numClips + k));
  return { clips, pool };
}
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
function titleFrom(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const cut = t.length > 64 ? t.slice(0, 64).replace(/\s+\S*$/, '') + '…' : t;
  return cut.charAt(0).toUpperCase() + cut.slice(1);
}

/*
  analyzeVideo → { mode, clips, pool, stats }
  mode "transcript" (words available) or "audio-visual" (no transcript)
*/
export function analyzeVideo({ words, loudness, scenes, duration, settings }) {
  const hasText = Array.isArray(words) && words.length >= 5;
  const units = hasText ? buildUnits(words) : buildAudioUnits(loudness, duration);
  if (!units.length) return { mode: hasText ? 'transcript' : 'audio-visual', clips: [], pool: [], stats: { units: 0, candidates: 0, note: 'No speech or sound activity was found in this video.' } };
  const cands = scoreCandidates({ units, words: hasText ? words : [], loudness, scenes, duration, settings });
  const { clips, pool } = selectClips(cands, { units, words: hasText ? words : [], duration, settings });
  return { mode: hasText ? 'transcript' : 'audio-visual', clips, pool, stats: { units: units.length, candidates: cands.length, words: hasText ? words.length : 0, scenes: (scenes || []).length, windows: loudness.rmsDb.length } };
}

/* next-best distinct alternative for one clip (the "regenerate" button) */
export function regenerateClip(analysis, clipId) {
  const idx = analysis.clips.findIndex((c) => c.id === clipId);
  if (idx < 0) return null;
  const others = analysis.clips.filter((c) => c.id !== clipId);
  const used = new Set(analysis.usedSeeds || []);
  used.add(analysis.clips[idx].seed.i + ':' + analysis.clips[idx].seed.j);
  for (let k = 0; k < analysis.pool.length; k++) {
    const p = analysis.pool[k];
    if (used.has(p.seed.i + ':' + p.seed.j)) continue;
    const clash = others.some((o) => Math.min(o.end, p.end) - Math.max(o.start, p.start) > 0);
    if (clash) continue;
    const old = analysis.clips[idx];
    analysis.pool.splice(k, 1);
    analysis.pool.push(old);                      // old pick goes back to the end of the pool
    analysis.usedSeeds = [...used];
    const next = Object.assign({}, p, { id: clipId, rank: old.rank });
    analysis.clips[idx] = next;
    return next;
  }
  return null;
}
