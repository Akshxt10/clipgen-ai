/*
  ClipGen AI backend · smart reframing (landscape → vertical/square) and ffmpeg graph building.

  Smart crop follows the subject:
    1. faces (OpenCV Haar cascade via tools/face_track.py) when available and found often enough, else
    2. motion: where the picture changes between sampled frames (a moving speaker / action), else
    3. the centre.
  The crop window moves smoothly (limited speed, dead-zone, then simplified into a few keyframes) so the picture
  does not jitter. Blur mode keeps the whole frame and fills the rest with a blurred copy (no black bars).
*/
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, grayFrames } from './media.js';
import { clamp, round } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ASPECTS = { '9:16': [9, 16], '16:9': [16, 9], '1:1': [1, 1] };

export function outputSize(aspect, quality) {
  const base = quality === '1080' ? 1080 : 720;
  const [a, b] = ASPECTS[aspect] || ASPECTS['9:16'];
  if (a === b) return { w: base, h: base };
  if (a < b) return { w: base, h: Math.round((base * b) / a / 2) * 2 };
  return { w: Math.round((base * a) / b / 2) * 2, h: base };
}

/*
  Motion centroid x (0..1) per sampled frame; null when nothing moved. Each frame is compared with the one about a
  second earlier (the following second for the first frames), so slow movements — a speaker leaning, walking —
  still register, while frame-to-frame noise does not.
*/
export function motionTrack({ frames, w, h, fps }) {
  const out = [];
  const lag = Math.max(1, Math.round(fps));
  for (let f = 0; f < frames.length; f++) {
    const ref = f >= lag ? f - lag : Math.min(frames.length - 1, f + lag);
    if (ref === f) { out.push({ t: f / fps, x: null, mag: 0 }); continue; }
    const a = frames[ref], b = frames[f];
    let sum = 0, wx = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(a[y * w + x] - b[y * w + x]);
        if (d > 18) { sum += d; wx += d * x; }
      }
    }
    const mag = sum / (w * h * 255);
    out.push({ t: f / fps, x: sum > 255 * 6 ? wx / sum / (w - 1) : null, mag });
  }
  return out;
}

/* fill gaps, smooth, rate-limit, then simplify to keyframes. points: [{t, x}] with x 0..1 or null. */
export function smoothPath(points, duration, { speed = 0.3, dead = 0.04, alpha = 0.4 } = {}) {
  const known = points.filter((p) => p.x !== null && p.x !== undefined);
  if (!known.length) return null;
  let last = known[0].x;
  const filled = points.map((p) => { if (p.x !== null && p.x !== undefined) last = p.x; return { t: p.t, x: last }; });
  // EMA
  let ema = filled[0].x;
  const sm = filled.map((p) => { ema = alpha * p.x + (1 - alpha) * ema; return { t: p.t, x: ema }; });
  // camera: hold inside the dead-zone, otherwise move toward the target at a limited speed
  let cam = sm[0].x;
  const path = [];
  for (let i = 0; i < sm.length; i++) {
    const dt = i ? sm[i].t - sm[i - 1].t : 0;
    const diff = sm[i].x - cam;
    if (Math.abs(diff) > dead) cam += Math.sign(diff) * Math.min(Math.abs(diff) - dead * 0.5, speed * dt);
    path.push({ t: sm[i].t, x: cam });
  }
  if (duration > path[path.length - 1].t + 1e-3) path.push({ t: duration, x: path[path.length - 1].x });
  /* the dead-zone makes the camera move in small steps: a short moving average turns them into a smooth glide */
  const R = 2;
  const glide = path.map((p, i) => {
    if (i === 0 || i === path.length - 1) return p;
    let sum = 0, n = 0;
    const r = Math.min(R, i, path.length - 1 - i);
    for (let k = i - r; k <= i + r; k++) { sum += path[k].x; n++; }
    return { t: p.t, x: sum / n };
  });
  return simplify(glide, 0.02);
}

