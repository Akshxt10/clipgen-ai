/*
  ClipGen AI · Phase 1 · step 1 · automatic highlight detection.

  Pipeline (everything on this device):
    open the video (mounted, never copied) → extract 16 kHz mono audio with FFmpeg.wasm (same call as the speech-caption test)
    → loudness curve → Whisper speech recognition with word timestamps (same recognizer files as the speech-caption test)
    → analyze.js (the backend's tested scoring/selection code, unchanged) → ranked clips → automatic checks → preview.

  The video engine and the recognizer are imported from ../phase0-speech/ and are NOT modified.
  Scores are heuristics (loudness, speech rate, hook/question/emotion cues, sentence boundaries). They are not human judgement.

  Export (step 2): chosen clips are cut from the original video, made 9:16 (720×1280) with the recognized words burned in, using the
  same crop/encoder/caption code as the speech-caption test (see export.js). One clip at a time, a fresh video engine per clip.
*/
import { createEngine } from '../phase0-speech/ffmpeg-engine.js';
import { createRecognizer, MODELS } from '../phase0-speech/speech.js';
import { normalizeWords, syncCheck, rmsDb } from '../phase0-speech/captions.js';
import { analyzeVideo, normalizeSettings } from './analyze.js';
import { loudnessFromPcm } from './loudness.js';
import { checkClips } from './checks.js';
import { planChunks, checkpointKey, transcribeChunked } from './asr-chunks.js';
import { clipWindow, buildClipCaptions, exportArgs, parseProbe, judgeOutput, progressFromLog, safeFileName, runExportQueue, captionVisibility, BAND, VF_BASE, OUT_W, OUT_H } from './export.js';

const VERSION = 'highlights-v3';
const FLAG_KEY = 'clipgen-highlights-run';
const CKPT_KEY = 'clipgen-highlights-ckpt';
const RATE = 16000;
const MAX_WINDOW = 600;
const FONT_URL = '../phase0-speech/font/Poppins-Bold.ttf';      // the caption font of the passed speech-caption export

const STEPS = [
  ['env', 'Check this phone', 2],
  ['engine', 'Load the video engine', 10],
  ['source', 'Open your video', 2],
  ['audio', 'Extract the audio', 6],
  ['loud', 'Measure loudness', 2],
  ['model', 'Load the speech model', 22],
  ['asr', 'Recognize your speech', 40],
  ['analyze', 'Find and rank highlights', 4],
  ['verify', 'Check the clips', 4]
];
const TOTAL_W = STEPS.reduce((a, s) => a + s[2], 0);

const $ = (s) => document.querySelector(s);
const msg = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };
const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

const st = { engine: null, rec: null, running: false, exporting: false, xEngine: null, urls: [], timer: null, videoDuration: null, videoUrl: null };
let run = null;

/* ---------------- UI ---------------- */
function buildSteps() {
  $('#steps').innerHTML = STEPS.map((s) => '<li id="s_' + s[0] + '"><span class="ic">○</span><span class="t">' + esc(s[1]) + '<div class="d"></div></span></li>').join('');
}
function setStep(id, status, note) {
  const li = $('#s_' + id); if (!li) return;
  li.className = status;
  li.querySelector('.ic').textContent = { run: '●', ok: '✓', warn: '!', fail: '✕' }[status] || '○';
  if (note !== undefined) li.querySelector('.d').textContent = note;
}
function paint() {
  if (!run) return;
  let done = 0;
  for (const s of STEPS) { if (run.steps[s[0]] === 'done') done += s[2]; else if (s[0] === run.current) done += s[2] * clamp(run.frac || 0, 0, 0.98); }
  $('#pfill').style.width = clamp((done / TOTAL_W) * 100, 0, 100).toFixed(1) + '%';
  $('#plabel').textContent = run.label || '';
  $('#pelapsed').textContent = run.t0 ? sec(performance.now() - run.t0) : '';
}
function addLog(line) {
  const el = $('#log'); if (!el) return;
  el.textContent += line + '\n';
  if (el.textContent.length > 60000) el.textContent = el.textContent.slice(-40000);
}
function banner(el, kind, title, body) {
  el.className = 'banner ' + kind;
  el.innerHTML = '<b>' + esc(title) + '</b>' + (body ? esc(body).replace(/\n/g, '<br>') : '');
}
/* Breadcrumbs for crash recovery. If Safari kills the tab no code runs, so everything the NEXT page load needs to explain what happened
   (which step, which speech part, whether the page was in the background) is written down as we go. */
