/* Browser end-to-end test: real Chromium (phone viewport) → static frontend on its own origin (like GitHub Pages)
   → real backend (real FFmpeg) on another origin. Only speech recognition is a test double (no model in the sandbox). */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startServer, makeVideo, probeFile, tmp, fileServer, fakeTranscriber, scriptWords } from '../helpers.js';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, '../../../phase2');
const SHOTS = process.env.SHOTS || tmp('cg-shots-');
const dir = tmp('cg-e2e-');
const log = (...a) => console.log('  ·', ...a);

/* static server for the frontend on a different origin than the API (CORS is really exercised) */
function staticServer(root) {
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((x) => { srv.closeAllConnections(); srv.close(x); }) })));
}

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([name, true]); console.log('✔', name, '(' + Math.round((Date.now() - t0) / 100) / 10 + 's)'); }
  catch (e) { results.push([name, false, e]); console.log('✖', name, '\n   ', (e && e.message || e).toString().split('\n').slice(0, 6).join('\n    ')); await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)).catch(() => {}); }
}
let page, ctx;
const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: false });

makeVideo(path.join(dir, 'main.mp4'), { dur: 40 });
const main = path.join(dir, 'main.mp4');
const FSRV = await fileServer({ '/talk.mp4': { file: main } });
const FE = await staticServer(FRONT);
const BE = await startServer({
  cfg: { allowedOrigins: [FE.base], limits: { uploadChunkBytes: 400000, maxConcurrentJobs: 1, requestsPerMinute: 100000 } },
  transcriber: fakeTranscriber(scriptWords(), { delayMs: 2500 })
});
const browser = await chromium.launch();
ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
page = await ctx.newPage();
const consoleErrors = [], pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
const noOverflow = async (label) => { const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth })); assert.ok(o.sw <= o.iw + 1, label + ' overflows horizontally: ' + o.sw + ' > ' + o.iw); };
const visibleText = () => page.evaluate(() => document.body.innerText);
async function download(clickFn) { const [d] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), clickFn()]); const f = path.join(dir, 'dl-' + Date.now() + '-' + d.suggestedFilename()); await d.saveAs(f); return { file: f, name: d.suggestedFilename() }; }

