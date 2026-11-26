/*
  ClipGen AI · speech-caption test · page logic.

  Pipeline (everything on this device):
    open the video (mounted, never copied) → extract 16 kHz mono audio with FFmpeg.wasm
    → Whisper (transformers.js, in a worker) → words with timestamps → caption lines → ASS subtitles
    → export 9:16 · 720×1280 with the captions burned in (libass) → verify.

  The page never writes caption text of its own. If nothing is recognized it stops and says so.
*/
import { createEngine } from './ffmpeg-engine.js';
import { createRecognizer, MODELS } from './speech.js';
import { OUT_W, OUT_H, normalizeWords, groupWords, buildAss, pickProbeTimes, unsupportedChars, wordErrorRate, syncCheck, rmsDb } from './captions.js';

const VERSION = 'speech-v1';
const FLAG_KEY = 'clipgen-speech-run';
const SAMPLE_RATE = 16000;
const MIN_DIFF_PIXELS = 600;

const VF_BASE = "crop=w='min(iw,trunc(ih*9/16/2)*2)':h='min(ih,trunc(iw*16/9/2)*2)',scale=" + OUT_W + ':' + OUT_H + ':flags=bicubic,setsar=1';
const VF_ASS = VF_BASE + ',subtitles=filename=/sub.ass:fontsdir=/fonts,format=yuv420p';

const STEPS = [
  ['env', 'Check this phone', 2],
  ['engine', 'Load the video engine', 10],
  ['source', 'Open your video', 2],
  ['audio', 'Extract the audio', 6],
  ['model', 'Load the speech model', 22],
  ['asr', 'Recognize your speech', 20],
  ['captions', 'Build caption timings', 2],
  ['export', 'Export 9:16 with your words burned in', 28],
  ['verify', 'Verify the result', 8]
];
const TOTAL_W = STEPS.reduce((a, s) => a + s[2], 0);

const $ = (s) => document.querySelector(s);
const msg = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };
const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
const mb = (b) => (b / 1048576).toFixed(1) + ' MB';
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const st = { engine: null, rec: null, running: false, run: null, urls: [], timer: null };
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

/* crash flag: tells us next time if Safari killed the tab during a run */
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
    this.lines = lines || [];
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
    deviceMemoryGB: navigator.deviceMemory || null, secureContext: !!window.isSecureContext, webassembly: typeof WebAssembly === 'object',
    worker: typeof Worker === 'function', crossOriginIsolated: !!window.crossOriginIsolated, webgpu: !!navigator.gpu,
    wakeLock: 'wakeLock' in navigator, screen: screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'
  };
}

async function stepEnv() {
  const env = run.rec.env = collectEnv();
  const bad = [];
  if (!env.secureContext) bad.push('This page is not served over HTTPS.');
  if (!env.webassembly) bad.push('WebAssembly is not available.');
  if (!env.worker) bad.push('Web Workers are not available.');
  if (bad.length) throw new Error(bad.join('\n'));
  try { if ('wakeLock' in navigator) { run.wake = await navigator.wakeLock.request('screen'); } } catch (_) { /* optional */ }
  return { note: (env.iosVersion ? 'iOS ' + env.iosVersion + ' · ' : '') + (env.cores || '?') + ' cores' };
}

async function stepEngine() {
  st.engine = await createEngine({
    onLog: (l) => { addLog(l); if (run && run.collector) run.collector.push(l); },
    onProgress: (d) => { if (run && d && typeof d.progress === 'number' && d.progress >= 0 && d.progress <= 1 && run.current === 'export') run.frac = d.progress; },
    onStatus: (s) => { if (run) { run.label = s.text; if (typeof s.fraction === 'number') run.frac = s.fraction * 0.8; } }
  });
  await memSnap('after-engine');
  return { note: st.engine.name };
}

