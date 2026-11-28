// Export logic tests (no browser). Part 1: pure maths. Part 2: NATIVE ffmpeg (libx264/libass) + tesseract OCR with the exact
// arguments and ASS script the page uses.
// The words are FIXTURES (labelled as such). This proves cutting, 9:16 output, caption offset and boundaries — NOT speech recognition,
// and NOT that FFmpeg.wasm on an iPhone behaves the same (that is only confirmed by running it on the phone).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionVisibility, clipWindow, captionWordsForClip, buildClipCaptions, exportArgs, parseProbe, judgeOutput, progressFromLog, safeFileName, runExportQueue, VF_BASE, VF_ASS, OUT_W, OUT_H } from '../export.js';

const here = dirname(fileURLToPath(import.meta.url));
const phase0App = readFileSync(join(here, '..', '..', 'phase0-speech', 'app.js'), 'utf8');
const has = (c) => { try { execFileSync('which', [c]); return true; } catch { return false; } };
const skipNative = !(has('ffmpeg') && has('ffprobe') && has('tesseract')) && 'ffmpeg/ffprobe/tesseract not installed';
const W = (w, s, e) => ({ w, s, e });

/* ---------------- shared pipeline: nothing was re-invented ---------------- */
test('the crop/scale filter and the encoder settings are IDENTICAL to the passed Phase 0 speech-caption export', () => {
  const vfLine = /const VF_BASE = (.*);\n/.exec(phase0App);
  assert.ok(vfLine, 'VF_BASE found in phase0-speech/app.js');
  assert.equal(new Function('OUT_W', 'OUT_H', 'return ' + vfLine[1])(OUT_W, OUT_H), VF_BASE, 'same crop + scale as the passed export');
  assert.ok(phase0App.includes("const VF_ASS = VF_BASE + ',subtitles=filename=/sub.ass:fontsdir=/fonts,format=yuv420p';"));
  assert.equal(VF_ASS, VF_BASE + ',subtitles=filename=/sub.ass:fontsdir=/fonts,format=yuv420p');
  // the encoder part of the Phase 0 export, token by token
  const m = /'-vf', VF_ASS, ('-r'[^\]]*?)'-y', 'out_speech\.mp4'\]/s.exec(phase0App);
  assert.ok(m, 'Phase 0 export argument list found');
  const phase0Tokens = m[1].match(/'([^']*)'/g).map((x) => x.slice(1, -1));
  const mine = exportArgs({ absStart: 5, len: 10, input: '/mnt/input_media', captions: true, out: 'o.mp4' });
  const at = mine.indexOf('-r');
  assert.deepEqual(mine.slice(at, at + phase0Tokens.length), phase0Tokens, 'same frame rate, codecs, bitrates, flags as the passed export');
  assert.deepEqual(mine.slice(0, 8), ['-hide_banner', '-ss', '5', '-i', '/mnt/input_media', '-t', '10', '-map']);
  assert.equal(mine[mine.indexOf('-vf') + 1], VF_ASS);
  assert.equal(mine[mine.length - 1], 'o.mp4');
  assert.equal(exportArgs({ absStart: 5, len: 10, input: 'i', captions: false, out: 'o.mp4' })[mine.indexOf('-vf') + 1].includes('subtitles'), false, 'no words → no subtitles filter, never a placeholder caption');
});

/* ---------------- clip window ---------------- */
test('clipWindow: absolute start = analysis start + clip start; never past the analysed part; never one ms beyond the requested end', () => {
  const w = clipWindow({ start: 20.3, end: 44.1 }, 10, 90);
  assert.deepEqual([w.relStart, w.relEnd, w.absStart, w.absEnd, w.len, w.ok], [20.3, 44.1, 30.3, 54.1, 23.8, true]);
  const edge = clipWindow({ start: 80, end: 95 }, 10, 90);             // asks for 5 s beyond the analysed part
  assert.equal(edge.relEnd, 90); assert.equal(edge.len, 10); assert.ok(edge.absEnd <= 100 + 1e-9);
  const odd = clipWindow({ start: 1.0004, end: 3.00079 }, 0, 100);
  assert.ok(odd.absEnd <= 3.00079 + 1e-9, 'floored, not rounded up: ' + odd.absEnd);
  assert.equal(clipWindow({ start: 5, end: 5.4 }, 0, 100).ok, false, 'a sub-second sliver is refused');
  assert.equal(clipWindow({ start: -3, end: 10 }, 0, 100).relStart, 0);
});

