// Burn-in test with NATIVE ffmpeg (libass) + tesseract OCR. It uses the same filter string and the same ASS builder as the page.
// The words are FIXTURES (labelled as such). This proves burn-in and timing, NOT speech recognition.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWords, groupWords, buildAss, pickProbeTimes, OUT_W, OUT_H } from '../captions.js';

const here = dirname(fileURLToPath(import.meta.url));
const has = (c) => { try { execFileSync('which', [c]); return true; } catch { return false; } };
const skip = !(has('ffmpeg') && has('tesseract')) && 'ffmpeg/tesseract not installed';
const VF_BASE = "crop=w='min(iw,trunc(ih*9/16/2)*2)':h='min(ih,trunc(iw*16/9/2)*2)',scale=" + OUT_W + ':' + OUT_H + ':flags=bicubic,setsar=1';
const VF_ASS = VF_BASE + ',subtitles=filename=sub.ass:fontsdir=fonts,format=yuv420p';
const C = (text, s, e) => ({ text, timestamp: [s, e] });

test('fixture words appear in the exported frame at their times and not in a gap', { skip }, () => {
  const d = mkdtempSync(join(tmpdir(), 'burn-'));
  mkdirSync(join(d, 'fonts'));
  copyFileSync(join(here, '..', 'font', 'Poppins-Bold.ttf'), join(d, 'fonts', 'font.ttf'));
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: d, stdio: ['ignore', 'pipe', 'pipe'] });
  // 16:9 landscape source with a tone, like a phone clip (crop to 9:16 is exercised too)
  run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=8', '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', 'src.mp4']);
  const words = normalizeWords([C('Orange', 1.0, 1.4), C('river', 1.4, 1.9), C('MORNING', 1.9, 2.5), C('Silver', 5.0, 5.5), C('lantern', 5.5, 6.2)], 8);
  const lines = groupWords(words);
  writeFileSync(join(d, 'sub.ass'), buildAss(lines));
  const probe = pickProbeTimes(lines, 8);
  assert.ok(probe.tGap !== null);
  run('ffmpeg', ['-v', 'error', '-i', 'src.mp4', '-vf', VF_ASS, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', 'out.mp4']);
  const frame = (t, name, vf) => { run('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', 'out.mp4', '-frames:v', '1', '-y', name]); return name; };
  const ocr = (img) => {
    // crop the caption band (y 780..1000 of 1280), grayscale + upscale to help tesseract
    run('ffmpeg', ['-v', 'error', '-i', img, '-vf', 'crop=720:300:0:760,format=gray,scale=iw*2:ih*2,negate', '-y', 'band_' + img]);
    return run('tesseract', ['band_' + img, '-', '--psm', '6']).toString().toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
  };
  // first caption on screen (karaoke fill finished near the end of the line)
  const t1 = 2.2, t2 = 5.9;
  const o1 = ocr(frame(t1, 'f1.png')), o2 = ocr(frame(t2, 'f2.png')), og = ocr(frame(probe.tGap, 'fg.png'));
  console.log('OCR at', t1, '->', JSON.stringify(o1), '| at', t2, '->', JSON.stringify(o2), '| gap', probe.tGap, '->', JSON.stringify(og));
  assert.match(o1, /orange/); assert.match(o1, /river/); assert.match(o1, /morning/);
  assert.match(o2, /silver/); assert.match(o2, /lantern/);
  assert.ok(!/orange|silver|lantern|morning/.test(og), 'no caption text in the gap frame');
  assert.ok(!/clipgen|caption|test/.test(o1 + o2), 'the old hardcoded test text must not appear');
  const info = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'csv=p=0', join(d, 'out.mp4')]).toString();
  assert.match(info, /h264,720,1280/);
  assert.match(info, /aac/);
  // pixel diff vs caption-free frame, same method as the page
  run('ffmpeg', ['-v', 'error', '-ss', String(probe.tWord), '-i', 'src.mp4', '-vf', VF_BASE, '-frames:v', '1', '-y', 'plain.png']);
  run('ffmpeg', ['-v', 'error', '-ss', String(probe.tWord), '-i', 'out.mp4', '-frames:v', '1', '-y', 'cap.png']);
  const cnt = (a, b) => Number(run('ffmpeg', ['-v', 'error', '-i', a, '-i', b, '-filter_complex', '[0][1]blend=all_mode=difference,format=gray,geq=lum=if(gt(lum(X\\,Y)\\,40)\\,255\\,0),signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']).toString().match(/YAVG=([\d.]+)/)[1]);
  const yavg = cnt('plain.png', 'cap.png');
  console.log('changed-pixel average (0..255) at word time:', yavg);
  assert.ok(yavg > 0.3, 'captions change the frame');
});
