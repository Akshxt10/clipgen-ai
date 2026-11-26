import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, groupWords, assTime, buildAss, pickProbeTimes, unsupportedChars, wordErrorRate, syncCheck, rmsDb } from '../captions.js';

// FIXTURE words. These are test data for the maths, NOT recognizer output.
const C = (text, s, e) => ({ text, timestamp: [s, e] });

test('normalizeWords drops non-speech markers and merges punctuation', () => {
  const w = normalizeWords([C(' [BLANK_AUDIO]', 0, 1), C(' hello', 1, 1.4), C(',', 1.4, 1.4), C(' world.', 1.5, 2)], 10);
  assert.deepEqual(w.map((x) => x.w), ['hello,', 'world.']);
});
test('normalizeWords repairs null end, clamps to duration, keeps order', () => {
  const w = normalizeWords([C('a', 0.2, null), C('b', 0.9, 1.2), C('c', 9.8, 11)], 10);
  assert.equal(w[0].e, 0.9);
  assert.equal(w[2].e, 10);
  for (let i = 1; i < w.length; i++) assert.ok(w[i].s >= w[i - 1].s);
});
test('normalizeWords drops words beyond the clip, handles garbage', () => {
  assert.deepEqual(normalizeWords(null, 5), []);
  assert.deepEqual(normalizeWords([C('x', 7, 8)], 5), []);
  assert.deepEqual(normalizeWords([{}, { text: '' }], 5), []);
});
test('no words -> no lines -> no events (nothing is invented)', () => {
  const lines = groupWords([]);
  assert.equal(lines.length, 0);
  assert.ok(!/Dialogue:/.test(buildAss(lines)));
  assert.deepEqual(pickProbeTimes(lines, 10), { tWord: null, tGap: null });
});
test('groupWords splits on count, gap and sentence end; lines never overlap', () => {
  const words = normalizeWords([C('one', 0, .3), C('two', .3, .6), C('three', .6, .9), C('four', .9, 1.2), C('five.', 1.2, 1.5), C('six', 1.6, 1.9), C('seven', 3, 3.3)], 10);
  const lines = groupWords(words);
  assert.deepEqual(lines.map((l) => l.text), ['one two three', 'four five.', 'six', 'seven']);
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i].start >= lines[i - 1].end - 1e-9);
  for (const l of lines) assert.ok(l.end > l.start);
});
test('assTime formats', () => {
  assert.equal(assTime(0), '0:00:00.00');
  assert.equal(assTime(61.234), '0:01:01.23');
  assert.equal(assTime(3600.5), '1:00:00.50');
});
test('buildAss contains the recognized words and escapes override braces', () => {
  const lines = groupWords(normalizeWords([C('he{llo}', 0.5, 1), C('wor\\ld', 1, 1.5)], 10));
  const ass = buildAss(lines);
  assert.match(ass, /Dialogue: 0,0:00:00\.50,/);
  assert.match(ass, /\}hello /);
  assert.match(ass, /\}world/);
  assert.ok(!/CLIPGEN AI CAPTION TEST/.test(ass));
});
test('pickProbeTimes picks a caption moment inside a line and a gap outside lines', () => {
  const lines = groupWords(normalizeWords([C('hello', 1, 1.4), C('there', 1.4, 2), C('friend', 5, 5.5)], 10));
  const p = pickProbeTimes(lines, 10);
  assert.ok(lines.some((l) => p.tWord >= l.start && p.tWord <= l.end));
  assert.ok(p.tGap !== null && !lines.some((l) => p.tGap >= l.start && p.tGap <= l.end));
});
test('unsupportedChars flags Devanagari but not Latin/punctuation', () => {
  assert.deepEqual(unsupportedChars('Hello, café — “ok” ₹5'), []);
  assert.deepEqual(unsupportedChars('नमस्ते').length > 0, true);
});
test('wordErrorRate', () => {
  assert.equal(wordErrorRate('the quick brown fox', 'The quick brown fox!'), 0);
  assert.equal(wordErrorRate('the quick brown fox', 'the quick fox'), 0.25);
  assert.equal(wordErrorRate('', 'x'), null);
});
test('syncCheck: words over a tone burst are on speech, words over silence are not', () => {
  const rate = 16000, pcm = new Float32Array(rate * 6);
  for (let i = rate * 2; i < rate * 4; i++) pcm[i] = 0.3 * Math.sin(i * 0.3);
  for (let i = 0; i < pcm.length; i++) pcm[i] += (Math.random() - 0.5) * 0.0005;
  const good = syncCheck(pcm, rate, [{ w: 'a', s: 2.2, e: 2.6 }, { w: 'b', s: 3, e: 3.5 }]);
  const bad = syncCheck(pcm, rate, [{ w: 'a', s: 0.2, e: 0.8 }, { w: 'b', s: 4.5, e: 5.5 }]);
  assert.equal(good.onSpeech, 1);
  assert.equal(bad.onSpeech, 0);
  assert.ok(rmsDb(pcm) > -30);
  assert.equal(rmsDb(new Float32Array(0)), -120);
});
