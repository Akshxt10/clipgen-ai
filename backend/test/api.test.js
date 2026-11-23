import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, makeVideo, probeFile, frameAt, tmp, fileServer, fakeTranscriber, scriptWords } from './helpers.js';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const dir = tmp('cg-assets-');
const V = (n) => path.join(dir, n);
let S, FS, pid, clips;                      // main server, file server, main project id
const CHUNK = 300000;

async function upload(srv, file, { name, chunk = CHUNK } = {}) {
  const buf = fs.readFileSync(file);
  name = name || path.basename(file);
  const c = await srv.api('POST', '/api/uploads', { name, size: buf.length });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  let off = 0;
  while (off < buf.length) {
    const end = Math.min(buf.length, off + chunk);
    const r = await fetch(srv.base + '/api/uploads/' + c.json.uploadId + '?offset=' + off, { method: 'PUT', headers: srv.headers, body: buf.subarray(off, end) });
    assert.equal(r.status, 200, await r.text());
    off = end;
  }
  const done = await srv.api('POST', '/api/uploads/' + c.json.uploadId + '/complete', {});
  assert.equal(done.status, 202, JSON.stringify(done.json));
  const job = await srv.waitJob(done.json.job.id);
  return { project: done.json.project, job };
}
const pickClip = (c) => c.find((x) => x.duration >= 5) || c[0];

before(async () => {
  makeVideo(V('main.mp4'), { dur: 40 });
  makeVideo(V('noaudio.mp4'), { dur: 10, audio: false });
  makeVideo(V('tiny.mp4'), { w: 320, h: 180, dur: 6 });
  S = await startServer({ cfg: { limits: { uploadChunkBytes: CHUNK, maxConcurrentJobs: 1, requestsPerMinute: 100000 } } });
  FS = await fileServer({
    '/main.mp4': { file: V('main.mp4') }, '/page': (req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>hi</html>'); },
    '/fake.mp4': (req, res) => { res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end('this is not a video at all'.repeat(100)); },
    '/denied.mp4': (req, res) => { res.writeHead(403); res.end('no'); }, '/redir.mp4': (req, res) => { res.writeHead(302, { Location: '/main.mp4' }); res.end(); }
  });
});
after(async () => { await S.close(); await FS.close(); });

test('health + capabilities describe the real server', async () => {
  const h = await S.api('GET', '/api/health');
  assert.equal(h.json.ok, true); assert.equal(h.json.ffmpeg, true);
  const c = await S.api('GET', '/api/capabilities');
  assert.equal(c.status, 200);
  assert.equal(c.json.ffmpeg.ok, true); assert.equal(c.json.transcription.available, true);
  assert.ok(c.json.limits.maxSourceMB > 0 && c.json.fonts.length >= 1 && Object.keys(c.json.captionStyles).length === 6);
  assert.deepEqual(c.json.aspects, ['9:16', '16:9', '1:1']);
});

test('platform links are refused with an explanation and an upload alternative; nothing is created', async () => {
  for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.tiktok.com/@x/video/1']) {
    const r = await S.api('POST', '/api/projects/url', { url });
    assert.equal(r.status, 422); assert.equal(r.json.error.code, 'unsupported-source'); assert.match(r.json.error.message, /upload/i);
  }
  assert.equal((await S.api('GET', '/api/projects')).json.projects.length, 0);
  const bad = await S.api('POST', '/api/projects/url', { url: 'not a url' });
  assert.equal(bad.status, 400);
});

test('link inspection: status of direct links', async () => {
  let r = await S.api('POST', '/api/sources/inspect', { url: FS.base + '/main.mp4' });
  assert.equal(r.json.status, 'reachable'); assert.equal(r.json.supported, true); assert.equal(r.json.type, 'video/mp4'); assert.ok(r.json.bytes > 1000); assert.equal(r.json.name, 'main.mp4');
  r = await S.api('POST', '/api/sources/inspect', { url: FS.base + '/page' }); assert.equal(r.json.status, 'not-media'); assert.equal(r.json.supported, false);
  r = await S.api('POST', '/api/sources/inspect', { url: FS.base + '/nope.mp4' }); assert.equal(r.json.status, 'not-found');
  r = await S.api('POST', '/api/sources/inspect', { url: FS.base + '/denied.mp4' }); assert.equal(r.json.status, 'forbidden'); assert.match(r.json.message, /does not bypass/i);
  r = await S.api('POST', '/api/sources/inspect', { url: 'https://www.youtube.com/watch?v=x' }); assert.equal(r.json.kind, 'platform'); assert.equal(r.json.supported, false);
});

