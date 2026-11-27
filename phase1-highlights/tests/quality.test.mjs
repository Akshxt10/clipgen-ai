// Quality-pass tests (written from the real-device feedback on IMG_4714.mov). All data below is FIXTURE data, labelled as such.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVideo, normalizeSettings } from '../analyze.js';
import { loudnessFromPcm } from '../loudness.js';
import { checkClips } from '../checks.js';

const RATE = 16000;
function pcmOf(seconds, spans) {            // spans: [from, to, amplitude]; room tone elsewhere
  const pcm = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.003 * Math.sin(i * 0.05);
  for (const [a, b, amp] of spans) for (let i = Math.round(a * RATE); i < Math.min(pcm.length, Math.round(b * RATE)); i++) pcm[i] += amp * Math.sin(i * 0.3) * (0.75 + 0.25 * Math.sin(i * 0.0011));
  return pcm;
}
// words from text starting at s; a pause of `gap` seconds after every `every` words
function say(text, s, { per = 0.42, gap = 0, every = 0, p } = {}) {
  let t = s; const out = [];
  text.split(' ').forEach((w, i) => { if (every && i && i % every === 0) t += gap; const x = { w, s: +t.toFixed(2), e: +(t + per - 0.04).toFixed(2) }; if (p !== undefined) x.p = p; out.push(x); t += per; });
  return out;
}
const end = (ws) => ws[ws.length - 1].e;
const S = (dur, o) => normalizeSettings(Object.assign({ numClips: 3, minDuration: 10, maxDuration: 25, intensity: 'balanced' }, o), dur);
const run = (words, spans, dur, o, scenes) => analyzeVideo({ words, loudness: loudnessFromPcm(pcmOf(dur, spans), RATE), scenes: scenes || [], duration: dur, settings: S(dur, o) });
const lastTok = (c) => c.transcript.trim().split(/\s+/).pop();

/* ---------- 1. complete sentences ---------- */
// 0–21 s: a loud run-on with no punctuation that the unit splitter has to cut at 14 s (…"and the ad-"), then clean sentences.
const runOn = say('so I was thinking about the whole thing with the ads and how people react to the ad and then I said well you know it is just the way that the market works when you put the ad-', 0.5, { gap: 0.3, every: 5 });
const clean = [].concat(
  say('Wait, what is the biggest mistake everyone makes with money?', 26),
  say('The secret is simple, and I could not believe how crazy it was!', 31),
  say('You save ten percent of everything you earn.', 36));
