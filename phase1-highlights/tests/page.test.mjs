// Full page test in headless Chromium.
// STAND-INS (not the real thing): FFmpeg engine = NATIVE ffmpeg; recognizer = fixture chunks.
// Proves page logic, audio->loudness->analysis->checks->preview wiring. It does NOT prove Whisper accuracy or that the
// picks are good highlights on real content (that is judged on a real device by the user).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.webm': 'video/webm' };

const work = mkdtempSync(join(tmpdir(), 'hl-'));
const src = join(work, 'highlights_test_source.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=150', '-f', 'lavfi', '-i',
  'aevalsrc=0.004*sin(2*PI*50*t)+0.07*sin(2*PI*300*t)*(between(t\\,2\\,30)+between(t\\,140\\,147))+0.5*sin(2*PI*300*t)*(between(t\\,60\\,90)+between(t\\,110\\,130)):s=44100:d=150',
  '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-y', src]);
const silent = join(work, 'silent.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=30', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', '30', '-c:v', 'libvpx', '-b:v', '100k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-y', silent]);
const short = join(work, 'short.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=12', '-f', 'lavfi', '-i', 'aevalsrc=0.004*sin(2*PI*50*t)+0.2*sin(2*PI*300*t)*between(t\\,0.4\\,10):s=44100:d=12', '-c:v', 'libvpx', '-b:v', '100k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-y', short]);
const noAudio = join(work, 'noaudio.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=10', '-an', '-c:v', 'libvpx', '-b:v', '100k', '-deadline', 'realtime', '-cpu-used', '8', '-y', noAudio]);

// Plan of the 150 s source, computed the same way the page does (same audio, same code), so the stand-in recognizer
// can tell which part of the recording it is being asked about — also after a resume.
import { planChunks } from '../asr-chunks.js';
import { loudnessFromPcm } from '../loudness.js';
const rawPcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0', '-i', src, '-t', '150', '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
const PCM = new Float32Array(rawPcm.buffer.slice(rawPcm.byteOffset, rawPcm.byteOffset + rawPcm.byteLength - (rawPcm.byteLength % 4)));
const PLAN = planChunks(loudnessFromPcm(PCM, 16000, 0.25), PCM.length / 16000);
// a part is identified by its length AND a fingerprint of its first samples
const fp = (a) => { let t = 0; for (let i = 0; i < 256 && i < a.length; i++) t += a[i] * (i + 1); return a.length + ':' + t.toFixed(6); };
const PLAN_FPS = PLAN.map((p) => fp(PCM.subarray(Math.round(p.s * 16000), Math.round(p.e * 16000))));
if (new Set(PLAN_FPS).size !== PLAN_FPS.length) throw new Error('test fixture: parts must be identifiable');

