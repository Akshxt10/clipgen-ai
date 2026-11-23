/*
  ClipGen AI backend · the long-running jobs: fetching a video from a link, preparing an uploaded video,
  analysing it, and rendering clips.
*/
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { httpGet } from './ssrf.js';
import { classify, filenameFrom, normalizeUrl } from './sources.js';
import { probe, thumbnail, extractWav, loudnessWindows, detectScenes } from './media.js';
import { analyzeVideo, normalizeSettings } from './analyze.js';
import { llmAvailable, reviewWithLlm, applyLlm } from './llm.js';
import { renderClip } from './render.js';
import { ApiError, readJson, writeJsonAtomic, round, exists } from './util.js';

const EXT_BY_TYPE = { 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm', 'video/x-matroska': '.mkv', 'video/x-m4v': '.m4v', 'video/mpeg': '.mpg', 'video/mp2t': '.ts', 'video/3gpp': '.3gp', 'video/x-msvideo': '.avi', 'video/x-flv': '.flv', 'video/x-ms-wmv': '.wmv' };
export const ALLOWED_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.ts', '.mts', '.m2ts', '.3gp', '.flv', '.wmv', '.ogv']);
export const extOf = (name) => { const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || ''); return m ? m[0].toLowerCase() : ''; };

/* after the bytes are on disk: validate it is a real video, read its details, make a thumbnail */
export async function prepareSource(app, project, ctx) {
  const { cfg, store } = app;
  const file = await store.sourcePath(project.id);
  ctx.report('probe', 0.9, 'Reading the video …');
  project.status = 'probing'; await store.save(project);
  let media;
  try { media = await probe(cfg, file, { signal: ctx.signal }); }
  catch (e) { await store.remove(project.id); throw e; }
  if (media.duration > cfg.limits.maxDurationSec) {
    await store.remove(project.id);
    throw new ApiError(413, 'too-long', 'This video is ' + Math.round(media.duration / 60) + ' minutes long; this server accepts videos up to ' + Math.round(cfg.limits.maxDurationSec / 60) + ' minutes.');
  }
  project.media = media;
  if (!project.name || project.name === project.source.originalName) project.name = (media.title || (project.source.originalName || 'Video').replace(/\.[A-Za-z0-9]{1,5}$/, '')).slice(0, 120);
  try { await thumbnail(cfg, file, Math.min(media.duration * 0.1, 5), store.file(project.id, 'thumbs/poster.jpg'), { signal: ctx.signal }); project.hasPoster = true; } catch (e) { if (e.name === 'AbortError') throw e; project.hasPoster = false; }
  project.status = 'ready'; project.error = null;
  await store.save(project);
  ctx.report('done', 1, 'Ready');
  return { projectId: project.id };
}

/* download a direct media link */
export async function fetchFromUrl(app, project, urlStr, ctx) {
  const { cfg, store } = app;
  const c = classify(urlStr, { allowPrivate: cfg.allowPrivateUrls });
  if (c.kind === 'platform') throw new ApiError(422, 'unsupported-source', c.message);
  ctx.report('download', 0, 'Contacting the server …');
  const timeout = AbortSignal.timeout(cfg.limits.downloadTimeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const { res, url } = await httpGet(c.url, { signal, timeoutMs: 30000, allowPrivate: cfg.allowPrivateUrls });
  try {
    if (res.statusCode === 401 || res.statusCode === 403) throw new ApiError(422, 'forbidden', 'The other server refuses to hand out this file (HTTP ' + res.statusCode + '). It may need a login, have expired, or block downloads. ClipGen AI does not bypass sign-ins or protections — upload the file instead.');
    if (res.statusCode !== 200) throw new ApiError(422, 'download-failed', 'The other server answered with HTTP ' + res.statusCode + '.');
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (/^text\/|application\/(xhtml|json)/.test(type) || type.startsWith('image/')) throw new ApiError(422, 'not-media', 'This link opens a web page or image, not a video file.');
    const total = Number(res.headers['content-length']) || 0;
    if (total && total > cfg.limits.maxSourceBytes) throw new ApiError(413, 'too-big', 'This file is ' + Math.round(total / 1048576) + ' MB; the limit on this server is ' + Math.round(cfg.limits.maxSourceBytes / 1048576) + ' MB.');
    await store.assertRoomFor(total || 50 * 1048576);
    const name = filenameFrom(url, res.headers['content-disposition']);
    let ext = EXT_BY_TYPE[type] || extOf(name);
    if (!ALLOWED_EXT.has(ext)) ext = '.mp4';
    const rel = 'source' + ext;
    const dest = store.file(project.id, rel);
    project.source = Object.assign({}, project.source, { file: rel, originalName: name, url: c.url });
    project.name = name.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, 120) || 'Video from link';
    await store.save(project);
    const out = fs.createWriteStream(dest);
    let received = 0;
    await new Promise((resolve, reject) => {
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > cfg.limits.maxSourceBytes) { res.destroy(new ApiError(413, 'too-big', 'The download exceeded the size limit of ' + Math.round(cfg.limits.maxSourceBytes / 1048576) + ' MB and was stopped.')); return; }
        ctx.report('download', total ? received / total * 0.85 : Math.min(0.8, received / (200 * 1048576)), 'Downloading ' + Math.round(received / 1048576) + ' MB' + (total ? ' of ' + Math.round(total / 1048576) + ' MB' : '') + ' …');
      });
      res.on('error', reject); out.on('error', reject);
      res.on('aborted', () => reject(new ApiError(502, 'download-failed', 'The download was interrupted.')));
      out.on('finish', resolve);
      res.pipe(out);
      signal.addEventListener('abort', () => res.destroy(signal.reason && signal.reason.name === 'TimeoutError' ? new ApiError(504, 'timeout', 'The download took too long and was stopped.') : Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
    });
    if (total && received !== total) throw new ApiError(502, 'download-failed', 'The download ended early (' + received + ' of ' + total + ' bytes).');
    project.source.bytes = received;
    await store.save(project);
  } catch (e) {
    try { res.destroy(); } catch (_) { /* ignore */ }
    await store.remove(project.id).catch(() => {});
    throw e;
  }
  return prepareSource(app, project, ctx);
}

