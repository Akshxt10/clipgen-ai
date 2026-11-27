// Chunked / resumable recognition: timing, memory recycling, interruption + retry. FIXTURE audio and a FAKE recognizer
// (it "hears" tone bursts) — this tests the orchestration and timeline maths, not Whisper.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planChunks, offsetChunks, checkpointKey, transcribeChunked } from '../asr-chunks.js';
import { loudnessFromPcm } from '../loudness.js';
import { normalizeWords } from '../../phase0-speech/captions.js';

const RATE = 16000;
// deterministic speech-like audio: bursts of 3–9 s separated by pauses of 0.6–1.5 s
function makeAudio(total) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pcm = new Float32Array(Math.round(total * RATE)), bursts = [];
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.002 * Math.sin(i * 0.05);
  let t = 0.5;
  while (t < total - 2) {
    const len = 3 + rnd() * 6, end = Math.min(total - 0.3, t + len);
    bursts.push([+t.toFixed(2), +end.toFixed(2)]);
    for (let i = Math.round(t * RATE); i < Math.round(end * RATE); i++) pcm[i] += 0.3 * Math.sin(i * 0.3);
    t = end + 0.6 + rnd() * 0.9;
  }
  return { pcm, bursts };
}
// fake recognizer: one "word" per 0.5 s of detected burst, timed from the sample envelope (0.01 s grid)
function fakeRecognizer(log) {
  return {
    init: async () => { log && log.push('init'); },
    dispose: () => { log && log.push('dispose'); },
    recognize: async (audio) => {
      log && log.push('rec:' + (audio.length / RATE).toFixed(2));
      const step = 160, chunks = []; let on = null;
      const env = []; for (let i = 0; i + step <= audio.length; i += step) { let m = 0; for (let k = i; k < i + step; k++) m = Math.max(m, Math.abs(audio[k])); env.push(m > 0.05); }
      const emit = (a, b) => { for (let t = a; t < b - 0.2; t += 0.5) chunks.push({ text: ' w' + chunks.length, timestamp: [+t.toFixed(2), +Math.min(b, t + 0.45).toFixed(2)] }); };
      env.forEach((v, i) => { if (v && on === null) on = i * 0.01; if (!v && on !== null) { emit(on, i * 0.01); on = null; } });
      if (on !== null) emit(on, env.length * 0.01);
      return { text: chunks.map((c) => c.text).join(''), chunks, ms: 5, timing: 'word', lib: 'fake' };
    }
  };
}
const memStore = () => { const m = { v: null, saves: 0 }; return { m, load: () => m.v, save: (x) => { m.v = JSON.parse(JSON.stringify(x)); m.saves++; }, clear: () => { m.v = null; } }; };

const A = makeAudio(100), LOUD = loudnessFromPcm(A.pcm, RATE, 0.25), PLAN = planChunks(LOUD, 100);

test('planChunks: contiguous cover, every part within Whisper-safe length, cuts land in pauses', () => {
  assert.ok(PLAN.length >= 4 && PLAN.length <= 7, 'parts: ' + PLAN.length);
  assert.equal(PLAN[0].s, 0); assert.equal(PLAN[PLAN.length - 1].e, 100);
  for (let i = 0; i < PLAN.length; i++) {
    assert.ok(PLAN[i].e - PLAN[i].s <= 27.01, 'part ' + i + ' length ' + (PLAN[i].e - PLAN[i].s));
    assert.ok(PLAN[i].e > PLAN[i].s);
    if (i) assert.equal(PLAN[i].s, PLAN[i - 1].e, 'no gap and no overlap');
    if (i < PLAN.length - 1) assert.ok(!A.bursts.some(([a, b]) => PLAN[i].e > a + 0.05 && PLAN[i].e < b - 0.05), 'cut at ' + PLAN[i].e + ' is inside a burst');
  }
});
test('planChunks: short audio is one part; sliver tails are merged; degenerate inputs are safe', () => {
  assert.deepEqual(planChunks(LOUD, 10), [{ s: 0, e: 10 }]);
  const p28 = planChunks(LOUD, 28); assert.equal(p28.length, 2); assert.equal(p28[1].e, 28);
  const p = planChunks(LOUD, 27.4); assert.ok(p.every((x) => x.e - x.s >= 1), JSON.stringify(p));
  assert.deepEqual(planChunks({ windowSec: 0.25, rmsDb: [] }, 5), [{ s: 0, e: 5 }]);
  const flat = planChunks({ windowSec: 0.25, rmsDb: new Array(400).fill(-40) }, 100);
  assert.ok(flat.every((x) => x.e - x.s <= 27.01) && flat[flat.length - 1].e === 100);
});
test('offsetChunks: shifts times, clamps to the part, drops words beyond the audio, keeps unknown ends unknown', () => {
  const r = offsetChunks([{ text: ' a', timestamp: [0.5, 0.9] }, { text: ' b', timestamp: [19.8, 20.6] }, { text: ' c', timestamp: [5, null] }, { text: ' ghost', timestamp: [21, 22] }, { text: ' bad', timestamp: [null, 1] }], 40, 20);
  assert.deepEqual(r.map((x) => x.text), [' a', ' b', ' c', ' bad']);
  assert.deepEqual(r[0].timestamp, [40.5, 40.9]);
  assert.deepEqual(r[1].timestamp, [59.8, 60]);
  assert.deepEqual(r[2].timestamp, [45, null]);
  assert.deepEqual(r[3].timestamp, [null, 41], 'unknown start stays unknown');
  assert.deepEqual(offsetChunks(null, 5, 5), []);
});