const server = http.createServer((req, res) => {
  const p = join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/phase1-highlights/';
const browser = await chromium.launch();

// FIXTURE transcript (labelled as such). Same as tests/logic.test.mjs.
const W = (txt, s, per = 0.4) => txt.split(' ').map((w, i) => ({ text: ' ' + w, timestamp: [+(s + i * per).toFixed(2), +(s + (i + 1) * per - 0.05).toFixed(2)] }));
const FIXTURE = [
  [2, 'so today we are going to talk about the weather in general.'], [9, 'it was mostly cloudy and then it rained a little bit.'],
  [16, 'we walked to the shop and bought some bread and milk.'], [24, 'nothing else really happened on that day to be honest.'],
  [62, 'Wait, what is the biggest mistake everyone makes with money?'], [67, 'The secret is simple, and I could not believe how crazy it was!'],
  [74, 'Because the first step is to save ten percent of everything you earn.'], [82, 'It was the best day of my life, I love it so much!'],
  [112, 'No way, are you serious, that is insane!'], [118, 'I was shaking and I was so scared, then suddenly it worked.'],
  [140, 'okay that is all for now, see you in the next one.']
].flatMap(([s, t]) => W(t, s));

async function newPage(ctx, { recognizer, source }) {
  const srcFile = source || src;
  const page = await ctx.newPage();
  const wd = mkdtempSync(join(work, 'wd-'));
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const map = (a) => a.map((x) => x === '/mnt/input_media' ? srcFile : x);
  await page.exposeFunction('__nExec', (args) => new Promise((resolveP) => {
    const p = spawn('ffmpeg', map(args), { cwd: wd });
    let buf = '';
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', (code) => resolveP({ code, lines: buf.split(/\r?\n|\r/).filter(Boolean).slice(-300) }));
  }));
  await page.exposeFunction('__nWrite', (name, b64) => { const f = join(wd, name.replace(/^\//, '')); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.from(b64, 'base64')); });
  await page.exposeFunction('__nRead', (name) => readFileSync(join(wd, name.replace(/^\//, ''))).toString('base64'));
  await page.addInitScript(({ useRecognizer, fixture, planFps, planStarts }) => {
    window.__events = [];
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    window.__CLIPGEN_TEST__ = {
      engine: { create: async (hooks) => ({
        name: 'STAND-IN native ffmpeg',
        exec: async (args) => { const r = await window.__nExec(args); r.lines.forEach((l) => hooks.onLog(l)); return r.code; },
        writeFile: async (n, d) => window.__nWrite(n, b64(d)),
        readFile: async (n) => unb64(await window.__nRead(n)),
        deleteFile: async () => {}, mkdir: async () => {}, mount: async () => {}, unmount: async () => {}, memInfo: async () => 0, terminate: () => { window.__events.push('terminate'); }
      }) }
    };
    // part-aware fixture recognizer: returns the fixture words that start inside the part it is given, on the part's local clock
    const part = (audio) => {
      let t = 0; for (let i = 0; i < 256 && i < audio.length; i++) t += audio[i] * (i + 1);
      const idx = planFps.indexOf(audio.length + ':' + t.toFixed(6));
      if (idx < 0) throw new Error('unexpected part ' + audio.length + ' samples');
      const off = planStarts[idx], len = audio.length / 16000;
      window.__events.push('rec:' + idx + ':' + len.toFixed(2));
      const chunks = fixture.filter((c) => c.timestamp[0] >= off - 1e-9 && c.timestamp[0] < off + len).map((c) => ({ text: c.text, timestamp: [+(c.timestamp[0] - off).toFixed(3), +(Math.min(c.timestamp[1], off + len) - off).toFixed(3)] }));
      return { idx, chunks };
    };
    const calls = () => window.__events.filter((e) => e.startsWith('rec:')).length;
    if (useRecognizer === 'fixture') window.__CLIPGEN_TEST__.recognize = async (audio) => ({ text: 'FIXTURE', chunks: part(audio).chunks });
    if (useRecognizer.startsWith('killer')) window.__CLIPGEN_TEST__.recognize = async (audio) => {
      if (calls() === 2 && !sessionStorage.getItem('killed')) {          // the 3rd part: the tab dies (simulated reload)
        sessionStorage.setItem('killed', '1');
        if (useRecognizer === 'killer-bg') { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); await new Promise((r) => setTimeout(r, 600)); }
        if (useRecognizer === 'killer-hard') { Storage.prototype.setItem = function () {}; }   // a real kill runs no code at all: nothing more is written
        location.reload(); await new Promise(() => {});
      }
      return { text: 'FIXTURE', chunks: part(audio).chunks };
    };
    if (useRecognizer === 'flaky') window.__CLIPGEN_TEST__.recognize = async (audio) => {
      if (calls() === 2 && !window.__flaked) { window.__flaked = true; throw new Error('The speech worker crashed: out of memory'); }
      return { text: 'FIXTURE', chunks: part(audio).chunks };
    };
    if (useRecognizer === 'short') window.__CLIPGEN_TEST__.recognize = async () => ({ text: 'FIXTURE', chunks: 'hello everyone this is a quick test of the new caption feature and it works well on my phone'.split(' ').map((w, i) => ({ text: ' ' + w, timestamp: [0.5 + i * 0.5, 0.5 + i * 0.5 + 0.42] })) });
    if (useRecognizer === 'dangling') window.__CLIPGEN_TEST__.recognize = async () => ({ text: 'FIXTURE', chunks: 'so we talked about the ads and how people react to the ad and then I said well you know it is just the way that the market works when you put the ad-'.split(' ').map((w, i) => ({ text: ' ' + w, timestamp: [0.5 + i * 0.3, 0.5 + i * 0.3 + 0.26] })) });
    if (useRecognizer === 'empty') window.__CLIPGEN_TEST__.recognize = async () => ({ text: '', chunks: [] });
  }, { useRecognizer: recognizer, fixture: FIXTURE, planFps: PLAN_FPS, planStarts: PLAN.map((p) => p.s) });
  await page.goto(base + 'index.html');
  return { page, errors };
}
async function runIt(page, file, set) {
  await page.setInputFiles('#file', file);
  const o = Object.assign({ startSec: 0, lenSec: 150, numClips: 3, minLen: 15, maxLen: 35 }, set || {});
  for (const [k, v] of Object.entries(o)) await page.fill('#' + k, String(v));
  await page.click('#btnRun');
  await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 120000 });
}

test('happy path: loudness + (fixture) transcript → ranked clips, checks pass, preview seeks', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await newPage(ctx, { recognizer: 'fixture' });
  await runIt(page, src);
  const verdict = await page.textContent('#verdict');
  console.log('VERDICT:', verdict.replace(/\s+/g, ' '));
  const run = await page.evaluate(() => { const r = window.__highlightsTest.run; return { clips: r.clips.map((c) => ({ id: c.id, rank: c.rank, start: c.start, end: c.end, score: c.score, cats: c.categories, title: c.title })), mode: r.analysis.mode, low: r.lowConfidence, check: r.check, dur: r.dur, sync: r.sync, steps: r.steps }; });
  console.log(JSON.stringify(run.clips));
  assert.match(verdict, /highlight\(s\) found/);
  assert.equal(run.mode, 'transcript');
  assert.equal(run.low, false);
  assert.equal(run.check.ok, true);
  assert.ok(run.dur > 149 && run.dur <= 150.1, 'audio duration ' + run.dur);
  assert.ok(run.clips.length >= 2);
  assert.ok(run.clips[0].start >= 55 && run.clips[0].end <= 135, 'top clip in the loud/hooky region');
  assert.ok(run.sync.onSpeech >= 0.8, 'word times on audible sound: ' + run.sync.onSpeech);
  assert.equal(await page.locator('.clip').count(), run.clips.length);
  assert.ok((await page.textContent('#clips')).includes('Preview'));
  // preview: seeks to the clip start (absolute = analysis start + clip start)
  await page.locator('[data-play="0"]').click();
  await page.waitForFunction(() => { const v = document.querySelector('#vid'); return v.readyState >= 1 && Math.abs(v.currentTime - window.__highlightsTest.run.clips[0].start) < 1.5; }, null, { timeout: 15000 });
  assert.equal(await page.isVisible('#vid'), true);
  // the waveform canvas is actually drawn
  const painted = await page.evaluate(() => { const c = document.querySelector('#wave'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
  assert.ok(painted > 500, 'waveform painted: ' + painted);
  const pageText = await page.textContent('#resultCard');
  assert.ok(!/visual changes|scene cut/i.test(pageText.replace('no scene-cut claims are made', '')), 'no scene claims on the page');
  assert.match(pageText, /Scene detection\s*not run/);
  const report = await page.inputValue('#report');
  assert.match(report, /SCENE DETECTION: not run/);
  assert.match(report, /CLIP #1 /);
  assert.match(report, /TRANSCRIPT: so today we are going/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('offset start: clip times in the report map back to the real video position', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'empty' });
  await runIt(page, src, { startSec: 50, lenSec: 90, minLen: 10, maxLen: 40, numClips: 2 });
  const rows = await page.evaluate(() => window.__highlightsTest.run.clips.map((c) => [c.start, c.end]));
  const text = await page.textContent('#clips');
  assert.ok(rows.length >= 1);
  const abs = Math.floor((50 + rows[0][0]) / 60) + ':' + String(Math.floor((50 + rows[0][0]) % 60)).padStart(2, '0');
  assert.ok(text.includes(abs), 'card shows absolute time ' + abs);
  await ctx.close();
});

test('nothing recognized: loudness-only mode is used AND labelled as such', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'empty' });
  await runIt(page, src, { minLen: 10, maxLen: 40 });
  const verdict = await page.textContent('#verdict');
  const mode = await page.evaluate(() => window.__highlightsTest.run.analysis.mode);
  console.log('LOUDNESS-ONLY VERDICT:', verdict.replace(/\s+/g, ' ').slice(0, 220));
  assert.equal(mode, 'audio-visual');
  assert.match(verdict, /loudness only/i);
  assert.match(await page.textContent('#s_asr'), /only 0 word/);
  const clips = await page.evaluate(() => window.__highlightsTest.run.clips);
  assert.ok(clips.length >= 1 && clips.every((c) => c.transcript === ''));
  assert.match(await page.textContent('#clips'), /No transcript for this clip/);
  await ctx.close();
});

test('short clip (like a 10 s phone test): settings are relaxed AND the page says so', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'short', source: short });
  await runIt(page, short, { lenSec: 12, minLen: 10, maxLen: 30, numClips: 3 });
  const verdict = await page.textContent('#verdict');
  const a = await page.evaluate(() => window.__highlightsTest.run.rec.analysis);
  console.log('SHORT VERDICT:', verdict.replace(/\s+/g, ' ').slice(0, 260), JSON.stringify(a.settings && [a.settings.minDuration, a.settings.maxDuration]));
  assert.match(verdict, /with caveats/);
  assert.match(verdict, /relaxed/);
  assert.equal(a.lowConfidence, true);
  assert.ok(a.clips >= 1);
  const c = await page.evaluate(() => window.__highlightsTest.run.clips[0]);
  assert.match(c.transcript, /hello everyone/);
  assert.ok(await page.evaluate(() => window.__highlightsTest.run.check.ok));
  await ctx.close();
});

test('a clip cut mid-sentence is shown with a visible warning, not presented as clean', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'dangling', source: short });
  await runIt(page, short, { lenSec: 12, minLen: 10, maxLen: 30, numClips: 3 });
  const card = await page.textContent('#clips');
  const verdict = await page.textContent('#verdict');
  console.log('DANGLING CARD:', card.replace(/\s+/g, ' ').slice(0, 420));
  assert.match(card, /⚠ May end mid-sentence \(the last word is “ad-”\)/);
  assert.match(verdict, /⚠ warning/);
  assert.ok(!/Starts and ends cleanly/.test(card));
  assert.match(await page.inputValue('#report'), /CAVEATS: May end mid-sentence/);
  await ctx.close();
});

const CKPT = 'clipgen-highlights-ckpt';
const fixtureAbs = FIXTURE.map((c) => c.timestamp[0]);
const wordStarts = (page) => page.evaluate(() => window.__highlightsTest.run.words.map((w) => w.s));

test('memory: the video engine is released BEFORE speech recognition, and recognition runs in parts of at most 27 s with exact timing', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'fixture' });
  await runIt(page, src);
  const ev = await page.evaluate(() => window.__events);
  const firstRec = ev.findIndex((e) => e.startsWith('rec:')), term = ev.indexOf('terminate');
  assert.ok(term >= 0 && term < firstRec, 'engine terminated (' + term + ') before the first recognition (' + firstRec + '): ' + ev.slice(0, 4));
  const lens = ev.filter((e) => e.startsWith('rec:')).map((e) => Number(e.split(':')[2]));
  assert.equal(lens.length, PLAN.length);
  assert.ok(PLAN.length >= 6, 'a 150 s recording is split into several parts: ' + PLAN.length);
  assert.ok(lens.every((l) => l <= 27.01), 'part lengths ' + lens);
  const starts = await wordStarts(page);
  assert.equal(starts.length, FIXTURE.length, 'no word lost or duplicated at part borders');
  starts.forEach((t, i) => assert.ok(Math.abs(t - fixtureAbs[i]) < 0.02, 'word ' + i + ': ' + t + ' vs ' + fixtureAbs[i]));
  const rep = await page.inputValue('#report');
  assert.match(rep, /VIDEO ENGINE RELEASED BEFORE SPEECH: yes/);
  assert.match(rep, new RegExp('ASR PARTS: ' + PLAN.length + ' \\(reused 0'));
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), CKPT), null, 'checkpoint removed after a successful run');
  await ctx.close();
});

