/*
  ClipGen AI backend · FFmpeg / FFprobe helpers.
  Everything here runs the real ffmpeg binary on the real file. Nothing is simulated.
*/
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { ApiError, round } from './util.js';

function abortErr() { return Object.assign(new Error('Cancelled'), { name: 'AbortError' }); }

/* run a binary; collects stdout (optionally) and stderr tail; resolves {code, stdout, stderr} */
export function run(bin, args, { signal, onStdoutLine, onStderrLine, collectStdout = false, maxStdout = 4_000_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortErr());
    let child;
    try { child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd }); }
    catch (e) { return reject(new ApiError(500, 'spawn-failed', 'Could not start ' + bin + ': ' + e.message)); }
    let out = '', err = '', outBuf = '', errBuf = '';
    const feed = (buf, chunk, cb) => { buf += chunk; const parts = buf.split(/\r\n|\n|\r/); buf = parts.pop(); if (cb) for (const l of parts) cb(l); return buf; };
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      if (collectStdout && out.length < maxStdout) out += s;
      outBuf = feed(outBuf, s, onStdoutLine);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8');
      err = (err + s).slice(-6000);
      errBuf = feed(errBuf, s, onStderrLine);
    });
    const onAbort = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (e) => { if (signal) signal.removeEventListener('abort', onAbort); reject(e.code === 'ENOENT' ? new ApiError(500, 'binary-missing', bin + ' is not installed on the server.') : e); });
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal && signal.aborted) return reject(abortErr());
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

const lastLines = (s, n = 4) => String(s).trim().split('\n').slice(-n).join(' | ').slice(0, 500);

/* ffprobe → normalized media info; throws a friendly ApiError when the file is not a usable video */
export async function probe(cfg, file, { signal } = {}) {
  const r = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { signal, collectStdout: true });
  if (r.code !== 0) throw new ApiError(422, 'not-a-video', 'This file could not be read as a video (' + lastLines(r.stderr, 2) + '). It may be corrupt, protected, or not a video format ClipGen AI supports.');
  let j;
  try { j = JSON.parse(r.stdout); } catch (_) { throw new ApiError(422, 'not-a-video', 'This file could not be read as a video.'); }
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic !== 1) || (j.streams || []).find((s) => s.codec_type === 'video');
  if (!v) throw new ApiError(422, 'no-video-stream', 'This file has no video track (audio-only files are not supported).');
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fmt = j.format || {};
  let duration = Number(fmt.duration) || Number(v.duration) || 0;
  const [n, d] = String(v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  let rot = 0;
  if (v.tags && v.tags.rotate) rot = Number(v.tags.rotate) || 0;
  for (const sd of v.side_data_list || []) if (typeof sd.rotation === 'number') rot = sd.rotation;
  let width = v.width || 0, height = v.height || 0;
  if (Math.abs(rot) % 180 === 90) { const t = width; width = height; height = t; }
  if (!duration || !isFinite(duration)) throw new ApiError(422, 'no-duration', 'The length of this video could not be determined (the file may be incomplete).');
  return {
    duration: round(duration, 3), width, height, rotation: rot, fps: d ? round(n / d, 2) : null,
    vcodec: v.codec_name, acodec: a ? a.codec_name : null, hasAudio: !!a,
    bitrate: Number(fmt.bit_rate) || null, container: fmt.format_name || null,
    title: (fmt.tags && (fmt.tags.title || fmt.tags.TITLE)) || null, size: Number(fmt.size) || null
  };
}