test('clips end on a finished sentence, never on a dangling word, dash or a forced mid-sentence split', () => {
  const words = runOn.concat(clean);
  const r = run(words, [[0.5, end(runOn), 0.5], [26, 42, 0.2]], 45, { minDuration: 10, maxDuration: 20 });
  assert.ok(r.clips.length >= 1, 'something is still found');
  for (const c of r.clips) {
    assert.match(lastTok(c), /[.!?]["')\]]*$/, 'clip ' + c.id + ' ends with: ' + JSON.stringify(c.transcript.slice(-40)));
    assert.ok(!/[-–—,]$/.test(lastTok(c)));
    assert.ok(!(c.start < 1 && c.end > 12 && c.end < 25 && !/[.!?]$/.test(lastTok(c))), 'the unfinished run-on is not offered');
  }
  assert.ok(r.clips.some((c) => /biggest mistake/.test(c.transcript)), 'the clean hook moment is offered');
});
test('a candidate that ends on a sentence beats the same speech cut mid-sentence', () => {
  // identical audio; only the wording of the end differs
  const a = say('Wait, what is the biggest mistake everyone makes with money? The secret is simple and I could not believe how crazy it was!', 2);
  const b = say('Wait, what is the biggest mistake everyone makes with money? The secret is simple and I could not believe how crazy it was and the', 2);
  const spans = [[2, 14, 0.3]];
  const ra = run(a, spans, 20, { minDuration: 8, maxDuration: 16 }), rb = run(b, spans, 20, { minDuration: 8, maxDuration: 16, intensity: 'aggressive' });
  assert.ok(ra.clips[0] && rb.clips[0]);
  assert.ok(ra.clips[0].score > rb.clips[0].score, 'clean end scores higher: ' + ra.clips[0].score + ' vs ' + rb.clips[0].score);
  assert.ok(rb.clips[0].caveats.some((x) => /sentence|cut/i.test(x)), 'dangling end is disclosed');
});

/* ---------- 2. transcript reliability ---------- */
const hook = 'Wait, what is the biggest mistake everyone makes with money? The secret is simple, and I could not believe how crazy it was!';
test('per-word confidence, when the recognizer provides it, lowers the score and is disclosed', () => {
  const spans = [[2, 17, 0.3]];
  const hi = run(say(hook, 2, { p: 0.96 }), spans, 25, { minDuration: 8, maxDuration: 20 }).clips[0];
  const lo = run(say(hook, 2, { p: 0.25 }), spans, 25, { minDuration: 8, maxDuration: 20, intensity: 'aggressive' }).clips[0];
  assert.ok(hi && lo);
  assert.ok(hi.signals.reliability > 0.9 && lo.signals.reliability < 0.5, hi.signals.reliability + ' / ' + lo.signals.reliability);
  assert.ok(lo.score < hi.score - 10, 'low-confidence transcript scores clearly lower: ' + lo.score + ' vs ' + hi.score);
  assert.ok(lo.caveats.some((x) => /unreliable|confiden/i.test(x)));
  assert.deepEqual(hi.caveats, []);
});
test('without confidence data: words timed over near-silence are treated as suspect (hallucination signal)', () => {
  const w = say(hook, 2);
  const real = run(w, [[2, 17, 0.3]], 25, { minDuration: 8, maxDuration: 20 }).clips[0];
  const ghost = run(w, [[20, 24, 0.3]], 25, { minDuration: 8, maxDuration: 20, intensity: 'aggressive' }).clips[0];   // audio is elsewhere
  assert.ok(real.signals.reliability > 0.9, 'words on sound: ' + real.signals.reliability);
  assert.ok(ghost && ghost.signals.reliability < 0.4, 'words on silence: ' + ghost.signals.reliability);
  assert.ok(ghost.caveats.some((x) => /silence|quiet|unreliable/i.test(x)));
});
test('repetition loops (a classic recognizer failure) are flagged', () => {
  const loop = say('thank you thank you thank you thank you thank you thank you thank you thank you thank you thank you thank you thank you.', 2);
  const c = run(loop, [[2, 14, 0.3]], 20, { minDuration: 5, maxDuration: 15, intensity: 'aggressive' }).clips[0];
  assert.ok(c, 'still reported, but flagged');
  assert.ok(c.signals.reliability < 0.5, 'reliability ' + c.signals.reliability);
  assert.ok(c.caveats.some((x) => /repeat|loop|unreliable/i.test(x)));
});
test('the page makes no claim to detect every transcription error: normal clean speech has no caveats', () => {
  const c = run(say(hook, 2), [[2, 17, 0.3]], 25, { minDuration: 8, maxDuration: 20 }).clips[0];
  assert.deepEqual(c.caveats, []);
});

/* ---------- 3. truthful reasons ---------- */
test('no scene detection → no scene/visual reason anywhere, and no scene weight in the score', () => {
  const words = runOn.concat(clean);
  for (const scenes of [[], undefined, null]) {
    const r = run(words, [[26, 42, 0.4]], 45, { minDuration: 8, maxDuration: 20, intensity: 'aggressive' }, scenes);
    assert.ok(r.clips.length);
    for (const c of r.clips) assert.ok(!c.reasons.some((x) => /scene|visual|cut/i.test(x)), JSON.stringify(c.reasons));
    assert.equal(r.stats.scenes, 0);
    assert.ok(r.clips.every((c) => c.signals.scene === 0));
  }
});
test('real scene cuts → the reason appears only for clips that actually contain cuts, with the real count', () => {
  const words = [].concat(say('The meeting was moved to the second floor, so we all walked over together and sat down at the long table by the window.', 2), say('Hold on, why does nobody ever tell you the worst habit that quietly ruins your health? The answer is simple, and honestly it shocked me!', 30));
  const cuts = [3, 4.5, 6, 7.2, 8.5, 10, 11.5, 13, 14.5, 16];          // all inside the first moment
  const r = run(words, [[2, 17, 0.3], [30, 45, 0.3]], 50, { minDuration: 8, maxDuration: 20, numClips: 2 }, cuts);
  const first = r.clips.find((c) => c.start < 10), second = r.clips.find((c) => c.start > 25);
  assert.ok(first && second);
  const inside = cuts.filter((t) => t >= first.start - 0.5 && t <= first.end).length;
  assert.ok(inside >= 3 && inside < cuts.length, 'the clip covers only part of the cuts: ' + inside);
  assert.ok(first.reasons.some((x) => x === inside + ' scene cuts detected in the picture'), 'real count ' + inside + ' in ' + JSON.stringify(first.reasons));
  assert.ok(!second.reasons.some((x) => /scene|visual/i.test(x)), JSON.stringify(second.reasons));
});

/* ---------- 4. hard constraints ---------- */
test('constraints hold across intensities and length settings: in range, within min/max, no overlap, clean cuts', () => {
  const lines = ['Wait, what is the biggest mistake everyone makes with money?', 'The secret is simple, and I could not believe how crazy it was!', 'Because the first step is to save ten percent of everything you earn.', 'It was the best day of my life, I love it so much!', 'No way, are you serious, that is insane!', 'I was shaking and I was so scared, then suddenly it worked.', 'So we walked to the shop and bought some bread and milk.', 'Nothing else really happened on that day to be honest.'];
  let words = [], spans = [], t = 1;
  for (let k = 0; k < 40; k++) { const ws = say(lines[k % lines.length], t); words = words.concat(ws); if (k % 3 === 0) spans.push([t, end(ws) + 1, 0.3]); t = end(ws) + (k % 4 === 3 ? 1.4 : 0.35); }
  const dur = Math.ceil(t + 1);
  for (const intensity of ['conservative', 'balanced', 'aggressive']) for (const [min, max] of [[5, 12], [10, 25], [15, 40], [20, 58]]) for (const numClips of [1, 3, 8]) {
    const o = { intensity, minDuration: min, maxDuration: max, numClips };
    const r = run(words, spans, dur, o);
    const st = S(dur, o);
    const tag = intensity + ' ' + min + '-' + max + ' x' + numClips;
    assert.ok(r.clips.length <= numClips, tag);
    const chk = checkClips(r.clips, words, dur);
    assert.deepEqual(chk.problems, [], tag);
    for (const c of r.clips) {
      assert.ok(c.duration >= st.minDuration - 0.011 && c.duration <= st.maxDuration + 0.011, tag + ' duration ' + c.duration + ' not in ' + st.minDuration + '–' + st.maxDuration);
      assert.ok(c.start >= 0 && c.end <= dur);
    }
    assert.deepEqual(r.clips.map((c) => c.rank), r.clips.map((_, i) => i + 1), tag + ' ranks');
    assert.ok(r.clips.every((c, i, a) => !i || a[i - 1].score >= c.score - 1e-9), tag + ' sorted by score');
  }
});