for (const variant of ['killer-hard', 'killer-reload', 'killer-bg']) {
  test('tab killed mid-recognition (' + variant + '): clear recovery message on reload, retry continues from the saved parts', async () => {
    const ctx = await browser.newContext();
    const { page } = await newPage(ctx, { recognizer: variant });
    await page.setInputFiles('#file', src);
    for (const [k, v] of Object.entries({ startSec: 0, lenSec: 150, numClips: 3, minLen: 15, maxLen: 35 })) await page.fill('#' + k, String(v));
    await page.click('#btnRun');
    await page.waitForSelector('#crashBanner:not(.hidden)', { timeout: 60000 });          // appears after the simulated kill + reload
    const b = (await page.textContent('#crashBanner')).replace(/\s+/g, ' ');
    console.log(variant.toUpperCase(), 'BANNER:', b);
    assert.match(b, /The previous run did not finish/);
    assert.match(b, /Recognize your speech/);
    assert.match(b, /speech part 3 of \d+/);
    assert.match(b, /2 speech part\(s\) were saved/);
    assert.match(b, /same video again/);
    if (variant === 'killer-bg') assert.match(b, /background or the phone was locked/);
    else if (variant === 'killer-reload') { assert.match(b, /closed or reloaded/); assert.ok(!/background/.test(b), 'a plain reload is not blamed on the background'); }
    else { assert.match(b, /stopped without warning, so Safari most likely ran out of memory/); assert.ok(!/background/.test(b)); }
    assert.equal(await page.inputValue('#lenSec'), '150', 'your settings are put back');
    assert.equal(await page.isVisible('#btnSmaller'), true, 'offers the smaller model');
    assert.equal(await page.evaluate(() => localStorage.getItem('clipgen-highlights-run')), null, 'no stale flag is left behind');
    // retry: pick the same file again, same settings
    await page.setInputFiles('#file', src);
    await page.fill('#lenSec', '150');
    await page.click('#btnRun');
    await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 120000 });
    assert.equal(await page.isVisible('#crashBanner'), false, 'banner is gone once a new run starts');
    const ev = await page.evaluate(() => window.__events.filter((e) => e.startsWith('rec:')));
    assert.equal(ev.length, PLAN.length - 2, 'only the unfinished parts were recognized after the retry');
    assert.equal(ev[0].split(':')[1], '2');
    const starts = await wordStarts(page);
    assert.equal(starts.length, FIXTURE.length);
    starts.forEach((t, i) => assert.ok(Math.abs(t - fixtureAbs[i]) < 0.02));
    assert.match(await page.textContent('#verdict'), /highlight\(s\) found/);
    assert.match(await page.inputValue('#report'), /ASR PARTS: \d+ \(reused 2/);
    assert.equal(await page.evaluate((k) => localStorage.getItem(k), CKPT), null);
    await ctx.close();
  });
}

