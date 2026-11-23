/*
  ClipGen AI backend · HTTP API.

  /api/health                         no sign-in needed (is the server up?)
  /api/capabilities                   what this server can do (limits, speech model, fonts …)
  /api/sources/inspect                check a pasted link (nothing is stored)
  /api/projects/url                   add a video from a direct link
  /api/uploads …                      chunked, resumable upload of a video file
  /api/projects …                     list / read / delete, analyse, clips, render, regenerate, ZIP
  /api/jobs …                         progress + cancel of background work
  /media/<project>/…?exp&sig          signed links for video playback / downloads (Range supported)

  If ACCESS_TOKEN is set, every /api call except /api/health needs "Authorization: Bearer <token>".
  Media links are HMAC-signed and expire, so the token never appears in a URL.
*/
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Transform } from 'node:stream';
import { pipeline as pipe } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { ApiError, bad, notFound, newId, ID_RE, clamp, round, safeName, readJson, writeJsonAtomic, signUrlPart, verifySig, sleep } from './util.js';
import { Store } from './store.js';
import { JobManager } from './jobs.js';
import { createTranscriber } from './transcribe.js';
import { inspect, classify } from './sources.js';
import { PLATFORM_PRESETS, INTENSITY, regenerateClip } from './analyze.js';
import { CAPTION_STYLES, availableFonts } from './captions.js';
import { normalizeRenderOptions, renderFileName } from './render.js';
import { faceAvailable } from './reframe.js';
import { llmAvailable } from './llm.js';
import { thumbnail } from './media.js';
import { writeZip } from './zip.js';
import { ALLOWED_EXT, extOf, prepareSource, fetchFromUrl, runAnalysis, loadAnalysis, saveAnalysis, updateAnalysis, runRender, pruneRenders, wordsBetween } from './pipeline.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo' };
const MEDIA_TTL_MS = 3 * 3600 * 1000;

export async function createApp(cfg, overrides = {}) {
  const store = new Store(cfg);
  const jobs = new JobManager(cfg);
  store.isBusy = (id) => jobs.isBusyProject(id);
  const app = { cfg, store, jobs, transcriber: overrides.transcriber || createTranscriber(cfg) };
  app.secret = cfg.signingSecret || (cfg.accessToken ? crypto.createHash('sha256').update('clipgen-sign:' + cfg.accessToken).digest('hex') : crypto.randomBytes(32).toString('hex'));
  await store.init();
  return app;
}

/* ---------------- small helpers ---------------- */
const cache = {};
function cached(key, ttl, fn) {
  const c = cache[key];
  if (c && Date.now() - c.at < ttl) return c.v;
  const v = fn();
  cache[key] = { at: Date.now(), v };
  return v;
}
function ffmpegInfo(cfg) {
  return cached('ffmpeg', 300000, () => {
    const r = spawnSync(cfg.ffmpeg, ['-version'], { encoding: 'utf8', timeout: 8000 });
    if (r.error || r.status !== 0) return { ok: false, version: null };
    const m = /ffmpeg version (\S+)/.exec(r.stdout || '');
    return { ok: true, version: m ? m[1] : 'unknown' };
  });
}

function mediaUrl(app, pathname) {
  const exp = Date.now() + MEDIA_TTL_MS;
  return pathname + '?exp=' + exp + '&sig=' + signUrlPart(app.secret, pathname, exp);
}

function cleanUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname; } catch (_) { return null; }
}

function publicProject(app, p) {
  const out = {
    id: p.id, name: p.name || 'Untitled video', status: p.status, error: p.error || null, notice: p.notice || null,
    createdAt: p.createdAt, updatedAt: p.updatedAt, analyzedAt: p.analyzedAt || null,
    source: { kind: (p.source && p.source.kind) || 'upload', originalName: p.source && p.source.originalName, bytes: (p.source && p.source.bytes) || null, link: p.source && p.source.url ? cleanUrl(p.source.url) : null },
    media: p.media ? { duration: p.media.duration, width: p.media.width, height: p.media.height, fps: p.media.fps, hasAudio: p.media.hasAudio, vcodec: p.media.vcodec, acodec: p.media.acodec, container: p.media.container } : null,
    hasTranscript: !!p.hasTranscript, hasAnalysis: !!p.hasAnalysis, clipCount: p.clipCount || 0,
    expiresAt: (p.lastAccess || p.createdAt) + app.cfg.limits.ttlMs
  };
  if (p.status !== 'error' && p.media) {
    out.urls = { source: mediaUrl(app, '/media/' + p.id + '/source') };
    if (p.hasPoster) out.urls.poster = mediaUrl(app, '/media/' + p.id + '/poster');
  }
  const j = app.jobs.activeFor(p.id);
  if (j) out.activeJob = app.jobs.snapshot(j);
  return out;
}