let flag = {};
const writeFlag = () => { try { localStorage.setItem(FLAG_KEY, JSON.stringify(flag)); } catch (_) { /* private mode */ } };
const patchFlag = (o) => { flag = Object.assign({}, flag, o, { t: Date.now() }); writeFlag(); };
const setFlag = (step) => patchFlag({ step });
const clearFlag = () => { flag = {}; try { localStorage.removeItem(FLAG_KEY); } catch (_) { /* ignore */ } };
const readFlag = () => { try { const v = localStorage.getItem(FLAG_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; } };
/* finished speech parts survive a crash here, so a retry does not start from zero */
const ckptStore = {
  load: () => { try { const v = localStorage.getItem(CKPT_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; } },
  save: (o) => { localStorage.setItem(CKPT_KEY, JSON.stringify(o)); },
  clear: () => { try { localStorage.removeItem(CKPT_KEY); } catch (_) { /* ignore */ } }
};

/* ---------------- engine helpers ---------------- */
async function runExec(label, args) {
  const lines = [];
  run.collector = lines; run.label = label; run.frac = 0;
  addLog('$ ffmpeg ' + args.join(' '));
  const t0 = performance.now();
  let ret;
  try { ret = await st.engine.exec(args); } finally { run.collector = null; }
  if (run.cancelled) throw new Error('Cancelled');
  return { ret, ms: performance.now() - t0, lines };
}
class ExecError extends Error {
  constructor(label, ret, lines) {
    const tail = (lines || []).filter((l) => l && l.trim()).slice(-6).join('\n');
    super(label + ' — FFmpeg exited with code ' + ret + (tail ? '\n' + tail : ''));
  }
}
async function memSnap(tag) {
  const o = { tag };
  if (!st.engine) { o.note = 'video engine already released'; run.mem.push(o); return; }
  try { const b = await st.engine.memInfo(); if (typeof b === 'number') o.wasmMB = +(b / 1048576).toFixed(0); } catch (_) { /* n/a */ }
  run.mem.push(o);
}
async function doStep(id, fn) {
  if (run.cancelled) throw new Error('Cancelled');
  run.current = id; run.frac = 0; run.stepT0 = performance.now();
  setStep(id, 'run', '');
  setFlag(id);
  try {
    const r = (await fn()) || {};
    run.steps[id] = 'done';
    run.timing[id] = Math.round(performance.now() - run.stepT0);
    setStep(id, r.status === 'warn' ? 'warn' : 'ok', (r.note ? r.note + '\n' : '') + sec(performance.now() - run.stepT0));
    paint();
    return r;
  } catch (e) {
    run.timing[id] = Math.round(performance.now() - run.stepT0);
    setStep(id, 'fail', msg(e));
    const err = e instanceof Error ? e : new Error(msg(e));
    err.step = id;
    throw err;
  }
}

/* ---------------- pipeline steps ---------------- */
function collectEnv() {
  const ua = navigator.userAgent || '';
  const ios = /OS (\d+)[_.](\d+)/.exec(ua);
  return {
    userAgent: ua, iosVersion: ios ? ios[1] + '.' + ios[2] : null, cores: navigator.hardwareConcurrency || null,
    secureContext: !!window.isSecureContext, webassembly: typeof WebAssembly === 'object', worker: typeof Worker === 'function',
    crossOriginIsolated: !!window.crossOriginIsolated, webgpu: !!navigator.gpu, screen: screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'
  };
}
async function stepEnv() {
  const env = run.rec.env = collectEnv();
  const bad = [];
  if (!env.secureContext) bad.push('This page is not served over HTTPS.');
  if (!env.webassembly) bad.push('WebAssembly is not available.');
  if (!env.worker) bad.push('Web Workers are not available.');
  if (bad.length) throw new Error(bad.join('\n'));
  try { if ('wakeLock' in navigator) run.wake = await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ }
  return { note: (env.iosVersion ? 'iOS ' + env.iosVersion + ' · ' : '') + (env.cores || '?') + ' cores' };
}
async function stepEngine() {
  st.engine = await createEngine({
    onLog: (l) => { addLog(l); if (run && run.collector) run.collector.push(l); },
    onProgress: () => {},
    onStatus: (s) => { if (run) { run.label = s.text; if (typeof s.fraction === 'number') run.frac = s.fraction * 0.8; } }
  });
  await memSnap('after-engine');
  return { note: st.engine.name };
}
async function stepSource() {
  const file = run.opts.file, eng = st.engine;
  run.rec.source = { name: file.name, sizeMB: +(file.size / 1048576).toFixed(1), type: file.type || 'unknown', durationSec: st.videoDuration };
  let how = 'opened without copying';
  try {
    await eng.mkdir('/mnt');
    await eng.mount('/mnt', { blobs: [{ name: 'input_media', data: file }] });
    run.input = '/mnt/input_media';
  } catch (e) {
    addLog('[highlights] WORKERFS mount failed: ' + msg(e));
    if (file.size > 600 * 1048576) throw new Error('Could not open the file without copying it, and it is ' + mb(file.size) + ' — copying would likely crash Safari. Try a smaller clip.');
    await eng.writeFile('input_media', new Uint8Array(await file.arrayBuffer()));
    run.input = 'input_media'; how = 'copied into memory (mount failed: ' + msg(e) + ')';
  }
  run.rec.source.how = how;
  await memSnap('after-source');
  return { note: file.name + ' · ' + mb(file.size) + ' · ' + how };
}
async function stepAudio() {
  const { start, len } = run.opts;
  const r = await runExec('Extracting the audio …', ['-hide_banner', '-ss', String(start), '-i', run.input, '-t', String(len), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-y', 'speech.pcm']);
  if (r.ret !== 0) {
    const noAudio = r.lines.some((l) => /matches no streams|does not contain any stream|Stream map/i.test(l));
    throw new ExecError(noAudio ? 'This video has no audio track' : 'Audio extraction failed', r.ret, r.lines);
  }
  const bytes = await st.engine.readFile('speech.pcm');
  try { await st.engine.deleteFile('speech.pcm'); } catch (_) { /* ignore */ }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4));
  run.pcm = new Float32Array(buf);
  const seconds = run.pcm.length / RATE;
  if (seconds < 3) throw new Error('Only ' + seconds.toFixed(2) + ' s of audio was found at that start time. Is the video shorter than ' + (start + 3) + ' s?');
  run.dur = seconds;
  const level = rmsDb(run.pcm);
  run.rec.audio = { seconds: +seconds.toFixed(2), rmsDb: level, ms: Math.round(r.ms) };
  await memSnap('after-audio');
  const quiet = level < -55;
  return { status: quiet ? 'warn' : 'ok', note: seconds.toFixed(1) + ' s · level ' + level + ' dBFS' + (quiet ? '\n! almost silent — highlights will not mean much' : '') };
}
async function stepLoud() {
  run.loud = loudnessFromPcm(run.pcm, RATE, 0.25);
  const v = run.loud.rmsDb;
  run.rec.loudness = { windows: v.length, minDb: Math.min.apply(null, v), maxDb: Math.max.apply(null, v) };
  // The video engine is not needed again. Release it NOW so its memory is free before the speech model loads
  // (on a phone, both side by side is the most likely reason Safari closes the tab).
  try { if (st.engine) st.engine.terminate(); } catch (_) { /* ignore */ }
  st.engine = null; run.engineReleased = true; run.rec.engineReleasedBeforeSpeech = true;
  addLog('[highlights] video engine released before speech recognition');
  return { note: v.length + ' windows · ' + run.rec.loudness.minDb + ' to ' + run.rec.loudness.maxDb + ' dB\nvideo engine released to free memory' };
}
async function stepModel() {
  const spec = MODELS[run.opts.model];
  run.label = 'Loading the speech model …';
  run.makeRec = () => (st.rec = createRecognizer({
    model: run.opts.model, language: 'auto',
    onStatus: (t) => { if (run.current === 'model') run.label = t; addLog('[speech] ' + t); },
    onProgress: (p) => { if (run.current !== 'model') return; run.label = 'Downloading the speech model … ' + p.loadedMB.toFixed(0) + (p.totalMB ? ' / ' + p.totalMB.toFixed(0) : '') + ' MB'; if (p.totalMB) run.frac = clamp(p.loadedMB / p.totalMB, 0, 0.98); }
  }));
  run.makeRec();
  const r = await st.rec.init();
  run.rec.model = { id: spec.id, lib: r.lib };
  await memSnap('after-model');
  return { note: spec.id + ' · ' + r.lib };
}
async function stepAsr() {
  // Recognize in parts of ~20 s (cut at pauses), one after another. Each finished part is saved, the speech engine is rebuilt
  // every 4 parts to return its memory, and a retry after a crash continues from the saved parts.
  const o = run.opts;
  const plan = run.plan = planChunks(run.loud, run.dur);
  const key = checkpointKey(o.file, o.start, o.len, o.model, plan);
  patchFlag({ chunk: { k: 0, n: plan.length } });
  const first = st.rec; let firstUsed = false;
  const makeRecognizer = () => {
    if (!firstUsed) { firstUsed = true; return { init: async () => {}, recognize: (a) => first.recognize(a), dispose: () => first.dispose() }; }   // already loaded in the previous step
    return run.makeRec();
  };
  let r;
  try {
    r = await transcribeChunked({
      pcm: run.pcm, rate: RATE, plan, makeRecognizer, key, store: ckptStore, recycleEvery: 4, isCancelled: () => run.cancelled,
      onPart: (p) => {
        run.frac = p.k / p.n;
        run.label = 'Recognizing speech: part ' + (p.k + 1) + ' of ' + p.n + ' (' + Math.round(p.s) + '–' + Math.round(p.e) + ' s)' + (p.resumed ? ' — reusing saved result' : '');
        patchFlag({ chunk: { k: p.k, n: p.n } });
        addLog('[speech] ' + run.label);
      }
    });
  } catch (e) {
    if (run.cancelled) throw e;
    const done = e.partsDone || 0, total = e.partsTotal || plan.length;
    run.rec.asrFailure = { failedPart: e.failedPart, partsDone: done, partsTotal: total };
    const hint = done > 0
      ? '\nNothing is lost: ' + done + ' of ' + total + ' speech parts were saved. Choose the same video again, keep the same settings and tap Find highlights to continue from part ' + (done + 1) + '.'
      : '\nTap Find highlights to try again. If it keeps stopping, pick “English · fast” as the speech model, close other apps and tabs, and keep Safari open on this page.';
    const err = new Error(msg(e) + hint); err.step = 'asr'; throw err;
  }
  run.raw = r;
  run.words = normalizeWords(r.chunks, run.dur);
  run.rec.asr = { timing: r.timing || 'word', ms: Math.round(r.ms), lib: (st.rec && run.rec.model && run.rec.model.lib) || null, rawChunks: (r.chunks || []).length, words: run.words.length, parts: r.parts.length, resumedParts: r.resumed, recycles: r.recycles, plan: plan.map((p) => p.s + '-' + p.e), partMs: r.parts.map((p) => Math.round(p.ms)) };
  await memSnap('after-asr');
  const rtf = r.ms ? (run.dur * 1000) / r.ms : 0;
  const partsNote = r.parts.length + ' part(s)' + (r.resumed ? ', ' + r.resumed + ' reused from the saved run' : '') + (r.recycles ? ', speech engine rebuilt ' + r.recycles + '×' : '');
  if (run.words.length < 5) {
    // not fatal: analyze.js falls back to audio-only scoring and the page says so
    return { status: 'warn', note: '! only ' + run.words.length + ' word(s) recognized — highlights will use loudness only (no transcript)\n' + partsNote };
  }
  const approx = r.timing === 'phrase';
  return { status: approx ? 'warn' : 'ok', note: (approx ? '! word times are estimated from phrase times\n' : '') + run.words.length + ' words · ' + partsNote + ' · ' + sec(r.ms) + ' of recognition' + (rtf ? ' (' + rtf.toFixed(2) + '× real-time)' : '') + '\n“' + run.words.slice(0, 18).map((x) => x.w).join(' ') + (run.words.length > 18 ? ' …' : '') + '”' };
}
async function stepAnalyze() {
  const o = run.opts;
  const settings = normalizeSettings({ numClips: o.numClips, minDuration: o.minLen, maxDuration: o.maxLen, intensity: o.intensity, platform: 'custom' }, run.dur);
  run.settings = settings;
  const input = { words: run.words, loudness: run.loud, scenes: [], duration: run.dur };
  // Attempt 1: exactly what the user asked for. If nothing qualifies, relax step by step and SAY so (never silently).
  const attempts = [{ settings, label: null }];
  if (settings.intensity !== 'aggressive') attempts.push({ settings: Object.assign({}, settings, { intensity: 'aggressive' }), label: 'more permissive score threshold' });
  const shorter = Math.max(3, Math.round(settings.minDuration / 3));
  if (shorter < settings.minDuration) attempts.push({ settings: Object.assign({}, settings, { intensity: 'aggressive', minDuration: shorter }), label: 'shorter minimum clip length (' + shorter + ' s) and a more permissive score threshold' });
  let res = null;
  run.lowConfidence = false; run.relaxed = null;
  for (const at of attempts) {
    res = analyzeVideo(Object.assign({ settings: at.settings }, input));
    if (res.clips.length) { if (at.label) { run.lowConfidence = true; run.relaxed = at.label; run.settings = at.settings; } break; }
  }
  // Fewer clips than requested? Say so, and offer the next-best moments from a more permissive pass, clearly labelled weaker.
  run.weak = [];
  const want = run.opts.numClips;
  if (res.clips.length && res.clips.length < want && run.settings.intensity !== 'aggressive') {
    const more = analyzeVideo(Object.assign({ settings: Object.assign({}, run.settings, { intensity: 'aggressive', numClips: want }) }, input));
    const picks = more.clips.filter((c) => res.clips.every((h) => c.end <= h.start - 1 || c.start >= h.end + 1)).slice(0, want - res.clips.length);
    run.weak = picks.map((c, k) => Object.assign({}, c, { weak: true, id: 'w' + (k + 1), rank: res.clips.length + k + 1 }));
  }
  run.shortfall = res.clips.length < want ? { found: res.clips.length, weak: run.weak.length, asked: want } : null;
  run.analysis = res;
  run.clips = res.clips;
  run.all = res.clips.concat(run.weak);
  run.rec.analysis = { weakClips: run.weak.length, asked: want, mode: res.mode, clips: res.clips.length, lowConfidence: run.lowConfidence, relaxed: run.relaxed, stats: res.stats, settings: run.settings };
  if (!res.clips.length) return { status: 'warn', note: '! no moment qualified as a highlight (' + (res.stats.note || 'scores were below the threshold even on “More clips”') + ')' };
  const notes = [res.clips.length + ' clip(s) · mode: ' + (res.mode === 'transcript' ? 'speech + loudness' : 'loudness only (no usable transcript)')];
  if (run.lowConfidence) notes.push('! nothing qualified with your settings, so I relaxed them: ' + run.relaxed);
  return { status: (run.lowConfidence || res.mode !== 'transcript') ? 'warn' : 'ok', note: notes.join('\n') };
}
async function stepVerify() {
  const chk = run.check = checkClips(run.all, run.words, run.dur);
  run.sync = syncCheck(run.pcm, RATE, run.words);
  run.rec.checks = { clipChecks: chk, sync: run.sync };
  const notes = [];
  notes.push(chk.ok ? '✓ all clips in range, no overlaps, cut between words, text matches' : '✕ ' + chk.problems.slice(0, 3).join('; '));
  if (run.sync.onSpeech !== null) notes.push(Math.round(run.sync.onSpeech * 100) + '% of recognized words sit on audible sound');
  return { status: chk.ok ? 'ok' : 'warn', note: notes.join('\n') };
}

/* ---------------- results ---------------- */
function drawWave() {
  const cv = $('#wave'); if (!cv || !run.loud) return;
  const ctx = cv.getContext('2d'), W = cv.width, H = cv.height, v = run.loud.rmsDb, n = v.length;
  ctx.clearRect(0, 0, W, H);
  const lo = -70, hi = Math.max(-10, Math.max.apply(null, v));
  const cols = ['#8b7bff', '#2fd4f0', '#38d39f', '#ffc857', '#ff8fb1', '#9ad0ff'];
  run.all.forEach((c, k) => { ctx.fillStyle = cols[k % cols.length] + '44'; ctx.fillRect((c.start / run.dur) * W, 0, ((c.end - c.start) / run.dur) * W, H); });
  ctx.fillStyle = '#c9cfe6';
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * n), b = Math.max(a + 1, Math.floor(((x + 1) / W) * n));
    let m = -120; for (let i = a; i < b && i < n; i++) if (v[i] > m) m = v[i];
    const h = clamp((m - lo) / (hi - lo), 0, 1) * (H - 4);
    ctx.fillRect(x, H - h, 1, h);
  }
}
function renderClips() {
  const cols = ['#8b7bff', '#2fd4f0', '#38d39f', '#ffc857', '#ff8fb1', '#9ad0ff'];
  const head = (run.shortfall ? '<p class="note"><b>' + run.shortfall.found + ' of ' + run.shortfall.asked + ' requested clips</b> scored above the cutoff for a real highlight in this part of the video' + (run.weak.length ? '. ' + run.weak.length + ' weaker moment(s) from a more permissive pass are listed after them, labelled “weaker”.' : ', and no other non-overlapping moment of the requested length was available. Try “More clips”, a longer part of the video, or a shorter minimum clip length.') + '</p>' : '');
  $('#clips').innerHTML = head + run.all.map((c, k) =>
    '<div class="clip" style="border-left:4px solid ' + cols[k % cols.length] + '">' +
      '<label class="pick"><input type="checkbox" id="pick_' + k + '" data-pick="' + k + '"' + (c.weak ? '' : ' checked') + '> Export this clip</label>' +
      '<div class="top"><span class="ti">#' + c.rank + (c.weak ? ' (weaker) ' : '') + ' · ' + esc(c.title) + '</span><span class="sc">' + Math.round(c.score) + '</span></div>' +
      '<div class="note" style="margin:0">' + clock(c.start + run.opts.start) + ' – ' + clock(c.end + run.opts.start) + ' in your video (' + (c.start + run.opts.start).toFixed(1) + '–' + (c.end + run.opts.start).toFixed(1) + ' s) · ' + c.duration.toFixed(1) + ' s · highlight score (heuristic)</div>' +
      '<div>' + c.categories.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
      '<ul>' + c.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
      (c.caveats && c.caveats.length ? '<ul class="warnl">' + c.caveats.map((r) => '<li>⚠ ' + esc(r) + '</li>').join('') + '</ul>' : '') +
      (c.transcript ? '<div class="tx">“' + esc(c.transcript) + '”</div>' : '<div class="note">No transcript for this clip (loudness only).</div>') +
      '<button class="btn small" data-play="' + k + '">▶ Preview</button>' +
      '<div class="xstat" id="x_' + k + '"></div>' +
    '</div>').join('');
  document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => playClip(Number(b.dataset.play))));
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('change', syncExportUi));
  initExport();
}
let stopAt = null;
function playClip(k) {
  const c = run.all[k]; if (!c) return;
  const vid = $('#vid');
  if (!st.videoUrl) { st.videoUrl = URL.createObjectURL(run.opts.file); st.urls.push(st.videoUrl); }
  const t0 = run.opts.start + c.start; stopAt = run.opts.start + c.end;
  const go = () => { try { vid.currentTime = t0; } catch (_) { /* ignore */ } vid.play().catch(() => {}); };
  vid.classList.remove('hidden');
  if (vid.getAttribute('src') !== st.videoUrl) { vid.src = st.videoUrl; vid.addEventListener('loadedmetadata', go, { once: true }); vid.load(); } else go();
  vid.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
function verdictFor(ok, err) {
  if (!ok) return { kind: 'bad', title: 'NOT FINISHED', body: err || 'The run did not finish.' };
  if (!run.clips.length) return { kind: 'bad', title: 'No highlights found', body: 'Nothing in this part of the video scored as a highlight, even on “More clips”. Try a longer part, a video with more speech, or “More clips”.' };
  const issues = [];
  if (!run.check.ok) issues.push('Some automatic checks failed: ' + run.check.problems.slice(0, 3).join('; '));
  if (run.analysis.mode !== 'transcript') issues.push('No usable transcript, so these picks use loudness only.');
  if (run.lowConfidence) issues.push('Nothing qualified with your settings, so they were relaxed (' + run.relaxed + '). Treat these as weak candidates.');
  const warned = run.clips.filter((c) => c.caveats && c.caveats.length).length;
  if (warned) issues.push(warned + ' of the clips carry a ⚠ warning (possible mid-sentence cut or unreliable transcript) — see the cards.');
  if (run.sync && run.sync.onSpeech !== null && run.sync.onSpeech < 0.6) issues.push('Only ' + Math.round(run.sync.onSpeech * 100) + '% of word times line up with audible sound.');
  if (issues.length) return { kind: 'warn', title: run.clips.length + (run.shortfall ? ' of ' + run.shortfall.asked : '') + ' highlight(s) found, with caveats', body: issues.join('\n') + '\nScores are heuristics — preview each clip and judge it yourself.' };
  return { kind: 'ok', title: run.clips.length + (run.shortfall ? ' of ' + run.shortfall.asked : '') + ' highlight(s) found' + (run.weak.length ? ' (+' + run.weak.length + ' weaker)' : ''), body: 'Automatic checks passed (clips are well-formed and cut between words). Whether they are GOOD highlights is your call — preview them and answer the box below.' };
}
function showResult(ok, errMsg) {
  $('#resultCard').classList.remove('hidden');
  const v = verdictFor(ok, errMsg);
  banner($('#verdict'), v.kind, v.title, v.body);
  $('#vid').classList.add('hidden');
  if (ok && run.clips.length) { drawWave(); renderClips(); $('#wave').classList.remove('hidden'); }
  else { $('#clips').innerHTML = ''; $('#wave').classList.add('hidden'); $('#exportBar').classList.add('hidden'); $('#exportCheck').classList.add('hidden'); }
  const m = [];
  const row = (k, val) => m.push('<tr><td>' + esc(k) + '</td><td>' + esc(val) + '</td></tr>');
  if (run.rec.model) row('Speech model', run.rec.model.id + ' · ' + run.rec.model.lib);
  if (run.rec.asr) row('Recognition', run.rec.asr.words + ' words · ' + sec(run.rec.asr.ms) + ' · ' + ((run.dur * 1000) / run.rec.asr.ms).toFixed(2) + '× real-time');
  row('Scene detection', 'not run in this version — no scene-cut claims are made');
  if (run.rec.analysis) row('Analysis mode', run.rec.analysis.mode + ' · ' + run.rec.analysis.stats.candidates + ' candidates');
  if (run.sync && run.sync.onSpeech !== null) row('Words on audible sound', Math.round(run.sync.onSpeech * 100) + '%');
  const last = run.mem[run.mem.length - 1];
  row('Video-engine memory', last && last.wasmMB ? last.wasmMB + ' MB' : 'not measurable');
  row('Total time', sec(performance.now() - run.t0));
  $('#metrics').innerHTML = m.join('');
  buildReport(ok, errMsg);
}
function buildReport(ok, errMsg) {
  const r = run.rec, L = [];
  L.push('ClipGen AI highlights report · ' + VERSION);
  L.push('When: ' + new Date().toISOString() + ' · model: ' + run.opts.model + ' · start ' + run.opts.start + ' s · analysed ' + run.opts.len + ' s · clips ' + run.opts.numClips + ' · length ' + run.opts.minLen + '–' + run.opts.maxLen + ' s · ' + run.opts.intensity);
  L.push('VERDICT: ' + (ok ? verdictFor(true).title : 'NOT FINISHED — ' + (errMsg || '').split('\n')[0]));
  if (r.env) L.push('DEVICE: ' + (r.env.iosVersion ? 'iOS ' + r.env.iosVersion : 'non-iOS') + ' · cores ' + r.env.cores + ' · screen ' + r.env.screen);
  if (r.source) L.push('SOURCE: ' + r.source.name + ' · ' + r.source.sizeMB + ' MB · duration ' + r.source.durationSec + ' s · ' + r.source.how);
  if (r.audio) L.push('AUDIO: ' + r.audio.seconds + ' s · level ' + r.audio.rmsDb + ' dBFS · extracted in ' + sec(r.audio.ms));
  if (r.loudness) L.push('LOUDNESS: ' + JSON.stringify(r.loudness));
  if (r.asr) L.push('ASR: timing=' + r.asr.timing + ' · ' + r.asr.words + ' words in ' + sec(r.asr.ms) + ' · ' + r.model.id + ' · ' + r.asr.lib);
  if (r.asr) L.push('ASR PARTS: ' + r.asr.parts + ' (reused ' + r.asr.resumedParts + ', engine rebuilt ' + r.asr.recycles + '×) · plan ' + r.asr.plan.join(' ') + ' · ms per part ' + r.asr.partMs.join(','));
  if (r.asrFailure) L.push('ASR FAILURE: stopped in part ' + (r.asrFailure.failedPart + 1) + ' of ' + r.asrFailure.partsTotal + ' · parts saved ' + r.asrFailure.partsDone);
  L.push('VIDEO ENGINE RELEASED BEFORE SPEECH: ' + (r.engineReleasedBeforeSpeech ? 'yes' : 'no') + ' · page in background during run: ' + (flag.hiddenCount || 0) + '× / ' + Math.round((flag.hiddenMs || 0) / 1000) + ' s');
  if (run.words && run.words.length) L.push('TRANSCRIPT: ' + run.words.map((x) => x.w).join(' ').slice(0, 1200));
  if (r.analysis) L.push('ANALYSIS: mode=' + r.analysis.mode + ' lowConfidence=' + r.analysis.lowConfidence + ' stats=' + JSON.stringify(r.analysis.stats));
  L.push('SCENE DETECTION: not run (analysis stats scenes=' + (run.rec.analysis ? run.rec.analysis.stats.scenes : 'n/a') + '); per-word recognizer confidence: not provided by this recognizer');
  if (run.shortfall) L.push('SHORTFALL: asked ' + run.shortfall.asked + ', ' + run.shortfall.found + ' above the cutoff, ' + run.shortfall.weak + ' weaker shown');
  if (run.all) for (const c of run.all) L.push((c.weak ? 'WEAKER CLIP #' : 'CLIP #') + c.rank + ' ' + c.start.toFixed(1) + '–' + c.end.toFixed(1) + ' s (video ' + clock(c.start + run.opts.start) + '–' + clock(c.end + run.opts.start) + ') score ' + c.score + ' [' + c.categories.join(', ') + '] FULL TEXT: “' + (c.transcript || '') + '” reasons: ' + c.reasons.join(' | ') + (c.caveats && c.caveats.length ? ' CAVEATS: ' + c.caveats.join(' | ') : '') + ' reliability=' + (c.signals.reliability !== undefined ? c.signals.reliability : 'n/a'));
  if (run.exp) {
    const rows = run.all.map((c) => [c, run.exp.items[c.id]]).filter(([, it]) => it.state !== 'idle');
    if (rows.length) {
      const f = run.exp.finished;
      L.push('EXPORT: ' + rows.length + ' clip(s) tried' + (f ? ' · done ' + f.done + ' · failed ' + f.failed + ' · cancelled ' + f.cancelled + ' · not tried ' + f.skipped + ' · ' + sec(f.ms) : ' · still running') + ' · one clip at a time, a fresh video engine per clip, source mounted not copied');
      for (const [c, it] of rows) {
        let t = 'EXPORT CLIP #' + c.rank + ' ' + it.state.toUpperCase();
        if (it.state === 'done') t += ' · source ' + it.win.absStart + '–' + it.win.absEnd + ' s (' + clock(it.win.absStart) + '–' + clock(it.win.absEnd) + ') · ' + it.info.width + '×' + it.info.height + ' ' + it.info.vcodec + '/' + it.info.acodec + ' · ' + it.info.duration.toFixed(2) + ' s · ' + mb(it.size) + ' · encode ' + sec(it.encMs) + ' · captions ' + it.caps.lines + ' lines/' + it.caps.words + ' words' + (it.burn ? ' · burn check ' + it.burn.wordPixels + ' px at word vs ' + (it.burn.gapPixels === null ? 'n/a' : it.burn.gapPixels) + ' px at gap → ' + (it.burn.result === 'yes' ? 'visible' : it.burn.result === 'no' ? 'NOT visible' : 'inconclusive (moving picture)') : '') + ' · engine memory ' + (it.wasmMB ? it.wasmMB + ' MB' : 'n/a') + ' · file ' + it.name + (it.warn.length ? ' · WARNINGS: ' + it.warn.join(' | ') : '') + (it.shareNote ? ' · share: ' + it.shareNote : '');
        else if (it.state === 'failed') t += ' · ' + String(it.error || '').split('\n').slice(0, 3).join(' | ');
        else if (it.note) t += ' · ' + it.note;
        L.push(t);
      }
      const xv = (n) => { const e = document.querySelector('input[name=' + n + ']:checked'); return e ? e.value : 'not answered'; };
      L.push('MY EXPORT CHECK: plays=' + xv('xplay') + ' · captions in sync=' + xv('xsync') + ' · saved=' + xv('xsave'));
    }
  }
  if (r.checks) L.push('CHECKS: ' + JSON.stringify({ ok: r.checks.clipChecks.ok, problems: r.checks.clipChecks.problems, sync: r.checks.sync }));
  L.push('MEMORY: ' + (run.mem.length ? run.mem.map((m) => m.tag + ' wasm=' + (m.wasmMB || 'n/a')).join(' | ') : 'n/a'));
  L.push('STEP TIMES (ms): ' + JSON.stringify(run.timing));
  const mine = document.querySelector('input[name=mine]:checked');
  L.push('MY CHECK (top picks look like real highlights): ' + (mine ? mine.value : 'not answered'));
  if (run.errors.length) { L.push('ERRORS:'); for (const e of run.errors) L.push('  [' + e.step + '] ' + e.message.split('\n').slice(0, 4).join(' | ')); }
  $('#report').value = L.join('\n');
  $('#reportCard').classList.remove('hidden');
}

/* ---------------- export of the chosen clips ---------------- */
/* One clip at a time. For each clip a FRESH video engine is started and thrown away afterwards, so the WebAssembly memory
   (which only ever grows) is handed back before the next clip. The source video is mounted, never copied. The words come from
   the recognition that already ran; Whisper is not loaded again. */
function initExport() {
  run.exp = { items: {}, cancelled: false, font: null, urls: [] };
  run.all.forEach((c, k) => { run.exp.items[c.id] = { k, state: 'idle', note: '', frac: 0 }; });
  $('#exportBar').classList.remove('hidden');
  $('#exportCheck').classList.add('hidden');
  $('#exportNote').textContent = '';
  syncExportUi();
}
function pickedIndexes() {
  return run && run.all ? run.all.map((c, k) => k).filter((k) => { const b = $('#pick_' + k); return b && b.checked; }) : [];
}
function syncExportUi() {
  if (!run || !run.exp) return;
  const todo = pickedIndexes().filter((k) => run.exp.items[run.all[k].id].state !== 'done');
  const b = $('#btnExport');
  b.textContent = '⬇ Export selected clips' + (todo.length ? ' (' + todo.length + ')' : '');
  b.disabled = st.exporting || st.running || !todo.length;
  b.classList.toggle('hidden', st.exporting);
  $('#btnExportCancel').classList.toggle('hidden', !st.exporting);
  document.querySelectorAll('[data-pick]').forEach((x) => { x.disabled = st.exporting; });
  $('#btnSelAll').disabled = $('#btnSelNone').disabled = st.exporting;
  const anyDone = run.all.some((c) => run.exp.items[c.id].state === 'done');
  $('#exportCheck').classList.toggle('hidden', !anyDone);
}
function paintItem(c) {
  const it = run.exp.items[c.id], el = $('#x_' + it.k); if (!el) return;
  let h = '';
  if (it.state === 'queued' || it.state === 'working') {
    h = '<div class="xl">' + esc(it.label || 'Waiting …') + '</div><div class="bar sm"><i style="width:' + Math.round(clamp(it.frac || 0, 0, 1) * 100) + '%"></i></div>';
  } else if (it.state === 'done') {
    const capNote = it.caps.lines ? it.caps.lines + ' caption line(s) from ' + it.caps.words + ' recognized word(s)' : 'no captions — no recognized words in this clip';
    h = '<div class="xdone">✓ Exported · ' + it.info.width + '×' + it.info.height + ' ' + esc(it.info.vcodec) + '/' + esc(it.info.acodec) + ' · ' + it.info.duration.toFixed(1) + ' s · ' + mb(it.size) + ' · ' + esc(capNote) + '</div>' +
      (it.warn.length ? '<ul class="warnl">' + it.warn.map((w) => '<li>⚠ ' + esc(w) + '</li>').join('') + '</ul>' : '') +
      '<video class="xvid" controls playsinline preload="metadata" src="' + it.url + '"></video>' +
      '<a class="btn small" data-dl="' + it.k + '" href="' + it.url + '" download="' + esc(it.name) + '">⬇ Download MP4</a>' +
      (canShareFiles(it) ? '<button class="btn small" data-share="' + it.k + '">Share / Save …</button>' : '') +
      '<div class="note" data-shareNote="' + it.k + '">' + esc(it.shareNote || '') + '</div>';
  } else if (it.state === 'failed') {
    h = '<div class="xerr">✕ Not exported: ' + esc(it.error || 'unknown error').replace(/\n/g, '<br>') + '</div><div class="note">Nothing was kept for this clip. Tick it and tap Export again to retry.</div>';
  } else if (it.state === 'cancelled' || it.state === 'skipped') {
    h = '<div class="note">' + esc(it.note || 'Not exported.') + ' Tick it and tap Export to try again.</div>';
  }
  el.innerHTML = h;
  el.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => shareClip(Number(b.dataset.share))));
}
function canShareFiles(it) {
  try { return !!(navigator.share && navigator.canShare && navigator.canShare({ files: [new File([it.blob], it.name, { type: 'video/mp4' })] })); } catch (_) { return false; }
}
async function shareClip(k) {
  const c = run.all[k], it = run.exp.items[c.id], note = document.querySelector('[data-shareNote="' + k + '"]');
  try {
    await navigator.share({ files: [new File([it.blob], it.name, { type: 'video/mp4' })], title: 'ClipGen clip ' + c.rank });
    it.shareNote = 'The share sheet was opened. Choose “Save Video” or “Save to Files” in it.';
  } catch (e) {
    if (e && e.name === 'AbortError') it.shareNote = 'Share sheet closed without saving.';
    else it.shareNote = 'The share sheet could not open (' + msg(e) + '). Use “Download MP4” instead.';
  }
  if (note) note.textContent = it.shareNote;
}