/* ---------------- analysis ---------------- */
async function loadSignals(store, id) { return readJson(store.file(id, 'signals.json'), null); }

export async function runAnalysis(app, project, rawSettings, ctx) {
  const { cfg, store, transcriber } = app;
  const id = project.id;
  const media = project.media;
  const settings = normalizeSettings(rawSettings, media.duration);
  const src = await store.sourcePath(id);
  const warnings = [];
  project.status = 'analyzing'; project.notice = null; await store.save(project);
  try {
    if (!media.hasAudio) throw new ApiError(422, 'no-audio', 'This video has no audio track. ClipGen AI finds moments from speech and sound, so it needs a video with audio.');

    /* signals that do not depend on settings are cached per project */
    let sig = await loadSignals(store, id);
    if (!sig) {
      ctx.report('audio', 0.02, 'Extracting the audio …');
      const wav = store.file(id, 'audio.wav');
      await extractWav(cfg, src, wav, { duration: media.duration, signal: ctx.signal, onProgress: (p) => ctx.report('audio', 0.02 + p * 0.08, 'Extracting the audio …') });
      ctx.report('loudness', 0.11, 'Measuring loudness …');
      const loud = await loudnessWindows(wav, { windowSec: 0.25, signal: ctx.signal });
      ctx.report('scenes', 0.14, 'Detecting scene changes …');
      const scenes = await detectScenes(cfg, src, { duration: media.duration, signal: ctx.signal, onProgress: (p) => ctx.report('scenes', 0.14 + p * 0.26, 'Detecting scene changes …') });
      sig = { loudness: loud, scenes };
      await writeJsonAtomic(store.file(id, 'signals.json'), sig);
    }

    /* transcript (cached by language) */
    let tr = await readJson(store.file(id, 'transcript.json'), null);
    if (tr && settings.language !== 'auto' && tr.requestedLanguage !== settings.language) tr = null;
    let engine = null;
    if (!tr) {
      const av = transcriber.available();
      if (!av.ok) warnings.push('Transcription is not available on this server (' + av.reason + '). Moments were chosen from audio and scene signals only, and captions are unavailable.');
      else {
        ctx.report('transcribe', 0.41, 'Transcribing the speech …');
        try {
          const wav = store.file(id, 'audio.wav');
          const t = await transcriber.transcribe(wav, { language: settings.language, signal: ctx.signal, outDir: store.dir(id), onProgress: (p) => ctx.report('transcribe', 0.41 + p * 0.44, 'Transcribing the speech … ' + Math.round(p * 100) + '%') });
          tr = { requestedLanguage: settings.language, language: t.language, words: t.words, segments: t.segments, engine: t.engine, at: Date.now() };
          await writeJsonAtomic(store.file(id, 'transcript.json'), tr);
        } catch (e) {
          if (e && e.name === 'AbortError') throw e;
          if (e instanceof ApiError && e.status === 400) throw e;       // e.g. wrong language for an English-only model: the user must change something
          warnings.push('Transcription failed (' + (e.message || e) + '). Moments were chosen from audio and scene signals only, and captions are unavailable.');
        }
      }
    }
    if (tr) engine = tr.engine;
    project.hasTranscript = !!(tr && tr.words.length);
    if (tr && !tr.words.length) warnings.push('No speech was recognised in this video.');

    ctx.report('score', 0.86, 'Scoring moments …');
    const result = analyzeVideo({ words: tr ? tr.words : [], loudness: sig.loudness, scenes: sig.scenes, duration: media.duration, settings });
    const analysis = { version: 1, createdAt: Date.now(), settings, mode: result.mode, engine: { transcription: engine, llm: false, language: tr ? tr.language : null }, stats: result.stats, clips: result.clips, pool: result.pool, warnings, usedSeeds: [] };

    if (llmAvailable(cfg) && result.clips.length) {
      ctx.report('review', 0.92, 'AI review of the best moments …');
      try {
        const ratings = await reviewWithLlm(cfg, [...result.clips, ...result.pool.slice(0, 6)], settings, { signal: ctx.signal });
        const n = applyLlm(analysis, ratings);
        analysis.engine.llm = n > 0 ? { model: cfg.llm.model, rated: n } : false;
      } catch (e) { if (e && e.name === 'AbortError') throw e; warnings.push('The optional AI review step failed (' + (e.message || e) + '); scores use audio/text signals only.'); }
    }

    ctx.report('thumbs', 0.96, 'Creating thumbnails …');
    for (const c of analysis.clips) {
      try { await thumbnail(cfg, src, c.start + Math.min(2, c.duration / 3), store.file(id, 'thumbs/' + c.id + '.jpg'), { signal: ctx.signal }); c.hasThumb = true; } catch (e) { if (e.name === 'AbortError') throw e; c.hasThumb = false; }
    }
    await writeJsonAtomic(store.file(id, 'analysis.json'), analysis);
    project.hasAnalysis = true; project.status = 'analyzed'; project.clipCount = analysis.clips.length; project.analyzedAt = Date.now();
    await store.save(project);
    return { clips: analysis.clips.length, mode: analysis.mode };
  } catch (e) {
    project.status = project.hasAnalysis ? 'analyzed' : 'ready';
    project.notice = e && e.name === 'AbortError' ? 'Analysis was cancelled.' : null;
    await store.save(project);
    throw e;
  }
}