test('recognizer crash (no reload): the page says what was saved, and Retry continues', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'flaky' });
  await runIt(page, src);
  const verdict = (await page.textContent('#verdict')).replace(/\s+/g, ' ');
  console.log('CRASH VERDICT:', verdict.slice(0, 360));
  assert.match(verdict, /NOT FINISHED/);
  assert.match(verdict, /speech worker crashed/);
  assert.match(verdict, new RegExp('Nothing is lost: 2 of ' + PLAN.length + ' speech parts were saved'));
  assert.match(await page.inputValue('#report'), /ASR FAILURE: stopped in part 3 of \d+ · parts saved 2/);
  assert.equal(await page.isVisible('#btnRun'), true);
  assert.equal(await page.isVisible('#btnCancel'), false, 'no stale "running" state');
  assert.equal(await page.evaluate(() => localStorage.getItem('clipgen-highlights-run')), null, 'a handled error leaves no crash flag');
  await page.click('#btnRun');
  await page.waitForFunction(() => window.__highlightsTest.run.ok === true, null, { timeout: 120000 });
  const after = await page.evaluate(() => window.__events.filter((e) => e.startsWith('rec:')).length);
  assert.equal(after, PLAN.length, 'parts 0–1 first time (the failed attempt logs nothing), then parts 2…end after Retry: ' + after);
  const starts = await wordStarts(page);
  assert.equal(starts.length, FIXTURE.length);
  await ctx.close();
});

