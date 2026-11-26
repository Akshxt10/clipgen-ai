/*
  ClipGen AI · Phase 1 · step 1 · automatic highlight detection.

  Pipeline (everything on this device):
    open the video (mounted, never copied) → extract 16 kHz mono audio with FFmpeg.wasm (same call as the speech-caption test)
    → loudness curve → Whisper speech recognition with word timestamps (same recognizer files as the speech-caption test)
    → analyze.js (the backend's tested scoring/selection code, unchanged) → ranked clips → automatic checks → preview.

  The video engine and the recognizer are imported from ../phase0-speech/ and are NOT modified.
  Scores are heuristics (loudness, speech rate, hook/question/emotion cues, sentence boundaries). They are not human judgement.
*/
import { createEngine } from '../phase0-speech/ffmpeg-engine.js';
import { createRecognizer, MODELS } from '../phase0-speech/speech.js';
import { normalizeWords, syncCheck, rmsDb } from '../phase0-speech/captions.js';
import { analyzeVideo, normalizeSettings } from './analyze.js';
import { loudnessFromPcm } from './loudness.js';
import { checkClips } from './checks.js';

const VERSION = 'highlights-v1';
const FLAG_KEY = 'clipgen-highlights-run';
const RATE = 16000;
const MAX_WINDOW = 600;

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

