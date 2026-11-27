/*
  ClipGen AI · Phase 1 · highlights · memory-safe, resumable speech recognition (pure logic, no browser APIs).

  Why: on an iPhone, Safari can kill the tab when memory runs short. Feeding the recognizer ONE long recording keeps
  everything in memory at once and loses all work if the tab dies. Instead:
    1. planChunks      split the audio into parts of ~20 s (never more than 27 s), cutting at the quietest moment near each
                       target so a word is not sliced in half. Whisper's own window is 30 s, so each part is one clean pass.
    2. transcribeChunked  recognize the parts one after another, apply each part's start offset to its word times
                       (so the timeline stays exact), save every finished part to a checkpoint, and every few parts throw the
                       recognizer away and make a fresh one so the speech engine's memory is returned.
    3. a retry after a crash reuses the saved parts and only recognizes the rest.
  The recognizer itself (phase0-speech/speech.js + asr-worker.js, proven on iPhone) is not changed.
*/

export const CHUNK_TARGET = 20, CHUNK_MAX = 27, CHUNK_SEARCH = 4;

/** Split [0,total] into parts. loud = { windowSec, rmsDb[] } (the same curve the analysis uses). */
export function planChunks(loud, total, o) {
  const target = (o && o.target) || CHUNK_TARGET, max = (o && o.max) || CHUNK_MAX, search = (o && o.search) || CHUNK_SEARCH;
  const w = (loud && loud.windowSec) || 0.25, v = (loud && loud.rmsDb) || [];
  const r2 = (x) => Math.round(x * 100) / 100;
  const out = [];
  let start = 0;
  while (total - start > max) {
    const from = Math.max(start + 5, start + target - search), to = Math.min(start + max - 0.5, start + target + search);
    let best = -1, bestV = Infinity, bestD = Infinity;
    for (let i = Math.ceil(from / w); i * w <= to && i < v.length; i++) {
      const centre = (i + 0.5) * w, d = Math.abs(centre - (start + target));
      const val = (v[i - 1] !== undefined ? v[i - 1] : v[i]) * 0.25 + v[i] * 0.5 + (v[i + 1] !== undefined ? v[i + 1] : v[i]) * 0.25;   // lightly smoothed
      if (val < bestV - 0.01 || (Math.abs(val - bestV) <= 0.01 && d < bestD)) { best = i; bestV = val; bestD = d; }
    }
    const cut = best >= 0 ? (best + 0.5) * w : start + target;
    out.push({ s: r2(start), e: r2(cut) });
    start = cut;
  }
  if (total - start > 0.05 || !out.length) {
    const prev = out[out.length - 1];
    if (prev && total - start < 1 && total - prev.s <= 29.5) prev.e = r2(total);           // a sliver joins the previous part
    else out.push({ s: r2(start), e: r2(total) });
  }
  return out;
}

/** Local (per-part) recognizer chunks → one list on the whole-recording timeline. */
export function offsetChunks(chunks, offset, partLen) {
  const out = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    const ts = (c && c.timestamp) || [];
    const sRaw = ts[0] === null || ts[0] === undefined ? null : Number(ts[0]);
    const s = sRaw !== null && Number.isFinite(sRaw) ? sRaw : null;        // an unknown start stays unknown (normalizeWords repairs it from its neighbour)
    if (s !== null && s >= partLen + 0.5) continue;                       // a word "after" the audio ended is not real
    const eRaw = ts[1] === null || ts[1] === undefined ? null : Number(ts[1]);
    const e = eRaw !== null && Number.isFinite(eRaw) ? Math.min(eRaw, partLen) : null;
    out.push({ text: c.text, timestamp: [s === null ? null : offset + s, e === null ? null : offset + Math.max(e, s === null ? 0 : s)] });
  }
  return out;
}

/** Stable key for "this exact analysis": same video file, same part of it, same model, same plan. */
export function checkpointKey(file, start, len, model, plan) {
  const f = file ? [file.name, file.size, file.lastModified].join('|') : 'none';
  return [f, start, len, model, plan.map((p) => p.s + '-' + p.e).join(',')].join('#');
}

/**
 * transcribeChunked({ pcm, rate, plan, makeRecognizer, key, store, recycleEvery, isCancelled, onPart })
 *   makeRecognizer() → { init(), recognize(Float32Array), dispose() }       (a fresh one each call)
 *   store → { load() → obj|null, save(obj), clear() }                        (optional; localStorage in the page)
 * returns { chunks, text, ms, timing, parts:[{s,e,ms,words,resumed}], resumed, recycles }
 * on failure throws an Error with .partsDone / .partsTotal / .failedPart (finished parts stay saved).
 */
export async function transcribeChunked(o) {
  const { pcm, rate, plan, makeRecognizer, key, store } = o;
  const recycleEvery = o.recycleEvery || 4;
  let saved = null;
  try { saved = store ? store.load() : null; } catch (_) { saved = null; }
  const fresh = !(saved && saved.key === key && saved.results && typeof saved.results === 'object' && Date.now() - (saved.savedAt || 0) < 24 * 3600 * 1000);
  const results = fresh ? {} : saved.results;
  const persist = () => { try { if (store) store.save({ key, savedAt: Date.now(), results }); } catch (_) { /* quota / private mode: no resume, still works */ } };

  const out = { chunks: [], text: [], ms: 0, timing: 'word', parts: [], resumed: 0, recycles: 0 };
  let rec = null, sinceFresh = 0, done = 0;
  const drop = () => { try { if (rec) rec.dispose(); } catch (_) { /* ignore */ } rec = null; };
  try {
    for (let k = 0; k < plan.length; k++) {
      if (o.isCancelled && o.isCancelled()) throw new Error('Cancelled');
      const p = plan[k], len = p.e - p.s;
      let r = results[k], resumed = !!r;
      if (!r || !Array.isArray(r.chunks)) {
        resumed = false;
        if (o.onPart) o.onPart({ k, n: plan.length, s: p.s, e: p.e, resumed: false, done });
        if (!rec) { rec = makeRecognizer(); await rec.init(); sinceFresh = 0; }
        const a = Math.max(0, Math.round(p.s * rate)), b = Math.min(pcm.length, Math.round(p.e * rate));
        let res;
        try { res = await rec.recognize(pcm.subarray(a, b)); }
        catch (e) { const err = e instanceof Error ? e : new Error(String(e)); err.failedPart = k; throw err; }
        r = { text: res.text || '', chunks: offsetChunks(res.chunks, p.s, len), ms: res.ms || 0, timing: res.timing || 'word', lib: res.lib };
        results[k] = r; persist();
        sinceFresh++;
        if (sinceFresh >= recycleEvery && k < plan.length - 1) { drop(); out.recycles++; }     // give the speech engine's memory back
      } else if (o.onPart) o.onPart({ k, n: plan.length, s: p.s, e: p.e, resumed: true, done });
      done++;
      if (resumed) out.resumed++;
      out.chunks.push(...r.chunks); out.text.push(r.text); out.ms += r.ms || 0;
      if (r.timing === 'phrase') out.timing = 'phrase';
      out.parts.push({ s: p.s, e: p.e, ms: r.ms || 0, words: r.chunks.length, resumed });
    }
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    err.partsDone = done; err.partsTotal = plan.length; if (err.failedPart === undefined) err.failedPart = done;
    drop();
    throw err;
  }
  drop();
  try { if (store) store.clear(); } catch (_) { /* ignore */ }
  out.text = out.text.join(' ').replace(/\s+/g, ' ').trim();
  return out;
}