test('ingest from a direct link: real download, real probe, poster', async () => {
  const r = await S.api('POST', '/api/projects/url', { url: FS.base + '/main.mp4' });
  assert.equal(r.status, 202);
  const job = await S.waitJob(r.json.job.id);
  assert.equal(job.state, 'done', JSON.stringify(job));
  const p = (await S.api('GET', '/api/projects/' + r.json.project.id)).json.project;
  assert.equal(p.status, 'ready'); assert.equal(p.media.width, 1280); assert.equal(p.media.height, 720); assert.ok(Math.abs(p.media.duration - 40) < 0.6); assert.equal(p.media.hasAudio, true);
  assert.equal(p.source.kind, 'url'); assert.ok(p.urls.source && p.urls.poster);
  const poster = await fetch(S.base + p.urls.poster); assert.equal(poster.status, 200); assert.equal(poster.headers.get('content-type'), 'image/jpeg');
  assert.equal(fs.statSync(path.join(S.config.dataDir, 'projects', p.id, 'source.mp4')).size, fs.statSync(V('main.mp4')).size, 'downloaded bytes identical');
  pid = p.id;
});

test('ingest failures: redirect works; HTML, fake video, 403 give useful errors and leave nothing behind', async () => {
  const redir = await S.api('POST', '/api/projects/url', { url: FS.base + '/redir.mp4' });
  const rj = await S.waitJob(redir.json.job.id); assert.equal(rj.state, 'done');
  await S.api('DELETE', '/api/projects/' + redir.json.project.id);
  for (const [p, code, re] of [['/page', 'not-media', /web page/i], ['/fake.mp4', 'not-a-video', /could not be read/i], ['/denied.mp4', 'forbidden', /bypass/i]]) {
    const r = await S.api('POST', '/api/projects/url', { url: FS.base + p });
    const j = await S.waitJob(r.json.job.id);
    assert.equal(j.state, 'error', p); assert.equal(j.error.code, code, p); assert.match(j.error.message, re);
    assert.equal((await S.api('GET', '/api/projects/' + r.json.project.id)).status, 404, 'failed project removed: ' + p);
  }
});

