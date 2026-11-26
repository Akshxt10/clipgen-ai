import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loudnessFromPcm } from '../loudness.js';
import { analyzeVideo, normalizeSettings } from '../analyze.js';
import { normalizeWords } from '../../phase0-speech/captions.js';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');

test('drift guard: analyze.js / lexicon.js are the backend originals (only the util import differs)', () => {
  assert.equal(rd('../analyze.js'), rd('../../backend/src/analyze.js').replace("'./util.js'", "'./util-lite.js'"));
  assert.equal(rd('../lexicon.js'), rd('../../backend/src/lexicon.js'));
});
test('the page uses no node: modules', () => {
  for (const f of ['../analyze.js', '../lexicon.js', '../util-lite.js', '../loudness.js']) assert.ok(!/node:/.test(rd(f)), f);
});

// ---- synthetic signal: 150 s, quiet room tone, two loud bursts. FIXTURE data, labelled as such. ----
const RATE = 16000;
function makePcm(seconds, bursts) {
  const pcm = new Float32Array(seconds * RATE);
  for (let i = 0; i < pcm.length; i++) pcm[i] = 0.004 * Math.sin(i * 0.05);
  for (const [a, b, amp] of bursts) for (let i = a * RATE; i < b * RATE; i++) pcm[i] += amp * Math.sin(i * 0.3) * (0.7 + 0.3 * Math.sin(i * 0.0007));
  return pcm;
}
test('loudnessFromPcm: shape, levels, silence', () => {
  const l = loudnessFromPcm(makePcm(10, [[4, 6, 0.5]]), RATE, 0.25);
  assert.equal(l.rmsDb.length, 40);
  assert.ok(l.rmsDb[18] > l.rmsDb[2] + 25, 'burst is much louder than room tone');
  assert.equal(loudnessFromPcm(new Float32Array(16000), RATE).rmsDb[0], -120);
  assert.ok(l.peakDb.every((p, i) => p >= l.rmsDb[i] - 0.2));
});

const W = (txt, s, per = 0.4) => txt.split(' ').map((w, i) => ({ w, s: +(s + i * per).toFixed(2), e: +(s + (i + 1) * per - 0.05).toFixed(2) }));
function transcript() {
  // sentences every ~6 s; the hooky/question/emotional ones sit on the loud bursts (60-90 s and 110-130 s)
  const lines = [
    [2, 'so today we are going to talk about the weather in general.'], [9, 'it was mostly cloudy and then it rained a little bit.'],
    [16, 'we walked to the shop and bought some bread and milk.'], [24, 'nothing else really happened on that day to be honest.'],
    [62, 'Wait, what is the biggest mistake everyone makes with money?'], [67, 'The secret is simple, and I could not believe how crazy it was!'],
    [74, 'Because the first step is to save ten percent of everything you earn.'], [82, 'It was the best day of my life, I love it so much!'],
    [112, 'No way, are you serious, that is insane!'], [118, 'I was shaking and I was so scared, then suddenly it worked.'],
    [140, 'okay that is all for now, see you in the next one.']
  ];
  return lines.flatMap(([s, t]) => W(t, s));
}
const settings = (o) => normalizeSettings(Object.assign({ numClips: 3, minDuration: 15, maxDuration: 35, intensity: 'balanced' }, o), 150);

