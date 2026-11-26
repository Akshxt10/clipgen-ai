/*
  ClipGen AI · Phase 1 · FFmpeg.wasm worker (single-thread core).
  Same calls as the Phase 0 worker that already runs on iPhone Safari.
  Classic (non-module) worker: it uses importScripts() to load the core.
*/
'use strict';

let core = null;
const post = (m, t) => self.postMessage(m, t || []);
const e2s = (e) => {
  try {
    if (e && e.message) return (e.name ? e.name + ': ' : '') + e.message;
    if (typeof e === 'number') return 'WASM abort/exception code ' + e;
    return String(e);
  } catch (_) { return 'Unknown error'; }
};

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data;
  try {
    let value = null;
    const transfer = [];
    switch (op) {
      case 'load': {
        importScripts(args.coreURL);
        if (typeof self.createFFmpegCore !== 'function') throw new Error('createFFmpegCore() not found after loading ffmpeg-core.js');
        core = await self.createFFmpegCore({
          mainScriptUrlOrBlob: args.coreURL + '#' + btoa(JSON.stringify({ wasmURL: args.wasmURL, workerURL: args.coreURL })),
          locateFile: (p) => (/\.wasm$/.test(p) ? args.wasmURL : p)
        });
        core.setLogger((d) => post({ type: 'log', msg: (d && d.message !== undefined) ? String(d.message) : String(d) }));
        core.setProgress((d) => post({ type: 'progress', data: d }));
        value = true;
        break;
      }
      case 'exec': {
        core.setTimeout(-1);
        core.exec(...args.args);
        // if the core does not expose `ret`, callers check the output file instead
        value = (typeof core.ret === 'number') ? core.ret : 0;
        core.reset();
        break;
      }
      case 'writeFile': { core.FS.writeFile(args.name, args.data); value = true; break; }
      case 'readFile': { const d = core.FS.readFile(args.name); value = d; transfer.push(d.buffer); break; }
      case 'deleteFile': { core.FS.unlink(args.name); value = true; break; }
      case 'mkdir': { core.FS.mkdir(args.path); value = true; break; }
      case 'mount': { core.FS.mount(core.FS.filesystems.WORKERFS, args.options, args.path); value = true; break; }
      case 'unmount': { core.FS.unmount(args.path); value = true; break; }
      case 'memInfo': {
        let b = null;
        try {
          if (core.HEAPU8 && core.HEAPU8.buffer) b = core.HEAPU8.buffer.byteLength;
          else if (core.wasmMemory) b = core.wasmMemory.buffer.byteLength;
        } catch (_) { /* not available */ }
        value = b;
        break;
      }
      default: throw new Error('Unknown op ' + op);
    }
    post({ type: 'result', id, value }, transfer);
  } catch (e) {
    post({ type: 'result', id, error: e2s(e) });
  }
};