export async function thumbnail(cfg, file, t, out, { width = 480, signal } = {}) {
  const r = await run(cfg.ffmpeg, ['-nostdin', '-y', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', 'scale=' + width + ':-2', '-q:v', '4', out], { signal });
  if (r.code !== 0) {
    // seeking past the end can yield no frame: retry from the start
    const r2 = await run(cfg.ffmpeg, ['-nostdin', '-y', '-i', file, '-frames:v', '1', '-vf', 'scale=' + width + ':-2', '-q:v', '4', out], { signal });
    if (r2.code !== 0) throw new ApiError(500, 'thumbnail-failed', 'Could not create a thumbnail: ' + lastLines(r2.stderr, 2));
  }
  return out;
}

/* progress from "-progress pipe:1": out_time_us=…  */
function progressParser(duration, cb) {
  return (line) => {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
    if (m && duration > 0 && cb) cb(Math.min(1, Number(m[1]) / 1e6 / duration));
  };
}

export async function extractWav(cfg, file, out, { duration, signal, onProgress } = {}) {
  const r = await run(cfg.ffmpeg, ['-nostdin', '-y', '-i', file, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-progress', 'pipe:1', '-nostats', out],
    { signal, onStdoutLine: progressParser(duration, onProgress) });
  if (r.code !== 0) throw new ApiError(422, 'audio-failed', 'The audio of this video could not be decoded: ' + lastLines(r.stderr, 2));
  return out;
}

/* locate the PCM data inside a WAV file */
async function wavData(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(head, 0, 4096, 0);
    if (head.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a wav');
    let pos = 12;
    while (pos + 8 <= bytesRead) {
      const id = head.toString('ascii', pos, pos + 4), size = head.readUInt32LE(pos + 4);
      if (id === 'data') return { offset: pos + 8, length: size };
      pos += 8 + size + (size % 2);
    }
    throw new Error('no data chunk');
  } finally { await fh.close(); }
}

/*
  Loudness windows from the 16 kHz mono wav: RMS and peak in dBFS per windowSec.
  Streams the file (never loads it whole), so memory stays flat for long videos.
*/
export async function loudnessWindows(wavFile, { windowSec = 0.25, signal } = {}) {
  const { offset, length } = await wavData(wavFile);
  const sr = 16000, win = Math.round(sr * windowSec);
  const total = Math.floor(Math.min(length, (await fsp.stat(wavFile)).size - offset) / 2);
  const rms = [], peak = [];
  let acc = 0, cnt = 0, pk = 0, carry = null;
  const push = () => {
    if (!cnt) return;
    const r = Math.sqrt(acc / cnt) / 32768, p = pk / 32768;
    rms.push(round(r > 1e-6 ? 20 * Math.log10(r) : -120, 1)); peak.push(round(p > 1e-6 ? 20 * Math.log10(p) : -120, 1));
    acc = 0; cnt = 0; pk = 0;
  };
  const stream = fs.createReadStream(wavFile, { start: offset, end: offset + total * 2 - 1, highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    if (signal && signal.aborted) { stream.destroy(); throw abortErr(); }
    let buf = chunk;
    if (carry) { buf = Buffer.concat([carry, chunk]); carry = null; }
    const n = Math.floor(buf.length / 2);
    if (buf.length % 2) carry = buf.subarray(buf.length - 1);
    for (let i = 0; i < n; i++) {
      const s = buf.readInt16LE(i * 2);
      acc += s * s; cnt++; const a = s < 0 ? -s : s; if (a > pk) pk = a;
      if (cnt === win) push();
    }
  }
  push();
  return { windowSec, rmsDb: rms, peakDb: peak, samples: total };
}

/* scene cuts: ffmpeg's scene score on a downscaled 4 fps copy (fast even for long videos) */
export async function detectScenes(cfg, file, { duration, threshold = 0.3, signal, onProgress } = {}) {
  const times = [];
  const r = await run(cfg.ffmpeg, ['-nostdin', '-i', file, '-an', '-sn', '-vf', 'fps=4,scale=320:-2,select=gt(scene\\,' + threshold + '),showinfo', '-f', 'null', '-', '-progress', 'pipe:1', '-nostats'], {
    signal,
    onStdoutLine: progressParser(duration, onProgress),
    onStderrLine: (l) => { const m = /Parsed_showinfo.*pts_time:([\d.]+)/.exec(l); if (m) times.push(round(Number(m[1]), 2)); }
  });
  if (r.code !== 0) throw new ApiError(500, 'scene-failed', 'Scene analysis failed: ' + lastLines(r.stderr, 2));
  return times;
}

/* raw gray frames at low resolution for a time range (used for motion tracking). Returns {frames:[Uint8Array], w, h, fps, t0} */
export async function grayFrames(cfg, file, { start, duration, fps = 4, w = 96, signal }) {
  const h = 54;
  const args = ['-nostdin', '-ss', String(start), '-t', String(duration), '-i', file, '-an', '-sn', '-vf', 'fps=' + fps + ',scale=' + w + ':' + h + ',format=gray', '-f', 'rawvideo', '-'];
  const frames = [];
  await new Promise((resolve, reject) => {
    const child = spawn(cfg.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0); const fsz = w * h;
    const abort = () => { try { child.kill('SIGKILL'); } catch (_) { /* ignore */ } reject(abortErr()); };
    if (signal) { if (signal.aborted) return abort(); signal.addEventListener('abort', abort, { once: true }); }
    child.stdout.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; while (buf.length >= fsz) { frames.push(Uint8Array.from(buf.subarray(0, fsz))); buf = buf.subarray(fsz); } });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', () => { if (signal) signal.removeEventListener('abort', abort); resolve(); });
  });
  return { frames, w, h, fps, t0: start };
}
