// Full-page export tests in headless Chromium: choose clips → Export selected clips → real MP4 files → download.
// STAND-INS (not the real thing): FFmpeg engine = NATIVE ffmpeg (same arguments the page sends, real libx264/libass);
// recognizer = fixture words. So this proves the page wiring, the arguments, the output files and the caption timing.
// It does NOT prove FFmpeg.wasm on an iPhone behaves the same, nor Safari's download/share behaviour — only the user's phone can.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClipCaptions } from '../export.js';

const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.webm': 'video/webm' };
const has = (c) => { try { execFileSync('which', [c]); return true; } catch { return false; } };
const skipOcr = !has('tesseract') && 'tesseract not installed';

const work = mkdtempSync(join(tmpdir(), 'hlx-'));
const src = join(work, 'export_test_source.webm');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=150', '-f', 'lavfi', '-i',
  'aevalsrc=0.004*sin(2*PI*50*t)+0.07*sin(2*PI*300*t)*(between(t\\,2\\,30)+between(t\\,140\\,147))+0.5*sin(2*PI*300*t)*(between(t\\,60\\,90)+between(t\\,110\\,130)):s=44100:d=150',
  '-c:v', 'libvpx', '-b:v', '200k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libopus', '-y', src]);

const server = http.createServer((req, res) => {
  const p = join(root, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
  if (!p.startsWith(root) || !existsSync(p) || statSync(p).isDirectory()) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/phase1-highlights/';
const browser = await chromium.launch();

// FIXTURE transcript (labelled as such).
const W = (txt, s, per = 0.4) => txt.split(' ').map((w, i) => ({ text: ' ' + w, timestamp: [+(s + i * per).toFixed(2), +(s + (i + 1) * per - 0.05).toFixed(2)] }));
const FIXTURE = [
  [2, 'so today we are going to talk about the weather in general.'], [9, 'it was mostly cloudy and then it rained a little bit.'],
  [16, 'we walked to the shop and bought some bread and milk.'], [24, 'nothing else really happened on that day to be honest.'],
  [62, 'Wait, what is the biggest mistake everyone makes with money?'], [67, 'The secret is simple, and I could not believe how crazy it was!'],
  [74, 'Because the first step is to save ten percent of everything you earn.'], [82, 'It was the best day of my life, I love it so much!'],
  [112, 'No way, are you serious, that is insane!'], [118, 'I was shaking and I was so scared, then suddenly it worked.'],
  [140, 'okay that is all for now, see you in the next one.']
].flatMap(([s, t]) => W(t, s));

async function newPage(ctx, { recognizer = 'fixture', share = false } = {}) {
  const page = await ctx.newPage();
  const wd = mkdtempSync(join(work, 'wd-'));
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  const procs = new Set();
  const map = (a) => a.map((x) => x === '/mnt/input_media' ? src : x.replace(/\/sub\.ass/g, 'sub.ass').replace(/fontsdir=\/fonts/g, 'fontsdir=fonts'));
  await page.exposeFunction('__nExec', (args) => new Promise((resolveP) => {
    const p = spawn('ffmpeg', map(args), { cwd: wd }); procs.add(p);
    let buf = '';
    p.stderr.on('data', (d) => { buf += d; });
    p.on('close', (code) => { procs.delete(p); resolveP({ code, lines: buf.split(/\r?\n|\r/).filter(Boolean).slice(-300) }); });
  }));
  await page.exposeFunction('__nKill', () => { for (const p of procs) { try { p.kill('SIGKILL'); } catch (_) { /* gone */ } } });
  await page.exposeFunction('__nWrite', (name, b64) => { const f = join(wd, name.replace(/^\//, '')); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, Buffer.from(b64, 'base64')); });
  await page.exposeFunction('__nRead', (name) => readFileSync(join(wd, name.replace(/^\//, ''))).toString('base64'));
  await page.exposeFunction('__nDel', (name) => { try { unlinkSync(join(wd, name.replace(/^\//, ''))); } catch (_) { /* missing */ } });
  await page.addInitScript(({ useRecognizer, fixture, withShare }) => {
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return btoa(s); };
    const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const X = window.__X = { creates: 0, terminates: 0, alive: 0, maxAlive: 0, encodes: 0, execs: [], writes: [], mounts: [], deletes: [], asrCalls: 0, cfg: { delayEncode: {}, failEncode: {} } };
    window.__CLIPGEN_TEST__ = {
      engine: { create: async (hooks) => {
        X.creates++; X.alive++; X.maxAlive = Math.max(X.maxAlive, X.alive);
        let dead = false, kill = null; const deadP = new Promise((_, rej) => { kill = () => rej(new Error('Cancelled')); }); deadP.catch(() => {});
        const guard = (p) => Promise.race([p, deadP]);
        return {
          name: 'STAND-IN native ffmpeg',
          exec: async (args) => {
            const enc = args.includes('libx264'); X.execs.push({ enc, args });
            if (enc) {
              const idx = ++X.encodes;
              if (X.cfg.delayEncode[idx]) await guard(new Promise((r) => setTimeout(r, X.cfg.delayEncode[idx])));
              if (X.cfg.failEncode[idx]) { hooks.onLog('Error while opening encoder (simulated failure)'); return 1; }
            }
            const r = await guard(window.__nExec(args)); r.lines.forEach((l) => hooks.onLog(l)); return r.code;
          },
          writeFile: async (n, d) => { X.writes.push({ n, bytes: d.length }); return window.__nWrite(n, b64(d)); },
          readFile: async (n) => unb64(await guard(window.__nRead(n))),
          deleteFile: async (n) => { X.deletes.push(n); return window.__nDel(n); },
          mkdir: async () => {}, mount: async (p, o) => { X.mounts.push({ p, names: o.blobs.map((b) => b.name), size: o.blobs[0].data.size }); }, unmount: async () => {}, memInfo: async () => 300 * 1048576,
          terminate: () => { if (dead) return; dead = true; X.terminates++; X.alive--; kill(); window.__nKill(); }
        };
      } }
    };
    let cursor = 0;
    window.__CLIPGEN_TEST__.recognize = async (audio) => {
      X.asrCalls++;
      if (useRecognizer === 'empty') return { text: '', chunks: [] };
      const off = cursor, len = audio.length / 16000; cursor += len;
      return { text: 'FIXTURE', chunks: fixture.filter((c) => c.timestamp[0] >= off - 1e-9 && c.timestamp[0] < off + len).map((c) => ({ text: c.text, timestamp: [+(c.timestamp[0] - off).toFixed(3), +(Math.min(c.timestamp[1], off + len) - off).toFixed(3)] })) };
    };
    if (withShare) { navigator.canShare = () => true; navigator.share = async (d) => { window.__shared = { name: d.files[0].name, size: d.files[0].size, type: d.files[0].type }; }; }
  }, { useRecognizer: recognizer, fixture: FIXTURE, withShare: share });
  await page.goto(base + 'index.html');
  return { page, errors, wd };
}
async function analyse(page, set) {
  await page.setInputFiles('#file', src);
  const o = Object.assign({ startSec: 0, lenSec: 150, numClips: 3, minLen: 15, maxLen: 35 }, set || {});
  for (const [k, v] of Object.entries(o)) await page.fill('#' + k, String(v));
  await page.click('#btnRun');
  await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 120000 });
}
const resetCounters = (page) => page.evaluate(() => { const X = window.__X; Object.assign(X, { creates: 0, terminates: 0, maxAlive: 0, encodes: 0, execs: [], writes: [], mounts: [], deletes: [] }); });
const waitFinished = (page, n, timeout = 180000) => page.waitForFunction((count) => { const e = window.__highlightsTest.exp; return e && e.finished && !document.querySelector('#btnExportCancel:not(.hidden)') && (count === undefined || e.finished.done + e.finished.failed + e.finished.cancelled + e.finished.skipped >= count); }, n, { timeout });
const items = (page) => page.evaluate(() => { const r = window.__highlightsTest.run; return r.all.map((c) => { const it = r.exp.items[c.id]; return { id: c.id, rank: c.rank, weak: !!c.weak, start: c.start, end: c.end, state: it.state, name: it.name, size: it.size, url: it.url, win: it.win, info: it.info, caps: it.caps, warn: it.warn, error: it.error, note: it.note, burn: it.burn }; }); });
async function blobBytes(page, url) {
  const b64 = await page.evaluate(async (u) => { const a = new Uint8Array(await (await fetch(u)).arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode.apply(null, a.subarray(i, i + 8192)); return btoa(s); }, url);
  return Buffer.from(b64, 'base64');
}
const ffprobe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height,pix_fmt:format=duration', '-of', 'json', file]).toString());
function ocrAt(file, t, tag) {
  const d = mkdtempSync(join(work, 'ocr-'));
  execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'crop=720:300:0:760,format=gray,scale=iw*2:ih*2,negate', '-y', join(d, tag + '.png')]);
  return spawnSync('tesseract', [join(d, tag + '.png'), '-', '--psm', '6'], { encoding: 'utf8' }).stdout.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}

test('Export selected clips: real 9:16 MP4s, exact windows, captions on the clip clock, working download link', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const { page, errors } = await newPage(ctx);
  await analyse(page);
  const run = await page.evaluate(() => { const r = window.__highlightsTest.run; return { start: r.opts.start, dur: r.dur, words: r.words, clips: r.all.map((c) => ({ id: c.id, rank: c.rank, start: c.start, end: c.end, weak: !!c.weak })) }; });
  console.log('CLIPS:', JSON.stringify(run.clips));
  assert.ok(run.clips.length >= 2);
  // each clip card: checkbox, times, score, transcript, Preview, export area
  assert.equal(await page.locator('[data-pick]').count(), run.clips.length);
  assert.equal(await page.locator('[data-play]').count(), run.clips.length);
  const card = await page.textContent('.clip');
  assert.match(card, /Export this clip/); assert.match(card, /in your video/); assert.match(card, /Preview/);
  assert.equal(await page.isVisible('#btnExport'), true);
  // strong clips are ticked, weaker ones are not; the button counts what is ticked
  const strong = run.clips.filter((c) => !c.weak).length;
  assert.match(await page.textContent('#btnExport'), new RegExp('\\(' + strong + '\\)'));
  // select exactly clip 0 and clip 1
  await page.click('#btnSelNone'); assert.equal(await page.isEnabled('#btnExport'), false);
  await page.check('#pick_0'); await page.check('#pick_1');
  assert.match(await page.textContent('#btnExport'), /\(2\)/);
  const asrBefore = await page.evaluate(() => window.__X.asrCalls);
  await resetCounters(page);
  await page.click('#btnExport');
  await waitFinished(page, 2);
  const it = await items(page);
  console.log('EXPORT ITEMS:', JSON.stringify(it.map((x) => ({ rank: x.rank, state: x.state, name: x.name, size: x.size, win: x.win && [x.win.absStart, x.win.absEnd], info: x.info, caps: x.caps, burn: x.burn, warn: x.warn }))));
  assert.deepEqual(it.map((x) => x.state), it.map((_, i) => (i < 2 ? 'done' : 'idle')), 'exactly the two ticked clips were exported');
  const X = await page.evaluate(() => window.__X);
  assert.equal(X.asrCalls, asrBefore, 'Whisper is NOT run again during export');
  for (const k of [0, 1]) {
    const x = it[k];
    // the exact selected window (analysis start 0): never past the requested end
    assert.equal(x.win.absStart, +(run.start + run.clips[k].start).toFixed(3));
    assert.ok(x.win.absEnd <= run.start + run.clips[k].end + 1e-9 && x.win.absEnd >= run.start + run.clips[k].end - 0.002, 'end ' + x.win.absEnd + ' vs ' + run.clips[k].end);
    assert.ok(x.win.absEnd <= run.start + run.dur + 1e-9);
    const enc = X.execs.filter((e) => e.enc)[k].args;
    assert.equal(enc[enc.indexOf('-ss') + 1], String(x.win.absStart)); assert.equal(enc[enc.indexOf('-t') + 1], String(x.win.len));
    assert.ok(enc.includes('/mnt/input_media'));
    // a REAL file: download it through the link the page shows
    assert.match(x.url, /^blob:/);
    const link = page.locator('[data-dl="' + k + '"]');
    assert.equal(await link.getAttribute('href'), x.url); assert.equal(await link.getAttribute('download'), x.name);
    const bytes = await blobBytes(page, x.url);
    assert.equal(bytes.length, x.size); assert.equal(bytes.subarray(4, 8).toString(), 'ftyp', 'an MP4 container');
    const f = join(work, 'out' + k + '.mp4'); writeFileSync(f, bytes);
    const pr = ffprobe(f);
    const v = pr.streams.find((s) => s.codec_type === 'video'), a = pr.streams.find((s) => s.codec_type === 'audio');
    assert.deepEqual([v.codec_name, v.width, v.height, v.pix_fmt, a.codec_name], ['h264', 720, 1280, 'yuv420p', 'aac']);
    const dur = Number(pr.format.duration), want = x.win.len;
    assert.ok(dur <= want + 0.25 && dur >= want - 0.6, 'duration ' + dur + ' vs requested ' + want);
    // the picture really decodes end to end
    execFileSync('ffmpeg', ['-v', 'error', '-i', f, '-f', 'null', '-']);
    // captions: this clip's caption lines, computed from the same words with the same code, are the ones on screen at their times
    const cap = buildClipCaptions(run.words, x.win);
    assert.ok(cap.lines.length >= 1, 'this clip has caption lines');
    assert.equal(x.caps.lines, cap.lines.length);
    assert.ok(cap.lines.every((l) => l.start >= 0 && l.end <= want + 1e-9), 'every caption line is inside the clip');
    if (!skipOcr) {
      const longest = cap.lines.reduce((a2, b2) => (b2.end - b2.start > a2.end - a2.start ? b2 : a2));
      const need = longest.words.map((w) => w.w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length >= 3);
      const t = cap.probe.tWord, seen = ocrAt(f, t, 'w' + k);
      const hit = need.filter((w) => seen.includes(w));
      console.log('clip', k, 'OCR at', t, 'expects', JSON.stringify(need), 'saw', JSON.stringify(seen));
      assert.ok(hit.length >= Math.ceil(need.length / 2), 'the caption words are on screen at their time (clip clock): ' + JSON.stringify({ need, seen }));
      if (cap.probe.tGap !== null) {
        const gap = ocrAt(f, cap.probe.tGap, 'g' + k);
        const all = cap.words.map((w) => w.w.toLowerCase().replace(/[^a-z]/g, '')).filter((w) => w.length >= 4);
        console.log('clip', k, 'OCR in the gap at', cap.probe.tGap, '->', JSON.stringify(gap));
        assert.ok(!all.some((w) => gap.includes(w)), 'no caption text in a gap: ' + gap);
      }
    }
    assert.ok(x.burn && ['yes', 'unclear'].includes(x.burn.result), 'the page\'s own caption check never says "no" here (OCR above is the real proof): ' + JSON.stringify(x.burn));
    if (k === 0) assert.equal(x.burn.result, 'yes', 'static-enough picture: the page\'s check confirms visible captions');
  }
  // the browser's own download flow saves exactly these bytes
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-dl="0"]')]);
  assert.equal(dl.suggestedFilename(), it[0].name);
  const saved = join(work, 'downloaded.mp4'); await dl.saveAs(saved);
  assert.deepEqual(readFileSync(saved), readFileSync(join(work, 'out0.mp4')), 'the downloaded file is byte-identical to the exported one');
  // the report says what happened, and only what happened
  const report = await page.inputValue('#report');
  assert.match(report, /EXPORT: 2 clip\(s\) tried · done 2 · failed 0/); assert.match(report, /EXPORT CLIP #1 DONE/); assert.match(report, /720×1280 h264\/aac/); assert.match(report, /MY EXPORT CHECK: plays=not answered/);
  assert.ok(!/EXPORT CLIP #3/.test(report), 'a clip that was not exported is not reported as exported');
  // a new analysis releases the old clip files
  const oldUrl = it[0].url;
  await page.click('#btnRun'); await page.waitForSelector('#resultCard:not(.hidden)', { timeout: 120000 });
  const stillThere = await page.evaluate(async (u) => { try { await (await fetch(u)).arrayBuffer(); return true; } catch (_) { return false; } }, oldUrl);
  assert.equal(stillThere, false, 'old export files are released when a new analysis starts');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('several clips: strictly one at a time, a fresh engine per clip that is thrown away, source never copied, no leftovers', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors, wd } = await newPage(ctx);
  await analyse(page);
  await page.click('#btnSelAll');
  const n = await page.locator('[data-pick]').count();
  assert.ok(n >= 3, 'need 3 clips for this test, have ' + n);
  await resetCounters(page);
  await page.click('#btnExport');
  await waitFinished(page, n);
  const X = await page.evaluate(() => window.__X);
  const it = await items(page);
  console.log('ENGINE LIFECYCLE: creates', X.creates, 'terminates', X.terminates, 'max alive at once', X.maxAlive, '| encodes', X.encodes);
  assert.ok(it.every((x) => x.state === 'done'), JSON.stringify(it.map((x) => x.state)));
  assert.equal(X.maxAlive, 1, 'never two video engines at once');
  assert.equal(X.creates, n, 'one fresh engine per clip'); assert.equal(X.terminates, n, 'every engine is thrown away (its memory returned)');
  assert.equal(X.encodes, n);
  assert.ok(X.mounts.length === n && X.mounts.every((m) => m.names[0] === 'input_media'), 'the source is mounted in place every time');
  assert.ok(Math.max(...X.writes.map((w) => w.bytes)) < 1024 * 1024, 'nothing the size of the video was ever copied into the engine: biggest write ' + Math.max(...X.writes.map((w) => w.bytes)) + ' bytes');
  assert.ok(X.deletes.filter((d) => d === 'clip_out.mp4').length === n, 'each clip file is deleted from the engine after it is read');
  assert.equal(existsSync(join(wd, 'clip_out.mp4')), false, 'no output left behind');
  const order = X.execs.filter((e) => e.enc).map((e) => Number(e.args[e.args.indexOf('-ss') + 1]));
  assert.equal(order.length, n);
  // every finished clip is still intact after the later clips were exported (no buffer was reused or released)
  const urls = await page.evaluate(() => window.__highlightsTest.exp.urls);
  assert.equal(urls.length, n, 'exactly one file URL per finished clip');
  for (const x of it) { const b = await blobBytes(page, x.url); assert.equal(b.length, x.size); assert.equal(b.subarray(4, 8).toString(), 'ftyp'); }
  // the clips do not overlap each other (they are the analysis' non-overlapping clips)
  const wins = it.map((x) => x.win).sort((a, b) => a.absStart - b.absStart);
  for (let i = 1; i < wins.length; i++) assert.ok(wins[i].absStart >= wins[i - 1].absEnd - 1e-9, 'clips do not overlap');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('cancel in the middle: finished clips are kept, the running clip is dropped, nothing offered for it, and a retry exports only what is missing', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await newPage(ctx);
  await analyse(page);
  await page.click('#btnSelNone'); await page.check('#pick_0'); await page.check('#pick_1');
  await resetCounters(page);
  await page.evaluate(() => { window.__X.cfg.delayEncode = { 2: 60000 }; });          // the 2nd clip's encode takes "forever"
  await page.click('#btnExport');
  await page.waitForFunction(() => { const r = window.__highlightsTest.run, e = r.exp; return e.items[r.all[0].id].state === 'done' && e.items[r.all[1].id].state === 'working' && window.__X.encodes === 2; }, null, { timeout: 120000 });
  assert.equal(await page.isVisible('#btnExportCancel'), true);
  await page.click('#btnExportCancel');
  await waitFinished(page, 2);
  const it = await items(page);
  assert.deepEqual(it.slice(0, 2).map((x) => x.state), ['done', 'cancelled']);
  const X = await page.evaluate(() => window.__X);
  assert.equal(X.alive, 0, 'no engine is left running after a cancel');
  assert.equal(await page.locator('[data-dl="0"]').count(), 1, 'the finished clip keeps its download');
  assert.equal(await page.locator('[data-dl="1"]').count(), 0, 'no download link for a cancelled clip');
  assert.equal(it[1].url, undefined);
  assert.equal((await page.evaluate(() => window.__highlightsTest.exp.urls)).length, 1, 'only the finished clip has a file');
  assert.match(await page.textContent('#x_1'), /Cancelled/);
  assert.match(await page.textContent('#exportNote'), /1 of 2 clip\(s\) exported.*1 cancelled/);
  const report = await page.inputValue('#report'); assert.match(report, /EXPORT CLIP #1 DONE/); assert.match(report, /EXPORT CLIP #2 CANCELLED/);
  // recovery: retry exports only the missing clip (the finished one is not redone)
  await page.evaluate(() => { window.__X.cfg.delayEncode = {}; });
  assert.match(await page.textContent('#btnExport'), /\(1\)/, 'only the one still missing is counted');
  await resetCounters(page);
  await page.click('#btnExport'); await waitFinished(page, 1);
  const again = await items(page);
  assert.deepEqual(again.slice(0, 2).map((x) => x.state), ['done', 'done']);
  assert.equal((await page.evaluate(() => window.__X.encodes)), 1, 'one encode only');
  assert.equal(again[0].url, it[0].url, 'the first clip was kept, not redone');
  const b = await blobBytes(page, again[1].url); assert.equal(b.subarray(4, 8).toString(), 'ftyp');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a clip that fails is reported honestly with nothing offered; the others still export; retry fixes it', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await newPage(ctx);
  await analyse(page);
  await page.click('#btnSelAll');
  const n = await page.locator('[data-pick]').count();
  await resetCounters(page);
  await page.evaluate(() => { window.__X.cfg.failEncode = { 2: true }; });
  await page.click('#btnExport'); await waitFinished(page, n);
  const it = await items(page);
  assert.equal(it[1].state, 'failed'); assert.match(it[1].error, /FFmpeg could not make this clip.*code 1/s);
  assert.equal(it[0].state, 'done'); assert.ok(it.slice(2).every((x) => x.state === 'done'), 'the clips after the failed one were still exported');
  assert.equal(await page.locator('[data-dl="1"]').count(), 0, 'no link for a clip that was not produced');
  assert.match(await page.textContent('#x_1'), /Not exported/);
  assert.match(await page.textContent('#exportNote'), new RegExp((n - 1) + ' of ' + n + ' clip\\(s\\) exported, 1 failed'));
  assert.equal((await page.evaluate(() => window.__X.alive)), 0);
  assert.match(await page.inputValue('#report'), /EXPORT CLIP #2 FAILED · FFmpeg could not make this clip/);
  await page.evaluate(() => { window.__X.cfg.failEncode = {}; });
  await resetCounters(page);
  await page.click('#btnExport'); await waitFinished(page, 1);
  assert.equal((await items(page))[1].state, 'done'); assert.equal(await page.evaluate(() => window.__X.encodes), 1);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('video engine cannot start: the export stops with a clear message instead of failing every clip the same way', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await newPage(ctx);
  await analyse(page);
  await page.click('#btnSelAll');
  const n = await page.locator('[data-pick]').count();
  await page.evaluate(() => { const real = window.__CLIPGEN_TEST__.engine.create; window.__CLIPGEN_TEST__.engine.create = async () => { throw new Error('The video engine could not be started. (simulated)'); }; window.__real = real; });
  await page.click('#btnExport'); await waitFinished(page, n);
  const it = await items(page);
  assert.equal(it[0].state, 'failed'); assert.match(it[0].error, /could not be started/);
  assert.ok(it.slice(1).every((x) => x.state === 'skipped'), JSON.stringify(it.map((x) => x.state)));
  assert.equal(await page.locator('[data-dl]').count(), 0);
  await ctx.close();
});

test('no recognized words: the clip still exports as a valid 9:16 MP4, with NO caption filter and an honest note (nothing invented)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page, errors } = await newPage(ctx, { recognizer: 'empty' });
  await analyse(page, { minLen: 10, maxLen: 40 });
  await page.click('#btnSelNone'); await page.check('#pick_0');
  await resetCounters(page);
  await page.click('#btnExport'); await waitFinished(page, 1);
  const it = await items(page);
  assert.equal(it[0].state, 'done'); assert.equal(it[0].caps.lines, 0);
  assert.match(it[0].warn.join(' '), /No recognized words fall inside this clip/);
  const X = await page.evaluate(() => window.__X);
  const enc = X.execs.find((e) => e.enc).args; assert.ok(!enc[enc.indexOf('-vf') + 1].includes('subtitles'));
  assert.equal(X.writes.some((w) => w.n === '/sub.ass'), false, 'no subtitle file was written');
  assert.match(await page.textContent('#x_0'), /no captions/);
  const f = join(work, 'nocap.mp4'); writeFileSync(f, await blobBytes(page, it[0].url));
  const v = ffprobe(f).streams.find((s) => s.codec_type === 'video'); assert.deepEqual([v.width, v.height, v.codec_name], [720, 1280, 'h264']);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Share / Save: the button appears only when the browser can share files, and shares the real exported file (stubbed share API)', async () => {
  const noShare = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const a = await newPage(noShare);
  await a.page.evaluate(() => { try { delete navigator.share; delete navigator.canShare; Object.defineProperty(navigator, 'canShare', { value: undefined, configurable: true }); Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch (_) { /* ignore */ } });
  await analyse(a.page);
  await a.page.click('#btnSelNone'); await a.page.check('#pick_0'); await a.page.click('#btnExport'); await waitFinished(a.page, 1);
  assert.equal(await a.page.locator('[data-share]').count(), 0, 'no Share button without support; the Download link is still there');
  assert.equal(await a.page.locator('[data-dl="0"]').count(), 1);
  await noShare.close();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await newPage(ctx, { share: true });
  await analyse(page);
  await page.click('#btnSelNone'); await page.check('#pick_0'); await page.click('#btnExport'); await waitFinished(page, 1);
  const it = await items(page);
  assert.equal(await page.locator('[data-share="0"]').count(), 1);
  await page.click('[data-share="0"]');
  const shared = await page.evaluate(() => window.__shared);
  assert.deepEqual(shared, { name: it[0].name, size: it[0].size, type: 'video/mp4' });
  assert.match(await page.textContent('[data-shareNote="0"]'), /share sheet was opened/i);
  await ctx.close();
});

test('a run that died during export is explained on the next load (which clip, what to do)', async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await newPage(ctx);
  await page.evaluate(() => localStorage.setItem('clipgen-highlights-run', JSON.stringify({ step: 'export', exp: { k: 1, n: 3 }, file: { name: 'IMG_4714.mov', size: 1 }, model: 'base.en', start: 0, len: 46, t: Date.now(), hiddenCount: 0 })));
  await page.reload();
  const t = await page.textContent('#crashBanner');
  console.log('RECOVERY TEXT:', t.replace(/\s+/g, ' '));
  assert.match(t, /Export clips/); assert.match(t, /clip 2 of 3/); assert.match(t, /Find highlights/); assert.match(t, /already downloaded/);
  await ctx.close();
});

test.after(async () => { await browser.close(); server.close(); });