async function xExec(eng, ctx, args) {
  const lines = []; ctx.lines = lines;
  addLog('$ ffmpeg ' + args.join(' '));
  const t0 = performance.now();
  let ret;
  try { ret = await eng.exec(args); } finally { ctx.lines = null; }
  if (run.exp.cancelled) throw new Error('Cancelled');
  return { ret, ms: performance.now() - t0, lines };
}
function decodePng(u8) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([u8], { type: 'image/png' })); const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, cv.width, cv.height); URL.revokeObjectURL(url); res({ w: cv.width, h: cv.height, data: d.data });
      } catch (e) { URL.revokeObjectURL(url); rej(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not decode a preview frame')); };
    img.src = url;
  });
}
function diffImages(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('preview frames differ in size (' + a.w + 'x' + a.h + ' vs ' + b.w + 'x' + b.h + ')');
  const A = a.data, B = b.data, y0 = Math.round(a.h * BAND.from), y1 = Math.round(a.h * BAND.to);
  const r = { band: 0, outside: 0, bandPixels: (y1 - y0) * a.w, outsidePixels: (a.h - (y1 - y0)) * a.w };
  for (let i = 0; i < A.length; i += 4) {
    if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 40) { const y = Math.floor(i / 4 / a.w); if (y >= y0 && y < y1) r.band++; else r.outside++; }
  }
  return r;
}
async function grabFrame(eng, ctx, args, outName) {
  const r = await xExec(eng, ctx, args.concat(['-frames:v', '1', '-y', outName]));
  if (r.ret !== 0) throw new ExecError('Could not read a frame back from the exported file', r.ret, r.lines);
  const png = await eng.readFile(outName);
  try { await eng.deleteFile(outName); } catch (_) { /* ignore */ }
  return png;
}

