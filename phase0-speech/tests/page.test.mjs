// Full page test in headless Chromium.
// STAND-INS (clearly not the real thing): the FFmpeg engine is replaced by NATIVE ffmpeg (libass) and the recognizer by fixture chunks.
// So this proves the page logic, the burn-in and the verification — it does NOT prove Whisper recognizes real speech.
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
const root = resolve(here, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf' };

const work = mkdtempSync(join(tmpdir(), 'page-'));
const src = join(work, 'speech_test_source.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=12', '-f', 'lavfi', '-i',
  'aevalsrc=0.4*sin(2*PI*300*t)*(between(t\\,2\\,3.5)+between(t\\,6\\,7.5))+0.0005*sin(2*PI*50*t):s=44100:d=12',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', src]);

const server = http.createServer((req, res) => {
  const p = join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch();

// FIXTURE words, labelled as such. They sit on the tone bursts of the source above.
const FIXTURE = [
  { text: ' Orange', timestamp: [2.0, 2.4] }, { text: ' river', timestamp: [2.4, 2.9] }, { text: ' morning.', timestamp: [2.9, 3.4] },
  { text: ' Silver', timestamp: [6.1, 6.6] }, { text: ' lantern', timestamp: [6.6, 7.3] }
];

async function newPage(ctx, { recognizer, source }) {
  const srcFile = source || src;
  const page = await ctx.newPage();
  const wd = mkdtempSync(join(work, 'wd-'));
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const map = (a) => a.map((x) => x === '/mnt/input_media' ? srcFile : x.replace(/\/sub\.ass/g, 'sub.ass').replace(/fontsdir=\/fonts/g, 'fontsdir=fonts'));
  await page.exposeFunction('__nExec', (args) => new Promise((resolveP) => {
    const p = spawn('ffmpeg', map(args), { cwd: wd });
    let buf = ''; const lines = [];
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', (code) => resolveP({ code, lines: buf.split(/\r?\n|\r/).filter(Boolean).slice(-400) }));
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
    if (useRecognizer === 'empty') window.__CLIPGEN_TEST__.recognize = async () => ({ text: '', chunks: [] });
  }, { useRecognizer: recognizer, fixture: FIXTURE });
  await page.goto(base + 'index.html');
  return { page, wd, errors };
}
async function runIt(page, extra) {
  await page.setInputFiles('#file', (extra && extra.file) || src);
  await page.fill('#startSec', '0'); await page.fill('#lenSec', '10');
  if (extra && extra.truth) await page.fill('#truth', extra.truth);
  await page.click('#btnRun');
  await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 90000 });
}

test('happy path: recognized (fixture) words are burned into the exported frame', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await newPage(ctx, { recognizer: 'fixture' });
  await runIt(page, { truth: 'Orange river morning. Silver lantern' });
  const verdict = await page.textContent('#verdict');
  const transcript = await page.textContent('#transcript');
  const report = await page.inputValue('#report');
  console.log('VERDICT:', verdict.replace(/\s+/g, ' '));
  console.log(report.split('\n').filter((l) => /CAPTION PIXELS|CHECKS|WORD ERROR|OUTPUT|CAPTION LINES|^  \d/.test(l)).join('\n'));
  assert.match(verdict, /Recognized speech was burned into the video/);
  assert.match(transcript, /Orange river/); assert.match(transcript, /morning\./);
  assert.match(transcript, /Silver lantern/);
  assert.ok(!/CLIPGEN AI CAPTION TEST/i.test(await page.content()));
  assert.match(report, /WORD ERROR RATE vs typed text: 0/);
  const run = await page.evaluate(() => { const r = window.__speechTest.run; return { burned: r.burned, cc: r.rec.captionCheck, sync: r.sync, steps: r.steps }; });
  assert.equal(run.burned, true);
  assert.ok(run.cc.differingPixelsAtWord > run.cc.differingPixelsAtGap * 3 + 300);
  assert.ok(run.sync.onSpeech >= 0.9, 'fixture words sit on the tone bursts');
  // independent check: take the actual exported file out of the page, grab the caption frame, OCR it
  const b64 = await page.evaluate(async () => { const u = await (await fetch(document.querySelector('#vid').src)).arrayBuffer(); let s = ''; const a = new Uint8Array(u); for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); });
  const out = join(work, 'exported.mp4'); writeFileSync(out, Buffer.from(b64, 'base64'));
  const t = run.cc.tWord;
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t + 0.3), '-i', out, '-frames:v', '1', '-vf', 'crop=720:300:0:760,format=gray,scale=iw*2:ih*2,negate', '-y', join(work, 'exp.png')]);
  const ocr = execFileSync('tesseract', [join(work, 'exp.png'), '-', '--psm', '6']).toString().toLowerCase();
  console.log('OCR of the exported file at t=' + (t + 0.3) + ':', JSON.stringify(ocr.trim()));
  assert.ok(/orange|river|morning|silver|lantern/.test(ocr), 'exported frame shows the recognized words');
  assert.ok(!/clipgen|caption test/.test(ocr));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('nothing recognized: stops honestly, no export, no invented captions', async () => {
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'empty' });
  await runIt(page);
  const verdict = await page.textContent('#verdict');
  assert.match(verdict, /NOT VERIFIED/);
  assert.match(verdict, /No speech was recognized/);
  assert.equal(await page.isVisible('#vid'), false);
  assert.match(await page.textContent('#transcript'), /Nothing was recognized/);
  const cls = await page.getAttribute('#s_export', 'class');
  assert.ok(!cls || cls === '', 'export step never ran: ' + cls);
  await ctx.close();
});

test('real recognizer path with the CDN unreachable: honest failure, no captions', async () => {
  const ctx = await browser.newContext();
  await ctx.route(/cdn\.jsdelivr\.net|huggingface\.co|unpkg\.com/, (r) => r.abort());
  const { page } = await newPage(ctx, { recognizer: 'none' });
  await runIt(page);
  const verdict = await page.textContent('#verdict');
  console.log('BLOCKED-CDN VERDICT:', verdict.replace(/\s+/g, ' ').slice(0, 300));
  assert.match(verdict, /NOT VERIFIED/);
  assert.match(verdict, /speech engine could not be started/);
  assert.equal(await page.isVisible('#vid'), false);
  await ctx.close();
});

test('video without an audio track gives a clear error', async () => {
  const noAudio = join(work, 'noaudio.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-y', noAudio]);
  const ctx = await browser.newContext();
  const { page } = await newPage(ctx, { recognizer: 'fixture', source: noAudio });
  await runIt(page, { file: noAudio });
  const verdict = await page.textContent('#verdict');
  console.log('NO-AUDIO VERDICT:', verdict.replace(/\s+/g, ' ').slice(0, 300));
  assert.match(verdict, /NOT VERIFIED/);
  assert.match(verdict, /no audio track/i);
  assert.equal(await page.isVisible('#vid'), false);
  await ctx.close();
});

test.after(async () => { await browser.close(); server.close(); });
