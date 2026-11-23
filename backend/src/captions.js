/*
  ClipGen AI backend · caption templates and ASS subtitle generation.
  Words come from the real transcript (or the user's edits). Pages of a few words are shown, and the word being
  spoken is highlighted (word-level timing). Burned into the video with ffmpeg's libass renderer.
*/
import { EMOTION, SURPRISE, FUNNY, HOOK_WORDS, STOPWORDS, normWord } from './lexicon.js';
import { clamp } from './util.js';
import { spawnSync } from 'node:child_process';

export const CAPTION_STYLES = {
  pop: { label: 'Pop', fonts: ['Montserrat', 'Poppins', 'Inter', 'DejaVu Sans'], bold: true, upper: true, words: 3, color: '#FFFFFF', highlight: '#FFD83D', outline: '#000000', outlineK: 0.10, shadow: 2, box: false, active: 112, perWord: true },
  karaoke: { label: 'Karaoke', fonts: ['Inter', 'Montserrat', 'DejaVu Sans'], bold: true, upper: false, words: 6, color: '#FFFFFF', highlight: '#2FD4F0', outline: '#000000', outlineK: 0.075, shadow: 1, box: false, active: 100, perWord: true },
  classic: { label: 'Classic', fonts: ['DejaVu Sans', 'Liberation Sans', 'Inter'], bold: false, upper: false, words: 7, color: '#FFFFFF', highlight: null, outline: '#000000', outlineK: 0.0, shadow: 0, box: true, active: 100, perWord: false },
  minimal: { label: 'Minimal', fonts: ['Inter', 'DejaVu Sans'], bold: false, upper: false, words: 7, color: '#FFFFFF', highlight: null, outline: '#000000', outlineK: 0.045, shadow: 1, box: false, active: 100, perWord: false },
  neon: { label: 'Neon', fonts: ['Poppins', 'Montserrat', 'Inter', 'DejaVu Sans'], bold: true, upper: true, words: 3, color: '#E6FBFF', highlight: '#FF3DCB', outline: '#0A1030', outlineK: 0.09, shadow: 3, box: false, active: 108, perWord: true },
  impact: { label: 'Impact', fonts: ['Poppins', 'Montserrat', 'DejaVu Sans'], bold: true, upper: true, words: 2, color: '#FFE600', highlight: '#FFFFFF', outline: '#000000', outlineK: 0.13, shadow: 2, box: false, active: 118, perWord: true }
};

let fontCache = null;
export function availableFonts() {
  if (fontCache) return fontCache;
  const want = ['Montserrat', 'Poppins', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Lora', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'];
  let have = new Set();
  try {
    const r = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8', timeout: 8000 });
    if (r.status === 0) for (const line of r.stdout.split('\n')) for (const fam of line.split(',')) have.add(fam.trim());
  } catch (_) { /* fontconfig missing */ }
  fontCache = want.filter((f) => have.has(f));
  if (!fontCache.length) fontCache = ['DejaVu Sans'];
  return fontCache;
}
export const _resetFontCache = () => { fontCache = null; };

const assColor = (hex, alpha = 0) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const h = (m ? m[1] : 'FFFFFF');
  return '&H' + alpha.toString(16).padStart(2, '0').toUpperCase() + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
};
const tagColor = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); const h = m ? m[1] : 'FFFFFF'; return '&H' + (h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toUpperCase() + '&'; };
const assT = (sec) => {
  sec = Math.max(0, sec);
  const cs = Math.round(sec * 100), h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(c).padStart(2, '0');
};
const esc = (t) => String(t).replace(/\\/g, '').replace(/[{}]/g, '').replace(/\r?\n/g, ' ');

export function normalizeCaptionOptions(o) {
  const x = o || {};
  const style = CAPTION_STYLES[x.style] ? x.style : 'pop';
  const hex = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toUpperCase() : d);
  const fonts = availableFonts();
  const t = CAPTION_STYLES[style];
  let font = typeof x.font === 'string' && fonts.includes(x.font) ? x.font : (t.fonts.find((f) => fonts.includes(f)) || fonts[0]);
  return {
    style, font,
    color: hex(x.color, t.color), highlight: t.highlight ? hex(x.highlight, t.highlight) : null, outline: hex(x.outline, t.outline),
    position: ['auto', 'bottom', 'middle', 'top'].includes(x.position) ? x.position : 'auto',
    size: clamp(Number(x.size) || 100, 60, 160),
    keywords: Array.isArray(x.keywords) ? x.keywords.map((k) => normWord(String(k))).filter(Boolean).slice(0, 40) : [],
    upper: typeof x.upper === 'boolean' ? x.upper : t.upper
  };
}

