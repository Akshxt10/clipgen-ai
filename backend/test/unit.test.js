import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { isPrivateIp, parsePublicUrl, resolveSafe } from '../src/ssrf.js';
import { classify, normalizeUrl, detectPlatform } from '../src/sources.js';
import { signUrlPart, verifySig, safeName } from '../src/util.js';
import { crc32, writeZip } from '../src/zip.js';
import { buildAss, buildPages, normalizeCaptionOptions, CAPTION_STYLES } from '../src/captions.js';
import { parseWhisperJson } from '../src/transcribe.js';
import { buildUnits, analyzeVideo, normalizeSettings, regenerateClip } from '../src/analyze.js';
import { motionTrack, smoothPath, simplify, planCrop, cropXExpr, buildGraph, outputSize } from '../src/reframe.js';
import { reviewWithLlm, applyLlm, llmAvailable } from '../src/llm.js';
import { tmp, scriptWords, makeVideo } from './helpers.js';
import { loudnessWindows, extractWav, detectScenes } from '../src/media.js';
import { loadConfig } from '../src/config.js';

/* ---------- SSRF ---------- */
test('private / reserved addresses are refused', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::7f00:1', '224.0.0.1', '255.255.255.255']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});
test('URL parsing rejects credentials, odd ports and non-http schemes', () => {
  assert.throws(() => parsePublicUrl('ftp://example.com/a.mp4'));
  assert.throws(() => parsePublicUrl('https://user:pw@example.com/a.mp4'));
  assert.throws(() => parsePublicUrl('https://example.com:22/a.mp4'));
  assert.throws(() => parsePublicUrl('file:///etc/passwd'));
  assert.throws(() => parsePublicUrl('http://localhost/a.mp4'));
  assert.throws(() => parsePublicUrl('http://127.0.0.1/a.mp4'));
  assert.equal(parsePublicUrl('https://example.com/a.mp4').hostname, 'example.com');
  assert.doesNotThrow(() => parsePublicUrl('http://127.0.0.1:8081/a.mp4', { allowPrivate: true }));
});
test('hostnames resolving to private addresses are refused', async () => {
  await assert.rejects(() => resolveSafe('localhost'));
  await assert.rejects(() => resolveSafe('127.0.0.1'));
});

/* ---------- source classification ---------- */
test('platform pages are recognised and never treated as direct media', () => {
  for (const u of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://vimeo.com/1', 'https://www.tiktok.com/@a/video/1', 'https://www.instagram.com/reel/x', 'https://x.com/a/status/1', 'https://m.facebook.com/watch/?v=1', 'https://twitch.tv/videos/1']) {
    const c = classify(u);
    assert.equal(c.kind, 'platform', u); assert.equal(c.supported, false);
    assert.match(c.message, /upload/i);
  }
  const d = classify('https://cdn.example.com/files/clip.mp4');
  assert.equal(d.kind, 'direct'); assert.equal(d.looksLikeVideo, true);
});
test('dropbox share links are converted to direct downloads', () => {
  const c = classify('https://www.dropbox.com/s/abc/video.mp4?dl=0');
  assert.equal(c.kind, 'direct'); assert.match(c.url, /dl=1/); assert.ok(c.note);
});

/* ---------- signing ---------- */
test('signed links verify, expire and cannot be tampered with', () => {
  const exp = Date.now() + 60000;
  const sig = signUrlPart('secret', '/media/p_x/source', exp);
  assert.equal(verifySig('secret', '/media/p_x/source', exp, sig), true);
  assert.equal(verifySig('secret', '/media/p_x/render', exp, sig), false);
  assert.equal(verifySig('other', '/media/p_x/source', exp, sig), false);
  assert.equal(verifySig('secret', '/media/p_x/source', Date.now() - 1, signUrlPart('secret', '/media/p_x/source', Date.now() - 1)), false);
  assert.equal(safeName('../../etc/passwd'), 'etc passwd');
});

/* ---------- zip ---------- */
test('ZIP writer produces a valid archive with correct CRCs', async () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const dir = tmp();
  const a = path.join(dir, 'a.bin'), b = path.join(dir, 'b.bin');
  fs.writeFileSync(a, Buffer.alloc(200000, 7)); fs.writeFileSync(b, 'hello zip');
  const out = path.join(dir, 'x.zip');
  await writeZip(fs.createWriteStream(out), [{ name: 'one.bin', path: a }, { name: 'two ünï.txt', path: b }]);
  await new Promise((r) => setTimeout(r, 100));
  const py = spawnSync('python3', ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(sorted(z.namelist()));print(len(z.read("one.bin")))', out], { encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr);
  assert.match(py.stdout, /^None/);
  assert.match(py.stdout, /200000/);
  const un = spawnSync('unzip', ['-tq', out], { encoding: 'utf8' });
  if (un.status !== null && !un.error) assert.equal(un.status, 0, un.stdout + un.stderr);
});

/* ---------- whisper.cpp JSON parsing ---------- */
test('whisper.cpp full JSON is turned into words with timestamps', () => {
  const json = { result: { language: 'en' }, transcription: [
    { offsets: { from: 0, to: 2500 }, text: ' Hello there, friends.', tokens: [
      { text: '[_BEG_]', offsets: { from: 0, to: 0 } }, { text: ' Hello', offsets: { from: 100, to: 600 } }, { text: ' there', offsets: { from: 600, to: 1100 } }, { text: ',', offsets: { from: 1100, to: 1150 } }, { text: ' fri', offsets: { from: 1300, to: 1700 } }, { text: 'ends', offsets: { from: 1700, to: 2000 } }, { text: '.', offsets: { from: 2000, to: 2050 } }] },
    { offsets: { from: 3000, to: 4000 }, text: ' [BLANK_AUDIO]' },
    { offsets: { from: 4000, to: 6000 }, text: ' No token detail here at all' }] };
  const r = parseWhisperJson(json);
  assert.equal(r.language, 'en');
  assert.deepEqual(r.words.slice(0, 3).map((w) => w.w), ['Hello', 'there,', 'friends.']);
  assert.ok(Math.abs(r.words[0].s - 0.1) < 0.01 && Math.abs(r.words[0].e - 0.6) < 0.01);
  assert.equal(r.words.filter((w) => /BLANK/.test(w.w)).length, 0);
  const tail = r.words.slice(3);
  assert.equal(tail.map((w) => w.w).join(' '), 'No token detail here at all');
  assert.ok(tail[0].s >= 4 && tail[tail.length - 1].e <= 6.01);
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].s >= r.words[i - 1].s - 1e-6, 'monotonic');
});