test('transcript mode: top clips land on the loud, hooky, emotional parts; invariants hold', () => {
  const words = normalizeWords(transcript().map((x) => ({ text: ' ' + x.w, timestamp: [x.s, x.e] })), 150);
  const loud = loudnessFromPcm(makePcm(150, [[60, 90, 0.5], [110, 130, 0.5]]), RATE);
  const r = analyzeVideo({ words, loudness: loud, scenes: [], duration: 150, settings: settings() });
  assert.equal(r.mode, 'transcript');
  assert.ok(r.clips.length >= 2, 'found clips: ' + r.clips.length);
  const top = r.clips[0];
  assert.ok(top.start >= 55 && top.end <= 135, 'top clip is in the loud region: ' + top.start + '–' + top.end);
  for (const c of r.clips) {
    assert.ok(c.start >= 0 && c.end <= 150 && c.end > c.start);
    assert.ok(c.duration >= 14 && c.duration <= 36.5, 'length ' + c.duration);
    assert.ok(!words.some((w) => w.s < c.start - 1e-6 && w.e > c.start + 1e-6), 'start cuts inside a word');
    assert.ok(!words.some((w) => w.s < c.end - 1e-6 && w.e > c.end + 1e-6), 'end cuts inside a word');
    assert.ok(c.reasons.length && c.categories.length && c.transcript.length > 10);
  }
  for (let i = 0; i < r.clips.length; i++) for (let j = i + 1; j < r.clips.length; j++) assert.ok(Math.min(r.clips[i].end, r.clips[j].end) <= Math.max(r.clips[i].start, r.clips[j].start) + 1e-6, 'overlap');
  assert.ok(!r.clips.some((c) => c.start < 30 && c.end < 40), 'the dull weather talk is not picked first');
  assert.ok(r.clips[0].score >= r.clips[r.clips.length - 1].score);
});
test('deterministic: same input, same output', () => {
  const words = normalizeWords(transcript().map((x) => ({ text: ' ' + x.w, timestamp: [x.s, x.e] })), 150);
  const loud = loudnessFromPcm(makePcm(150, [[60, 90, 0.5], [110, 130, 0.5]]), RATE);
  const a = analyzeVideo({ words, loudness: loud, scenes: [], duration: 150, settings: settings() });
  const b = analyzeVideo({ words, loudness: loud, scenes: [], duration: 150, settings: settings() });
  assert.deepEqual(a.clips, b.clips);
});
test('no transcript -> audio-only fallback says so and follows the loud bursts', () => {
  const loud = loudnessFromPcm(makePcm(150, [[60, 90, 0.5], [110, 130, 0.5]]), RATE);
  const r = analyzeVideo({ words: [], loudness: loud, scenes: [], duration: 150, settings: settings({ minDuration: 10, maxDuration: 40, intensity: 'aggressive' }) });
  assert.equal(r.mode, 'audio-visual');
  assert.ok(r.clips.length >= 1);
  assert.ok(r.clips[0].start >= 50 && r.clips[0].end <= 140);
  assert.equal(r.clips[0].transcript, '');
});
test('digital silence and tiny input give zero clips, not invented ones', () => {
  const loud = loudnessFromPcm(new Float32Array(RATE * 20), RATE);
  const r = analyzeVideo({ words: [], loudness: loud, scenes: [], duration: 20, settings: normalizeSettings({}, 20) });
  assert.equal(r.clips.length, 0);
});

import { checkClips } from '../checks.js';
test('checkClips accepts analyzer output and rejects broken clips', () => {
  const words = normalizeWords(transcript().map((x) => ({ text: ' ' + x.w, timestamp: [x.s, x.e] })), 150);
  const loud = loudnessFromPcm(makePcm(150, [[60, 90, 0.5], [110, 130, 0.5]]), RATE);
  const r = analyzeVideo({ words, loudness: loud, scenes: [], duration: 150, settings: settings() });
  const good = checkClips(r.clips, words, 150);
  assert.deepEqual(good.problems, []);
  assert.equal(good.ok, true);
  const w0 = words.find((w) => w.s > 62);
  const bad = checkClips([{ id: 'x', start: w0.s + 0.1, end: 200, transcript: 'nope' }, { id: 'y', start: w0.s + 0.2, end: 190, transcript: '' }], words, 150);
  assert.equal(bad.ok, false);
  assert.equal(bad.cleanCuts, false); assert.equal(bad.inRange, false); assert.equal(bad.noOverlap, false); assert.equal(bad.textMatches, false);
});
