/*
  ClipGen AI backend · configuration. Everything comes from environment variables, so secrets (the optional
  ACCESS_TOKEN, LLM_API_KEY) live in the host's settings and never in the frontend or in the repository.
*/
import os from 'node:os';
import path from 'node:path';

const MB = 1024 * 1024;

export function loadConfig(overrides) {
  const env = process.env;
  const int = (k, d) => { const v = parseInt(env[k] || '', 10); return Number.isFinite(v) && v >= 0 ? v : d; };
  const cpus = Math.max(1, os.cpus().length);
  const cfg = {
    version: '1.0.0',
    port: int('PORT', 8787),
    host: env.HOST || '0.0.0.0',
    dataDir: env.DATA_DIR || path.resolve('data'),
    /* origins allowed to call the API from a browser; '*' allows any */
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://akshxt10.github.io').split(',').map((s) => s.trim()).filter(Boolean),
    /* when set, every /api call except /api/health needs "Authorization: Bearer <ACCESS_TOKEN>" */
    accessToken: env.ACCESS_TOKEN || '',
    signingSecret: env.SIGNING_SECRET || '',
    limits: {
      maxSourceBytes: int('MAX_SOURCE_MB', 1024) * MB,
      maxDurationSec: int('MAX_DURATION_MIN', 120) * 60,
      maxDiskBytes: int('MAX_DISK_MB', 6144) * MB,
      maxProjects: int('MAX_PROJECTS', 30),
      maxConcurrentJobs: Math.max(1, int('MAX_CONCURRENT_JOBS', 1)),
      ttlMs: int('RETENTION_HOURS', 12) * 3600 * 1000,
      uploadChunkBytes: int('UPLOAD_CHUNK_MB', 8) * MB,
      maxClips: 20,
      maxRendersPerProject: int('MAX_RENDERS_PER_PROJECT', 60),
      downloadTimeoutMs: int('DOWNLOAD_TIMEOUT_MIN', 30) * 60 * 1000,
      requestsPerMinute: int('REQUESTS_PER_MINUTE', 600)
    },
    ffmpeg: env.FFMPEG_PATH || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH || 'ffprobe',
    threads: Math.min(cpus, int('FFMPEG_THREADS', 4)),
    renderPreset: env.RENDER_PRESET || 'veryfast',
    whisper: {
      bin: env.WHISPER_BIN || 'whisper-cli',
      model: env.WHISPER_MODEL_PATH || '',
      threads: Math.min(cpus, int('WHISPER_THREADS', 4))
    },
    llm: { url: env.LLM_API_URL || '', key: env.LLM_API_KEY || '', model: env.LLM_MODEL || '', timeoutMs: int('LLM_TIMEOUT_SEC', 40) * 1000 },
    face: { mode: env.FACE_DETECT || 'auto', python: env.PYTHON_BIN || 'python3' },
    fontsDir: env.FONTS_DIR || '',
    /* tests only: lets the URL fetcher reach 127.0.0.1. Never set this on a real deployment. */
    allowPrivateUrls: env.ALLOW_PRIVATE_URLS === '1',
    /* serve the web app from this folder too (the Docker image does, so the backend URL is also a working app) */
    frontendDir: env.FRONTEND_DIR || '',
    /* behind Render / Hugging Face the client address is in X-Forwarded-For */
    trustProxy: env.TRUST_PROXY !== '0',
    log: env.LOG_LEVEL || 'info'
  };
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      if (overrides[k] && typeof overrides[k] === 'object' && !Array.isArray(overrides[k]) && cfg[k] && typeof cfg[k] === 'object') cfg[k] = Object.assign({}, cfg[k], overrides[k]);
      else cfg[k] = overrides[k];
    }
  }
  return cfg;
}