/* group words into on-screen pages */
export function buildPages(words, maxWords) {
  const pages = [];
  let cur = [];
  const flush = () => { if (cur.length) pages.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length) {
      const gap = w.s - cur[cur.length - 1].e;
      if (gap > 0.7 || cur.length >= maxWords) flush();
    }
    cur.push(w);
    if (/[.!?…]["')\]]*$/.test(w.w) && cur.length >= 2) flush();
  }
  flush();
  return pages;
}

/* which words of a page to emphasise: user keywords, emotional/surprising/funny/hook words, figures; else the longest content word */
export function emphasisIndexes(page, userKeywords) {
  const set = new Set(userKeywords || []);
  const idx = new Set();
  page.forEach((w, k) => {
    const t = normWord(w.w);
    if (!t) return;
    if (set.has(t) || EMOTION.has(t) || SURPRISE.has(t) || FUNNY.has(t) || HOOK_WORDS.has(t) || /\d/.test(t)) idx.add(k);
  });
  if (!idx.size) {
    let best = -1, bl = 0;
    page.forEach((w, k) => { const t = normWord(w.w); if (t.length >= 6 && !STOPWORDS.has(t) && t.length > bl) { bl = t.length; best = k; } });
    if (best >= 0) idx.add(best);
  }
  return idx;
}

/*
  buildAss(words, { width, height, duration, options }) – words are clip-local (0 = first frame of the clip).
*/
export function buildAss(words, { width, height, duration, options }) {
  const o = normalizeCaptionOptions(options);
  const t = CAPTION_STYLES[o.style];
  const vertical = height > width * 1.2, square = Math.abs(height - width) < width * 0.1;
  const fontSize = Math.round((vertical ? width * 0.078 : square ? width * 0.066 : height * 0.062) * (o.size / 100) * (o.style === 'impact' ? 1.12 : 1));
  const margin = Math.round(width * 0.08);
  const align = o.position === 'top' ? 8 : o.position === 'middle' ? 5 : 2;
  const marginV = o.position === 'bottom' || o.position === 'auto'
    ? Math.round(height * (vertical ? 0.2 : square ? 0.09 : 0.075))      // auto: clear of phone UI on vertical
    : Math.round(height * 0.12);
  const outline = Math.max(0, Math.round(fontSize * t.outlineK));
  const border = t.box ? 3 : 1;
  const back = t.box ? assColor('#000000', 0x70) : assColor('#000000', 0x80);
  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + width, 'PlayResY: ' + height, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,' + o.font + ',' + fontSize + ',' + assColor(o.color) + ',' + assColor(o.color) + ',' + assColor(o.outline) + ',' + back + ',' + (t.bold ? -1 : 0) + ',0,0,0,100,100,0,0,' + border + ',' + (t.box ? Math.round(fontSize * 0.22) : outline) + ',' + t.shadow + ',' + align + ',' + margin + ',' + margin + ',' + marginV + ',1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const txt = (w) => esc(o.upper ? w.w.toUpperCase() : w.w);
  const clean = words.filter((w) => w && typeof w.w === 'string' && w.w.trim() && w.e > 0 && w.s < duration).map((w) => ({ w: w.w.trim(), s: Math.max(0, w.s), e: Math.min(duration, Math.max(w.e, w.s + 0.05)) }));
  const pages = buildPages(clean, t.words);
  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageEnd = Math.min(duration, Math.max(page[page.length - 1].e + 0.12, page[page.length - 1].s + 0.25), p + 1 < pages.length ? pages[p + 1][0].s : duration);
    if (!t.perWord || !o.highlight) {
      lines.push('Dialogue: 0,' + assT(page[0].s) + ',' + assT(pageEnd) + ',Default,,0,0,0,,' + page.map(txt).join(' '));
      continue;
    }
    const emph = emphasisIndexes(page, o.keywords);
    for (let k = 0; k < page.length; k++) {
      const s = page[k].s, e = k + 1 < page.length ? page[k + 1].s : pageEnd;
      if (e - s < 0.02) continue;
      const body = page.map((w, m) => {
        if (m === k) return '{\\1c' + tagColor(o.highlight) + '\\fscx' + t.active + '\\fscy' + t.active + '}' + txt(w) + '{\\r}';
        if (emph.has(m)) return '{\\1c' + tagColor(o.highlight) + '}' + txt(w) + '{\\r}';
        return txt(w);
      }).join(' ');
      lines.push('Dialogue: 0,' + assT(s) + ',' + assT(e) + ',Default,,0,0,0,,' + body);
    }
  }
  return lines.join('\n') + '\n';
}