export async function loadAnalysis(store, id) {
  const a = await readJson(store.file(id, 'analysis.json'), null);
  if (!a) throw new ApiError(409, 'not-analyzed', 'This video has not been analysed yet.');
  return a;
}
export const saveAnalysis = (store, id, a) => writeJsonAtomic(store.file(id, 'analysis.json'), a);

export async function wordsBetween(store, id, start, end) {
  const tr = await readJson(store.file(id, 'transcript.json'), null);
  if (!tr) return [];
  return tr.words.filter((w) => w.e > start && w.s < end);
}

/* analysis.json is read-modify-written by several requests/jobs: serialise per project */
const locks = new Map();
export function updateAnalysis(store, id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const a = await loadAnalysis(store, id);
    const out = await fn(a);
    await saveAnalysis(store, id, a);
    return out;
  });
  locks.set(id, next);
  next.finally(() => { if (locks.get(id) === next) locks.delete(id); }).catch(() => {});
  return next;
}

/* remove rendered files of this clip that are no longer the current one */
export async function pruneRenders(store, id, clipId, keep) {
  const dir = path.join(store.dir(id), 'renders');
  let names = [];
  try { names = await fsp.readdir(dir); } catch (_) { return; }
  for (const n of names) if (n.startsWith(clipId + '-') && n.endsWith('.mp4') && n !== keep) await fsp.rm(path.join(dir, n), { force: true });
}

export async function runRender(app, project, clipId, opts, ctx) {
  const { cfg, store } = app;
  const words = await wordsBetween(store, project.id, opts.start, opts.end);
  const r = await renderClip({ cfg, store, project, clipId, opts, words, ctx });
  await updateAnalysis(store, project.id, (a) => {
    const clip = a.clips.find((c) => c.id === clipId);
    if (clip) clip.render = Object.assign({ at: Date.now(), opts: { start: opts.start, end: opts.end, aspect: opts.aspect, reframe: opts.reframe, quality: opts.quality, captions: opts.captions, style: opts.caption.style } }, r);
  });
  await pruneRenders(store, project.id, clipId, r.file);
  return r;
}
