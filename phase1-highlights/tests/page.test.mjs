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
  await page.addInitScript(({ useRecognizer, fixture }) => {
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    window.__CLIPGEN_TEST__ = {
      engine: { create: async (hooks) => ({
        name: 'STAND-IN native ffmpeg',
        exec: async (args) => { const r = await window.__nExec(args); r.lines.forEach((l) => hooks.onLog(l)); return r.code; },
        writeFile: async (n, d) => window.__nWrite(n, b64(d)),
        readFile: async (n) => unb64(await window.__nRead(n)),
        deleteFile: async () => {}, mkdir: async () => {}, mount: async () => {}, unmount: async () => {}, memInfo: async () => 0, terminate: () => {}
      }) }
    };
    if (useRecognizer === 'fixture') window.__CLIPGEN_TEST__.recognize = async () => ({ text: 'FIXTURE', chunks: fixture });
    if (useRecognizer === 'short') window.__CLIPGEN_TEST__.recognize = async () => ({ text: 'FIXTURE', chunks: 'hello everyone this is a quick test of the new caption feature and it works well on my phone'.split(' ').map((w, i) => ({ text: ' ' + w, timestamp: [0.5 + i * 0.5, 0.5 + i * 0.5 + 0.42] })) });
    if (useRecognizer === 'empty') window.__CLIPGEN_TEST__.recognize = async () => ({ text: '', chunks: [] });
  }, { useRecognizer: recognizer, fixture: FIXTURE });
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
  const report = await page.inputValue('#report');
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
