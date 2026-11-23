/*
  ClipGen AI backend · render one clip: cut from the real source video, reframe to the target aspect ratio,
  burn captions, keep the original audio, write an MP4 (H.264 + AAC, fast-start so it streams on phones).
*/
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { run, probe } from './media.js';
import { ApiError, clamp, round, bad } from './util.js';
import { buildAss, normalizeCaptionOptions, availableFonts } from './captions.js';
import { outputSize, planCrop, buildGraph, sampleMotion, detectFaces } from './reframe.js';

export function normalizeRenderOptions(raw, media, defaults = {}) {
  const o = raw || {};
  const d = media.duration;
  let start = Number(o.start), end = Number(o.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw bad('invalid-range', 'A start and end time are required.');
  start = clamp(start, 0, Math.max(0, d - 0.5)); end = clamp(end, start + 0.5, d);
  if (end - start < 1) throw bad('invalid-range', 'A clip must be at least 1 second long.');
  if (end - start > 600) throw bad('invalid-range', 'A clip can be at most 10 minutes long.');
  let words = null;
  if (o.words !== undefined && o.words !== null) {
    if (!Array.isArray(o.words) || o.words.length > 4000) throw bad('invalid-words', 'Caption text is invalid or too long.');
    words = o.words.map((w) => ({ w: String(w && w.w != null ? w.w : '').slice(0, 60), s: Number(w && w.s), e: Number(w && w.e) })).filter((w) => w.w.trim() && Number.isFinite(w.s) && Number.isFinite(w.e));
  }
  return {
    start: round(start, 2), end: round(end, 2),
    aspect: ['9:16', '16:9', '1:1'].includes(o.aspect) ? o.aspect : (defaults.aspect || '9:16'),
    reframe: ['smart', 'center', 'blur'].includes(o.reframe) ? o.reframe : (defaults.reframe || 'smart'),
    quality: o.quality === '1080' ? '1080' : '720',
    captions: o.captions === undefined ? defaults.captions !== false : o.captions !== false,
    caption: normalizeCaptionOptions(Object.assign({}, defaults.caption || {}, o.caption || {}, { style: (o.caption && o.caption.style) || defaults.captionStyle })),
    words
  };
}

const keyOf = (clipId, opts, extra) => crypto.createHash('sha1').update(JSON.stringify([clipId, opts, extra])).digest('hex').slice(0, 10);

/* the file name a render with these options gets; equal names ⇔ identical result (used to tell "up to date" from "stale") */
export function renderFileName(clipId, opts, words) {
  return clipId + '-' + keyOf(clipId, Object.assign({}, opts, { words: undefined }), (opts.words || words || []).map((w) => [w.w, w.s, w.e])) + '.mp4';
}

export async function renderClip({ cfg, store, project, clipId, opts, words, ctx }) {
  const media = project.media;
  const src = await store.sourcePath(project.id);
  const dir = path.join(store.dir(project.id), 'renders');
  const outName = renderFileName(clipId, opts, words);
  const key = outName.slice(clipId.length + 1, -4);
  const outPath = path.join(dir, outName);
  try {
    const st = await fsp.stat(outPath);
    if (st.size > 1000) return { file: outName, bytes: st.size, cached: true, duration: round(opts.end - opts.start, 2) };
  } catch (_) { /* render it */ }
  const rendersNow = (await fsp.readdir(dir)).filter((n) => n.endsWith('.mp4')).length;
  if (rendersNow >= cfg.limits.maxRendersPerProject) throw new ApiError(507, 'storage-full', 'This video already has the maximum number of rendered files. Delete the project or wait for old files to expire.');

  const dur = round(opts.end - opts.start, 2);
  const out = outputSize(opts.aspect, opts.quality);
  const work = path.join(dir, 'tmp-' + key + '-' + crypto.randomBytes(3).toString('hex'));
  await fsp.mkdir(work, { recursive: true });
  try {
    ctx.report('plan', 0.02, 'Planning the framing …');
    let motion = null, faces = null;
    const srcAspect = media.width / media.height, tgt = out.w / out.h;
    const needsCrop = opts.reframe === 'smart' && srcAspect > tgt * 1.03;
    if (needsCrop) {
      faces = await detectFaces(cfg, src, { start: opts.start, duration: dur, signal: ctx.signal });
      if (!faces || faces.samples.length < 3) motion = (await sampleMotion(cfg, src, { start: opts.start, duration: dur, signal: ctx.signal })).motion;
    }
    const plan = planCrop({ srcW: media.width, srcH: media.height, aspect: opts.aspect, reframe: opts.reframe, motion, faces, duration: dur, fps: faces ? faces.fps : 4 });

    const wordsAbs = opts.words || words || [];
    const local = wordsAbs.filter((w) => w.e > opts.start && w.s < opts.end).map((w) => ({ w: w.w, s: round(w.s - opts.start, 3), e: round(w.e - opts.start, 3) }));
    let captionsInfo = null;
    if (opts.captions && local.length) {
      await fsp.writeFile(path.join(work, 'caps.ass'), buildAss(local, { width: out.w, height: out.h, duration: dur, options: opts.caption }));
      captionsInfo = { file: 'caps.ass', fontsDir: cfg.fontsDir || '' };
    }
    let graph = buildGraph({ plan, out, captions: captionsInfo });
    if (media.fps && media.fps > 31) graph = graph.replace('[0:v]', '[0:v]fps=30,');
    await fsp.writeFile(path.join(work, 'graph.txt'), graph);

    ctx.report('render', 0.08, 'Rendering …');
    const tmpOut = path.join(work, 'out.mp4');
    const args = ['-nostdin', '-y', '-ss', String(opts.start), '-t', String(dur), '-i', src, '-filter_complex_script', 'graph.txt', '-map', '[vout]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', cfg.renderPreset, '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-threads', String(cfg.threads),
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmpOut];
    const r = await run(cfg.ffmpeg, args, {
      cwd: work, signal: ctx.signal,
      onStdoutLine: (l) => { const m = /^out_time_(?:us|ms)=(\d+)/.exec(l); if (m) ctx.report('render', 0.08 + 0.9 * Math.min(1, Number(m[1]) / 1e6 / dur), 'Rendering …'); }
    });
    if (r.code !== 0) throw new ApiError(500, 'render-failed', 'Rendering failed: ' + String(r.stderr).trim().split('\n').slice(-3).join(' | ').slice(0, 400));
    const info = await probe(cfg, tmpOut, { signal: ctx.signal });
    if (Math.abs(info.duration - dur) > 1.5) throw new ApiError(500, 'render-failed', 'The rendered clip has an unexpected length (' + info.duration + ' s instead of ' + dur + ' s).');
    await fsp.rename(tmpOut, outPath);
    return { file: outName, bytes: (await fsp.stat(outPath)).size, duration: info.duration, width: info.width, height: info.height, mode: plan.mode, subject: plan.subject, captions: !!captionsInfo, hasAudio: info.hasAudio, faces: !!(faces && faces.samples.length) };
  } finally { await fsp.rm(work, { recursive: true, force: true }); }
}

export { availableFonts };