test('chunked transcript has the same words at the same times as one pass over the whole recording', async () => {
  const log = [];
  const single = normalizeWords((await fakeRecognizer().recognize(A.pcm)).chunks.map((c) => c), 100);
  const out = await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => fakeRecognizer(log), key: 'k' });
  const chunked = normalizeWords(out.chunks, 100);
  const lens = log.filter((l) => l.startsWith('rec:')).map((l) => Number(l.slice(4)));
  assert.equal(lens.length, PLAN.length);
  assert.ok(lens.every((l) => l <= 27.01), 'no part longer than 27 s is ever sent: ' + lens);
  assert.equal(chunked.length, single.length, 'same number of words');
  chunked.forEach((w, i) => { assert.ok(Math.abs(w.s - single[i].s) < 0.011, 'word ' + i + ' start ' + w.s + ' vs ' + single[i].s); });
  for (let i = 1; i < chunked.length; i++) assert.ok(chunked[i].s >= chunked[i - 1].s, 'timeline is monotonic across part borders');
  assert.ok(chunked.every((w) => A.bursts.some(([a, b]) => w.s >= a - 0.02 && w.s <= b + 0.02)), 'every word sits inside a real burst');
});
test('memory recycling: the recognizer is thrown away and rebuilt every N parts, and nothing is left alive', async () => {
  const log = []; let made = 0;
  await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => { made++; return fakeRecognizer(log); }, key: 'k', recycleEvery: 2 });
  const expected = Math.ceil(PLAN.length / 2);
  assert.equal(made, expected);
  assert.equal(log.filter((l) => l === 'init').length, made);
  assert.equal(log.filter((l) => l === 'dispose').length, made, 'every recognizer disposed');
  assert.equal(log[log.length - 1], 'dispose');
});

test('interruption + retry: finished parts are saved, a retry recognizes only the rest, result equals an uninterrupted run', async () => {
  const reference = await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => fakeRecognizer(), key: 'k' });
  const store = memStore(); let calls = 0, savedWhenFailing = -1;
  const crashing = () => { const r = fakeRecognizer(); const orig = r.recognize; r.recognize = async (a) => { calls++; if (calls === 3) { savedWhenFailing = Object.keys(store.m.v.results).length; throw new Error('The speech worker crashed: out of memory'); } return orig(a); }; return r; };
  await assert.rejects(() => transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: crashing, key: 'k', store }), (e) => { assert.match(e.message, /crashed/); assert.equal(e.partsDone, 2); assert.equal(e.partsTotal, PLAN.length); assert.equal(e.failedPart, 2); return true; });
  assert.equal(savedWhenFailing, 2, 'parts 1 and 2 were already on disk when part 3 died');
  assert.ok(store.m.v && Object.keys(store.m.v.results).length === 2, 'progress survives the failure');
  const log = [];
  const out = await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => fakeRecognizer(log), key: 'k', store });
  assert.equal(log.filter((l) => l.startsWith('rec:')).length, PLAN.length - 2, 'only the missing parts were recognized');
  assert.equal(out.resumed, 2);
  assert.deepEqual(out.chunks, reference.chunks, 'identical transcript and timing');
  assert.equal(store.m.v, null, 'checkpoint cleared after success');
});
test('a checkpoint for a different video / model / plan, an expired one, or a corrupt one is ignored', async () => {
  const full = async (store, key) => { const log = []; const o = await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => fakeRecognizer(log), key, store }); return { o, n: log.filter((l) => l.startsWith('rec:')).length }; };
  const mk = (key, savedAt) => ({ m: {}, load: () => ({ key, savedAt, results: { 0: { chunks: [{ text: ' STALE', timestamp: [1, 2] }], text: ' STALE', ms: 1, timing: 'word' } } }), save() {}, clear() {} });
  for (const store of [mk('another-video', Date.now()), mk('k', Date.now() - 25 * 3600 * 1000), { load: () => { throw new Error('boom'); }, save() { throw new Error('quota'); }, clear() { throw new Error('x'); } }, { load: () => ({ key: 'k', savedAt: Date.now(), results: 'garbage' }), save() {}, clear() {} }]) {
    const { o, n } = await full(store, 'k');
    assert.equal(n, PLAN.length, 'everything recognized from scratch');
    assert.ok(!/STALE/.test(o.text));
  }
});
test('cancel keeps finished parts and stops before the next one', async () => {
  const store = memStore(); let n = 0;
  await assert.rejects(() => transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: () => fakeRecognizer(), key: 'k', store, isCancelled: () => n++ >= 1 }), (e) => { assert.match(e.message, /Cancelled/); assert.equal(e.partsDone, 1); return true; });
  assert.equal(Object.keys(store.m.v.results).length, 1);
});
test('phrase-level timing in any part marks the whole transcript as approximate; checkpointKey changes with every input', async () => {
  let i = 0;
  const mixed = () => { const r = fakeRecognizer(); const o = r.recognize; r.recognize = async (a) => Object.assign(await o(a), i++ === 1 ? { timing: 'phrase' } : {}); return r; };
  assert.equal((await transcribeChunked({ pcm: A.pcm, rate: RATE, plan: PLAN, makeRecognizer: mixed, key: 'k' })).timing, 'phrase');
  const f = { name: 'a.mov', size: 10, lastModified: 5 };
  const base = checkpointKey(f, 0, 60, 'base.en', PLAN);
  assert.notEqual(base, checkpointKey({ ...f, size: 11 }, 0, 60, 'base.en', PLAN));
  assert.notEqual(base, checkpointKey(f, 5, 60, 'base.en', PLAN));
  assert.notEqual(base, checkpointKey(f, 0, 60, 'tiny.en', PLAN));
  assert.notEqual(base, checkpointKey(f, 0, 60, 'base.en', PLAN.slice(1)));
  assert.equal(base, checkpointKey({ ...f }, 0, 60, 'base.en', PLAN));
});