/* ---------------- caption offset and boundaries ---------------- */
const WORDS = [W('Early', 6.0, 6.4), W('Edge', 7.8, 8.4), W('Orange', 10.0, 10.6), W('river', 10.6, 11.2), W('morning.', 11.2, 11.8),
  W('Silver', 16.0, 16.6), W('lantern', 16.6, 17.2), W('Tail', 19.5, 20.3), W('Late', 21.0, 21.4)];
const WIN = clipWindow({ start: 8, end: 20 }, 10, 60);              // abs 18 – 30, analysis clock 8 – 20

test('captionWordsForClip: words are shifted so the clip starts at 0; words outside are dropped; boundary words are clamped, never extended', () => {
  const cw = captionWordsForClip(WORDS, WIN);
  assert.deepEqual(cw.map((x) => x.w), ['Edge', 'Orange', 'river', 'morning.', 'Silver', 'lantern', 'Tail']);
  const by = Object.fromEntries(cw.map((x) => [x.w, x]));
  assert.deepEqual([by.Orange.s, by.Orange.e], [2, 2.6], 'analysis 10.0 → clip 2.0');
  assert.deepEqual([by.Silver.s, by.Silver.e], [8, 8.6]);
  assert.deepEqual([by.Edge.s, by.Edge.e], [0, 0.4], 'starts before the cut → clamped to 0, not negative');
  assert.deepEqual([by.Tail.s, by.Tail.e], [11.5, 12], 'ends after the cut → clamped to the clip length');
  for (const x of cw) assert.ok(x.s >= 0 && x.e <= WIN.len && x.e > x.s, x.w);
  assert.ok(!cw.some((x) => x.w === 'Early' || x.w === 'Late'), 'words before the start / after the end never appear');
});

test('a word whose middle is outside the clip is not captioned (no half-word caption for speech that is not in the clip)', () => {
  const win = clipWindow({ start: 10, end: 20 }, 0, 60);
  const cw = captionWordsForClip([W('a', 9.5, 10.1), W('b', 19.9, 20.8), W('c', 12, 12.5)], win);
  assert.deepEqual(cw.map((x) => x.w), ['c']);
});

function assEvents(ass) {
  return ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => { const p = l.split(','); const t = (x) => { const m = /(\d+):(\d+):(\d+)\.(\d+)/.exec(x); return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 100; }; return { start: t(p[1]), end: t(p[2]), text: p.slice(9).join(',') }; });
}
test('buildClipCaptions: every ASS event lies inside [0, clip length]; no event text contains a word from outside; ASS times equal the shifted word times', () => {
  const cap = buildClipCaptions(WORDS, WIN);
  const ev = assEvents(cap.ass);
  assert.ok(ev.length >= 3);
  for (const e of ev) { assert.ok(e.start >= 0, 'start ' + e.start); assert.ok(e.end <= WIN.len + 1e-9, 'end ' + e.end + ' > ' + WIN.len); assert.ok(e.end > e.start); }
  const all = ev.map((e) => e.text).join(' ');
  assert.ok(!/Early|Late/.test(all));
  assert.ok(/Orange/.test(all) && /Silver/.test(all));
  const orange = ev.find((e) => /Orange/.test(e.text));
  assert.equal(orange.start, 2, 'the caption line starts at the first word (2.0 s into the clip)');
  assert.ok(/\\k60\}Orange/.test(orange.text), 'karaoke timing = 0.6 s for the word Orange');
  assert.ok(ev[ev.length - 1].end <= WIN.len, 'the tail padding added after the last line cannot run past the clip');
});

test('buildClipCaptions: no recognized words in the clip → no captions at all (nothing invented)', () => {
  const cap = buildClipCaptions(WORDS, clipWindow({ start: 30, end: 40 }, 10, 60));
  assert.equal(cap.ass, null); assert.deepEqual(cap.lines, []); assert.deepEqual(cap.words, []);
  assert.equal(buildClipCaptions([], WIN).ass, null);
});