test('SSRF: a server without test mode refuses private targets', async () => {
  const strict = await startServer({ cfg: { allowPrivateUrls: false } });
  try {
    for (const url of ['http://127.0.0.1:8787/x.mp4', 'http://localhost/x.mp4', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x.mp4', 'http://10.0.0.5/x.mp4']) {
      const r = await strict.api('POST', '/api/projects/url', { url });
      assert.equal(r.status, 400, url);
      const i = await strict.api('POST', '/api/sources/inspect', { url });
      assert.ok(i.status === 400 || i.json.supported === false, url);
    }
  } finally { await strict.close(); }
});

test('chunked upload: offset mismatch, resume, completion, format + size checks', async () => {
  const buf = fs.readFileSync(V('tiny.mp4'));
  const c = await S.api('POST', '/api/uploads', { name: 'tiny.mp4', size: buf.length });
  const id = c.json.uploadId;
  let r = await fetch(S.base + '/api/uploads/' + id + '?offset=0', { method: 'PUT', body: buf.subarray(0, 1000) }); assert.equal(r.status, 200);
  r = await fetch(S.base + '/api/uploads/' + id + '?offset=5000', { method: 'PUT', body: buf.subarray(5000, 6000) });
  const bad = await r.json(); assert.equal(r.status, 409); assert.equal(bad.error.code, 'offset-mismatch'); assert.equal(bad.error.received, 1000);
  const state = await S.api('GET', '/api/uploads/' + id); assert.equal(state.json.received, 1000);
  const early = await S.api('POST', '/api/uploads/' + id + '/complete', {}); assert.equal(early.status, 409);
  r = await fetch(S.base + '/api/uploads/' + id + '?offset=1000', { method: 'PUT', body: buf.subarray(1000) }); assert.equal(r.status, 200);
  const done = await S.api('POST', '/api/uploads/' + id + '/complete', {}); assert.equal(done.status, 202);
  const j = await S.waitJob(done.json.job.id); assert.equal(j.state, 'done');
  const p = (await S.api('GET', '/api/projects/' + done.json.project.id)).json.project;
  assert.equal(p.media.width, 320); assert.equal(p.source.kind, 'upload');
  await S.api('DELETE', '/api/projects/' + p.id);
  assert.equal((await S.api('POST', '/api/uploads', { name: 'virus.exe', size: 10 })).status, 415);
  assert.equal((await S.api('POST', '/api/uploads', { name: 'a.mp4', size: 0 })).status, 400);
  const huge = await startServer({ cfg: { limits: { maxSourceBytes: 5000 } } });
  assert.equal((await huge.api('POST', '/api/uploads', { name: 'a.mp4', size: 6000 })).status, 413);
  await huge.close();
});

test('practical formats: MOV, MKV, AVI, WebM, MPEG-TS and a non-video renamed .mp4', async () => {
  const fmts = [['clip.mov', { extra: ['-f', 'mov'] }], ['clip.mkv', {}], ['clip.avi', { vcodec: 'mpeg4' }], ['clip.webm', { vcodec: 'libvpx-vp9', extra: ['-c:a', 'libopus', '-b:v', '300k'] }], ['clip.ts', {}]];
  for (const [n, o] of fmts) {
    try { makeVideo(V(n), { w: 320, h: 180, dur: 4, ...o }); } catch (e) { if (n === 'clip.webm') { makeVideo(V(n), { w: 320, h: 180, dur: 4, vcodec: 'libvpx', extra: ['-c:a', 'libvorbis'] }); } else throw e; }
    const { project, job } = await upload(S, V(n));
    assert.equal(job.state, 'done', n + ': ' + JSON.stringify(job));
    await S.api('DELETE', '/api/projects/' + project.id);
  }
  fs.writeFileSync(V('fake.mp4'), 'hello, I am text'.repeat(500));
  const { project, job } = await upload(S, V('fake.mp4'));
  assert.equal(job.state, 'error'); assert.equal(job.error.code, 'not-a-video');
  assert.equal((await S.api('GET', '/api/projects/' + project.id)).status, 404);
});

test('video without audio is accepted but analysis explains it needs audio', async () => {
  const { project } = await upload(S, V('noaudio.mp4'));
  const a = await S.api('POST', '/api/projects/' + project.id + '/analyze', {});
  const j = await S.waitJob(a.json.job.id);
  assert.equal(j.state, 'error'); assert.equal(j.error.code, 'no-audio');
  await S.api('DELETE', '/api/projects/' + project.id);
});

test('analysis end to end: real audio/scene signals + transcript → ranked, distinct clips with thumbnails', async () => {
  const a = await S.api('POST', '/api/projects/' + pid + '/analyze', { settings: { numClips: 4, minDuration: 5, maxDuration: 12, platform: 'shorts', intensity: 'balanced', keywords: 'secret, free' } });
  assert.equal(a.status, 202);
  const seen = new Set();
  let job;
  for (;;) { const r = await S.api('GET', '/api/jobs/' + a.json.job.id); job = r.json.job; seen.add(job.stage); if (['done', 'error'].includes(job.state)) break; await new Promise((r2) => setTimeout(r2, 40)); }
  assert.equal(job.state, 'done', JSON.stringify(job));
  const g = await S.api('GET', '/api/projects/' + pid);
  const an = g.json.analysis;
  assert.equal(an.mode, 'transcript'); assert.equal(an.engine.transcription.name, 'test-double'); assert.deepEqual(an.settings.keywords, ['secret', 'free']);
  assert.ok(an.clips.length >= 3, 'clips: ' + an.clips.length);
  for (const c of an.clips) {
    assert.ok(c.start >= 0 && c.end <= 40.5 && c.duration >= 4.5 && c.duration <= 12.6, JSON.stringify([c.start, c.end]));
    assert.ok(c.thumbUrl, 'thumbnail'); const t = await fetch(S.base + c.thumbUrl); assert.equal(t.status, 200); assert.ok((await t.arrayBuffer()).byteLength > 1000);
  }
  clips = an.clips;
  const sorted = [...an.clips].sort((x, y) => x.start - y.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].start >= sorted[i - 1].end);
  assert.ok(fs.existsSync(path.join(S.config.dataDir, 'projects', pid, 'transcript.json')) && fs.existsSync(path.join(S.config.dataDir, 'projects', pid, 'signals.json')));
  const w = await S.api('GET', '/api/projects/' + pid + '/words?start=11&end=15');
  assert.ok(w.json.words.length > 5 && w.json.words[0].w === 'Wow,');
});

