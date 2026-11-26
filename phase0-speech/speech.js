/*
  ClipGen AI · speech-caption test · speech recognition client (runs on the page, talks to asr-worker.js).

  Models (all open-source Whisper, quantized for phones):
    tiny.en  ≈ 40 MB   English only, fastest
    base.en  ≈ 80 MB   English only, more accurate
    tiny     ≈ 40 MB   other languages, auto-detect (Latin letters only get a caption font for now)
    base     ≈ 80 MB   other languages, auto-detect
*/

export const MODELS = {
  'tiny.en': { id: 'Xenova/whisper-tiny.en', multilingual: false, label: 'English · fast (≈40 MB)' },
  'base.en': { id: 'Xenova/whisper-base.en', multilingual: false, label: 'English · better (≈80 MB)' },
  'tiny':    { id: 'Xenova/whisper-tiny',    multilingual: true,  label: 'Other languages · fast (≈40 MB)' },
  'base':    { id: 'Xenova/whisper-base',    multilingual: true,  label: 'Other languages · better (≈80 MB)' }
};

// Test hook: the automated tests inject a stand-in recognizer. Never set on a real page.
const testHook = () => (typeof window !== 'undefined' && window.__CLIPGEN_TEST__ && window.__CLIPGEN_TEST__.recognize) || null;

/**
 * createRecognizer({ model: 'tiny.en', language: 'auto', onStatus(text), onProgress({loadedMB,totalMB}) })
 *   .init()  -> { lib }
 *   .recognize(Float32Array) -> { text, chunks, lib, ms }
 *   .dispose()
 */
export function createRecognizer(options) {
  const o = options || {};
  const spec = MODELS[o.model] || MODELS['tiny.en'];
  const hook = testHook();
  if (hook) {
    return {
      init: async () => ({ lib: 'test-hook' }),
      recognize: async (audio) => Object.assign({ lib: 'test-hook', ms: 0 }, await hook(audio, { model: o.model, language: o.language })),
      dispose: () => {}
    };
  }
  let worker = null;
  let pending = null;
  const files = new Map();
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'status') { if (o.onStatus) o.onStatus(m.text); }
      else if (m.type === 'progress') {
        files.set(m.file, { loaded: m.loaded || 0, total: m.total || 0 });
        let l = 0, t = 0; for (const f of files.values()) { l += f.loaded; t += f.total; }
        if (o.onProgress) o.onProgress({ loadedMB: l / 1048576, totalMB: t / 1048576 });
      } else if (pending && (m.type === 'ready' || m.type === 'result')) { const p = pending; pending = null; p.resolve(m); }
      else if (pending && m.type === 'error') { const p = pending; pending = null; p.reject(new Error(m.error)); }
    };
    worker.onerror = (ev) => {
      if (ev.preventDefault) ev.preventDefault();
      const e = new Error('The speech worker crashed: ' + (ev.message || 'unknown error') + ' (a browser that cannot run module workers, or the phone ran out of memory)');
      if (pending) { const p = pending; pending = null; p.reject(e); }
    };
    return worker;
  };
  const send = (message, transfer) => new Promise((resolve, reject) => {
    pending = { resolve, reject };
    try { ensure().postMessage(message, transfer || []); } catch (e) { pending = null; reject(e); }
  });
  return {
    init: async () => { const r = await send({ op: 'init', model: spec.id }); return { lib: r.lib }; },
    recognize: async (audio) => {
      const copy = audio.slice();   // keep our copy for the sync check; the worker gets its own
      const r = await send({ op: 'run', audio: copy, multilingual: spec.multilingual, language: o.language }, [copy.buffer]);
      return { text: r.text, chunks: r.chunks, lib: r.lib, ms: r.ms, timing: r.timing || 'word' };
    },
    dispose: () => { try { if (worker) worker.terminate(); } catch (_) { /* ignore */ } worker = null; }
  };
}
