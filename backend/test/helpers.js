/* test helpers: real ffmpeg synthetic videos, a real HTTP server on a random port, a deterministic transcriber double */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../src/config.js';
import { createApp, createServer } from '../src/server.js';

export const tmp = (p = 'cg-test-') => fs.mkdtempSync(path.join(os.tmpdir(), p));

/*
  makeVideo: size WxH, `dur` seconds, a bright box moving left→right (so smart framing has something to follow),
  audio = tone bursts. bursts: [[startSec, endSec, amplitude]]
*/
export function makeVideo(file, { w = 1280, h = 720, dur = 40, fps = 25, bursts, audio = true, vcodec = 'libx264', extra = [] } = {}) {
  bursts = bursts || [[1, 9, 0.35], [11, 19, 0.8], [21, 29, 0.5], [31, 39, 0.9]];
  const boxW = Math.round(h / 5);
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x20242c:s=' + w + 'x' + h + ':r=' + fps + ':d=' + dur,
    '-f', 'lavfi', '-i', 'color=c=white:s=' + boxW + 'x' + boxW + ':r=' + fps + ':d=' + dur];
  if (audio) {
    const gate = bursts.map(([a, b, amp]) => 'between(t\\,' + a + '\\,' + b + ')*' + amp).join('+');
    args.push('-f', 'lavfi', '-i', 'aevalsrc=exprs=(' + gate + ')*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*3*t)):s=44100:d=' + dur);
  }
  /* a bright box travels left → right over the whole video, so smart framing has a subject to follow */
  args.push('-filter_complex', "[0:v][1:v]overlay=x='(W-w)*t/" + dur + "':y='(H-h)/2',drawbox=x=0:y=0:w=iw:h=6:color=0x2fd4f0:t=fill[v]", '-map', '[v]');
  if (audio) args.push('-map', '2:a');
  args.push('-c:v', vcodec, '-pix_fmt', 'yuv420p', '-g', String(fps * 2));
  if (audio) args.push('-c:a', 'aac', '-b:a', '96k');
  args.push(...extra, file);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + r.stderr);
  return file;
}

export function probeFile(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { encoding: 'utf8' });
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video'), a = j.streams.find((s) => s.codec_type === 'audio');
  return { w: v.width, h: v.height, dur: Number(j.format.duration), audio: !!a, vcodec: v.codec_name, acodec: a && a.codec_name };
}

/* raw RGB frame at time t → {w,h,data} */
export function frameAt(file, t, { w, h } = {}) {
  const args = ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1'];
  if (w && h) args.push('-vf', 'scale=' + w + ':' + h);
  args.push('-f', 'rawvideo', '-pix_fmt', 'rgb24', '-');
  const r = spawnSync('ffmpeg', args, { maxBuffer: 1 << 28 });
  const info = probeFile(file);
  return { w: w || info.w, h: h || info.h, data: r.stdout };
}

/* a script with speech-like segments aligned to the audio bursts. Returns words [{w,s,e}] */
export const SCRIPT = [
  { s: 1.2, text: 'Here is the secret nobody tells you about saving money. The biggest mistake is ignoring small costs. Why does this matter? Because ten dollars a day becomes three thousand six hundred and fifty dollars a year.' },
  { s: 11.2, text: 'Wow, I cannot believe what happened next! We were walking down the street and suddenly the whole crowd started laughing. It was the funniest and most surprising moment of my life, honestly.' },
  { s: 21.2, text: 'So the first step is to track every expense. Second, set a weekly budget. Third, review the results every Sunday. This simple system works because it removes guesswork and builds a habit.' },
  { s: 31.2, text: 'I remember the day we lost everything. It was a terrible night and I was crying. Then my friend called and said we will get through this together. That moment changed my life forever.' }
];
export function scriptWords(script = SCRIPT, perSeg = 7.6) {
  const words = [];
  for (const seg of script) {
    const toks = seg.text.split(/\s+/);
    const step = perSeg / toks.length;
    toks.forEach((t, i) => words.push({ w: t, s: Math.round((seg.s + i * step) * 1000) / 1000, e: Math.round((seg.s + (i + 1) * step - 0.05) * 1000) / 1000 }));
  }
  return words;
}
/* transcriber double (tests only): returns the scripted words, exactly like WhisperCpp's output shape */
export function fakeTranscriber(words = scriptWords(), { fail, delayMs = 0 } = {}) {
  return {
    name: 'test-double',
    available: () => (fail === 'unavailable' ? { ok: false, reason: 'not installed (test)' } : { ok: true, model: 'ggml-test.bin', multilingual: true }),
    async transcribe(wav, { onProgress }) {
      if (fail === 'error') throw new Error('boom');
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (onProgress) onProgress(1);
      return { language: 'en', words, segments: [], engine: { name: 'test-double', model: 'ggml-test.bin' } };
    }
  };
}

export async function startServer({ cfg = {}, transcriber, token } = {}) {
  const dataDir = tmp('cg-data-');
  const config = loadConfig(Object.assign({ dataDir, port: 0, host: '127.0.0.1', allowedOrigins: ['https://akshxt10.github.io'], accessToken: token || '', allowPrivateUrls: true, log: 'silent', face: { mode: 'auto', python: 'python3' } }, cfg));
  const app = await createApp(config, { transcriber: transcriber || fakeTranscriber() });
  const server = createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  const api = async (method, p, body, extra = {}) => {
    const res = await fetch(base + p, { method, headers: Object.assign({}, headers, body !== undefined ? { 'Content-Type': 'application/json' } : {}, extra), body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not json */ }
    return { status: res.status, json, headers: res.headers, text };
  };
  const waitJob = async (jobId, timeoutMs = 120000) => {
    const t0 = Date.now();
    for (;;) {
      const r = await api('GET', '/api/jobs/' + jobId);
      const j = r.json.job;
      if (['done', 'error', 'cancelled'].includes(j.state)) return j;
      if (Date.now() - t0 > timeoutMs) throw new Error('job timeout: ' + JSON.stringify(j));
      await new Promise((r2) => setTimeout(r2, 150));
    }
  };
  return { base, app, server, api, waitJob, config, headers, close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(r); }) };
}

/* a plain static file server (Range support) standing in for "someone's public video URL" */
export function fileServer(routes) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const r = routes[u.pathname];
    if (!r) { res.writeHead(404); return res.end('nope'); }
    if (typeof r === 'function') return r(req, res);
    const st = fs.statSync(r.file);
    const type = r.type || 'video/mp4';
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const a = Number(range[1]), b = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { 'Content-Type': type, 'Content-Range': 'bytes ' + a + '-' + b + '/' + st.size, 'Content-Length': b - a + 1 });
      return fs.createReadStream(r.file, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    fs.createReadStream(r.file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }) })));
}
