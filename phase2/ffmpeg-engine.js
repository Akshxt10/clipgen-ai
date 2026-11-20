/*
  ClipGen AI · Phase 1 · FFmpeg.wasm engine loader (ES module).

  Mirrors the engine code in Phase 0 (which is proven on iPhone Safari):
    1. download the single-thread core (ffmpeg-core.js + .wasm) from a free CDN, with CDN/version fallbacks
    2. start it in our own worker (ffmpeg-worker.js); if that fails, fall back to the official @ffmpeg/ffmpeg wrapper
  The downloaded core is kept in memory for the page's lifetime, so the 2nd analysis does not download again
  (the browser HTTP cache also keeps it between visits).

  Nothing here is paid or needs a server. No SharedArrayBuffer / COOP / COEP needed (single-thread).
*/

const CORE_SOURCES = [
  { id: 'jsDelivr · core 0.12.10', base: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd' },
  { id: 'unpkg · core 0.12.10',    base: 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd' },
  { id: 'jsDelivr · core 0.12.6',  base: 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd' },
  { id: 'unpkg · core 0.12.6',     base: 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd' }
];
const WRAPPER_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/umd',
  'https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd'
];
const START_TIMEOUT_MS = 120000;

let coreCache = null; // { src, coreURL, wasmURL, jsBytes, wasmBytes, downloadMs }

const msg = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };
const withTimeout = (p, ms, what) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(what + ' timed out after ' + Math.round(ms / 1000) + ' s')), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});
// Test hook: the automated tests inject a stand-in engine. Never set on a real page.
const testHook = () => (typeof window !== 'undefined' && window.__CLIPGEN_TEST__ && window.__CLIPGEN_TEST__.engine) || null;

export function isCoreCached() { return !!coreCache; }

async function fetchBlob(url, type, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !res.body.getReader) {
    const b = await res.blob();
    if (onProgress) onProgress(b.size, b.size);
    return new Blob([b], { type });
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (onProgress) onProgress(got, total);
  }
  return new Blob(chunks, { type });
}

/** Downloads the core once. onStatus({ text, fraction }) is optional. */
export async function downloadCore(onStatus) {
  if (testHook()) return { src: { id: 'test-hook' }, cached: true, wasmBytes: 0, jsBytes: 0, downloadMs: 0 };
  if (coreCache) return Object.assign({ cached: true }, coreCache);
  const errors = [];
  for (const src of CORE_SOURCES) {
    try {
      const t0 = performance.now();
      if (onStatus) onStatus({ text: 'Downloading the video engine (one time, ~32 MB) …', fraction: 0 });
      const js = await fetchBlob(src.base + '/ffmpeg-core.js', 'text/javascript');
      const wasm = await fetchBlob(src.base + '/ffmpeg-core.wasm', 'application/wasm', (got, total) => {
        if (onStatus) {
          const mb = (got / 1e6).toFixed(1);
          onStatus({ text: 'Downloading the video engine … ' + mb + (total ? ' / ' + (total / 1e6).toFixed(1) : '') + ' MB', fraction: total ? Math.min(0.99, got / total) : null });
        }
      });
      coreCache = {
        src,
        coreURL: URL.createObjectURL(js),
        wasmURL: URL.createObjectURL(wasm),
        jsBytes: js.size,
        wasmBytes: wasm.size,
        downloadMs: performance.now() - t0
      };
      return Object.assign({ cached: false }, coreCache);
    } catch (e) {
      errors.push(src.id + ': ' + msg(e));
    }
  }
  throw new Error('Could not download the video engine from any CDN (' + (navigator.onLine ? 'online' : 'OFFLINE') + ').\n' + errors.join('\n'));
}