const st = { engine: null, rec: null, running: false, urls: [], timer: null, videoDuration: null, videoUrl: null };
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
const setFlag = (step) => { try { localStorage.setItem(FLAG_KEY, JSON.stringify({ step, t: Date.now() })); } catch (_) { /* private mode */ } };
const clearFlag = () => { try { localStorage.removeItem(FLAG_KEY); } catch (_) { /* ignore */ } };
const readFlag = () => { try { const v = localStorage.getItem(FLAG_KEY); return v ? JSON.parse(v) : null; } catch (_) { return null; } };

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
  return { note: v.length + ' windows · ' + run.rec.loudness.minDb + ' to ' + run.rec.loudness.maxDb + ' dB' };
}
async function stepModel() {
  const spec = MODELS[run.opts.model];
  run.label = 'Loading the speech model …';
  st.rec = createRecognizer({
    model: run.opts.model, language: 'auto',
    onStatus: (t) => { run.label = t; addLog('[speech] ' + t); },
    onProgress: (p) => { run.label = 'Downloading the speech model … ' + p.loadedMB.toFixed(0) + (p.totalMB ? ' / ' + p.totalMB.toFixed(0) : '') + ' MB'; if (p.totalMB) run.frac = clamp(p.loadedMB / p.totalMB, 0, 0.98); }
  });
  const r = await st.rec.init();
  run.rec.model = { id: spec.id, lib: r.lib };
  await memSnap('after-model');
  return { note: spec.id + ' · ' + r.lib };
}
async function stepAsr() {
  run.label = 'Recognizing speech … (about ' + Math.max(1, Math.round(run.dur / 60)) + '+ min of audio — this can take a while on a phone)'; run.frac = 0.05;
  const r = await st.rec.recognize(run.pcm);
  if (run.cancelled) throw new Error('Cancelled');
  run.raw = r;
  run.words = normalizeWords(r.chunks, run.dur);
  run.rec.asr = { timing: r.timing || 'word', ms: Math.round(r.ms), lib: r.lib, rawChunks: (r.chunks || []).length, words: run.words.length };
  await memSnap('after-asr');
  const rtf = (run.dur * 1000) / r.ms;
  if (run.words.length < 5) {
    // not fatal: analyze.js falls back to audio-only scoring and the page says so
    return { status: 'warn', note: '! only ' + run.words.length + ' word(s) recognized — highlights will use loudness only (no transcript)\n' + sec(r.ms) + ' (' + rtf.toFixed(2) + '× real-time)' };
  }
  const approx = r.timing === 'phrase';
  return { status: approx ? 'warn' : 'ok', note: (approx ? '! word times are estimated from phrase times\n' : '') + run.words.length + ' words in ' + sec(r.ms) + ' (' + rtf.toFixed(2) + '× real-time)\n“' + run.words.slice(0, 18).map((x) => x.w).join(' ') + (run.words.length > 18 ? ' …' : '') + '”' };
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
  run.analysis = res;
  run.clips = res.clips;
  run.rec.analysis = { mode: res.mode, clips: res.clips.length, lowConfidence: run.lowConfidence, relaxed: run.relaxed, stats: res.stats, settings: run.settings };
  if (!res.clips.length) return { status: 'warn', note: '! no moment qualified as a highlight (' + (res.stats.note || 'scores were below the threshold even on “More clips”') + ')' };
  const notes = [res.clips.length + ' clip(s) · mode: ' + (res.mode === 'transcript' ? 'speech + loudness' : 'loudness only (no usable transcript)')];
  if (run.lowConfidence) notes.push('! nothing qualified with your settings, so I relaxed them: ' + run.relaxed);
  return { status: (run.lowConfidence || res.mode !== 'transcript') ? 'warn' : 'ok', note: notes.join('\n') };
}
async function stepVerify() {
  const chk = run.check = checkClips(run.clips, run.words, run.dur);
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
  run.clips.forEach((c, k) => { ctx.fillStyle = cols[k % cols.length] + '44'; ctx.fillRect((c.start / run.dur) * W, 0, ((c.end - c.start) / run.dur) * W, H); });
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
  $('#clips').innerHTML = run.clips.map((c, k) =>
    '<div class="clip" style="border-left:4px solid ' + cols[k % cols.length] + '">' +
      '<div class="top"><span class="ti">#' + c.rank + ' · ' + esc(c.title) + '</span><span class="sc">' + Math.round(c.score) + '</span></div>' +
      '<div class="note" style="margin:0">' + clock(c.start + run.opts.start) + ' – ' + clock(c.end + run.opts.start) + ' in your video · ' + c.duration.toFixed(1) + ' s · highlight score (heuristic)</div>' +
      '<div>' + c.categories.map((t) => '<span class="tag">' + esc(t) + '</span>').join('') + '</div>' +
      '<ul>' + c.reasons.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ul>' +
      (c.transcript ? '<div class="tx">“' + esc(c.transcript) + '”</div>' : '<div class="note">No transcript for this clip (loudness only).</div>') +
      '<button class="btn small" data-play="' + k + '">▶ Preview</button>' +
    '</div>').join('');
  document.querySelectorAll('[data-play]').forEach((b) => b.addEventListener('click', () => playClip(Number(b.dataset.play))));
}
let stopAt = null;
function playClip(k) {
  const c = run.clips[k]; if (!c) return;
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
  if (run.sync && run.sync.onSpeech !== null && run.sync.onSpeech < 0.6) issues.push('Only ' + Math.round(run.sync.onSpeech * 100) + '% of word times line up with audible sound.');
  if (issues.length) return { kind: 'warn', title: run.clips.length + ' highlight(s) found, with caveats', body: issues.join('\n') + '\nScores are heuristics — preview each clip and judge it yourself.' };
  return { kind: 'ok', title: run.clips.length + ' highlight(s) found', body: 'Automatic checks passed (clips are well-formed and cut between words). Whether they are GOOD highlights is your call — preview them and answer the box below.' };
}
function showResult(ok, errMsg) {
  $('#resultCard').classList.remove('hidden');
  const v = verdictFor(ok, errMsg);
  banner($('#verdict'), v.kind, v.title, v.body);
  $('#vid').classList.add('hidden');
  if (ok && run.clips.length) { drawWave(); renderClips(); $('#wave').classList.remove('hidden'); } else { $('#clips').innerHTML = ''; $('#wave').classList.add('hidden'); }
  const m = [];
  const row = (k, val) => m.push('<tr><td>' + esc(k) + '</td><td>' + esc(val) + '</td></tr>');
  if (run.rec.model) row('Speech model', run.rec.model.id + ' · ' + run.rec.model.lib);
  if (run.rec.asr) row('Recognition', run.rec.asr.words + ' words · ' + sec(run.rec.asr.ms) + ' · ' + ((run.dur * 1000) / run.rec.asr.ms).toFixed(2) + '× real-time');
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
  if (run.words && run.words.length) L.push('TRANSCRIPT: ' + run.words.map((x) => x.w).join(' ').slice(0, 1200));
  if (r.analysis) L.push('ANALYSIS: mode=' + r.analysis.mode + ' lowConfidence=' + r.analysis.lowConfidence + ' stats=' + JSON.stringify(r.analysis.stats));
  if (run.clips) for (const c of run.clips) L.push('CLIP #' + c.rank + ' ' + c.start.toFixed(1) + '–' + c.end.toFixed(1) + ' s (video ' + clock(c.start + run.opts.start) + '–' + clock(c.end + run.opts.start) + ') score ' + c.score + ' [' + c.categories.join(', ') + '] “' + (c.transcript || '').slice(0, 140) + '” reasons: ' + c.reasons.join(' | '));
  if (r.checks) L.push('CHECKS: ' + JSON.stringify({ ok: r.checks.clipChecks.ok, problems: r.checks.clipChecks.problems, sync: r.checks.sync }));
  L.push('MEMORY: ' + (run.mem.length ? run.mem.map((m) => m.tag + ' wasm=' + (m.wasmMB || 'n/a')).join(' | ') : 'n/a'));
  L.push('STEP TIMES (ms): ' + JSON.stringify(run.timing));
  const mine = document.querySelector('input[name=mine]:checked');
  L.push('MY CHECK (top picks look like real highlights): ' + (mine ? mine.value : 'not answered'));
  if (run.errors.length) { L.push('ERRORS:'); for (const e of run.errors) L.push('  [' + e.step + '] ' + e.message.split('\n').slice(0, 4).join(' | ')); }
  $('#report').value = L.join('\n');
  $('#reportCard').classList.remove('hidden');
}