async function publicAnalysis(app, p, a) {
  const tr = (a.clips || []).some((c) => c.render) ? await readJson(app.store.file(p.id, 'transcript.json'), null) : null;
  const clips = a.clips.map((c) => {
    const o = Object.assign({}, c);
    if (c.hasThumb) o.thumbUrl = mediaUrl(app, '/media/' + p.id + '/thumb/' + c.id);
    if (c.render && c.render.file) {
      o.renderUrl = mediaUrl(app, '/media/' + p.id + '/render/' + c.render.file);
      o.downloadUrl = o.renderUrl + '&dl=1';
      /* is the rendered file what the current settings would produce? */
      try {
        const opts = renderOptsFor(p, a, c, {});
        const words = tr ? tr.words.filter((w) => w.e > opts.start && w.s < opts.end) : [];
        o.renderCurrent = renderFileName(c.id, opts, words) === c.render.file;
      } catch (_) { o.renderCurrent = false; }
    }
    return o;
  });
  return { version: a.version, createdAt: a.createdAt, settings: a.settings, mode: a.mode, engine: a.engine, stats: a.stats, warnings: a.warnings || [], clips, poolCount: (a.pool || []).length };
}

function clipOrThrow(a, cid) {
  const c = a.clips.find((x) => x.id === cid);
  if (!c) throw notFound('Clip');
  return c;
}

/* default render options for a clip = analysis settings < clip edits < request body */
function renderOptsFor(project, a, clip, body) {
  const s = a.settings;
  const hasWords = !!project.hasTranscript;
  const defaults = { aspect: s.aspect, reframe: s.reframe, captions: s.captions && hasWords, captionStyle: s.captionStyle, caption: { keywords: s.keywords || [] } };
  const base = Object.assign({ start: clip.start, end: clip.end }, clip.edit || {});
  const merged = Object.assign({}, base, body || {});
  if (merged.caption || (clip.edit && clip.edit.caption)) merged.caption = Object.assign({}, (clip.edit && clip.edit.caption) || {}, (body && body.caption) || {});
  return normalizeRenderOptions(merged, project.media, defaults);
}

/* store a clip's current edits (times + look) so the editor state survives reloads */
function applyEdit(clip, opts, media) {
  if (!clip.auto) clip.auto = { start: clip.start, end: clip.end };      // the AI's original suggestion, for "reset"
  clip.start = opts.start; clip.end = opts.end; clip.duration = round(opts.end - opts.start, 2);
  clip.edit = { aspect: opts.aspect, reframe: opts.reframe, quality: opts.quality, captions: opts.captions, caption: opts.caption };
  if (opts.words) clip.edit.words = opts.words;
  else delete clip.edit.words;
}

/* ---------------- JSON / body helpers ---------------- */
async function readBody(req, limit = 1048576) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > limit) throw new ApiError(413, 'body-too-large', 'The request is too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { const j = JSON.parse(buf.toString('utf8')); return j && typeof j === 'object' ? j : {}; } catch (_) { throw bad('invalid-json', 'The request body is not valid JSON.'); }
}