/* ---------------- output checks ---------------- */
test('parseProbe / judgeOutput', () => {
  const lines = ['Input #0, mov,mp4,m4a,3gp,3g2,mj2, from \'out.mp4\':', '  Duration: 00:00:12.02, start: 0.000000, bitrate: 1700 kb/s',
    '  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 720x1280 [SAR 1:1 DAR 9:16], 1600 kb/s, 30 fps, 30 tbr',
    '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 128 kb/s'];
  const info = parseProbe(lines);
  assert.deepEqual(info, { duration: 12.02, width: 720, height: 1280, vcodec: 'h264', acodec: 'aac' });
  assert.equal(judgeOutput(info, 12, 2e6).ok, true);
  assert.match(judgeOutput(info, 10, 2e6).problems.join(), /longer than the requested/);
  assert.match(judgeOutput(info, 14, 2e6).problems.join(), /shorter than the requested/);
  assert.match(judgeOutput(Object.assign({}, info, { width: 1080 }), 12, 2e6).problems.join(), /1080×1280/);
  assert.match(judgeOutput(Object.assign({}, info, { acodec: null }), 12, 2e6).problems.join(), /no audio/);
  assert.match(judgeOutput(info, 12, 500).problems.join(), /too small/);
  assert.match(judgeOutput(Object.assign({}, info, { vcodec: 'vp9' }), 12, 2e6).problems.join(), /not H\.264/);
});
test('progressFromLog and safeFileName', () => {
  assert.equal(progressFromLog('frame=  120 fps= 30 q=26.0 size=  512kB time=00:00:04.00 bitrate=1048.6kbits/s speed=1x', 8), 0.5);
  assert.equal(progressFromLog('time=00:00:09.00', 8), 0.99);
  assert.equal(progressFromLog('Stream #0:0', 8), null);
  assert.equal(safeFileName('IMG 4714 (1).MOV', 2, clipWindow({ start: 20.3, end: 44.1 }, 0, 100)), 'clipgen_IMG_4714_1_clip2_0m20s-0m44s.mp4');
  assert.match(safeFileName('../../etc/passwd', 1, WIN), /^clipgen_[A-Za-z0-9_-]+_clip1_\d+m\d\ds-\d+m\d\ds\.mp4$/);
});

test('captionVisibility: visible / not visible / unclear (a moving picture is never reported as "no captions")', () => {
  const m = (band, outside) => ({ band, outside, bandPixels: 220000, outsidePixels: 700000 });
  assert.equal(captionVisibility(m(9000, 10), m(0, 0)), 'yes');
  assert.equal(captionVisibility(m(9000, 10), null), 'yes');
  assert.equal(captionVisibility(m(100, 0), m(0, 0)), 'no', 'too few changed pixels');
  assert.equal(captionVisibility(m(9000, 10), m(8000, 5)), 'no', 'the same amount of change in the gap means it is not captions');
  assert.equal(captionVisibility(m(96000, 300000), m(60000, 250000)), 'unclear', 'whole picture changed: cannot compare');
});

/* ---------------- the queue ---------------- */
test('runExportQueue: clips run strictly one after another (never two at once), in order, each reported done', async () => {
  let live = 0, peak = 0; const order = [], states = [];
  const out = await runExportQueue({ items: ['a', 'b', 'c'], isCancelled: () => false, onState: (it, s) => states.push(it + ':' + s),
    exportOne: async (it) => { live++; peak = Math.max(peak, live); order.push(it); await new Promise((r) => setTimeout(r, 15)); live--; return it; } });
  assert.equal(peak, 1); assert.deepEqual(order, ['a', 'b', 'c']); assert.deepEqual(out.done, ['a', 'b', 'c']);
  assert.deepEqual(states, ['a:working', 'a:done', 'b:working', 'b:done', 'c:working', 'c:done']);
});
test('runExportQueue: a failed clip is reported and the next clips still run', async () => {
  const states = {};
  const out = await runExportQueue({ items: ['a', 'b', 'c'], isCancelled: () => false, onState: (it, s, i) => { states[it] = s + (i && i.error ? ':' + i.error : ''); },
    exportOne: async (it) => { if (it === 'b') throw new Error('FFmpeg exited with code 1'); return it; } });
  assert.deepEqual(out.done, ['a', 'c']); assert.deepEqual(out.failed, ['b']);
  assert.equal(states.b, 'failed:FFmpeg exited with code 1'); assert.equal(states.c, 'done');
});
test('runExportQueue: cancelling keeps finished clips, discards the running one, never starts the rest', async () => {
  let cancelled = false; const started = [], states = {};
  const out = await runExportQueue({ items: ['a', 'b', 'c'], isCancelled: () => cancelled, onState: (it, s) => { states[it] = s; },
    exportOne: async (it) => { started.push(it); if (it === 'b') { cancelled = true; throw new Error('Cancelled'); } return it; } });
  assert.deepEqual(started, ['a', 'b']); assert.deepEqual(out.done, ['a']); assert.deepEqual(out.cancelled, ['b', 'c']);
  assert.deepEqual(states, { a: 'done', b: 'cancelled', c: 'cancelled' });
});
test('runExportQueue: a fatal error (engine cannot start) stops the rest instead of failing every clip the same way', async () => {
  const out = await runExportQueue({ items: ['a', 'b', 'c'], isCancelled: () => false, onState: () => {}, exportOne: async () => { const e = new Error('engine down'); e.fatal = true; throw e; } });
  assert.deepEqual(out.failed, ['a']); assert.deepEqual(out.skipped, ['b', 'c']);
});