async function stepSource() {
  const file = run.opts.file, eng = st.engine;
  run.rec.source = { name: file.name, sizeMB: +(file.size / 1048576).toFixed(1), type: file.type || 'unknown' };
  let how = 'opened without copying';
  try {
    await eng.mkdir('/mnt');
    await eng.mount('/mnt', { blobs: [{ name: 'input_media', data: file }] });
    run.input = '/mnt/input_media';
  } catch (e) {
    addLog('[speech] WORKERFS mount failed: ' + msg(e));
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
  const r = await runExec('Extracting the audio …', ['-hide_banner', '-ss', String(start), '-i', run.input, '-t', String(len), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-y', 'speech.pcm']);
  if (r.ret !== 0) {
    const noAudio = r.lines.some((l) => /matches no streams|does not contain any stream|Stream map/i.test(l));
    throw new ExecError(noAudio ? 'This video has no audio track' : 'Audio extraction failed', r.ret, r.lines);
  }
  const bytes = await st.engine.readFile('speech.pcm');
  try { await st.engine.deleteFile('speech.pcm'); } catch (_) { /* ignore */ }
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength - (bytes.byteLength % 4));
  run.pcm = new Float32Array(buf);
  const seconds = run.pcm.length / SAMPLE_RATE;
  if (seconds < 0.5) throw new Error('Only ' + seconds.toFixed(2) + ' s of audio was found at that start time. Is the video shorter than ' + (start + 1) + ' s?');
  run.clipSeconds = Math.min(len, seconds);
  const level = rmsDb(run.pcm);
  run.rec.audio = { seconds: +seconds.toFixed(2), rmsDb: level, ms: Math.round(r.ms) };
  await memSnap('after-audio');
  const quiet = level < -55;
  return { status: quiet ? 'warn' : 'ok', note: seconds.toFixed(1) + ' s · level ' + level + ' dBFS' + (quiet ? '\n! almost silent — recognition will probably find nothing' : '') };
}

async function stepModel() {
  const spec = MODELS[run.opts.model];
  run.label = 'Loading the speech model …';
  st.rec = createRecognizer({
    model: run.opts.model, language: run.opts.language,
    onStatus: (t) => { run.label = t; addLog('[speech] ' + t); },
    onProgress: (p) => { run.label = 'Downloading the speech model … ' + p.loadedMB.toFixed(0) + (p.totalMB ? ' / ' + p.totalMB.toFixed(0) : '') + ' MB'; if (p.totalMB) run.frac = clamp(p.loadedMB / p.totalMB, 0, 0.98); }
  });
  const r = await st.rec.init();
  run.rec.model = { id: spec.id, lib: r.lib };
  await memSnap('after-model');
  return { note: spec.id + ' · ' + r.lib };
}

async function stepAsr() {
  run.label = 'Recognizing speech … (this can take up to a minute on a phone)'; run.frac = 0.05;
  const r = await st.rec.recognize(run.pcm);
  if (run.cancelled) throw new Error('Cancelled');
  run.raw = r;
  run.words = normalizeWords(r.chunks, run.clipSeconds);
  run.rec.asr = { timing: r.timing || 'word', ms: Math.round(r.ms), lib: r.lib, rawChunks: (r.chunks || []).length, words: run.words.length, text: r.text };
  await memSnap('after-asr');
  if (!run.words.length) {
    throw new Error('No speech was recognized in seconds ' + run.opts.start + '–' + (run.opts.start + run.clipSeconds).toFixed(0) + '. The page will NOT make up captions. Check that someone speaks clearly in that part of the video.' +
      (r.text ? '\nThe recognizer returned: “' + r.text.trim().slice(0, 120) + '” but without usable word timings.' : ''));
  }
  const rtf = (run.clipSeconds * 1000) / r.ms;
  const approx = r.timing === 'phrase';
  return { status: approx ? 'warn' : 'ok', note: (approx ? '! word times are estimated from phrase times (less exact)\n' : '') + run.words.length + ' words in ' + sec(r.ms) + ' (' + rtf.toFixed(2) + '× real-time)\n“' + run.words.map((x) => x.w).join(' ').slice(0, 140) + '”' };
}

async function stepCaptions() {
  run.lines = groupWords(run.words);
  const text = run.words.map((x) => x.w).join(' ');
  run.badChars = unsupportedChars(text);
  run.sync = syncCheck(run.pcm, SAMPLE_RATE, run.words);
  run.probe = pickProbeTimes(run.lines, run.clipSeconds);
  run.rec.captions = { lines: run.lines.length, probe: run.probe, sync: run.sync, unsupported: run.badChars.join('') };
  const notes = [run.lines.length + ' caption line(s)'];
  let status = 'ok';
  if (run.badChars.length) { status = 'warn'; notes.push('! these characters cannot be drawn by the caption font yet: ' + run.badChars.join(' ')); }
  if (run.sync.onSpeech !== null) {
    notes.push(Math.round(run.sync.onSpeech * 100) + '% of the words sit on audible sound');
    if (run.sync.onSpeech < 0.6) status = 'warn';
  }
  return { status, note: notes.join('\n') };
}

async function stepExport() {
  const eng = st.engine;
  const font = new Uint8Array(await (await fetch('font/Poppins-Bold.ttf')).arrayBuffer());
  try { await eng.mkdir('/fonts'); } catch (_) { /* exists */ }
  await eng.writeFile('/fonts/font.ttf', font.slice());
  const ass = buildAss(run.lines, { family: 'Poppins', bold: true });
  run.ass = ass;
  await eng.writeFile('/sub.ass', new TextEncoder().encode(ass));
  const { start, len } = run.opts;
  const args = ['-hide_banner', '-ss', String(start), '-i', run.input, '-t', String(len), '-map', '0:v:0', '-map', '0:a:0?', '-dn', '-sn', '-vf', VF_ASS, '-r', '30',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2', '-movflags', '+faststart', '-y', 'out_speech.mp4'];
  const r = await runExec('Exporting 9:16 with your words burned in …', args);
  if (r.ret !== 0) throw new ExecError('Export failed', r.ret, r.lines);
  const bytes = await eng.readFile('out_speech.mp4');
  if (!bytes || bytes.length < 10000) throw new Error('Output file is missing or too small (' + (bytes ? bytes.length : 0) + ' bytes).');
  run.outBytes = bytes;
  run.rec.export = { ms: Math.round(r.ms), sizeMB: +(bytes.length / 1048576).toFixed(2), realtimeFactor: +((run.clipSeconds * 1000) / r.ms).toFixed(2), libassLog: r.lines.filter((l) => /libass|fontselect|fontconfig|cannot find|No usable/i.test(l)).slice(0, 6) };
  await memSnap('after-export');
  return { note: sec(r.ms) + ' · ' + mb(bytes.length) };
}

function decodePng(u8) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(new Blob([u8], { type: 'image/png' })); const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
        const d = x.getImageData(0, 0, c.width, c.height); URL.revokeObjectURL(url); res({ w: c.width, h: c.height, data: d.data });
      } catch (e) { URL.revokeObjectURL(url); rej(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not decode a preview frame')); };
    img.src = url;
  });
}
function diffImages(a, b) {
  if (a.w !== b.w || a.h !== b.h) throw new Error('preview frames differ in size (' + a.w + 'x' + a.h + ' vs ' + b.w + 'x' + b.h + ')');
  const A = a.data, B = b.data; let n = 0;
  for (let i = 0; i < A.length; i += 4) {
    if (Math.max(Math.abs(A[i] - B[i]), Math.abs(A[i + 1] - B[i + 1]), Math.abs(A[i + 2] - B[i + 2])) > 40) n++;
  }
  return n;
}
async function grabPng(label, args, outName) {
  const r = await runExec(label, args.concat(['-frames:v', '1', '-y', outName]));
  if (r.ret !== 0) throw new ExecError('Frame extraction failed', r.ret, r.lines);
  const png = await st.engine.readFile(outName);
  try { await st.engine.deleteFile(outName); } catch (_) { /* ignore */ }
  return png;
}
/** How many pixels differ between the captioned export and the same moment of the video without captions. */
async function framesDiff(t, tag) {
  const plain = await decodePng(await grabPng('Checking a frame …', ['-hide_banner', '-ss', String(run.opts.start + t), '-i', run.input, '-vf', VF_BASE], tag + '_p.png'));
  const pngOut = await grabPng('Checking a frame …', ['-hide_banner', '-ss', String(t), '-i', 'out_speech.mp4'], tag + '_o.png');
  const out = await decodePng(pngOut);
  return { count: diffImages(plain, out), png: pngOut };
}
async function probeOutput() {
  const r = await runExec('Reading output info …', ['-hide_banner', '-i', 'out_speech.mp4']);
  const t = r.lines.join('\n');
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(t);
  const dim = /Video:[^\n]*?,\s*(\d{2,5})x(\d{2,5})/.exec(t);
  const vc = /Video:\s*(\w+)/.exec(t), ac = /Audio:\s*(\w+)/.exec(t);
  return { duration: dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null, width: dim ? Number(dim[1]) : null, height: dim ? Number(dim[2]) : null, vcodec: vc ? vc[1] : null, acodec: ac ? ac[1] : null };
}

async function stepVerify() {
  const notes = []; let status = 'ok';
  const info = await probeOutput(); run.rec.outputInfo = info;
  const dimOk = info.width === OUT_W && info.height === OUT_H;
  const durOk = info.duration !== null && Math.abs(info.duration - run.clipSeconds) < 1;
  notes.push((info.width || '?') + '×' + (info.height || '?') + ' ' + (info.vcodec || '?') + '/' + (info.acodec || 'no audio') + ' · ' + (info.duration !== null ? info.duration.toFixed(2) : '?') + ' s');
  if (!dimOk || !durOk) { status = 'warn'; notes.push('! unexpected size or length'); }
  if (!info.acodec) { status = 'warn'; notes.push('! the export has no audio'); }
  const wordFrame = await framesDiff(run.probe.tWord, 'fw');
  run.rec.captionCheck = { tWord: run.probe.tWord, differingPixelsAtWord: wordFrame.count };
  run.captionPng = wordFrame.png;
  let burned = wordFrame.count >= MIN_DIFF_PIXELS;
  if (run.probe.tGap !== null) {
    const gapFrame = await framesDiff(run.probe.tGap, 'fg');
    run.rec.captionCheck.tGap = run.probe.tGap; run.rec.captionCheck.differingPixelsAtGap = gapFrame.count;
    burned = burned && wordFrame.count > gapFrame.count * 3 + 300;
    notes.push('caption frame (t=' + run.probe.tWord + ' s): ' + wordFrame.count + ' changed pixels · no-caption frame (t=' + run.probe.tGap + ' s): ' + gapFrame.count);
  } else {
    notes.push('caption frame (t=' + run.probe.tWord + ' s): ' + wordFrame.count + ' changed pixels (no caption-free moment to compare)');
  }
  run.burned = burned;
  notes.push(burned ? '✓ the recognized words are visible in the exported frame' : '✕ captions NOT visible in the exported frame');
  if (!burned) { status = 'fail'; }
  const truth = ($('#truth').value || '').trim();
  if (truth) {
    const hyp = run.words.map((x) => x.w).join(' ');
    run.wer = wordErrorRate(truth, hyp);
    run.rec.wer = run.wer;
    notes.push('word error rate vs what you typed: ' + (run.wer === null ? 'n/a' : Math.round(run.wer * 100) + '%'));
  }
  await memSnap('after-verify');
  if (status === 'fail') { const e = new Error(notes.join('\n')); e.soft = true; throw e; }
  return { status, note: notes.join('\n') };
}

/* ---------------- results ---------------- */
function verdictFor(ok, err) {
  if (!ok) return { kind: 'bad', title: 'NOT VERIFIED', body: err || 'The run did not finish.' };
  const issues = [];
  if (run.badChars.length) issues.push('Some characters cannot be drawn by the caption font yet (' + run.badChars.join(' ') + ').');
  if (run.sync && run.sync.onSpeech !== null && run.sync.onSpeech < 0.6) issues.push('Only ' + Math.round(run.sync.onSpeech * 100) + '% of the word times line up with audible sound.');
  if (run.wer !== null && run.wer !== undefined && run.wer > 0.35) issues.push('Word error rate is ' + Math.round(run.wer * 100) + '%: the recognizer got many words wrong.');
  if (issues.length) return { kind: 'warn', title: 'Captions were generated from recognized speech, with problems', body: issues.join('\n') + '\nLook at the video and the words below before trusting this.' };
  return { kind: 'ok', title: 'Recognized speech was burned into the video', body: 'Automatic checks passed. Now confirm with your own eyes that the words match what you said (box below).' };
}

function showResult(ok, errMsg) {
  $('#resultCard').classList.remove('hidden');
  const v = verdictFor(ok, errMsg);
  banner($('#verdict'), v.kind, v.title, v.body);
  const vid = $('#vid'), dl = $('#dl');
  if (ok && run.outBytes) {
    const url = URL.createObjectURL(new Blob([run.outBytes], { type: 'video/mp4' }));
    st.urls.push(url); vid.src = url; vid.classList.remove('hidden'); dl.href = url; dl.classList.remove('hidden');
  } else { vid.removeAttribute('src'); vid.classList.add('hidden'); dl.classList.add('hidden'); }
  const tr = $('#transcript');
  const rows = run.words ? run.lines || [] : [];
  tr.innerHTML = rows.length
    ? rows.map((l) => '<div class="ln"><span class="tm">' + l.start.toFixed(2) + '–' + l.end.toFixed(2) + ' s</span><span>' + esc(l.text) + '</span></div>').join('')
    : '<p class="note">' + (run.raw && run.raw.text ? 'Recognizer text: “' + esc(run.raw.text.trim()) + '” (no usable word times)' : 'Nothing was recognized.') + '</p>';
  const m = [];
  const row = (k, val, cls) => m.push('<tr><td>' + esc(k) + '</td><td class="' + (cls || '') + '">' + esc(val) + '</td></tr>');
  if (run.rec.model) row('Speech model', run.rec.model.id + ' · ' + run.rec.model.lib);
  if (run.rec.asr) row('Recognition', run.rec.asr.words + ' words · ' + sec(run.rec.asr.ms) + ' · ' + ((run.clipSeconds * 1000) / run.rec.asr.ms).toFixed(2) + '× real-time');
  if (run.rec.export) row('Export', sec(run.rec.export.ms) + ' · ' + run.rec.export.realtimeFactor + '× real-time · ' + run.rec.export.sizeMB + ' MB');
  if (run.rec.outputInfo) row('Output file', (run.rec.outputInfo.width || '?') + '×' + (run.rec.outputInfo.height || '?') + ' · ' + (run.rec.outputInfo.vcodec || '?') + '/' + (run.rec.outputInfo.acodec || 'no audio'));
  if (run.sync && run.sync.onSpeech !== null) row('Words on audible sound', Math.round(run.sync.onSpeech * 100) + '%');
  if (run.wer !== null && run.wer !== undefined) row('Word error rate', Math.round(run.wer * 100) + '% (0% = perfect)');
  const last = run.mem[run.mem.length - 1];
  row('Video-engine memory', last && last.wasmMB ? last.wasmMB + ' MB' : 'not measurable');
  row('Total time', sec(performance.now() - run.t0));
  $('#metrics').innerHTML = m.join('');
  buildReport(ok, errMsg);
}

function buildReport(ok, errMsg) {
  const r = run.rec, L = [];
  L.push('ClipGen AI speech-caption report · ' + VERSION);
  L.push('When: ' + new Date().toISOString() + ' · model: ' + run.opts.model + ' · language: ' + run.opts.language + ' · start ' + run.opts.start + ' s · length ' + run.opts.len + ' s');
  L.push('VERDICT: ' + (ok ? verdictFor(true).title : 'NOT VERIFIED — ' + (errMsg || '').split('\n')[0]));
  if (r.env) L.push('DEVICE: ' + (r.env.iosVersion ? 'iOS ' + r.env.iosVersion : 'non-iOS') + ' · cores ' + r.env.cores + ' · screen ' + r.env.screen + ' · COI ' + r.env.crossOriginIsolated + ' · WebGPU ' + r.env.webgpu);
  if (r.env) L.push('UA: ' + r.env.userAgent);
  if (r.source) L.push('SOURCE: ' + r.source.name + ' · ' + r.source.sizeMB + ' MB · ' + r.source.how);
  if (r.audio) L.push('AUDIO: ' + r.audio.seconds + ' s · level ' + r.audio.rmsDb + ' dBFS · extracted in ' + sec(r.audio.ms));
  if (r.model) L.push('MODEL: ' + r.model.id + ' · ' + r.model.lib);
  if (r.asr) L.push('ASR: timing=' + r.asr.timing + ' · ' + r.asr.words + ' words (' + r.asr.rawChunks + ' raw chunks) in ' + sec(r.asr.ms) + ' · text: ' + JSON.stringify(String(r.asr.text || '').trim().slice(0, 300)));
  if (run.lines && run.lines.length) {
    L.push('CAPTION LINES (start–end s: text):');
    for (const l of run.lines) L.push('  ' + l.start.toFixed(2) + '–' + l.end.toFixed(2) + ': ' + l.text);
    L.push('WORD TIMES: ' + run.words.map((x) => x.w + '@' + x.s.toFixed(2) + '-' + x.e.toFixed(2)).join(' '));
  }
  if (r.captions) L.push('CHECKS: sync ' + JSON.stringify(r.captions.sync) + ' · unsupported chars ' + JSON.stringify(r.captions.unsupported));
  if (r.captionCheck) L.push('CAPTION PIXELS: ' + JSON.stringify(r.captionCheck));
  if (r.wer !== undefined) L.push('WORD ERROR RATE vs typed text: ' + r.wer);
  if (r.export) L.push('EXPORT: ' + sec(r.export.ms) + ' · ' + r.export.realtimeFactor + 'x real-time · ' + r.export.sizeMB + ' MB · libass log ' + JSON.stringify(r.export.libassLog));
  if (r.outputInfo) L.push('OUTPUT: ' + JSON.stringify(r.outputInfo));
  L.push('MEMORY: ' + (run.mem.length ? run.mem.map((m) => m.tag + ' wasm=' + (m.wasmMB || 'n/a')).join(' | ') : 'n/a'));
  L.push('STEP TIMES (ms): ' + JSON.stringify(run.timing));
  const mine = document.querySelector('input[name=mine]:checked');
  L.push('MY CHECK (words match what I said): ' + (mine ? mine.value : 'not answered'));
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
  for (const u of st.urls) { try { URL.revokeObjectURL(u); } catch (_) { /* ignore */ } }
  st.urls = [];
  const model = $('#model').value;
  const opts = {
    file, model, language: MODELS[model].multilingual ? $('#lang').value : 'english',
    start: Math.max(0, Number($('#startSec').value) || 0), len: clamp(Number($('#lenSec').value) || 10, 3, 30)
  };
  run = { opts, rec: { version: VERSION }, steps: {}, timing: {}, errors: [], mem: [], t0: performance.now(), cancelled: false, current: null, frac: 0, label: 'Starting …' };
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
    await doStep('model', stepModel);
    await doStep('asr', stepAsr);
    await doStep('captions', stepCaptions);
    await doStep('export', stepExport);
    await doStep('verify', stepVerify);
    ok = true;
  } catch (e) {
    errMsg = msg(e);
    run.errors.push({ step: e.step || run.current || '?', message: errMsg });
    if (run.current && !run.steps[run.current] && e.soft) run.steps[run.current] = 'done';
    // when the export finished but verification failed, still show the video so the user can look
    if (e.soft && run.outBytes) { errMsg = 'The export finished, but the automatic check did not find the words in the frame.\n' + errMsg; }
  }
  clearFlag();
  run.label = ok ? 'Done.' : (run.cancelled ? 'Cancelled.' : 'Stopped.');
  $('#pfill').style.width = ok ? '100%' : $('#pfill').style.width;
  cleanup();
  st.running = false;
  $('#btnRun').classList.remove('hidden'); $('#btnCancel').classList.add('hidden');
  paint();
  showResult(ok, errMsg);
  if (!ok && run.outBytes) { // let the user inspect the file anyway
    const url = URL.createObjectURL(new Blob([run.outBytes], { type: 'video/mp4' }));
    st.urls.push(url); $('#vid').src = url; $('#vid').classList.remove('hidden'); $('#dl').href = url; $('#dl').classList.remove('hidden');
  }
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
function boot() {
  buildSteps();
  $('#model').innerHTML = Object.entries(MODELS).map(([k, v]) => '<option value="' + k + '">' + esc(v.label) + '</option>').join('');
  const syncLang = () => $('#langRow').classList.toggle('hidden', !MODELS[$('#model').value].multilingual);
  $('#model').addEventListener('change', syncLang); syncLang();
  $('#file').addEventListener('change', () => { $('#btnRun').disabled = !$('#file').files.length; });
  $('#btnRun').addEventListener('click', start);
  $('#btnCancel').addEventListener('click', cancel);
  $('#btnCopy').addEventListener('click', async () => {
    const t = $('#report').value;
    try { await navigator.clipboard.writeText(t); $('#btnCopy').textContent = 'Copied ✓'; }
    catch (_) { $('#report').select(); $('#btnCopy').textContent = 'Select all and copy manually'; }
    setTimeout(() => { $('#btnCopy').textContent = 'Copy report'; }, 2500);
  });
  document.querySelectorAll('input[name=mine]').forEach((r) => r.addEventListener('change', () => { if (run && !st.running) buildReport(!!run.burned, ''); }));
  const flag = readFlag();
  if (flag) {
    clearFlag();
    const b = $('#crashBanner'); b.classList.remove('hidden');
    banner(b, 'bad', 'The previous run did not finish', 'It stopped during “' + ((STEPS.find((s) => s[0] === flag.step) || [])[1] || flag.step) + '”. Safari probably closed or reloaded the tab (usually a memory limit). Tell Claude which step this says.');
  }
  window.__speechTest = { get run() { return run; } };
}
boot();
