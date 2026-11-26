/*
  ClipGen AI · speech-caption test · speech recognition worker (module worker).

  Runs OpenAI's open-source Whisper model ON THIS DEVICE through transformers.js (ONNX Runtime WebAssembly).
  No server, no API key, no cost. The library and the model are downloaded once from free public CDNs
  (jsDelivr for the code, Hugging Face for the model) and then cached by the browser.

  Messages in : { op: 'init', model, language }  |  { op: 'run', audio: Float32Array (16 kHz mono), multilingual, language }
  Messages out: { type: 'status', text } · { type: 'progress', file, loaded, total } · { type: 'ready', lib }
                { type: 'result', text, chunks, lib, ms } · { type: 'error', error }
*/

// Tried in order. 2.17.2 is the long-established release with word-level timestamps for Whisper; 3.x is the fallback.
const LIBS = [
  { id: 'transformers.js 2.17.2', url: 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2', major: 2 },
  { id: 'transformers.js 3.0.2', url: 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2', major: 3 }
];

let asr = null;
let libUsed = null;
const post = (m) => self.postMessage(m);
const msg = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };

async function init(model) {
  const problems = [];
  for (const lib of LIBS) {
    try {
      post({ type: 'status', text: 'Loading the speech engine (' + lib.id + ') …' });
      const tf = await import(lib.url);
      const env = tf.env;
      env.allowLocalModels = false;
      env.useBrowserCache = true;
      try { env.backends.onnx.wasm.numThreads = 1; env.backends.onnx.wasm.proxy = false; } catch (_) { /* optional */ }
      const progress_callback = (d) => {
        if (d && d.status === 'progress') post({ type: 'progress', file: d.file, loaded: d.loaded, total: d.total });
      };
      post({ type: 'status', text: 'Downloading / opening the speech model (' + model + ') …' });
      const opts = lib.major === 2 ? { quantized: true, progress_callback } : { dtype: 'q8', device: 'wasm', progress_callback };
      asr = await tf.pipeline('automatic-speech-recognition', model, opts);
      libUsed = lib.id;
      return lib.id;
    } catch (e) {
      problems.push(lib.id + ': ' + msg(e));
      asr = null;
    }
  }
  throw new Error('The speech engine could not be started.\n' + problems.join('\n'));
}

self.onmessage = async (ev) => {
  const m = ev.data || {};
  try {
    if (m.op === 'init') {
      const lib = await init(m.model);
      post({ type: 'ready', lib });
    } else if (m.op === 'run') {
      if (!asr) throw new Error('speech engine not initialised');
      const t0 = performance.now();
      const opts = { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 };
      if (m.multilingual) {
        opts.task = 'transcribe';
        if (m.language && m.language !== 'auto') opts.language = m.language;
      }
      let out, timing = 'word';
      try {
        out = await asr(m.audio, opts);
        const ok = out && Array.isArray(out.chunks) && out.chunks.some((c) => c && c.timestamp && Number.isFinite(c.timestamp[0]));
        if (!ok) throw new Error('no word-level timestamps returned');
      } catch (e) {
        // Fallback: phrase-level timestamps, then spread each phrase's words by letter count. Marked as approximate.
        post({ type: 'status', text: 'Word timestamps unavailable (' + msg(e) + ') — using phrase timing …' });
        opts.return_timestamps = true;
        out = await asr(m.audio, opts);
        timing = 'phrase';
        const words = [];
        for (const c of (out && out.chunks) || []) {
          const ts = c.timestamp || [];
          const a = Number(ts[0]), b = Number.isFinite(Number(ts[1])) && ts[1] !== null ? Number(ts[1]) : a + 2;
          const ws = String(c.text || '').trim().split(/\s+/).filter(Boolean);
          const total = ws.reduce((x, w) => x + w.length, 0) || 1;
          let t = a;
          for (const w of ws) { const d = ((b - a) * w.length) / total; words.push({ text: ' ' + w, timestamp: [t, t + d] }); t += d; }
        }
        out = { text: out && out.text, chunks: words };
      }
      post({ type: 'result', text: out && out.text ? String(out.text) : '', chunks: (out && out.chunks) || [], lib: libUsed, ms: performance.now() - t0, timing });
    }
  } catch (e) {
    post({ type: 'error', error: msg(e) });
  }
};