async function exportOne(c, pos) {
  const exp = run.exp, it = exp.items[c.id];
  const win = clipWindow(c, run.opts.start, run.dur);
  if (!win.ok) throw new Error('This clip is too short to export (' + win.len + ' s).');
  const cap = buildClipCaptions(run.words, win);
  const ctx = { lines: null, encoding: false };
  const prefix = 'Clip ' + (pos.index + 1) + ' of ' + pos.total + ': ';
  const say = (t, frac) => { it.label = prefix + t; if (typeof frac === 'number') it.frac = Math.max(it.frac || 0, frac); paintItem(c); };
  const out = 'clip_out.mp4', input = '/mnt/input_media';
  let eng = null;
  try {
    say('starting a fresh video engine …', 0.02);
    try {
      eng = await createEngine({
        onLog: (l) => { addLog(l); if (ctx.lines) ctx.lines.push(l); if (ctx.encoding) { const f = progressFromLog(l, win.len); if (f !== null) say('encoding 9:16 with captions … ' + Math.round(f * 100) + '%', 0.1 + f * 0.75); } },
        onProgress: (d) => { if (ctx.encoding && d && typeof d.progress === 'number' && d.progress >= 0 && d.progress <= 1) say('encoding 9:16 with captions … ' + Math.round(d.progress * 100) + '%', 0.1 + d.progress * 0.75); },
        onStatus: (s) => { say(s.text); }
      });
    } catch (e) { const er = new Error(msg(e)); er.fatal = true; throw er; }
    st.xEngine = eng;
    if (exp.cancelled) throw new Error('Cancelled');
    try {
      await eng.mkdir('/mnt');
      await eng.mount('/mnt', { blobs: [{ name: 'input_media', data: run.opts.file }] });          // opened in place, never copied
    } catch (e) { const er = new Error('Could not open the video without copying it (' + msg(e) + '). Copying a big video into memory could crash Safari, so no export was attempted.'); er.fatal = true; throw er; }
    say('preparing captions …', 0.06);
    if (cap.ass) {
      if (!exp.font) {
        const r = await fetch(FONT_URL);
        if (!r.ok) throw new Error('The caption font could not be loaded (HTTP ' + r.status + ').');
        exp.font = new Uint8Array(await r.arrayBuffer());
      }
      try { await eng.mkdir('/fonts'); } catch (_) { /* exists */ }
      await eng.writeFile('/fonts/font.ttf', exp.font.slice());
      await eng.writeFile('/sub.ass', new TextEncoder().encode(cap.ass));
    }
    ctx.encoding = true; say('encoding 9:16 with captions … 0%', 0.1);
    const t0 = performance.now();
    const r = await xExec(eng, ctx, exportArgs({ absStart: win.absStart, len: win.len, input, captions: !!cap.ass, out }));
    ctx.encoding = false;
    if (r.ret !== 0) throw new ExecError('FFmpeg could not make this clip', r.ret, r.lines);
    const encMs = performance.now() - t0;

    say('checking the exported file …', 0.88);
    const bytes = await eng.readFile(out);
    const size = bytes ? bytes.length : 0;
    const blob = new Blob([bytes || new Uint8Array(0)], { type: 'video/mp4' });
    const info = parseProbe((await xExec(eng, ctx, ['-hide_banner', '-i', out])).lines);        // (FFmpeg prints the file's streams and exits non-zero: expected)
    const verdict = judgeOutput(info, win.len, size);
    if (!verdict.ok) throw new Error('The exported file failed its check: ' + verdict.problems.join('; ') + '.');
    const warn = [];
    let burn = null;
    if (cap.ass) {
      const px = async (t, tag) => diffImages(await decodePng(await grabFrame(eng, ctx, ['-hide_banner', '-ss', String(win.absStart + t), '-i', input, '-vf', VF_BASE], tag + '_p.png')), await decodePng(await grabFrame(eng, ctx, ['-hide_banner', '-ss', String(t), '-i', out], tag + '_o.png')));
      const word = await px(cap.probe.tWord, 'fw');
      const gap = cap.probe.tGap !== null ? await px(cap.probe.tGap, 'fg') : null;
      const result = captionVisibility(word, gap);
      burn = { tWord: cap.probe.tWord, wordPixels: word.band, wordOutside: +(word.outside / word.outsidePixels).toFixed(3), tGap: cap.probe.tGap, gapPixels: gap ? gap.band : null, result, visible: result === 'yes' };
      if (result === 'no') warn.push('The automatic check did not see the captions in a test frame. Play the clip before you use it.');
      else if (result === 'unclear') warn.push('The picture moves a lot between the two frames the automatic caption check compares, so it could not tell. Play the clip to confirm the captions.');
    } else {
      await decodePng(await grabFrame(eng, ctx, ['-hide_banner', '-ss', String(Math.min(win.len / 2, Math.max(0, (info.duration || win.len) - 0.2))), '-i', out], 'fm.png'));   // proves the picture can be decoded
      warn.push('No recognized words fall inside this clip, so it has no captions (nothing is invented).');
    }
    if (cap.unsupported.length) warn.push('These characters cannot be drawn by the caption font yet: ' + cap.unsupported.join(' '));
    if (cap.ass && run.rec.asr && run.rec.asr.timing === 'phrase') warn.push('Word times were estimated from phrase times, so caption timing is less exact.');
    let wasmMB = null;
    try { const b = await eng.memInfo(); if (typeof b === 'number' && b > 0) wasmMB = +(b / 1048576).toFixed(0); } catch (_) { /* n/a */ }
    try { await eng.deleteFile(out); } catch (_) { /* ignore */ }

    const url = URL.createObjectURL(blob);
    exp.urls.push(url);
    Object.assign(it, { state: 'done', blob, url, size, info, win, name: safeFileName(run.opts.file.name, c.rank, win), warn, burn, encMs: Math.round(encMs), wasmMB,
      caps: { lines: cap.lines.length, words: cap.words.length, first: cap.lines.length ? cap.lines[0].start : null, last: cap.lines.length ? cap.lines[cap.lines.length - 1].end : null }, frac: 1, error: '' });
    return it;
  } finally {
    ctx.encoding = false;
    try { if (eng) eng.terminate(); } catch (_) { /* ignore */ }
    if (st.xEngine === eng) st.xEngine = null;
  }
}