test('transcription missing or failing is reported honestly and analysis still works from audio', async () => {
  for (const fail of ['unavailable', 'error']) {
    const srv = await startServer({ transcriber: fakeTranscriber(scriptWords(), { fail }) });
    try {
      const { project } = await upload(srv, V('main.mp4'), { chunk: 1 << 22 });
      const a = await srv.api('POST', '/api/projects/' + project.id + '/analyze', { settings: { numClips: 3, minDuration: 5, maxDuration: 12 } });
      const j = await srv.waitJob(a.json.job.id); assert.equal(j.state, 'done', JSON.stringify(j));
      const an = (await srv.api('GET', '/api/projects/' + project.id)).json;
      assert.equal(an.analysis.mode, 'audio-visual'); assert.ok(an.analysis.warnings.some((w) => /Transcription/.test(w) && /captions are unavailable/.test(w)), fail);
      assert.equal(an.project.hasTranscript, false); assert.ok(an.analysis.clips.length >= 1);
      assert.ok(an.analysis.clips.every((c) => c.transcript === ''));
    } finally { await srv.close(); }
  }
});

async function render(clipId, body) {
  const r = await S.api('POST', '/api/projects/' + pid + '/clips/' + clipId + '/render', body || {});
  assert.equal(r.status, 202, JSON.stringify(r.json));
  const j = await S.waitJob(r.json.job.id);
  assert.equal(j.state, 'done', JSON.stringify(j));
  const g = (await S.api('GET', '/api/projects/' + pid)).json.analysis.clips.find((c) => c.id === clipId);
  const file = path.join(S.config.dataDir, 'projects', pid, 'renders', g.render.file);
  const keep = V('keep-' + Math.random().toString(36).slice(2) + '.mp4'); fs.copyFileSync(file, keep);   // renders of one clip replace each other on the server
  return { clip: g, file: keep, serverFile: file, job: j };
}
function whiteCentroid(f, t) {
  const fr = frameAt(f, t, { w: 180, h: 320 });
  let sum = 0, wx = 0;
  for (let i = 0; i < fr.w * fr.h; i++) { const r = fr.data[i * 3], g = fr.data[i * 3 + 1], b = fr.data[i * 3 + 2]; if (r > 235 && g > 235 && b > 235) { sum++; wx += i % fr.w; } }
  return { n: sum, x: sum ? wx / sum / fr.w : null };
}