/* ---------------- file serving with Range support ---------------- */
async function serveFile(req, res, file, { type, download, cacheControl } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch (_) { throw notFound('File'); }
  if (!st.isFile()) throw notFound('File');
  const ext = path.extname(file).toLowerCase();
  const headers = { 'Content-Type': type || MIME[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl || 'private, max-age=300', 'X-Content-Type-Options': 'nosniff' };
  if (download) headers['Content-Disposition'] = 'attachment; filename="' + String(download).replace(/[^\w. -]/g, '_') + '"; filename*=UTF-8\'\'' + encodeURIComponent(download);
  let start = 0, end = st.size - 1, status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    if (m[1] === '') { const n = Number(m[2]); start = Math.max(0, st.size - n); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
    status = 206;
    headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  res.on('close', () => rs.destroy());
  rs.pipe(res);
}

/* ---------------- router ---------------- */
export function createServer(app) {
  const { cfg, store, jobs } = app;
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), handler, opts });

  /* ---- health & capabilities ---- */
  route('GET', '/api/health', async ({ res, json }) => {
    json(200, { ok: true, name: 'clipgen-ai-backend', version: cfg.version, authRequired: !!cfg.accessToken, ffmpeg: ffmpegInfo(cfg).ok, time: Date.now() });
  }, { public: true });

  route('GET', '/api/capabilities', async ({ json }) => {
    const tr = cached('whisper', 60000, () => app.transcriber.available());
    const used = await store.usedBytes();
    json(200, {
      version: cfg.version,
      ffmpeg: ffmpegInfo(cfg),
      transcription: tr.ok ? { available: true, engine: 'whisper.cpp', model: tr.model, multilingual: tr.multilingual } : { available: false, reason: tr.reason },
      llmReview: llmAvailable(cfg) ? { available: true, model: cfg.llm.model } : { available: false },
      faceTracking: faceAvailable(cfg),
      limits: {
        maxSourceMB: Math.round(cfg.limits.maxSourceBytes / 1048576), maxDurationMin: Math.round(cfg.limits.maxDurationSec / 60), maxClips: cfg.limits.maxClips,
        uploadChunkBytes: cfg.limits.uploadChunkBytes, retentionHours: Math.round(cfg.limits.ttlMs / 360000) / 10, maxProjects: cfg.limits.maxProjects,
        storageUsedMB: Math.round(used / 1048576), storageMaxMB: Math.round(cfg.limits.maxDiskBytes / 1048576)
      },
      uploadExtensions: [...ALLOWED_EXT],
      platforms: PLATFORM_PRESETS, intensities: Object.keys(INTENSITY),
      captionStyles: Object.fromEntries(Object.entries(CAPTION_STYLES).map(([k, v]) => [k, { label: v.label, color: v.color, highlight: v.highlight, perWord: v.perWord, upper: v.upper, bold: v.bold, box: v.box }])),
      fonts: availableFonts(),
      aspects: ['9:16', '16:9', '1:1']
    });
  });

  /* ---- link check + add by link ---- */
  route('POST', '/api/sources/inspect', async ({ json, body }) => {
    const b = await body();
    if (!b.url || typeof b.url !== 'string' || b.url.length > 2048) throw bad('invalid-url', 'Paste a link that starts with https://');
    json(200, await inspect(b.url.trim(), { allowPrivate: cfg.allowPrivateUrls }));
  });

  route('POST', '/api/projects/url', async ({ json, body }) => {
    const b = await body();
    if (!b.url || typeof b.url !== 'string' || b.url.length > 2048) throw bad('invalid-url', 'Paste a link that starts with https://');
    const c = classify(b.url.trim(), { allowPrivate: cfg.allowPrivateUrls });
    if (c.kind === 'platform') throw new ApiError(422, 'unsupported-source', c.message, { platform: c.platform, platformName: c.platformName });
    await store.assertRoomFor(20 * 1048576);
    const project = await store.create({ name: safeName(b.name, 'Video from link'), status: 'ingesting', source: { kind: 'url', url: c.url } });
    const job = jobs.create({ type: 'ingest', projectId: project.id, label: 'Fetch video from link', run: (ctx) => fetchFromUrl(app, project, c.url, ctx) });
    json(202, { project: publicProject(app, project), job: jobs.snapshot(job) });
  });

  /* ---- chunked, resumable upload ---- */
  const uploading = new Set();
  const uploadMeta = (id) => path.join(store.uploadDir(id), 'meta.json');
  route('POST', '/api/uploads', async ({ json, body }) => {
    const b = await body();
    const name = safeName(b.name, 'video');
    const ext = extOf(String(b.name || ''));
    const size = Number(b.size);
    if (!Number.isFinite(size) || size <= 0) throw bad('invalid-size', 'The file size is missing.');
    if (!ALLOWED_EXT.has(ext)) throw new ApiError(415, 'unsupported-format', 'This file type (' + (ext || 'no extension') + ') is not supported. Use one of: ' + [...ALLOWED_EXT].join(' ') + '.');
    if (size > cfg.limits.maxSourceBytes) throw new ApiError(413, 'too-big', 'This file is ' + Math.round(size / 1048576) + ' MB; the limit on this server is ' + Math.round(cfg.limits.maxSourceBytes / 1048576) + ' MB.');
    await store.assertRoomFor(size * 1.05);
    const id = newId('u');
    await fsp.mkdir(store.uploadDir(id), { recursive: true });
    await writeJsonAtomic(uploadMeta(id), { name, originalName: String(b.name || name).slice(0, 200), ext, size, createdAt: Date.now() });
    json(201, { uploadId: id, chunkBytes: cfg.limits.uploadChunkBytes, received: 0 });
  });

  route('GET', '/api/uploads/:id', async ({ json, params }) => {
    const m = await readJson(uploadMeta(params.id), null);
    if (!m) throw notFound('Upload');
    let received = 0;
    try { received = (await fsp.stat(path.join(store.uploadDir(params.id), 'data.part'))).size; } catch (_) { /* none yet */ }
    json(200, { uploadId: params.id, size: m.size, received });
  });

  route('PUT', '/api/uploads/:id', async ({ req, json, params, query }) => {
    const id = params.id;
    const m = await readJson(uploadMeta(id), null);
    if (!m) throw notFound('Upload');
    if (uploading.has(id)) throw new ApiError(409, 'upload-busy', 'Another chunk of this upload is still being received.');
    uploading.add(id);
    try {
      const part = path.join(store.uploadDir(id), 'data.part');
      let have = 0;
      try { have = (await fsp.stat(part)).size; } catch (_) { /* none */ }
      const offset = Number(query.get('offset'));
      if (!Number.isFinite(offset) || offset !== have) throw new ApiError(409, 'offset-mismatch', 'The server has ' + have + ' bytes of this upload; continue from there.', { received: have });
      const room = Math.min(m.size - have, cfg.limits.uploadChunkBytes * 2);
      let n = 0;
      const limiter = new Transform({ transform(chunk, enc, cb) { n += chunk.length; if (n > room) cb(new ApiError(413, 'chunk-too-large', 'This chunk is larger than allowed.')); else cb(null, chunk); } });
      try { await pipe(req, limiter, fs.createWriteStream(part, { flags: 'a' })); }
      catch (e) {
        if (e instanceof ApiError) throw e;
        throw new ApiError(400, 'upload-interrupted', 'The chunk did not arrive completely. Resume from the received position.');
      }
      const received = (await fsp.stat(part)).size;
      json(200, { received, size: m.size, complete: received === m.size });
    } finally { uploading.delete(id); }
  });

  route('POST', '/api/uploads/:id/complete', async ({ json, params }) => {
    const id = params.id;
    const m = await readJson(uploadMeta(id), null);
    if (!m) throw notFound('Upload');
    const part = path.join(store.uploadDir(id), 'data.part');
    let have = 0;
    try { have = (await fsp.stat(part)).size; } catch (_) { /* none */ }
    if (have !== m.size) throw new ApiError(409, 'incomplete', 'Only ' + have + ' of ' + m.size + ' bytes have arrived.', { received: have });
    const name = m.name.replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'Video';
    const project = await store.create({ name: name.slice(0, 120), status: 'ingesting', source: { kind: 'upload', originalName: m.originalName, bytes: m.size } });
    const rel = 'source' + m.ext;
    await fsp.rename(part, store.file(project.id, rel));
    await fsp.rm(store.uploadDir(id), { recursive: true, force: true });
    project.source.file = rel; project.source.originalName = m.originalName;
    await store.save(project);
    const job = jobs.create({ type: 'ingest', projectId: project.id, label: 'Prepare uploaded video', run: (ctx) => prepareSource(app, project, ctx) });
    json(202, { project: publicProject(app, project), job: jobs.snapshot(job) });
  });

  route('DELETE', '/api/uploads/:id', async ({ json, params }) => {
    await fsp.rm(store.uploadDir(params.id), { recursive: true, force: true });
    json(200, { ok: true });
  });

  /* ---- projects ---- */
  route('GET', '/api/projects', async ({ json }) => {
    const list = await store.list();
    json(200, { projects: list.map((p) => publicProject(app, p)) });
  });

  route('GET', '/api/projects/:id', async ({ json, params }) => {
    const p = await store.touch(params.id);
    const out = { project: publicProject(app, p) };
    if (p.hasAnalysis) { try { out.analysis = await publicAnalysis(app, p, await loadAnalysis(store, p.id)); } catch (_) { /* ignore */ } }
    json(200, out);
  });

  route('DELETE', '/api/projects/:id', async ({ json, params }) => {
    const p = await store.get(params.id);
    for (const j of jobs.jobs.values()) if (j.projectId === p.id && (j.state === 'queued' || j.state === 'running')) jobs.cancel(j.id);
    if (jobs.isBusyProject(p.id)) await sleep(400);
    await store.remove(p.id);
    json(200, { ok: true });
  });

  /* ---- analysis ---- */
  route('POST', '/api/projects/:id/analyze', async ({ json, params, body }) => {
    const p = await store.touch(params.id);
    if (!p.media || (p.status !== 'ready' && p.status !== 'analyzed')) throw new ApiError(409, 'not-ready', 'This video is not ready yet (status: ' + p.status + ').');
    if (jobs.isBusyProject(p.id)) throw new ApiError(409, 'busy', 'This video is already being processed.');
    const b = await body();
    const job = jobs.create({ type: 'analyze', projectId: p.id, label: 'Analyse video', run: (ctx) => runAnalysis(app, p, b.settings || b, ctx) });
    json(202, { job: jobs.snapshot(job) });
  });

  route('GET', '/api/projects/:id/analysis', async ({ json, params }) => {
    const p = await store.touch(params.id);
    json(200, { analysis: await publicAnalysis(app, p, await loadAnalysis(store, p.id)) });
  });

  /* transcript words for a time range (caption editing) */
  route('GET', '/api/projects/:id/words', async ({ json, params, query }) => {
    const p = await store.touch(params.id);
    const s = Number(query.get('start')), e = Number(query.get('end'));
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) throw bad('invalid-range', 'start and end are required.');
    json(200, { words: await wordsBetween(store, p.id, s, e) });
  });

  /* ---- clips ---- */
  route('PATCH', '/api/projects/:id/clips/:cid', async ({ json, params, body }) => {
    const p = await store.touch(params.id);
    const b = await body();
    const out = await updateAnalysis(store, p.id, async (a) => {
      const clip = clipOrThrow(a, params.cid);
      const opts = renderOptsFor(p, a, clip, b);
      applyEdit(clip, opts, p.media);
      if (typeof b.title === 'string') clip.title = b.title.trim().slice(0, 120) || clip.title;
      if (b.start !== undefined || b.end !== undefined) {
        const w = await wordsBetween(store, p.id, clip.start, clip.end);
        clip.transcript = w.map((x) => x.w).join(' ').replace(/\s+/g, ' ').trim() || clip.transcript;
        clip.hasThumb = false;
        try { await thumbnail(cfg, await store.sourcePath(p.id), clip.start + Math.min(2, clip.duration / 3), store.file(p.id, 'thumbs/' + clip.id + '.jpg')); clip.hasThumb = true; } catch (_) { /* keep without */ }
      }
      return clip;
    });
    json(200, { clip: (await publicAnalysis(app, p, { clips: [out], pool: [], settings: Object.assign({}, (await loadAnalysis(store, p.id)).settings), warnings: [] })).clips[0] });
  });

  route('POST', '/api/projects/:id/clips/:cid/regenerate', async ({ json, params }) => {
    const p = await store.touch(params.id);
    if (jobs.activeFor(p.id, 'analyze')) throw new ApiError(409, 'busy', 'The video is being analysed right now.');
    const out = await updateAnalysis(store, p.id, async (a) => {
      const old = clipOrThrow(a, params.cid);
      const oldRender = old.render && old.render.file;
      const next = regenerateClip(a, params.cid);
      if (!next) throw new ApiError(409, 'no-alternative', 'No other distinct moment is available. Try “Analyse again” with a higher AI selection intensity or more clips.');
      next.hasThumb = false;
      try { await thumbnail(cfg, await store.sourcePath(p.id), next.start + Math.min(2, next.duration / 3), store.file(p.id, 'thumbs/' + next.id + '.jpg')); next.hasThumb = true; } catch (_) { /* keep without */ }
      if (oldRender) await pruneRenders(store, p.id, params.cid, '');
      return next;
    });
    json(200, { clip: (await publicAnalysis(app, p, { clips: [out], pool: [], settings: Object.assign({}, (await loadAnalysis(store, p.id)).settings), warnings: [] })).clips[0] });
  });

  /* render one clip: the request body carries the editor state, which is saved too */
  route('POST', '/api/projects/:id/clips/:cid/render', async ({ json, params, body }) => {
    const p = await store.touch(params.id);
    if (jobs.activeFor(p.id, 'analyze')) throw new ApiError(409, 'busy', 'The video is being analysed right now.');
    const b = await body();
    const opts = await updateAnalysis(store, p.id, (a) => {
      const clip = clipOrThrow(a, params.cid);
      const o = renderOptsFor(p, a, clip, b);
      applyEdit(clip, o, p.media);
      return o;
    });
    const dup = [...jobs.jobs.values()].find((j) => j.projectId === p.id && j.type === 'render' && j.clipId === params.cid && (j.state === 'queued' || j.state === 'running'));
    if (dup) return json(202, { job: jobs.snapshot(dup) });
    const job = jobs.create({ type: 'render', projectId: p.id, label: 'Render clip ' + params.cid, run: (ctx) => runRender(app, p, params.cid, opts, ctx) });
    job.clipId = params.cid;
    json(202, { job: jobs.snapshot(job) });
  });

  route('POST', '/api/projects/:id/render-all', async ({ json, params, body }) => {
    const p = await store.touch(params.id);
    if (jobs.activeFor(p.id, 'analyze')) throw new ApiError(409, 'busy', 'The video is being analysed right now.');
    const b = await body();
    const ids = Array.isArray(b.clipIds) ? b.clipIds.map(String) : null;
    const a0 = await loadAnalysis(store, p.id);
    const targets = a0.clips.filter((c) => !ids || ids.includes(c.id)).map((c) => c.id);
    if (!targets.length) throw bad('no-clips', 'There are no clips to render.');
    const job = jobs.create({
      type: 'render-all', projectId: p.id, label: 'Render ' + targets.length + ' clips',
      run: async (ctx) => {
        const failed = []; let done = 0;
        for (let i = 0; i < targets.length; i++) {
          if (ctx.signal.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
          const cid = targets[i];
          const a = await loadAnalysis(store, p.id);
          const clip = a.clips.find((c) => c.id === cid);
          if (!clip) continue;
          const opts = renderOptsFor(p, a, clip, b.options || {});
          const sub = { signal: ctx.signal, report: (st, pr, msg) => ctx.report('render', (i + (pr || 0)) / targets.length, 'Clip ' + (i + 1) + ' of ' + targets.length + ' · ' + (msg || 'Rendering …')) };
          try { await runRender(app, p, cid, opts, sub); done++; }
          catch (e) { if (e && e.name === 'AbortError') throw e; failed.push({ id: cid, message: e.message || String(e) }); }
        }
        if (!done && failed.length) throw new ApiError(500, 'render-failed', failed[0].message);
        return { rendered: done, failed };
      }
    });
    json(202, { job: jobs.snapshot(job) });
  });

  route('POST', '/api/projects/:id/zip-link', async ({ json, params, body }) => {
    const p = await store.touch(params.id);
    const b = await body();
    const a = await loadAnalysis(store, p.id);
    const ids = Array.isArray(b.clipIds) ? b.clipIds.map(String).filter((x) => /^c\d{1,3}$/.test(x)) : [];
    const n = a.clips.filter((c) => c.render && c.render.file && (!ids.length || ids.includes(c.id))).length;
    if (!n) throw new ApiError(409, 'nothing-rendered', 'Render some clips first, then download them together.');
    json(200, { url: mediaUrl(app, '/media/' + p.id + '/zip/' + (ids.length ? ids.join(',') : 'all')) + '&dl=1', clips: n });
  });

  /* ---- jobs ---- */
  route('GET', '/api/jobs', async ({ json, query }) => {
    const pid = query.get('projectId');
    json(200, { jobs: [...jobs.jobs.values()].filter((j) => !pid || j.projectId === pid).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((j) => jobs.snapshot(j)) });
  });
  route('GET', '/api/jobs/:id', async ({ json, params }) => json(200, { job: jobs.snapshot(jobs.get(params.id)) }));
  route('POST', '/api/jobs/:id/cancel', async ({ json, params }) => json(200, { job: jobs.snapshot(jobs.cancel(params.id)) }));

  /* ---- signed media ---- */
  route('GET', '/media/:id/:kind', async ({ req, res, params, query, url }) => mediaRoute({ req, res, params, query, url }), { media: true });
  route('GET', '/media/:id/:kind/:name', async ({ req, res, params, query, url }) => mediaRoute({ req, res, params, query, url }), { media: true });
  route('HEAD', '/media/:id/:kind', async ({ req, res, params, query, url }) => mediaRoute({ req, res, params, query, url }), { media: true });
  route('HEAD', '/media/:id/:kind/:name', async ({ req, res, params, query, url }) => mediaRoute({ req, res, params, query, url }), { media: true });

  async function mediaRoute({ req, res, params, query, url }) {
    if (!ID_RE.test(params.id)) throw notFound('File');
    if (!verifySig(app.secret, url.pathname, query.get('exp'), query.get('sig'))) throw new ApiError(403, 'link-expired', 'This link has expired. Reload the page to get a fresh one.');
    const p = await store.touch(params.id);
    const dl = query.get('dl') === '1';
    const dir = store.dir(p.id);
    if (params.kind === 'source') return serveFile(req, res, await store.sourcePath(p.id), { download: dl ? safeName(p.name) + extOf(p.source.file) : undefined });
    if (params.kind === 'poster') return serveFile(req, res, path.join(dir, 'thumbs', 'poster.jpg'), { type: 'image/jpeg' });
    if (params.kind === 'thumb') {
      if (!/^c\d{1,3}$/.test(params.name || '')) throw notFound('File');
      return serveFile(req, res, path.join(dir, 'thumbs', params.name + '.jpg'), { type: 'image/jpeg' });
    }
    if (params.kind === 'render') {
      if (!/^c\d{1,3}-[0-9a-f]{10}\.mp4$/.test(params.name || '')) throw notFound('File');
      let nice = null;
      if (dl) {
        const a = await readJson(store.file(p.id, 'analysis.json'), null);
        const c = a && a.clips.find((x) => x.render && x.render.file === params.name);
        nice = c ? 'clipgen-' + String(c.rank).padStart(2, '0') + '-' + safeName(c.title, 'clip') + '.mp4' : params.name;
      }
      return serveFile(req, res, path.join(dir, 'renders', params.name), { type: 'video/mp4', download: nice });
    }
    if (params.kind === 'zip') {
      const a = await loadAnalysis(store, p.id);
      const want = !params.name || params.name === 'all' ? null : decodeURIComponent(params.name).split(',');
      if (want && !want.every((x) => /^c\d{1,3}$/.test(x))) throw notFound('File');
      const entries = [];
      for (const c of a.clips) {
        if (!c.render || !c.render.file || (want && !want.includes(c.id))) continue;
        const f = path.join(dir, 'renders', c.render.file);
        if (fs.existsSync(f)) entries.push({ name: 'clipgen-' + String(c.rank).padStart(2, '0') + '-' + safeName(c.title, 'clip') + '.mp4', path: f });
      }
      if (!entries.length) throw new ApiError(409, 'nothing-rendered', 'No rendered clips are available.');
      const used = new Set();
      for (const e of entries) { let n = e.name, k = 2; while (used.has(n)) n = e.name.replace(/\.mp4$/, '') + '-' + k++ + '.mp4'; used.add(n); e.name = n; }
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="' + safeName(p.name, 'clips').replace(/[^\w. -]/g, '_') + '-clips.zip"', 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      try { await writeZip(res, entries); } catch (_) { res.destroy(); }
      return;
    }
    throw notFound('File');
  }

  /* ---- optional: serve the web app itself ---- */
  const frontendDir = cfg.frontendDir && fs.existsSync(cfg.frontendDir) ? path.resolve(cfg.frontendDir) : null;
  async function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(frontendDir, '.' + path.sep + rel);
    if (file !== frontendDir && !file.startsWith(frontendDir + path.sep)) throw notFound('Page');
    return serveFile(req, res, file, { cacheControl: 'no-cache' });
  }

  /* ---- CORS, auth, rate limit, dispatch ---- */
  const hits = new Map();
  setInterval(() => hits.clear(), 60000).unref();

  function corsHeaders(req) {
    const origin = req.headers.origin;
    const h = {};
    if (!origin) return h;
    if (cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin)) {
      h['Access-Control-Allow-Origin'] = cfg.allowedOrigins.includes('*') ? '*' : origin;
      h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, Range';
      h['Access-Control-Allow-Methods'] = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
      h['Access-Control-Expose-Headers'] = 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition';
      h['Access-Control-Max-Age'] = '600';
      h['Vary'] = 'Origin';
    }
    return h;
  }
  const clientIp = (req) => (cfg.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
  function tokenOk(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest(), b = crypto.createHash('sha256').update(cfg.accessToken).digest();
    return crypto.timingSafeEqual(a, b);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = corsHeaders(req);
    const json = (status, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, cors, { 'Content-Length': Buffer.byteLength(body) }));
      res.end(body);
    };
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (status, headers) => origWriteHead(status, Object.assign({}, cors, headers || {}));
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const pathname = url.pathname;
      let matched = null, params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (m) { matched = r; params = Object.assign({}, m.groups); break; }
      }
      if (!matched) {
        if (frontendDir && (req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/') && !pathname.startsWith('/media/')) return await serveStatic(req, res, pathname);
        if (pathname.startsWith('/api/')) {
          const other = routes.some((r) => r.re.test(pathname));
          throw new ApiError(other ? 405 : 404, other ? 'method-not-allowed' : 'not-found', other ? 'That method is not allowed here.' : 'Unknown API endpoint.');
        }
        throw notFound('Page');
      }
      if (!matched.opts.media && !matched.opts.public) {
        if (cfg.accessToken && !tokenOk(req)) throw new ApiError(401, 'unauthorized', 'This server needs an access token. Open Settings and enter the token you set on the server.');
      }
      if (!matched.opts.public) {
        const ip = clientIp(req);
        const n = (hits.get(ip) || 0) + 1;
        hits.set(ip, n);
        if (n > cfg.limits.requestsPerMinute) { res.setHeader('Retry-After', '30'); throw new ApiError(429, 'rate-limited', 'Too many requests. Please wait a moment.'); }
      }
      await matched.handler({ req, res, url, params, query: url.searchParams, json, body: () => readJsonBody(req) });
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (e instanceof ApiError) return json(e.status, { error: Object.assign({ code: e.code, message: e.message }, e.extra || {}) });
      if (e && e.name === 'AbortError') return json(499, { error: { code: 'cancelled', message: 'Cancelled.' } });
      if (cfg.log !== 'silent') console.error('[error]', req.method, req.url, e && e.stack || e);
      json(500, { error: { code: 'internal', message: 'Something went wrong on the server. Please try again.' } });
    }
  });
  server.requestTimeout = 0;           // large uploads and downloads can take long
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  return server;
}