/* ---------- captions / ASS ---------- */
test('ASS captions: valid structure, colours, per-word highlight, keywords, fonts', () => {
  const words = [{ w: 'This', s: 0, e: 0.3 }, { w: 'is', s: 0.3, e: 0.5 }, { w: 'free!', s: 0.5, e: 1.0 }, { w: 'Never', s: 1.3, e: 1.6 }, { w: 'pay', s: 1.6, e: 1.9 }, { w: 'again.', s: 1.9, e: 2.4 }];
  for (const style of Object.keys(CAPTION_STYLES)) {
    const ass = buildAss(words, { width: 720, height: 1280, duration: 3, options: { style, keywords: ['free'] } });
    assert.match(ass, /^\[Script Info\]/); assert.match(ass, /PlayResX: 720/); assert.match(ass, /\[Events\]/);
    const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    assert.ok(dialogues.length >= 2, style);
    assert.ok(!/undefined|NaN|&H&/.test(ass), style + ' has bad values');
    for (const d of dialogues) assert.match(d, /^Dialogue: \d+,\d:\d\d:\d\d\.\d\d,\d:\d\d:\d\d\.\d\d,/);
  }
  const pop = buildAss(words, { width: 720, height: 1280, duration: 3, options: { style: 'pop', color: '#FF0000', highlight: '#00FF00' } });
  assert.match(pop, /Style: Default,[^,]*,\d+,&H000000FF/);   // red in BGR order
  assert.match(pop, /&H00FF00&/);   // green
  const o = normalizeCaptionOptions({ style: 'nope', font: 'Comic Sans', size: 9999, position: 'weird', color: 'red' });
  assert.equal(o.style, 'pop'); assert.equal(o.size, 160); assert.equal(o.position, 'auto'); assert.match(o.color, /^#[0-9A-F]{6}$/);
  const pages = buildPages(words, 3);
  assert.deepEqual(pages.map((p) => p.map((w) => w.w).join(' ')), ['This is free!', 'Never pay again.']);
});
test('ASS text escapes braces/backslashes from the transcript', () => {
  const ass = buildAss([{ w: '{\\an8}evil', s: 0, e: 1 }, { w: 'x\\Ny', s: 1, e: 2 }], { width: 720, height: 1280, duration: 3, options: { style: 'minimal' } });
  assert.ok(!/\{\\an8\}evil/.test(ass.split('[Events]')[1]));
});

/* ---------- analysis engine ---------- */
function flatLoud(duration, bursts) {
  const n = Math.round(duration / 0.25);
  const rms = new Array(n).fill(-60), peak = new Array(n).fill(-60);
  for (const [a, b, db] of bursts) for (let i = Math.floor(a / 0.25); i < Math.min(n, Math.ceil(b / 0.25)); i++) { rms[i] = db; peak[i] = db + 6; }
  return { windowSec: 0.25, rmsDb: rms, peakDb: peak };
}
test('analysis: distinct, non-overlapping, ordered by score, sentence-aligned, deterministic', () => {
  const words = scriptWords();
  const loud = flatLoud(40, [[1, 9, -26], [11, 19, -12], [21, 29, -20], [31, 39, -10]]);
  const settings = normalizeSettings({ numClips: 4, minDuration: 5, maxDuration: 12, intensity: 'balanced' }, 40);
  const r1 = analyzeVideo({ words, loudness: loud, scenes: [], duration: 40, settings });
  const r2 = analyzeVideo({ words, loudness: loud, scenes: [], duration: 40, settings });
  assert.deepEqual(r1.clips, r2.clips, 'deterministic');
  assert.ok(r1.clips.length >= 3, 'found clips: ' + r1.clips.length);
  const byStart = [...r1.clips].sort((a, b) => a.start - b.start);
  for (let i = 1; i < byStart.length; i++) assert.ok(byStart[i].start >= byStart[i - 1].end - 1e-6, 'no overlap');
  for (let i = 1; i < r1.clips.length; i++) assert.ok(r1.clips[i - 1].score >= r1.clips[i].score, 'ranked by score');
  for (const c of r1.clips) {
    assert.ok(c.duration >= 4.5 && c.duration <= 13, 'duration ' + c.duration);
    assert.ok(c.score >= 0 && c.score <= 100);
    assert.ok(c.transcript.length > 20);
    assert.ok(c.categories.length && c.reasons.length);
    /* never cut inside a word: boundaries sit in gaps between words */
    for (const w of words) assert.ok(!(w.s < c.start - 1e-6 && w.e > c.start + 1e-6), 'start inside a word');
    for (const w of words) assert.ok(!(w.s < c.end - 1e-6 && w.e > c.end + 1e-6), 'end inside a word');
    assert.match(c.transcript.trim(), /[.!?]$/, 'ends on a sentence end: ' + c.transcript.slice(-30));
  }
  /* real content: the moment with laughter/surprise wording is found and labelled */
  const funny = r1.clips.find((c) => /laughing|surprising/.test(c.transcript));
  assert.ok(funny && funny.categories.some((k) => /Funny|Surprising|Emotional/.test(k)), JSON.stringify(funny && funny.categories));
  const money = r1.clips.find((c) => /dollars a day/.test(c.transcript));
  assert.ok(money && money.categories.length && money.reasons.length, 'the money/saving moment is found');
});
test('analysis: only spans actual speech — silence-only video yields no clips; no transcript falls back to audio', () => {
  const settings = normalizeSettings({ numClips: 3, minDuration: 5, maxDuration: 12 }, 40);
  const quiet = analyzeVideo({ words: [], loudness: flatLoud(40, []), scenes: [], duration: 40, settings });
  assert.equal(quiet.clips.length, 0);
  const aud = analyzeVideo({ words: [], loudness: flatLoud(40, [[2, 10, -15], [20, 28, -9]]), scenes: [], duration: 40, settings });
  assert.equal(aud.mode, 'audio-visual'); assert.ok(aud.clips.length >= 1);
  for (const c of aud.clips) assert.ok(c.hook === '' && c.transcript === '');
});
test('analysis: intensity changes how many clips pass; settings are clamped', () => {
  const words = scriptWords(), loud = flatLoud(40, [[1, 9, -26], [11, 19, -12], [21, 29, -20], [31, 39, -10]]);
  const n = (i) => analyzeVideo({ words, loudness: loud, scenes: [], duration: 40, settings: normalizeSettings({ numClips: 20, minDuration: 5, maxDuration: 10, intensity: i }, 40) }).clips.length;
  assert.ok(n('aggressive') >= n('balanced') && n('balanced') >= n('conservative'));
  const s = normalizeSettings({ numClips: 999, minDuration: -4, maxDuration: 'x', platform: 'nope', aspect: '4:3', intensity: 'zzz', language: 'EN!!' }, 30);
  assert.equal(s.numClips, 20); assert.ok(s.minDuration >= 5 && s.maxDuration <= 30 && s.maxDuration > s.minDuration - 1); assert.equal(s.platform, 'shorts'); assert.equal(s.aspect, '9:16'); assert.equal(s.intensity, 'balanced'); assert.equal(s.language, 'auto');
});
test('regenerate gives a different, non-overlapping moment', () => {
  const words = scriptWords(), loud = flatLoud(40, [[1, 9, -26], [11, 19, -12], [21, 29, -20], [31, 39, -10]]);
  const a = analyzeVideo({ words, loudness: loud, scenes: [], duration: 40, settings: normalizeSettings({ numClips: 2, minDuration: 5, maxDuration: 10, intensity: 'aggressive' }, 40) });
  const analysis = { clips: a.clips.map((c) => ({ ...c })), pool: a.pool.map((c) => ({ ...c })), usedSeeds: [] };
  assert.ok(analysis.pool.length > 0, 'pool has alternatives');
  const before = analysis.clips[0];
  const next = regenerateClip(analysis, before.id);
  assert.ok(next && (next.start !== before.start || next.end !== before.end));
  assert.equal(next.id, before.id);
  const other = analysis.clips[1];
  assert.ok(Math.min(next.end, other.end) - Math.max(next.start, other.start) <= 0, 'no overlap with the other clip');
});

/* ---------- reframing ---------- */
test('motion tracking follows a moving object and the crop path is smooth + simplified', () => {
  const w = 96, h = 54, fps = 4, n = 40;
  const frames = [];
  for (let i = 0; i < n; i++) {
    const f = new Uint8Array(w * h).fill(30);
    const x0 = Math.round((w - 12) * i / (n - 1));
    for (let y = 20; y < 32; y++) for (let x = x0; x < x0 + 12; x++) f[y * w + x] = 255;
    frames.push(f);
  }
  const m = motionTrack({ frames, w, h, fps });
  const known = m.filter((q) => q.x !== null);
  assert.ok(known.length > 10);
  assert.ok(known[known.length - 1].x > known[0].x + 0.3, 'centroid moves right: ' + known[0].x + ' → ' + known[known.length - 1].x);
  const plan = planCrop({ srcW: 1280, srcH: 720, aspect: '9:16', reframe: 'smart', motion: m, faces: null, duration: 10, fps });
  assert.equal(plan.mode, 'crop'); assert.equal(plan.subject, 'motion');
  assert.equal(plan.cropW % 2, 0); assert.equal(plan.cropH, 720); assert.ok(Math.abs(plan.cropW - 405) <= 2);
  assert.ok(plan.keys.length >= 2 && plan.keys.length < 30, 'simplified: ' + plan.keys.length);
  assert.ok(plan.keys[plan.keys.length - 1].x > plan.keys[0].x + 100, 'crop moves');
  for (const k of plan.keys) assert.ok(k.x >= 0 && k.x <= 1280 - plan.cropW, 'crop inside the frame');
  const expr = cropXExpr(plan.keys);
  assert.ok(expr.length > 5 && !/undefined|NaN/.test(expr));
  const g = buildGraph({ plan, out: outputSize('9:16', '720'), captions: { file: 'caps.ass', fontsDir: '' } });
  assert.match(g, /crop=/); assert.match(g, /ass=/); assert.match(g, /\[vout\]/);
});
test('smoothing limits camera speed and ignores jitter', () => {
  const jitter = Array.from({ length: 30 }, (_, i) => ({ t: i * 0.25, x: 0.5 + (i % 2 ? 0.02 : -0.02) }));
  const p = smoothPath(jitter, 7.5);
  const xs = p.map((q) => q.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.05, 'jitter is absorbed');
  const jump = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.25, x: i === 0 ? 0.1 : 0.9 }));
  const q = smoothPath(jump, 10);
  const maxStep = Math.max(...q.slice(1).map((v, i) => Math.abs(v.x - q[i].x) / (v.t - q[i].t)));
  assert.ok(maxStep <= 0.35, 'speed limited: ' + maxStep);
  assert.ok(simplify([{ t: 0, x: 0 }, { t: 1, x: 0.5 }, { t: 2, x: 1 }], 0.01).length === 2);
});
test('graph variants: blur fill, center, passthrough', () => {
  const out916 = outputSize('9:16', '720');
  assert.deepEqual([out916.w, out916.h], [720, 1280]);
  const blur = planCrop({ srcW: 1920, srcH: 1080, aspect: '9:16', reframe: 'blur', duration: 5 });
  assert.match(buildGraph({ plan: blur, out: out916, captions: null }), /boxblur|gblur/);
  const same = planCrop({ srcW: 1920, srcH: 1080, aspect: '16:9', reframe: 'smart', duration: 5 });
  assert.equal(same.mode, 'passthrough');
});