async function startExport() {
  if (st.exporting || st.running || !run || !run.exp) return;
  const exp = run.exp;
  const picks = pickedIndexes().map((k) => run.all[k]).filter((c) => exp.items[c.id].state !== 'done');
  if (!picks.length) { $('#exportNote').textContent = 'Tick at least one clip that is not exported yet.'; return; }
  exp.cancelled = false; exp.finished = null; st.exporting = true; exp.t0 = performance.now();
  for (const c of picks) Object.assign(exp.items[c.id], { state: 'queued', label: 'Waiting for its turn …', frac: 0, error: '', note: '' });
  picks.forEach(paintItem);
  patchFlag({ step: 'export', version: VERSION, model: run.opts.model, start: run.opts.start, len: run.opts.len, file: { name: run.opts.file.name, size: run.opts.file.size }, chunk: null, exp: { k: 0, n: picks.length }, hiddenCount: 0, hiddenMs: 0, hiddenNow: false, hiddenSince: null, unloaded: false });
  try { if ('wakeLock' in navigator) exp.wake = await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ }
  syncExportUi();
  $('#exportNote').textContent = 'Exporting ' + picks.length + ' clip(s), one at a time. Keep Safari open on this page with the screen on.';
  let res;
  try {
    res = await runExportQueue({
      items: picks, isCancelled: () => exp.cancelled,
      exportOne: (c, pos) => exportOne(c, pos),
      onState: (c, state, info) => {
        const it = exp.items[c.id];
        if (state === 'working') { it.state = 'working'; it.label = 'Clip ' + (info.index + 1) + ' of ' + info.total + ': starting …'; it.frac = 0; patchFlag({ exp: { k: info.index, n: info.total, id: c.id } }); }
        else if (state === 'failed') { it.state = 'failed'; it.error = info.error; }
        else if (state === 'cancelled' || state === 'skipped') { it.state = state; it.note = info.note; }
        paintItem(c); syncExportUi();
      }
    });
  } catch (e) {
    res = { done: [], failed: [], cancelled: [], skipped: [] };
    $('#exportNote').textContent = 'The export stopped unexpectedly: ' + msg(e);
  }
  exp.finished = { done: res.done.length, failed: res.failed.length, cancelled: res.cancelled.length, skipped: res.skipped.length, ms: Math.round(performance.now() - exp.t0) };
  clearFlag();
  try { if (exp.wake) exp.wake.release(); } catch (_) { /* ignore */ }
  try { if (run.wake) run.wake.release(); } catch (_) { /* ignore */ }
  st.exporting = false; st.xEngine = null;
  const f = exp.finished;
  $('#exportNote').textContent = f.done + ' of ' + picks.length + ' clip(s) exported' + (f.failed ? ', ' + f.failed + ' failed (see the card)' : '') + (f.cancelled ? ', ' + f.cancelled + ' cancelled' : '') + (f.skipped ? ', ' + f.skipped + ' not tried' : '') + '.' + (f.done ? ' Use “Download MP4” on each clip.' : '');
  syncExportUi();
  buildReport(run.ok, run.err);
}
function cancelExport() {
  if (!st.exporting || !run || !run.exp) return;
  run.exp.cancelled = true;
  $('#exportNote').textContent = 'Cancelling … clips already finished are kept.';
  try { if (st.xEngine) st.xEngine.terminate(); } catch (_) { /* ignore */ }
}
function revokeExportUrls() {
  if (run && run.exp) { for (const u of run.exp.urls) { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } } run.exp.urls = []; }
}