/* ---------- engine 1: our own worker ---------- */
function createCustomEngine(core, hooks) {
  const worker = new Worker(new URL('./ffmpeg-worker.js', import.meta.url));
  let nextId = 1;
  const pending = new Map();
  let dead = null;
  const failAll = (err) => { dead = err; for (const p of pending.values()) p.reject(err); pending.clear(); };

  worker.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'log') hooks.onLog(m.msg);
    else if (m.type === 'progress') hooks.onProgress(m.data);
    else if (m.type === 'result') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.value);
    }
  };
  worker.onerror = (ev) => {
    if (ev.preventDefault) ev.preventDefault();
    failAll(new Error('Worker crashed: ' + (ev.message || 'unknown error')));
  };
  const call = (op, args, transfer) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = nextId++;
    pending.set(id, { resolve, reject });
    try { worker.postMessage({ id, op, args }, transfer || []); } catch (e) { pending.delete(id); reject(e); }
  });

  const engine = {
    name: 'custom-worker',
    exec: (args) => call('exec', { args }),
    writeFile: (name, data) => {
      if (data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength) data = data.slice();
      return call('writeFile', { name, data }, [data.buffer]);
    },
    readFile: (name) => call('readFile', { name }),
    deleteFile: (name) => call('deleteFile', { name }),
    mkdir: (path) => call('mkdir', { path }),
    mount: (path, options) => call('mount', { path, options }),
    unmount: (path) => call('unmount', { path }),
    memInfo: () => call('memInfo', {}),
    terminate: () => { failAll(new Error('Cancelled')); try { worker.terminate(); } catch (_) { /* ignore */ } }
  };
  return call('load', { coreURL: core.coreURL, wasmURL: core.wasmURL }).then(() => engine, (e) => { engine.terminate(); throw e; });
}

/* ---------- engine 2: official @ffmpeg/ffmpeg wrapper (fallback) ---------- */
function loadScriptTag(url) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => res();
    s.onerror = () => rej(new Error('failed to load ' + url));
    document.head.appendChild(s);
  });
}
async function createOfficialEngine(core, hooks) {
  let lastErr = null;
  if (!(window.FFmpegWASM && window.FFmpegWASM.FFmpeg)) {
    for (const base of WRAPPER_BASES) {
      try { await loadScriptTag(base + '/ffmpeg.js'); lastErr = null; break; } catch (e) { lastErr = e; }
    }
    if (lastErr) throw lastErr;
  }
  let chunkURL = null;
  for (const base of WRAPPER_BASES) {
    try { chunkURL = URL.createObjectURL(await fetchBlob(base + '/814.ffmpeg.js', 'text/javascript')); break; } catch (e) { lastErr = e; }
  }
  if (!chunkURL) throw lastErr || new Error('wrapper worker chunk not found');
  const ff = new window.FFmpegWASM.FFmpeg();
  ff.on('log', (d) => hooks.onLog(d && d.message !== undefined ? d.message : String(d)));
  ff.on('progress', (d) => hooks.onProgress(d));
  await ff.load({ coreURL: core.coreURL, wasmURL: core.wasmURL, classWorkerURL: chunkURL });
  return {
    name: 'official-wrapper',
    exec: (args) => ff.exec(args),
    writeFile: (n, d) => ff.writeFile(n, d),
    readFile: (n) => ff.readFile(n),
    deleteFile: (n) => ff.deleteFile(n),
    mkdir: (p) => ff.createDir(p),
    mount: (p, o) => ff.mount('WORKERFS', o, p),
    unmount: (p) => ff.unmount(p),
    memInfo: async () => null,
    terminate: () => { try { ff.terminate(); } catch (_) { /* ignore */ } }
  };
}

/**
 * Starts FFmpeg and returns an engine:
 *   { name, exec(args)->exitCode, writeFile, readFile, deleteFile, mkdir, mount(path, {blobs:[{name,data}]}), unmount, memInfo, terminate }
 * options: { onLog(line), onProgress(data), onStatus({text,fraction}) }
 */
export async function createEngine(options) {
  const o = options || {};
  const hooks = { onLog: o.onLog || (() => {}), onProgress: o.onProgress || (() => {}) };
  const core = await downloadCore(o.onStatus);
  const hook = testHook();
  if (hook) return hook.create(hooks);
  if (o.onStatus) o.onStatus({ text: 'Starting the video engine …', fraction: null });
  const fails = [];
  try { return await withTimeout(createCustomEngine(core, hooks), START_TIMEOUT_MS, 'engine start'); }
  catch (e) { fails.push('custom-worker: ' + msg(e)); hooks.onLog('[engine] custom worker failed: ' + msg(e)); }
  try { return await withTimeout(createOfficialEngine(core, hooks), START_TIMEOUT_MS, 'fallback engine start'); }
  catch (e) { fails.push('official-wrapper: ' + msg(e)); hooks.onLog('[engine] official wrapper failed: ' + msg(e)); }
  throw new Error('The video engine could not be started.\n' + fails.join('\n'));
}