test('a leftover checkpoint from another video is never mixed into this run', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'fixture' });
  await page.evaluate((k) => localStorage.setItem(k, JSON.stringify({ key: 'some-other-video#0#150#base.en#0-20', savedAt: Date.now(), results: { 0: { text: ' STALE', ms: 1, timing: 'word', chunks: [{ text: ' STALE', timestamp: [1, 2] }] } } })), CKPT);
  await runIt(page, src);
  const words = await page.evaluate(() => window.__highlightsTest.run.words.map((w) => w.w));
  assert.ok(!words.includes('STALE'));
  assert.equal(await page.evaluate(() => window.__events.filter((e) => e.startsWith('rec:')).length), PLAN.length);
  await ctx.close();
});

test('silent video: honest "No highlights found"', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'empty' });
  await runIt(page, silent, { lenSec: 30 });
  const verdict = await page.textContent('#verdict');
  assert.match(verdict, /No highlights found/);
  assert.equal(await page.locator('.clip').count(), 0);
  await ctx.close();
});

test('real recognizer path with the CDN unreachable: stops honestly', async () => {
  const ctx = await browser.newContext();
  await ctx.route(/cdn\.jsdelivr\.net|huggingface\.co|unpkg\.com/, (r) => r.abort());
  const { page } = await newPage(ctx, { recognizer: 'none' });
  await runIt(page, src, { lenSec: 30 });
  const verdict = await page.textContent('#verdict');
  assert.match(verdict, /NOT FINISHED/);
  assert.match(verdict, /speech engine could not be started/);
  assert.equal(await page.locator('.clip').count(), 0);
  await ctx.close();
});

test('video without an audio track gives a clear error', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'fixture', source: noAudio });
  await runIt(page, noAudio, { lenSec: 10 });
  const verdict = await page.textContent('#verdict');
  assert.match(verdict, /NOT FINISHED/);
  assert.match(verdict, /no audio track/i);
  await ctx.close();
});

test.after(async () => { await browser.close(); server.close(); });