/* ---------------- run control ---------------- */
function cleanup() {
  clearInterval(st.timer); st.timer = null;
  try { if (run && run.wake) run.wake.release(); } catch (_) { /* ignore */ }
  try { if (st.rec) st.rec.dispose(); } catch (_) { /* ignore */ }
  st.rec = null;
}
async function start() {
  if (st.running || st.exporting) return;
  const file = $('#file').files[0];
  if (!file) return;
  const num = (id, d, a, b) => { const v = Number($('#' + id).value); return Number.isFinite(v) ? clamp(v, a, b) : d; };
  const opts = {
    file, model: $('#model').value, start: num('startSec', 0, 0, 100000), len: num('lenSec', 60, 5, MAX_WINDOW),
    numClips: Math.round(num('numClips', 3, 1, 10)), minLen: num('minLen', 10, 5, 120), maxLen: num('maxLen', 30, 8, 180), intensity: $('#intensity').value
  };
  revokeExportUrls();                       // clips exported from an earlier analysis are released
  if (st.videoUrl) { try { URL.revokeObjectURL(st.videoUrl); } catch (_) { /* ignore */ } st.videoUrl = null; $('#vid').removeAttribute('src'); }
  run = { opts, rec: { version: VERSION }, steps: {}, timing: {}, errors: [], mem: [], t0: performance.now(), cancelled: false, current: null, frac: 0, label: 'Starting …', clips: [] };
  st.running = true;
  $('#crashBanner').classList.add('hidden');
  patchFlag({ step: 'env', version: VERSION, model: opts.model, start: opts.start, len: opts.len, file: { name: file.name, size: file.size }, chunk: null, hiddenCount: 0, hiddenMs: 0, hiddenNow: false, hiddenSince: null, unloaded: false });
  buildSteps();
  $('#log').textContent = '';
  $('#resultCard').classList.add('hidden'); $('#reportCard').classList.add('hidden');
  $('#btnRun').classList.add('hidden'); $('#btnCancel').classList.remove('hidden');
  st.timer = setInterval(paint, 400);
  let ok = false, errMsg = '';
  try {
    await doStep('env', stepEnv);
    await doStep('engine', stepEngine);
    await doStep('source', stepSource);
    await doStep('audio', stepAudio);
    await doStep('loud', stepLoud);
    await doStep('model', stepModel);
    await doStep('asr', stepAsr);
    await doStep('analyze', stepAnalyze);
    await doStep('verify', stepVerify);
    ok = true;
  } catch (e) {
    errMsg = msg(e);
    run.errors.push({ step: e.step || run.current || '?', message: errMsg });
  }
  clearFlag();
  run.ok = ok; run.err = errMsg;
  run.label = ok ? 'Done.' : (run.cancelled ? 'Cancelled.' : 'Stopped.');
  if (ok) $('#pfill').style.width = '100%';
  cleanup();
  run.pcm = null;                           // the audio is only needed during analysis; free it before any export
  st.running = false;
  $('#btnRun').classList.remove('hidden'); $('#btnCancel').classList.add('hidden');
  paint();
  showResult(ok, errMsg);
  try { $('#resultCard').scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (_) { /* ignore */ }
  try { if (st.engine) st.engine.terminate(); } catch (_) { /* ignore */ }
  st.engine = null;
}
function cancel() {
  if (!run || !st.running) return;
  run.cancelled = true;
  try { if (st.engine) st.engine.terminate(); } catch (_) { /* ignore */ }
  try { if (st.rec) st.rec.dispose(); } catch (_) { /* ignore */ }
}

/* ---------------- boot ---------------- */
function readDuration(file) {
  const v = document.createElement('video'); v.preload = 'metadata'; v.muted = true;
  const u = URL.createObjectURL(file);
  const done = () => { URL.revokeObjectURL(u); };
  v.onloadedmetadata = () => {
    st.videoDuration = Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null;
    if (st.videoDuration) {
      $('#fileInfo').textContent = file.name + ' · ' + mb(file.size) + ' · ' + clock(st.videoDuration) + ' long';
      if (!st.lenTouched) $('#lenSec').value = String(Math.min(Math.floor(st.videoDuration), 60));      // never overwrite a length you typed or that a recovery restored (resume needs identical settings)
    }
    done();
  };
  v.onerror = () => { st.videoDuration = null; $('#fileInfo').textContent = file.name + ' · ' + mb(file.size) + ' · (this browser could not read the length — set “Analyse how many seconds” yourself)'; done(); };
  v.src = u;
}
/* the phone locking or Safari going to the background can suspend or kill the run: record it, and get the screen-lock back */
function onVisibility() {
  if (!st.running && !st.exporting) return;
  if (document.visibilityState === 'hidden' && flag.unloaded) return;     // browsers fire pagehide, THEN hidden, when a page is closed or reloaded
  if (document.visibilityState === 'hidden') patchFlag({ hiddenNow: true, hiddenSince: Date.now(), hiddenCount: (flag.hiddenCount || 0) + 1 });
  else {
    patchFlag({ hiddenNow: false, hiddenMs: (flag.hiddenMs || 0) + (flag.hiddenSince ? Date.now() - flag.hiddenSince : 0), hiddenSince: null });
    try { if ('wakeLock' in navigator) navigator.wakeLock.request('screen').then((w) => { run.wake = w; }).catch(() => {}); } catch (_) { /* optional */ }
  }
}
/* explain a run that never reported back (tab killed or reloaded) and say exactly what to do */
function showRecovery() {
  const f = readFlag();
  if (!f || !f.step) { clearFlag(); return; }
  clearFlag();
  const stepName = f.step === 'export' ? 'Export clips' : (STEPS.find((s) => s[0] === f.step) || [])[1] || f.step;
  const lines = [];
  lines.push('It stopped during “' + stepName + '”' + (f.chunk && f.chunk.n && (f.step === 'asr') ? ', speech part ' + (f.chunk.k + 1) + ' of ' + f.chunk.n : '') + (f.step === 'export' && f.exp ? ', clip ' + (f.exp.k + 1) + ' of ' + f.exp.n : '') + (f.file ? ' (' + f.file.name + ', ' + f.model + ')' : '') + '.');
  if (f.hiddenNow) lines.push('Safari was in the background or the phone was locked at that moment — iPhone can stop a page there. Keep Safari open on this page with the screen on until it finishes.');
  else if (f.unloaded) lines.push('The page was closed or reloaded' + (f.hiddenCount ? ' (it had also been in the background ' + f.hiddenCount + '× during the run)' : '') + ' — by you, or by Safari. If you did not do it, Safari probably ran out of memory.');
  else if (f.hiddenCount) lines.push('The page had been in the background ' + f.hiddenCount + '× during the run, and then stopped without warning (Safari most likely ran out of memory).');
  else lines.push('The page was in front and stopped without warning, so Safari most likely ran out of memory. Close other apps and tabs and try again.');
  const ck = ckptStore.load(); const saved = ck && ck.results ? Object.keys(ck.results).length : 0;
  if (f.step === 'export') lines.push('Clips you had already downloaded are safe in Files. To export again: choose the same video, tap Find highlights (speech is recognized again, about a minute), then export ONE clip at a time and close other apps and tabs first.');
  else if (saved) lines.push(saved + ' speech part(s) were saved. Choose the same video again with the same settings and tap Find highlights — those parts are reused, so it continues instead of starting over.');
  else lines.push('Nothing was saved yet. Choose your video again and tap Find highlights.');
  if (f.start !== undefined && !$('#startSec').value) { /* defaults stay */ }
  const b = $('#crashBanner'); b.classList.remove('hidden');
  banner(b, 'bad', 'The previous run did not finish', lines.join('\n'));
  const smaller = f.model && /base/.test(f.model) ? f.model.replace('base', 'tiny') : null;
  b.insertAdjacentHTML('beforeend', '<div>' + (smaller && MODELS[smaller] ? '<button class="btn small" id="btnSmaller">Use the smaller model (starts over)</button>' : '') + '<button class="btn small" id="btnDismiss">Dismiss</button></div>');
  const bs = $('#btnSmaller'); if (bs) bs.addEventListener('click', () => { $('#model').value = smaller; bs.remove(); });
  $('#btnDismiss').addEventListener('click', () => { b.classList.add('hidden'); ckptStore.clear(); });
  if (f.start !== undefined) { $('#startSec').value = String(f.start); }
  if (f.len !== undefined) { $('#lenSec').value = String(f.len); st.lenTouched = true; }
  if (f.model && MODELS[f.model]) $('#model').value = f.model;
}
function boot() {
  buildSteps();
  $('#model').innerHTML = Object.entries(MODELS).map(([k, v]) => '<option value="' + k + '"' + (k === 'base.en' ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('');
  $('#file').addEventListener('change', () => { const f = $('#file').files[0]; $('#btnRun').disabled = !f; if (f) readDuration(f); });
  $('#lenSec').addEventListener('input', () => { st.lenTouched = true; });
  $('#btnRun').addEventListener('click', start);
  $('#btnCancel').addEventListener('click', cancel);
  $('#vid').addEventListener('timeupdate', () => { const v = $('#vid'); if (stopAt !== null && v.currentTime >= stopAt) { v.pause(); stopAt = null; } });
  $('#btnCopy').addEventListener('click', async () => {
    const t = $('#report').value;
    try { await navigator.clipboard.writeText(t); $('#btnCopy').textContent = 'Copied ✓'; }
    catch (_) { $('#report').select(); $('#btnCopy').textContent = 'Select all and copy manually'; }
    setTimeout(() => { $('#btnCopy').textContent = 'Copy report'; }, 2500);
  });
  document.querySelectorAll('input[name=mine],input[name=xplay],input[name=xsync],input[name=xsave]').forEach((r) => r.addEventListener('change', () => { if (run && !st.running) buildReport(run.ok, run.err); }));
  $('#btnExport').addEventListener('click', startExport);
  $('#btnExportCancel').addEventListener('click', cancelExport);
  $('#btnSelAll').addEventListener('click', () => { document.querySelectorAll('[data-pick]').forEach((b) => { b.checked = true; }); syncExportUi(); });
  $('#btnSelNone').addEventListener('click', () => { document.querySelectorAll('[data-pick]').forEach((b) => { b.checked = false; }); syncExportUi(); });
  document.addEventListener('visibilitychange', onVisibility);
  // a normal reload/close also fires "hidden" right before pagehide: do not mistake that for the app being backgrounded
  window.addEventListener('pagehide', () => {
    if (!st.running && !st.exporting) return;
    const own = flag.hiddenSince && Date.now() - flag.hiddenSince < 300;
    patchFlag(Object.assign({ unloaded: true }, own ? { hiddenNow: false, hiddenSince: null, hiddenCount: Math.max(0, (flag.hiddenCount || 0) - 1) } : {}));
  });
  showRecovery();
  window.__highlightsTest = { get run() { return run; }, get exp() { return run && run.exp; } };
}
boot();