test('render 9:16: real cut from the source, exact length, original audio, vertical size, burned captions', async () => {
  const c = pickClip(clips);
  const r = await render(c.id, { aspect: '9:16', reframe: 'smart', captions: true, caption: { style: 'pop' } });
  const info = probeFile(r.file);
  assert.equal(info.w, 720); assert.equal(info.h, 1280); assert.equal(info.vcodec, 'h264'); assert.equal(info.acodec, 'aac'); assert.equal(info.audio, true);
  assert.ok(Math.abs(info.dur - r.clip.duration) < 0.25, info.dur + ' vs ' + r.clip.duration);
  assert.equal(r.clip.render.captions, true);
  /* the clip really comes from that part of the video: the audio is loud only when the source burst is */
  const loud = spawnSync('ffmpeg', ['-v', 'info', '-i', r.file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  assert.match(loud, /mean_volume: -\d+/);
  /* captions are really drawn: same clip without captions differs in the lower area */
  const plain = await render(c.id, { captions: false });
  const a = frameAt(r.file, 2.5), b = frameAt(plain.file, 2.5);
  let diff = 0; const y0 = Math.floor(a.h * 0.6) * a.w * 3;
  for (let i = y0; i < a.data.length; i += 3) if (Math.abs(a.data[i] - b.data[i]) > 60 || Math.abs(a.data[i + 1] - b.data[i + 1]) > 60) diff++;
  assert.ok(diff > 300, 'caption pixels: ' + diff);
  /* identical request is served from cache */
  const again = await render(c.id, { aspect: '9:16', reframe: 'smart', captions: true, caption: { style: 'pop' } });
  assert.equal(again.clip.render.file, r.clip.render.file);
});

test('smart reframing follows the moving subject; centre crop does not', async () => {
  const c = pickClip(clips);
  const dur = c.duration;
  const smart = await render(c.id, { reframe: 'smart', captions: false });
  const centre = await render(c.id, { reframe: 'center', captions: false });
  const s0 = whiteCentroid(smart.file, 0.6), s1 = whiteCentroid(smart.file, dur - 0.8);
  const c0 = whiteCentroid(centre.file, 0.6), c1 = whiteCentroid(centre.file, dur - 0.8);
  assert.ok(s0.n > 50 && s1.n > 50, 'subject stays visible when smart: ' + s0.n + ',' + s1.n);
  assert.ok(Math.abs(s1.x - s0.x) < 0.35, 'smart keeps subject steady in frame: ' + s0.x + ' → ' + s1.x);
  const centreShift = c0.n && c1.n ? Math.abs(c1.x - c0.x) : 1;
  assert.ok(centreShift > Math.abs(s1.x - s0.x), 'centre crop lets it drift more: ' + centreShift + ' vs ' + Math.abs(s1.x - s0.x));
});

test('other formats: 16:9, 1:1, blur fill, 1080p', async () => {
  const c = pickClip(clips);
  for (const [o, w, h] of [[{ aspect: '16:9' }, 1280, 720], [{ aspect: '1:1' }, 720, 720], [{ aspect: '9:16', reframe: 'blur' }, 720, 1280], [{ aspect: '9:16', quality: '1080', reframe: 'center' }, 1080, 1920]]) {
    const r = await render(c.id, Object.assign({ captions: true }, o));
    const i = probeFile(r.file);
    assert.deepEqual([i.w, i.h], [w, h], JSON.stringify(o)); assert.ok(i.audio);
    assert.ok(Math.abs(i.dur - c.duration) < 0.3);
  }
  /* blur fill: no black bars → top rows are not black */
  const r = await render(c.id, { aspect: '9:16', reframe: 'blur', captions: false });
  const fr = frameAt(r.file, 1, { w: 90, h: 160 }); let lum = 0; for (let i = 0; i < 90 * 20; i++) lum += fr.data[i * 3 + 2]; assert.ok(lum / (90 * 20) > 12, 'top of blur-fill frame is filled: ' + lum / (90 * 20));
});

test('editing: trim, caption text, style → saved, stale detection, new render has the new length', async () => {
  const c = pickClip(clips);
  const start = c.start + 1, end = c.end - 1;
  const p = await S.api('PATCH', '/api/projects/' + pid + '/clips/' + c.id, { start, end, caption: { style: 'karaoke', color: '#00FF00' }, title: 'My edited title' });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  assert.equal(p.json.clip.title, 'My edited title'); assert.equal(p.json.clip.start, start); assert.equal(p.json.clip.edit.caption.style, 'karaoke'); assert.equal(p.json.clip.auto.start, c.start);
  const words = (await S.api('GET', '/api/projects/' + pid + '/words?start=' + start + '&end=' + end)).json.words.map((w, i) => (i === 2 ? { ...w, w: 'EDITED' } : w));
  const r = await render(c.id, { words });
  assert.ok(Math.abs(probeFile(r.file).dur - (end - start)) < 0.3);
  const fresh = (await S.api('GET', '/api/projects/' + pid)).json.analysis.clips.find((x) => x.id === c.id);
  assert.equal(fresh.renderCurrent, true); assert.equal(fresh.edit.words[2].w, 'EDITED');
  await S.api('PATCH', '/api/projects/' + pid + '/clips/' + c.id, { aspect: '1:1' });
  const stale = (await S.api('GET', '/api/projects/' + pid)).json.analysis.clips.find((x) => x.id === c.id);
  assert.equal(stale.renderCurrent, false, 'changed options mark the old render stale');
  assert.equal((await S.api('PATCH', '/api/projects/' + pid + '/clips/' + c.id, { start: 5, end: 5.2 })).status, 400);
  assert.equal((await S.api('PATCH', '/api/projects/' + pid + '/clips/c999', { start: 1, end: 5 })).status, 404);
  await S.api('PATCH', '/api/projects/' + pid + '/clips/' + c.id, { aspect: '9:16', start: c.start, end: c.end });
});

test('downloads: signed links, Range, attachment names, tampering, expiry', async () => {
  const c = pickClip(clips);
  const r = await render(c.id, {});
  const clip = r.clip; const url = (await S.api('GET', '/api/projects/' + pid)).json.analysis.clips.find((x) => x.id === c.id);
  const full = await fetch(S.base + url.renderUrl); assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const all = Buffer.from(await full.arrayBuffer()); assert.equal(all.length, fs.statSync(r.serverFile).size);
  const part = await fetch(S.base + url.renderUrl, { headers: { Range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 100-199/' + all.length);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(all.subarray(100, 200)), 'range content correct');
  const suffix = await fetch(S.base + url.renderUrl, { headers: { Range: 'bytes=-50' } }); assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 50);
  assert.equal((await fetch(S.base + url.renderUrl, { headers: { Range: 'bytes=99999999-' } })).status, 416);
  const dl = await fetch(S.base + url.downloadUrl); assert.match(dl.headers.get('content-disposition'), /^attachment; filename="clipgen-\d\d-.*\.mp4"/);
  await dl.arrayBuffer();
  const tampered = url.renderUrl.replace(/sig=(.)/, (m, ch) => 'sig=' + (ch === 'a' ? 'b' : 'a'));
  assert.equal((await fetch(S.base + tampered)).status, 403);
  assert.equal((await fetch(S.base + url.renderUrl.replace(/\/render\/.*\?/, '/render/c1-0000000000.mp4?'))).status, 403);
  assert.equal((await fetch(S.base + url.renderUrl.split('?')[0])).status, 403);
  const src = await fetch(S.base + (await S.api('GET', '/api/projects/' + pid)).json.project.urls.source, { headers: { Range: 'bytes=0-3' } }); assert.equal(src.status, 206); await src.arrayBuffer();
  void clip;
});

test('render-all + ZIP: valid archive with every clip as a playable MP4; ZIP can be limited to chosen clips', async () => {
  const all = await S.api('POST', '/api/projects/' + pid + '/render-all', { clipIds: clips.map((c) => c.id) });
  const j = await S.waitJob(all.json.job.id); assert.equal(j.state, 'done', JSON.stringify(j)); assert.equal(j.result.rendered, clips.length); assert.deepEqual(j.result.failed, []);
  const z = await S.api('POST', '/api/projects/' + pid + '/zip-link', {});
  assert.equal(z.json.clips, clips.length);
  const res = await fetch(S.base + z.json.url); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/zip');
  const zf = V('clips.zip'); fs.writeFileSync(zf, Buffer.from(await res.arrayBuffer()));
  const py = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;z.extractall(sys.argv[2]);print("\\n".join(z.namelist()))', zf, V('unz')], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  const names = py.stdout.trim().split('\n'); assert.equal(names.length, clips.length); assert.ok(names.every((n) => /^clipgen-\d\d-.+\.mp4$/.test(n)), names.join());
  for (const n of names) { const i = probeFile(path.join(V('unz'), n)); assert.ok(i.audio && i.dur > 3, n); }
  const one = await S.api('POST', '/api/projects/' + pid + '/zip-link', { clipIds: [clips[0].id] }); assert.equal(one.json.clips, 1);
  const r1 = await fetch(S.base + one.json.url); fs.writeFileSync(V('one.zip'), Buffer.from(await r1.arrayBuffer()));
  assert.equal(spawnSync('python3', ['-c', 'import zipfile,sys;print(len(zipfile.ZipFile(sys.argv[1]).namelist()))', V('one.zip')], { encoding: 'utf8' }).stdout.trim(), '1');
});

test('regenerate swaps in a different distinct moment and drops the stale render', async () => {
  const an = (await S.api('GET', '/api/projects/' + pid)).json.analysis;
  const target = an.clips[0];
  const r = await S.api('POST', '/api/projects/' + pid + '/clips/' + target.id + '/regenerate', {});
  if (r.status === 409) { assert.equal(r.json.error.code, 'no-alternative'); return; }
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(r.json.clip.start !== target.start || r.json.clip.end !== target.end);
  assert.equal(r.json.clip.id, target.id); assert.equal(r.json.clip.renderUrl, undefined);
  const after = (await S.api('GET', '/api/projects/' + pid)).json.analysis.clips;
  const others = after.filter((c) => c.id !== target.id);
  for (const o of others) assert.ok(Math.min(o.end, r.json.clip.end) - Math.max(o.start, r.json.clip.start) <= 0, 'no overlap');
  assert.ok(!fs.readdirSync(path.join(S.config.dataDir, 'projects', pid, 'renders')).some((n) => n.startsWith(target.id + '-')), 'old render deleted');
});

test('jobs: cancellation of a running render, queueing with one worker', async () => {
  const big = await upload(S, V('main.mp4'), { chunk: 1 << 22 });
  const a = await S.api('POST', '/api/projects/' + big.project.id + '/analyze', { settings: { numClips: 3, minDuration: 5, maxDuration: 12 } });
  assert.equal((await S.waitJob(a.json.job.id)).state, 'done');
  const cl = (await S.api('GET', '/api/projects/' + big.project.id)).json.analysis.clips;
  const r1 = await S.api('POST', '/api/projects/' + big.project.id + '/clips/' + cl[0].id + '/render', { quality: '1080', aspect: '9:16', reframe: 'smart' });
  const r2 = await S.api('POST', '/api/projects/' + big.project.id + '/clips/' + cl[1].id + '/render', {});
  const st2 = (await S.api('GET', '/api/jobs/' + r2.json.job.id)).json.job; assert.ok(['queued', 'running'].includes(st2.state));
  const dup = await S.api('POST', '/api/projects/' + big.project.id + '/clips/' + cl[1].id + '/render', {}); assert.equal(dup.json.job.id, r2.json.job.id, 'same clip is not rendered twice at once');
  const c = await S.api('POST', '/api/jobs/' + r1.json.job.id + '/cancel', {});
  assert.equal(c.json.job.state, 'cancelled');
  const j2 = await S.waitJob(r2.json.job.id); assert.equal(j2.state, 'done');
  const busy = await S.api('POST', '/api/projects/' + big.project.id + '/analyze', {});
  await S.waitJob(busy.json.job.id);
  assert.equal((await S.api('GET', '/api/jobs/j_doesnotexist1')).status, 404);
  assert.ok(!fs.readdirSync(path.join(S.config.dataDir, 'projects', big.project.id, 'renders')).some((n) => n.startsWith('tmp-')), 'no temp work left behind');
  await S.api('DELETE', '/api/projects/' + big.project.id);
});

test('delete removes every file; project is then gone', async () => {
  const { project } = await upload(S, V('tiny.mp4'));
  const d = path.join(S.config.dataDir, 'projects', project.id);
  assert.ok(fs.existsSync(d));
  assert.equal((await S.api('DELETE', '/api/projects/' + project.id)).status, 200);
  assert.ok(!fs.existsSync(d)); assert.equal((await S.api('GET', '/api/projects/' + project.id)).status, 404);
  assert.equal((await S.api('GET', '/api/projects/..%2F..%2Fetc')).status, 404);
});

test('retention sweep, quotas, duration limit, restart recovery', async () => {
  const srv = await startServer({ cfg: { limits: { ttlMs: 50, maxProjects: 2, maxDurationSec: 5, uploadChunkBytes: 1 << 22 } } });
  try {
    const long = await upload(srv, V('tiny.mp4'));            // 6 s > 5 s limit
    assert.equal(long.job.state, 'error'); assert.equal(long.job.error.code, 'too-long');
    srv.app.cfg.limits.maxDurationSec = 600;
    const a = await upload(srv, V('tiny.mp4'));
    assert.equal(a.job.state, 'done');
    await new Promise((r) => setTimeout(r, 120));
    assert.ok((await srv.app.store.sweep()) >= 1);
    assert.equal((await srv.api('GET', '/api/projects/' + a.project.id)).status, 404);
    srv.app.cfg.limits.ttlMs = 3600000;
    await upload(srv, V('tiny.mp4')); await upload(srv, V('tiny.mp4'));
    const c = await srv.api('POST', '/api/uploads', { name: 'x.mp4', size: 100 });
    const extra = await srv.api('POST', '/api/uploads/' + c.json.uploadId + '/complete', {});
    assert.ok(extra.status === 409 || extra.status === 507);
    /* restart: a project left "analyzing" by a stopped server is reset */
    const ids = await srv.app.store.ids(); const p = await srv.app.store.get(ids[0]); p.status = 'analyzing'; await srv.app.store.save(p);
    const app2 = await createApp(loadConfig({ dataDir: srv.config.dataDir, log: 'silent' }));
    const p2 = await app2.store.get(ids[0]); assert.equal(p2.status, 'ready'); assert.match(p2.notice, /interrupted/i);
  } finally { await srv.close(); }
});

test('access token, CORS allow-list and rate limiting', async () => {
  const srv = await startServer({ token: 'secret-token-123', cfg: { limits: { requestsPerMinute: 8 } } });
  try {
    assert.equal((await fetch(srv.base + '/api/health')).status, 200);
    assert.equal((await fetch(srv.base + '/api/capabilities')).status, 401);
    assert.equal((await fetch(srv.base + '/api/capabilities', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const ok = await fetch(srv.base + '/api/capabilities', { headers: { Authorization: 'Bearer secret-token-123', Origin: 'https://akshxt10.github.io' } });
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('access-control-allow-origin'), 'https://akshxt10.github.io');
    const evil = await fetch(srv.base + '/api/capabilities', { headers: { Authorization: 'Bearer secret-token-123', Origin: 'https://evil.example' } });
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(srv.base + '/api/projects', { method: 'OPTIONS', headers: { Origin: 'https://akshxt10.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } });
    assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/i);
    /* signed media links work without the token header (so <video> can load them) */
    makeVideo(V('t2.mp4'), { w: 320, h: 180, dur: 3 });
    const buf = fs.readFileSync(V('t2.mp4'));
    const H = { Authorization: 'Bearer secret-token-123' };
    const c = await (await fetch(srv.base + '/api/uploads', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name: 't2.mp4', size: buf.length }) })).json();
    await fetch(srv.base + '/api/uploads/' + c.uploadId + '?offset=0', { method: 'PUT', headers: H, body: buf });
    let n429 = 0;
    for (let i = 0; i < 12; i++) { const r = await fetch(srv.base + '/api/jobs', { headers: H }); if (r.status === 429) n429++; }
    assert.ok(n429 >= 1, 'rate limit triggers');
  } finally { await srv.close(); }
});

test('unknown routes, bad methods and invalid ids are handled', async () => {
  assert.equal((await S.api('GET', '/api/nothing')).status, 404);
  assert.equal((await S.api('DELETE', '/api/health')).status, 405);
  assert.equal((await S.api('GET', '/api/projects/x')).status, 404);
  assert.equal((await fetch(S.base + '/media/p_abcdefghijkl/source')).status, 403);
  const j = await fetch(S.base + '/api/projects/url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }); assert.equal(j.status, 400);
});
