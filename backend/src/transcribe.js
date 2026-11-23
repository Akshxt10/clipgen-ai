/*
  ClipGen AI backend · speech-to-text with whisper.cpp (open source, runs on the server's CPU, no paid API).

  The Docker image builds whisper.cpp and downloads a model; see backend/DEPLOY.md. This module:
    - reports honestly whether a transcription engine is available (binary + model present)
    - runs `whisper-cli` on the 16 kHz wav and parses its full JSON output (`-ojf`) into words with timestamps
    - falls back from token timestamps to segment timestamps (words spread across the segment) when needed
  NOTE for maintainers: parseWhisperJson() is unit-tested against the documented whisper.cpp JSON layout, but the
  whisper binary itself could not be executed in the development sandbox (no model could be downloaded there).
*/
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { run } from './media.js';
import { ApiError, round } from './util.js';

const SPECIAL = /^(\[_[A-Z_]+_?\d*\]|<\|[^|]*\|>|\[BLANK_AUDIO\]|\[ ?(?:MUSIC|Music|music)\s*\])$/;
const NOISE_ONLY = /^[\s♪]*$/;

function ms(v) { return Number(v) / 1000; }

/* token list → words. A new word starts at a token whose text begins with a space (BPE convention). */
function tokensToWords(tokens, segStart, segEnd) {
  const words = [];
  let cur = null;
  const flush = () => { if (cur && cur.w.trim()) words.push({ w: cur.w.trim(), s: cur.s, e: cur.e, p: cur.n ? round(cur.p / cur.n, 3) : null }); cur = null; };
  for (const t of tokens) {
    const text = String(t.text == null ? '' : t.text);
    if (SPECIAL.test(text.trim()) || (t.id != null && t.id >= 50257 && !/[A-Za-z0-9]/.test(text))) continue;
    const s = t.offsets ? ms(t.offsets.from) : null, e = t.offsets ? ms(t.offsets.to) : null;
    const startsWord = /^\s/.test(text) || !cur;
    if (startsWord) { flush(); cur = { w: text, s: s == null ? segStart : s, e: e == null ? segEnd : e, p: 0, n: 0 }; }
    else cur.w += text;
    if (e != null) cur.e = Math.max(cur.e, e);
    if (typeof t.p === 'number') { cur.p += t.p; cur.n += 1; }
  }
  flush();
  /* tokens often carry 0-length or overlapping stamps: make words monotonic and inside the segment */
  let prev = segStart;
  for (const w of words) {
    if (w.s < prev) w.s = prev;
    if (w.e < w.s) w.e = w.s;
    prev = w.e;
  }
  return words;
}

/* no usable token times: spread the words over the segment in proportion to their length */
function spreadWords(text, s, e) {
  const parts = String(text).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return [];
  const total = parts.reduce((a, p) => a + p.length + 1, 0);
  let t = s;
  return parts.map((p) => { const d = ((p.length + 1) / total) * (e - s); const w = { w: p, s: round(t, 3), e: round(t + d, 3), p: null }; t += d; return w; });
}

export function parseWhisperJson(json) {
  const segs = Array.isArray(json && json.transcription) ? json.transcription : [];
  const words = [], segments = [];
  for (const seg of segs) {
    const s = seg.offsets ? ms(seg.offsets.from) : 0, e = seg.offsets ? ms(seg.offsets.to) : s;
    const text = String(seg.text || '').trim();
    if (!text || NOISE_ONLY.test(text) || SPECIAL.test(text)) continue;
    let ws = Array.isArray(seg.tokens) ? tokensToWords(seg.tokens, s, e) : [];
    const spanOk = ws.length && ws.some((w) => w.e - w.s > 0.01) && ws[0].s >= s - 0.5 && ws[ws.length - 1].e <= e + 1.0;
    if (!spanOk) ws = spreadWords(text, s, e);
    ws.forEach((w) => { w.s = round(w.s, 3); w.e = round(w.e, 3); });
    segments.push({ s: round(s, 3), e: round(e, 3), text });
    words.push(...ws);
  }
  return { language: (json && json.result && json.result.language) || null, words, segments };
}

export class WhisperCpp {
  constructor(cfg) { this.cfg = cfg; this.name = 'whisper.cpp'; }
  modelName() { return this.cfg.whisper.model ? path.basename(this.cfg.whisper.model) : null; }
  available() {
    const w = this.cfg.whisper;
    if (!w.model || !fs.existsSync(w.model)) return { ok: false, reason: 'No speech model found (set WHISPER_MODEL_PATH).' };
    const r = spawnSync(w.bin, ['--help'], { stdio: 'ignore' });
    if (r.error && r.error.code === 'ENOENT') return { ok: false, reason: 'The whisper.cpp binary “' + w.bin + '” is not installed.' };
    return { ok: true, model: this.modelName(), multilingual: !/\.en\./.test(this.modelName() || '') };
  }
  async transcribe(wavPath, { language = 'auto', signal, onProgress, outDir }) {
    const av = this.available();
    if (!av.ok) throw new ApiError(503, 'transcription-unavailable', 'Transcription is not available on this server. ' + av.reason);
    if (language !== 'auto' && language !== 'en' && !av.multilingual) throw new ApiError(400, 'language-unsupported', 'The installed speech model is English-only. Use language “English” or install a multilingual model.');
    const prefix = path.join(outDir || path.dirname(wavPath), 'whisper-out');
    const args = ['-m', this.cfg.whisper.model, '-f', wavPath, '-l', language === 'auto' ? 'auto' : language, '-t', String(this.cfg.whisper.threads), '-ojf', '-of', prefix, '-pp'];
    const r = await run(this.cfg.whisper.bin, args, {
      signal,
      onStderrLine: (l) => { const m = /progress\s*=\s*(\d+)%/.exec(l); if (m && onProgress) onProgress(Number(m[1]) / 100); }
    });
    if (r.code !== 0) throw new ApiError(500, 'transcription-failed', 'The speech recognizer failed (exit ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-2).join(' | ').slice(0, 300));
    let json;
    try { json = JSON.parse(await fsp.readFile(prefix + '.json', 'utf8')); } catch (e) { throw new ApiError(500, 'transcription-failed', 'The speech recognizer produced no readable result.'); }
    const out = parseWhisperJson(json);
    out.engine = { name: this.name, model: av.model };
    return out;
  }
}

export function createTranscriber(cfg) { return new WhisperCpp(cfg); }