/* Ramer–Douglas–Peucker on (t, x) */
export function simplify(pts, eps) {
  if (pts.length <= 2) return pts;
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const rec = (a, b) => {
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const t = (pts[i].t - pts[a].t) / Math.max(1e-9, pts[b].t - pts[a].t);
      const d = Math.abs(pts[i].x - (pts[a].x + t * (pts[b].x - pts[a].x)));
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps && mi > 0) { keep[mi] = true; rec(a, mi); rec(mi, b); }
  };
  rec(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

/* face samples [{t,cx}] → points with gaps (null) for frames without a face */
export function facePoints(samples, duration, fps) {
  const n = Math.max(1, Math.floor(duration * fps) + 1);
  const arr = Array.from({ length: n }, (_, i) => ({ t: i / fps, x: null }));
  for (const s of samples) { const i = Math.round(s.t * fps); if (arr[i]) arr[i].x = s.cx; }
  return arr;
}

/*
  planCrop: source size + sampled information → how to turn the clip into the target aspect.
  Returns { mode: 'passthrough'|'crop'|'blur', cropW, cropH, keys:[{t,x}] (x = left edge in source px), subject: 'face'|'motion'|'center'|'none' }
*/
export function planCrop({ srcW, srcH, aspect, reframe, motion, faces, duration, fps }) {
  const [a, b] = ASPECTS[aspect] || ASPECTS['9:16'];
  const target = a / b, src = srcW / srcH;
  if (Math.abs(src - target) / target < 0.03) return { mode: 'passthrough', subject: 'none', keys: [] };
  if (reframe === 'blur' || src < target) return { mode: 'blur', subject: 'none', keys: [] };
  const cropH = srcH - (srcH % 2);
  const cropW = Math.min(srcW, Math.round((cropH * target) / 2) * 2);
  const maxX = srcW - cropW;
  if (reframe === 'center') return { mode: 'crop', cropW, cropH, keys: [{ t: 0, x: maxX / 2 }, { t: duration, x: maxX / 2 }], subject: 'center' };
  let subject = 'center', pathN = null;
  if (faces && faces.samples && faces.samples.length >= Math.max(2, Math.floor(duration * fps * 0.25))) {
    pathN = smoothPath(facePoints(faces.samples, duration, fps), duration, { speed: 0.35, dead: 0.05 });
    if (pathN) subject = 'face';
  }
  if (!pathN && motion) {
    const act = motion.filter((m) => m.x !== null).length;
    if (act >= Math.max(2, motion.length * 0.15)) { pathN = smoothPath(motion.map((m) => ({ t: m.t, x: m.x })), duration, { speed: 0.25, dead: 0.06 }); if (pathN) subject = 'motion'; }
  }
  if (!pathN) return { mode: 'crop', cropW, cropH, keys: [{ t: 0, x: maxX / 2 }, { t: duration, x: maxX / 2 }], subject: 'center' };
  const keys = pathN.map((p) => ({ t: round(p.t, 2), x: round(clamp(p.x * srcW - cropW / 2, 0, maxX), 1) }));
  return { mode: 'crop', cropW, cropH, keys, subject };
}

/* ffmpeg expression for the crop x position (piecewise linear in time t) */
export function cropXExpr(keys) {
  if (keys.length === 1 || keys.every((k) => k.x === keys[0].x)) return String(Math.round(keys[0].x));
  let expr = String(round(keys[keys.length - 1].x, 1));
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i], b = keys[i + 1];
    const dt = Math.max(0.001, b.t - a.t);
    expr = 'if(lt(t,' + b.t + '),' + a.x + '+(' + round(b.x - a.x, 1) + ')*(t-' + a.t + ')/' + round(dt, 3) + ',' + expr + ')';
  }
  return expr;
}

/* filter_complex script for one clip */
export function buildGraph({ plan, out, captions }) {
  const parts = [];
  if (plan.mode === 'passthrough') parts.push('[0:v]scale=' + out.w + ':' + out.h + ':flags=lanczos,setsar=1[vb]');
  else if (plan.mode === 'crop') {
    const x = cropXExpr(plan.keys).replace(/,/g, '\\,');
    parts.push('[0:v]crop=w=' + plan.cropW + ':h=' + plan.cropH + ':x=' + x + ':y=0,scale=' + out.w + ':' + out.h + ':flags=lanczos,setsar=1[vb]');
  } else {
    parts.push('[0:v]split=2[a][b]');
    parts.push('[a]scale=' + out.w + ':' + out.h + ':force_original_aspect_ratio=increase,crop=' + out.w + ':' + out.h + ',scale=' + Math.round(out.w / 6 / 2) * 2 + ':' + Math.round(out.h / 6 / 2) * 2 + ',boxblur=6:2,scale=' + out.w + ':' + out.h + ',eq=brightness=-0.06[bg]');
    parts.push('[b]scale=' + out.w + ':' + out.h + ':force_original_aspect_ratio=decrease:flags=lanczos[fg]');
    parts.push('[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[vb]');
  }
  if (captions) parts.push('[vb]ass=' + captions.file + (captions.fontsDir ? ':fontsdir=' + captions.fontsDir : '') + '[vout]');
  else parts.push('[vb]null[vout]');
  return parts.join(';\n');
}

let faceOk = null;
export function faceAvailable(cfg) {
  if (cfg.face.mode === 'off') return false;
  if (faceOk === null) {
    const r = spawnSync(cfg.face.python, ['-c', 'import cv2'], { stdio: 'ignore', timeout: 15000 });
    faceOk = r.status === 0;
  }
  return faceOk;
}

export async function detectFaces(cfg, file, { start, duration, signal }) {
  if (!faceAvailable(cfg)) return null;
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-face-'));
  try {
    const fps = 2;
    const r = await run(cfg.ffmpeg, ['-nostdin', '-y', '-ss', String(start), '-t', String(duration), '-i', file, '-an', '-sn', '-vf', 'fps=' + fps + ',scale=480:-2', '-q:v', '5', path.join(dir, 'frame_%04d.jpg')], { signal });
    if (r.code !== 0) return null;
    const p = await run(cfg.face.python, [path.join(HERE, '..', 'tools', 'face_track.py'), dir, String(fps)], { signal, collectStdout: true });
    if (p.code !== 0) return null;
    const j = JSON.parse(p.stdout.trim().split('\n').pop());
    return j.ok ? { fps, samples: j.samples } : null;
  } catch (e) { if (e && e.name === 'AbortError') throw e; return null; }
  finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

export async function sampleMotion(cfg, file, { start, duration, signal }) {
  const fps = 4;
  const g = await grayFrames(cfg, file, { start, duration, fps, signal });
  return { fps, motion: motionTrack(g) };
}