/* ---------- LLM review with a stub OpenAI-compatible server ---------- */
test('optional LLM review: strict JSON, blended scores, failures are harmless', async () => {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      const body = JSON.parse(b);
      if (!/^Bearer k/.test(req.headers.authorization || '') || !body.messages.length) { res.writeHead(401); return res.end('{}'); }
      const ids = [...body.messages[0].content.matchAll(/"id":"(c\d+)"/g)].map((m) => m[1]);
      const out = { ratings: ids.map((id, i) => ({ id, score: 90 - i * 10, label: 'Hook', title: 'Great moment ' + id, reason: 'strong opener' })) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '```json\n' + JSON.stringify(out) + '\n```' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const cfg = loadConfig({ llm: { url: 'http://127.0.0.1:' + srv.address().port + '/v1/chat/completions', key: 'k', model: 'stub', timeoutMs: 5000 } });
  assert.equal(llmAvailable(cfg), true);
  const words = scriptWords(), loud = flatLoud(40, [[1, 9, -26], [11, 19, -12], [21, 29, -20], [31, 39, -10]]);
  const settings = normalizeSettings({ numClips: 3, minDuration: 5, maxDuration: 12 }, 40);
  const a = analyzeVideo({ words, loudness: loud, scenes: [], duration: 40, settings });
  const analysis = { clips: a.clips, pool: a.pool };
  const ratings = await reviewWithLlm(cfg, a.clips, settings, {});
  const n = applyLlm(analysis, ratings);
  assert.ok(n >= 1);
  assert.ok(analysis.clips.every((c) => typeof c.llmScore === 'number'));
  for (let i = 1; i < analysis.clips.length; i++) assert.ok(analysis.clips[i - 1].score >= analysis.clips[i].score);
  srv.close();
  const dead = loadConfig({ llm: { url: 'http://127.0.0.1:1/x', key: 'k', model: 'stub', timeoutMs: 1000 } });
  await assert.rejects(() => reviewWithLlm(dead, a.clips, settings, {}));
  assert.equal(llmAvailable(loadConfig({})), false);
});

/* ---------- media signals from a real file ---------- */
test('loudness windows + scene detection run on a real video', async () => {
  const dir = tmp(); const f = path.join(dir, 'v.mp4'); makeVideo(f, { dur: 12, bursts: [[1, 4, 0.9], [7, 10, 0.2]] });
  const cfg = loadConfig({});
  const wav = path.join(dir, 'a.wav');
  await extractWav(cfg, f, wav, { duration: 12 });
  const l = await loudnessWindows(wav, { windowSec: 0.25 });
  assert.ok(l.rmsDb.length >= 46 && l.rmsDb.length <= 50);
  const at = (t) => l.rmsDb[Math.floor(t / 0.25)];
  assert.ok(at(2.5) > at(5.5) + 20, 'burst louder than silence: ' + at(2.5) + ' vs ' + at(5.5));
  assert.ok(at(2.5) > at(8.5) + 5, 'loud burst louder than quiet burst');
  const sc = await detectScenes(cfg, f, { duration: 12 });
  assert.ok(Array.isArray(sc));
});