/* ---------------- run control ---------------- */
function cleanup() {
  clearInterval(st.timer); st.timer = null;
  try { if (run && run.wake) run.wake.release(); } catch (_) { /* ignore */ }
  try { if (st.rec) st.rec.dispose(); } catch (_) { /* ignore */ }
  st.rec = null;
}
async function start() {
  if (st.running) return;
  const file = $('#file').files[0];
  if (!file) return;
  const num = (id, d, a, b) => { const v = Number($('#' + id).value); return Number.isFinite(v) ? clamp(v, a, b) : d; };
  const opts = {
    file, model: $('#model').value, start: num('startSec', 0, 0, 100000), len: num('lenSec', 60, 5, MAX_WINDOW),
    numClips: Math.round(num('numClips', 3, 1, 10)), minLen: num('minLen', 10, 5, 120), maxLen: num('maxLen', 30, 8, 180), intensity: $('#intensity').value
  };
  if (st.videoUrl) { try { URL.revokeObjectURL(st.videoUrl); } catch (_) { /* ignore */ } st.videoUrl = null; $('#vid').removeAttribute('src'); }
  run = { opts, rec: { version: VERSION }, steps: {}, timing: {}, errors: [], mem: [], t0: performance.now(), cancelled: false, current: null, frac: 0, label: 'Starting …', clips: [] };
  st.running = true;
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
  st.running = false;
  $('#btnRun').classList.remove('hidden'); $('#btnCancel').classList.add('hidden');
  paint();
  showResult(ok, errMsg);
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
      $('#lenSec').value = String(Math.min(Math.floor(st.videoDuration), 60));
    }
    done();
  };
  v.onerror = () => { st.videoDuration = null; $('#fileInfo').textContent = file.name + ' · ' + mb(file.size) + ' · (this browser could not read the length — set “Analyse how many seconds” yourself)'; done(); };
  v.src = u;
}
function boot() {
  buildSteps();
  $('#model').innerHTML = Object.entries(MODELS).map(([k, v]) => '<option value="' + k + '"' + (k === 'base.en' ? ' selected' : '') + '>' + esc(v.label) + '</option>').join('');
  $('#file').addEventListener('change', () => { const f = $('#file').files[0]; $('#btnRun').disabled = !f; if (f) readDuration(f); });
  $('#btnRun').addEventListener('click', start);
  $('#btnCancel').addEventListener('click', cancel);
  $('#vid').addEventListener('timeupdate', () => { const v = $('#vid'); if (stopAt !== null && v.currentTime >= stopAt) { v.pause(); stopAt = null; } });
  $('#btnCopy').addEventListener('click', async () => {
    const t = $('#report').value;
    try { await navigator.clipboard.writeText(t); $('#btnCopy').textContent = 'Copied ✓'; }
    catch (_) { $('#report').select(); $('#btnCopy').textContent = 'Select all and copy manually'; }
    setTimeout(() => { $('#btnCopy').textContent = 'Copy report'; }, 2500);
  });
  document.querySelectorAll('input[name=mine]').forEach((r) => r.addEventListener('change', () => { if (run && !st.running) buildReport(run.ok, run.err); }));
  const flag = readFlag();
  if (flag) {
    clearFlag();
    const b = $('#crashBanner'); b.classList.remove('hidden');
    banner(b, 'bad', 'The previous run did not finish', 'It stopped during “' + ((STEPS.find((s) => s[0] === flag.step) || [])[1] || flag.step) + '”. Safari probably closed or reloaded the tab (usually a memory limit). Tell Claude which step this says.');
  }
  window.__highlightsTest = { get run() { return run; } };
}
boot();