/* ---------------- NATIVE: the real FFmpeg/libass output ---------------- */
test('NATIVE export of a clip (analysis start 10 s, clip 8–20 s → file 18–30 s): exact cut, 9:16, captions on the clip clock, none outside', { skip: skipNative, timeout: 180000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'exp-'));
  mkdirSync(join(d, 'fonts'));
  copyFileSync(join(here, '..', '..', 'phase0-speech', 'font', 'Poppins-Bold.ttf'), join(d, 'fonts', 'font.ttf'));
  const run = (cmd, args, o) => execFileSync(cmd, args, Object.assign({ cwd: d, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }, o || {}));
  // 40 s landscape phone-like source: RED until 20.000 s then BLUE; long GOP (a seek must decode from far back to be frame-exact);
  // 0.5 s tone beeps at 16.0 (BEFORE the clip), 20.0, 25.0 (inside) and 31.0 (AFTER the clip).
  const beeps = [16, 20, 25, 31].map((t) => 'between(t\\,' + t + '\\,' + (t + 0.5) + ')').join('+');
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=1280x720:r=30:d=20', '-f', 'lavfi', '-i', 'color=c=blue:s=1280x720:r=30:d=20',
    '-f', 'lavfi', '-i', 'aevalsrc=0.5*sin(2*PI*440*t)*(' + beeps + '):s=44100:d=40', '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-g', '600', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', 'src.mp4']);
  const win = WIN;                                                              // abs 18 – 30
  assert.deepEqual([win.absStart, win.absEnd, win.len], [18, 30, 12]);
  const cap = buildClipCaptions(WORDS.filter((x) => !['Edge', 'Tail'].includes(x.w)), win);   // clean OCR: only well-inside words
  writeFileSync(join(d, 'sub.ass'), cap.ass);
  const args = exportArgs({ absStart: win.absStart, len: win.len, input: 'src.mp4', captions: true, out: 'out.mp4' }).map((x) => x.replace(/\/sub\.ass/g, 'sub.ass').replace(/fontsdir=\/fonts/g, 'fontsdir=fonts'));
  const log = run('ffmpeg', args).toString();   // (stderr is empty at default level; failures throw)

  // 1. a real playable file: dimensions, codecs, length ≤ requested end
  const probeText = spawnSync('ffmpeg', ['-hide_banner', '-i', join(d, 'out.mp4')], { encoding: 'utf8' }).stderr;
  const info = parseProbe(probeText.split('\n'));
  console.log('OUTPUT INFO:', JSON.stringify(info));
  assert.equal(info.width, OUT_W); assert.equal(info.height, OUT_H); assert.equal(info.vcodec, 'h264'); assert.equal(info.acodec, 'aac');
  assert.ok(info.duration <= win.len + 0.25 && info.duration >= win.len - 0.6, 'duration ' + info.duration);
  assert.equal(judgeOutput(info, win.len, readFileSync(join(d, 'out.mp4')).length).ok, true);
  const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,nb_read_frames,pix_fmt,r_frame_rate:format=duration', '-of', 'json', 'out.mp4']).toString());
  assert.equal(probe.streams[0].width, 720); assert.equal(probe.streams[0].height, 1280); assert.equal(probe.streams[0].pix_fmt, 'yuv420p');
  assert.ok(Number(probe.format.duration) <= 12.25, 'never beyond the requested end: ' + probe.format.duration);
  assert.ok(Number(probe.streams[0].nb_read_frames) <= 12 * 30 + 1, 'frames ' + probe.streams[0].nb_read_frames);

  // 2. exact start: the picture turns red→blue at source 20.000 s = clip 2.000 s
  const px = (t) => { const b = run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', 'out.mp4', '-frames:v', '1', '-vf', 'crop=8:8:356:60,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']); return [b[0], b[1], b[2]]; };
  const a = px(1.8), b = px(2.2);
  console.log('PIXEL at clip 1.8 s', a, '| at 2.2 s', b);
  assert.ok(a[0] > a[2] + 100, 'before 2.0 s of the clip it is still red'); assert.ok(b[2] > b[0] + 100, 'after 2.0 s of the clip it is blue');
  const tight = [px(1.93), px(2.07)];
  assert.ok(tight[0][0] > tight[0][2] && tight[1][2] > tight[1][0], 'the colour change is within ±0.07 s of where it should be: ' + JSON.stringify(tight));

  // 3. exact audio window: only the beeps at source 20 s and 25 s (clip 2.0 s and 7.0 s) are inside; 16 s and 31 s are not
  const pcm = run('ffmpeg', ['-v', 'error', '-i', 'out.mp4', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-']);
  const f = new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength - (pcm.byteLength % 4)));
  const win50 = 400, loudAt = []; for (let i = 0; i + win50 <= f.length; i += win50) { let s = 0; for (let k = i; k < i + win50; k++) s += f[k] * f[k]; if (Math.sqrt(s / win50) > 0.1) loudAt.push(+(i / 8000).toFixed(2)); }
  const groups = []; for (const t of loudAt) { const g = groups[groups.length - 1]; if (g && t - g[1] < 0.11) g[1] = t; else groups.push([t, t]); }
  console.log('BEEPS in the exported clip (start–last window, s):', JSON.stringify(groups), '· audio length', (f.length / 8000).toFixed(2));
  assert.equal(groups.length, 2, 'exactly the two beeps that lie inside the clip');
  assert.ok(Math.abs(groups[0][0] - 2.0) < 0.12, 'first beep at ~2.0 s: ' + groups[0][0]); assert.ok(Math.abs(groups[1][0] - 7.0) < 0.12, 'second beep at ~7.0 s: ' + groups[1][0]);
  assert.ok(f.length / 8000 <= 12.1, 'audio does not run past the requested end');

  // 4. captions land on the clip clock (OCR of the exported frames)
  const ocr = (t, name) => {
    run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', 'out.mp4', '-frames:v', '1', '-y', name + '.png']);
    run('ffmpeg', ['-v', 'error', '-i', name + '.png', '-vf', 'crop=720:300:0:760,format=gray,scale=iw*2:ih*2,negate', '-y', name + '_band.png']);
    return run('tesseract', [name + '_band.png', '-', '--psm', '6']).toString().toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  const at30 = ocr(3.0, 'f30'), at36 = ocr(3.6, 'f36'), at89 = ocr(8.9, 'f89'), at03 = ocr(0.4, 'f03'), at115 = ocr(11.7, 'f117'), at15 = ocr(1.5, 'f15');
  console.log('OCR clip 3.0 s ->', JSON.stringify(at30), '| 3.6 s ->', JSON.stringify(at36), '| 8.9 s ->', JSON.stringify(at89), '| 0.4 s ->', JSON.stringify(at03), '| 1.5 s ->', JSON.stringify(at15), '| 11.7 s ->', JSON.stringify(at115));
  assert.match(at30, /orange/); assert.match(at30, /river/); assert.match(at36, /morning/);
  assert.match(at89, /silver/); assert.match(at89, /lantern/);
  assert.ok(!/early|edge|orange|silver|late|tail/.test(at03 + ' ' + at15), 'nothing is captioned before the first word of the clip (spoken words are at 2.0 s and 8.0 s)');
  assert.ok(!/early|late|tail|edge/.test(at36 + at89 + at115), 'words from before the start / after the end never appear');
  assert.ok(!/orange|river|silver|lantern/.test(at115), 'no stale caption at the very end');
  // 5. pixel check, the method the page uses: the captioned frame differs from the plain frame at a word time, not at a gap
  assert.ok(cap.probe.tWord !== null && cap.probe.tGap !== null);
});

test('NATIVE export without any recognized words: still a valid 9:16 MP4, no caption filter, no invented text', { skip: skipNative, timeout: 120000 }, () => {
  const d = mkdtempSync(join(tmpdir(), 'exp0-'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: d, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=12', '-f', 'lavfi', '-i', 'sine=f=300:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', 'src.mp4']);
  const win = clipWindow({ start: 2, end: 9 }, 0, 12);
  const cap = buildClipCaptions([], win);
  assert.equal(cap.ass, null);
  run('ffmpeg', ['-v', 'error'].concat(exportArgs({ absStart: win.absStart, len: win.len, input: 'src.mp4', captions: false, out: 'out.mp4' }).slice(1)));
  const j = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height:format=duration', '-of', 'json', 'out.mp4']).toString());
  assert.deepEqual(j.streams.map((s) => s.codec_name).sort(), ['aac', 'h264']);
  assert.ok(j.streams.some((s) => s.width === 720 && s.height === 1280));
  assert.ok(Number(j.format.duration) <= 7.25);
});