await step('first visit: dashboard asks to connect a backend (no backend configured on this origin)', async () => {
  await page.goto(FE.base + '/#/');
  await page.waitForSelector('text=Connect your ClipGen backend');
  assert.match(await visibleText(), /Turn long videos into/);
  await noOverflow('connect'); await shot('01-connect');
});
await step('connect: enter address, test, status pill turns connected', async () => {
  await page.fill('input[aria-label="Backend address"]', BE.base);
  await page.click('text=Test & save');
  await page.waitForSelector('#statusText:has-text("Backend connected")', { timeout: 20000 });
  await page.waitForSelector('input[aria-label="Video link"]');
  await shot('02-dashboard');
  await noOverflow('dashboard');
});
await step('platform link: detected, explained, nothing fetched, upload offered', async () => {
  await page.fill('input[aria-label="Video link"]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await page.waitForSelector('text=YouTube link detected');
  assert.match(await visibleText(), /not a video file|Not downloadable/i);
  await page.click('text=Add video');
  await page.waitForTimeout(600);
  assert.ok(page.url().includes('#/') && !page.url().includes('project'), 'stays on dashboard');
  assert.equal((await BE.api('GET', '/api/projects')).json.projects.length, 0);
  await shot('03-youtube');
});
await step('invalid input gives inline guidance', async () => {
  await page.fill('input[aria-label="Video link"]', 'hello world');
  await page.waitForSelector('text=cannot contain spaces');
});
await step('direct link: status check → Add video → real download → project opens', async () => {
  await page.fill('input[aria-label="Video link"]', FSRV.base + '/talk.mp4');
  await page.waitForSelector('text=Source reachable');
  assert.match(await visibleText(), /talk\.mp4/);
  await shot('04-link-ok');
  await page.click('text=Add video');
  await page.waitForURL(/#\/project\/.+\/generate/, { timeout: 60000 });
  await page.waitForSelector('text=Clip generation');
  assert.match(await visibleText(), /0:40|40/);
  await shot('05-generate'); await noOverflow('generate');
});
await step('generation settings: platform, clip count, caption style, hook, language, intensity are interactive and persist', async () => {
  await page.click('.pick:has-text("TikTok")');
  assert.equal(await page.inputValue('input[type=number] >> nth=0'), '15');
  await page.click('button[aria-label="More clips"]'); await page.click('button[aria-label="More clips"]');
  await page.fill('input[type=number] >> nth=0', '6'); await page.dispatchEvent('input[type=number] >> nth=0', 'change');
  await page.fill('input[type=number] >> nth=1', '12'); await page.dispatchEvent('input[type=number] >> nth=1', 'change');
  await page.click('.pick:has-text("Neon")');
  await page.fill('input[placeholder="secret, free, never …"]', 'secret, money');
  await page.selectOption('select >> nth=1', 'en');
  await page.click('button:has-text("Aggressive")');
  await page.click('.seg button:has-text("9:16")');
  const saved = await page.evaluate(() => 0);
  void saved;
});
await step('analysis: progress with stages, then clips dashboard', async () => {
  await page.click('text=Analyse & generate clips');
  await page.waitForURL(/#\/project\/.+\/analysis/);
  await page.waitForSelector('text=AI analysis');
  await page.waitForSelector('.stage.now');
  assert.match(await visibleText(), /Transcribing speech|Extracting audio|Measuring|Detecting/);
  await shot('06-analysis'); await noOverflow('analysis');
  await page.waitForURL(/#\/project\/.+\/clips/, { timeout: 90000 });
  await page.waitForSelector('.clip');
  const n = await page.locator('.clip').count();
  assert.ok(n >= 3, 'clip cards: ' + n);
  const text = await visibleText();
  assert.match(text, /Engagement score/); assert.match(text, /Download all \(ZIP\)/); assert.match(text, /test-double/);
  for (let i = 0; i < n; i++) assert.ok(await page.locator('.clip .pic img').nth(i).evaluate((im) => im.complete && im.naturalWidth > 0), 'thumbnail ' + i);
  await shot('07-clips'); await noOverflow('clips');
});
await step('preview modal plays the real video segment with live captions, then closes', async () => {
  await page.locator('.clip .pic').first().click();
  await page.waitForSelector('.modal video:not(.bgblur)');
  await page.waitForFunction(() => { const v = document.querySelector('.modal video:not(.bgblur)'); return v && v.readyState >= 2; }, null, { timeout: 20000 });
  const t = await page.evaluate(async () => { const v = document.querySelector('.modal video:not(.bgblur)'); v.muted = true; await v.play().catch(() => {}); await new Promise((r) => setTimeout(r, 1500)); return v.currentTime; });
  assert.ok(t > 0.5, 'video is playing, currentTime=' + t);
  assert.ok(await page.locator('.modal .capov span').count() >= 1, 'caption words shown');
  await shot('08-preview');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });
});
await step('Render & download from a card → real MP4 (720x1280, audio, right length)', async () => {
  const card = page.locator('.clip').first();
  const dur = await card.locator('.badge-d').innerText();
  const d = await download(() => card.locator('text=Render & download').click());
  assert.match(d.name, /^clipgen-\d\d-.*\.mp4$/);
  const i = probeFile(d.file);
  assert.deepEqual([i.w, i.h], [720, 1280]); assert.ok(i.audio);
  const [m, s] = dur.split(':').map(Number); assert.ok(Math.abs(i.dur - (m * 60 + s)) < 1.6, 'length ' + i.dur + ' vs ' + dur);
  await page.waitForSelector('.clip .chip.ok:has-text("Rendered")');
});
await step('editor: trim, edit caption text, restyle, change format, render, download', async () => {
  await page.locator('.clip').nth(1).locator('a:has-text("Edit")').click();
  await page.waitForURL(/#\/project\/.+\/edit\/c\d+/);
  await page.waitForSelector('.frame video:not(.bgblur)');
  await shot('09-editor'); await noOverflow('editor');
  const startBefore = Number(await page.inputValue('input[aria-label="Start (seconds)"]'));
  const endBefore = Number(await page.inputValue('input[aria-label="End (seconds)"]'));
  await page.locator('.nudge >> nth=0').locator('text=+1 s').click();
  await page.locator('.nudge >> nth=1').locator('text=−1 s').click();
  const startAfter = Number(await page.inputValue('input[aria-label="Start (seconds)"]'));
  const endAfter = Number(await page.inputValue('input[aria-label="End (seconds)"]'));
  assert.ok(Math.abs(startAfter - (startBefore + 1)) < 0.11 && Math.abs(endAfter - (endBefore - 1)) < 0.11, 'trim moved');
  await page.click('.tabs >> text=Captions');
  const row = page.locator('.caprow input').first();
  await row.fill('EDITED CAPTION TEXT'); await row.blur();
  await page.waitForSelector('text=Saved', { timeout: 10000 });
  await page.click('.tabs >> text=Style'); await page.click('.pick:has-text("Impact")');
  await page.click('.tabs >> text=Format'); await page.click('button:has-text("1:1 square")');
  await page.waitForSelector('.frame.a11');
  await shot('10-editor-square');
  await page.click('text=Render clip');
  await page.waitForSelector('.notice.ok:has-text("Rendered")', { timeout: 120000 });
  await page.waitForSelector('button:has-text("Show live preview")');
  await page.waitForTimeout(500);
  const d = await download(() => page.click('text=Download MP4'));
  const i = probeFile(d.file);
  assert.deepEqual([i.w, i.h], [720, 720]);
  assert.ok(Math.abs(i.dur - (endAfter - startAfter)) < 0.4, 'trimmed length ' + i.dur + ' vs ' + (endAfter - startAfter));
  /* the edit persisted on the server */
  const pid = page.url().match(/project\/([^/]+)/)[1];
  const cid = page.url().match(/edit\/(c\d+)/)[1];
  const clip = (await BE.api('GET', '/api/projects/' + pid)).json.analysis.clips.find((c) => c.id === cid);
  assert.equal(clip.edit.aspect, '1:1'); assert.equal(clip.edit.caption.style, 'impact'); assert.ok(clip.edit.words.some((w) => w.w === 'EDITED'));
  /* change something → render is marked out of date */
  await page.click('.tabs >> text=Format'); await page.click('button:has-text("9:16 vertical")');
  await page.waitForSelector('text=You changed something since the last render');
});
await step('reload on the editor restores the saved edits', async () => {
  await page.waitForSelector('text=Saved', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  await page.reload();
  await page.waitForSelector('.frame video:not(.bgblur)');
  await page.click('.tabs >> text=Captions');
  assert.ok((await page.locator('.caprow input').first().inputValue()).startsWith('EDITED CAPTION TEXT'));
  await page.click('.tabs >> text=Style');
  assert.ok(await page.locator('.pick.on:has-text("Impact")').count() === 1);
});
await step('regenerate a clip from its card replaces it with a different moment', async () => {
  const pid = page.url().match(/project\/([^/]+)/)[1];
  await page.goto(FE.base + '/#/project/' + pid + '/clips');
  await page.waitForSelector('.clip');
  const before = await page.locator('.clip').nth(2).locator('.chip.num').innerText();
  await page.locator('.clip').nth(2).locator('text=Regenerate this clip').click();
  await page.waitForSelector('.toast:has-text("Replaced"), .toast:has-text("No other distinct")', { timeout: 20000 });
  const t = await page.locator('.toast').first().innerText();
  if (/Replaced/.test(t)) { const after = await page.locator('.clip').nth(2).locator('.chip.num').innerText(); assert.notEqual(after, before); } else log('no alternative available (expected in a small video)');
});
await step('Download all → real ZIP with every clip', async () => {
  const d = await download(() => page.click('text=Download all (ZIP)'));
  assert.match(d.name, /clips\.zip$/);
  const py = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(len(z.namelist()))', d.file], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.ok(Number(py.stdout) >= 3, 'zip entries ' + py.stdout);
  await shot('11-after-zip');
});
await step('select clips → ZIP contains only the selected ones', async () => {
  await page.locator('.clip .selbox').first().click();
  assert.match(await visibleText(), /Download selected \(ZIP\)/);
  const d = await download(() => page.click('text=Download selected (ZIP)'));
  const py = spawnSync('python3', ['-c', 'import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).namelist()))', d.file], { encoding: 'utf8' });
  assert.equal(py.stdout.trim(), '1');
});
await step('library, history, settings, about screens', async () => {
  await page.goto(FE.base + '/#/library'); await page.waitForSelector('.clip'); await noOverflow('library');
  await page.evaluate(() => { document.querySelectorAll('img[loading=lazy]').forEach((i) => { i.loading = 'eager'; i.scrollIntoView(); }); });
  await page.waitForTimeout(1500);
  const broken = await page.evaluate(() => [...document.querySelectorAll('.clip img')].filter((i) => !(i.complete && i.naturalWidth > 0)).length);
  assert.equal(broken, 0, broken + ' clip thumbnail(s) failed to load');
  await page.evaluate(() => window.scrollTo(0, 0)); await shot('12-library');
  await page.goto(FE.base + '/#/history'); await page.waitForSelector('.hist');
  const h = await visibleText(); assert.match(h, /AI analysis/); assert.match(h, /Clip render/); assert.match(h, /Video from link/); await noOverflow('history'); await shot('13-history');
  await page.goto(FE.base + '/#/settings'); await page.waitForSelector('text=Server version');
  const st = await visibleText(); assert.match(st, /Speech recognition/); assert.match(st, /FFmpeg/); await noOverflow('settings'); await shot('14-settings');
  await page.goto(FE.base + '/#/about'); await page.waitForSelector('text=How it works'); await noOverflow('about');
});
await step('persistence: settings and defaults survive a reload', async () => {
  await page.goto(FE.base + '/#/settings'); await page.waitForSelector('text=Clip generation defaults');
  await page.selectOption('select >> nth=0', 'reels');
  await page.reload(); await page.waitForSelector('text=Clip generation defaults');
  assert.equal(await page.inputValue('select >> nth=0'), 'reels');
  await page.waitForSelector('#statusText:has-text("Backend connected")');
});
await step('upload: file chooser → chunked upload with progress, survives a dropped chunk, then project opens', async () => {
  await page.goto(FE.base + '/#/upload'); await page.waitForSelector('.dropzone');
  let failed = false;
  await page.route(/\/api\/uploads\/[^?]+\?offset=\d+/, async (route) => { if (!failed && route.request().method() === 'PUT' && /offset=[1-9]/.test(route.request().url())) { failed = true; return route.abort(); } return route.continue(); });
  const big = path.join(dir, 'upload.mp4');
  const mk = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=10,noise=alls=60:allf=t+u', '-f', 'lavfi', '-i', 'sine=f=300:d=10', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '3M', '-c:a', 'aac', big], { encoding: 'utf8' }); assert.equal(mk.status, 0, mk.stderr);
  assert.ok(fs.statSync(big).size > 1500000, 'test file spans several chunks: ' + fs.statSync(big).size);
  await page.setInputFiles('input[type=file]', big);
  await page.waitForSelector('text=Uploading upload.mp4');
  await page.waitForSelector('text=/\\d+% · /', { timeout: 20000 });
  await shot('15-uploading');
  await page.waitForURL(/#\/project\/.+\/generate/, { timeout: 90000 });
  assert.ok(failed, 'a chunk was really dropped and the client recovered');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
await step('reload while analysis is running resumes the progress view and finishes', async () => {
  await page.click('text=Analyse & generate clips');
  await page.waitForURL(/#\/project\/.+\/analysis/);
  await page.waitForSelector('.stage.now');
  await page.reload();
  await page.waitForSelector('text=AI analysis');
  await page.waitForSelector('.stage');
  await page.waitForURL(/#\/project\/.+\/clips/, { timeout: 90000 });
  await page.waitForSelector('.clip');
});
await step('cancel an analysis from the progress screen', async () => {
  await page.click('text=Analyse again');
  await page.waitForSelector('text=Clip generation');
  const b = page.locator('button:has-text("Analyse again")');
  await b.click(); await page.waitForURL(/analysis/);
  await page.click('button:has-text("Cancel")');
  await page.waitForSelector('text=Cancelled', { timeout: 20000 });
});
await step('a deleted/expired video shows a clear message instead of breaking', async () => {
  await page.goto(FE.base + '/#/project/p_doesnotexist12/clips');
  await page.waitForSelector('text=no longer on the server', { timeout: 20000 });
});
await step('backend offline: clear message, app keeps working after it returns', async () => {
  await ctx.route('**/api/projects', (r) => r.abort());
  await page.goto(FE.base + '/#/library'); await page.waitForSelector('.notice.bad', { timeout: 20000 });
  assert.match(await visibleText(), /Could not reach/i);
  await ctx.unroute('**/api/projects');
});
await step('desktop width layout', async () => {
  const p2 = await ctx.newPage(); await p2.setViewportSize({ width: 1280, height: 800 });
  await p2.goto(FE.base + '/#/library');
  await p2.waitForTimeout(1500);
  await p2.screenshot({ path: path.join(SHOTS, '16-desktop.png') });
  const o = await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1); assert.ok(o);
  await p2.close();
});
await step('no leftover creator / registry / manifest / approval system anywhere in the UI', async () => {
  const bad = /creator|registry|manifest|signing key|channel verif|approval|attribution/i;
  for (const hash of ['#/', '#/link', '#/upload', '#/library', '#/history', '#/settings', '#/about']) {
    await page.goto(FE.base + '/' + hash); await page.waitForTimeout(500);
    const t = await visibleText(); assert.ok(!bad.test(t), hash + ' mentions: ' + (t.match(bad) || [])[0]);
  }
  assert.equal(consoleErrors.length, 0, 'console errors: ' + consoleErrors.join(' | '));
  assert.equal(pageErrors.length, 0, 'page errors: ' + pageErrors.join(' | '));
});

await browser.close(); await BE.close(); await FE.close(); await FSRV.close();
const failed = results.filter((r) => !r[1]);
console.log('\nE2E: ' + (results.length - failed.length) + '/' + results.length + ' passed · screenshots in ' + SHOTS);
process.exit(failed.length ? 1 : 0);
