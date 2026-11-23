/*
  Live clip preview: plays the REAL source video between the clip's start and end, cropped/framed like the chosen
  aspect ratio, with the captions drawn on top from the real word timestamps. (The exported file is produced by
  FFmpeg on the server; this preview approximates its look. After rendering, the exported file can be played here.)
*/
import { h, fmtTime, clamp } from './util.js';
import { icon } from './icons.js';

const PAGE_WORDS = { pop: 3, karaoke: 6, classic: 7, minimal: 7, neon: 3, impact: 2 };
const SENT_END = /[.!?…]["')\]]*$/;
const norm = (w) => String(w).toLowerCase().replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

export function buildPages(words, maxWords) {
  const pages = []; let cur = [];
  const flush = () => { if (cur.length) pages.push(cur); cur = []; };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length && w.s - cur[cur.length - 1].e > 0.7) flush();
    cur.push(w);
    if (cur.length >= maxWords || SENT_END.test(w.w)) flush();
  }
  flush();
  return pages;
}

export function createPreview({ sourceUrl, styles = {} }) {
  let st = { start: 0, end: 1, aspect: '9:16', reframe: 'smart', captions: true, caption: { style: 'pop', color: '#FFFFFF', highlight: '#FFD83D', outline: '#000000', position: 'auto', size: 100, keywords: [], upper: true, font: '' }, words: [], renderedUrl: '', useRendered: false };
  let src = '', listeners = [], raf = 0, pages = [], pagesKey = '';
  const vid = h('video', { playsinline: '', preload: 'metadata', class: 'cover' });
  vid.setAttribute('webkit-playsinline', '');
  const bg = h('video', { playsinline: '', muted: true, preload: 'metadata', class: 'bgblur', 'aria-hidden': 'true', tabindex: '-1' });
  bg.muted = true;
  const cap = h('div', { class: 'capov' });
  const frame = h('div', { class: 'frame a916', onclick: () => toggle() }, bg, vid, cap);
  const playBtn = h('button', { class: 'btn iconbtn', type: 'button', 'aria-label': 'Play or pause', onclick: () => toggle() });
  const scrub = h('input', { type: 'range', min: '0', max: '1000', value: '0', 'aria-label': 'Position in clip', oninput: () => { const r = range(); seek(r.a + (scrub.value / 1000) * (r.b - r.a)); } });
  const label = h('span', { class: 'small muted num' }, '0:00');
  const el = h('div', null, h('div', { class: 'frame-wrap' }, frame), h('div', { class: 'pcontrols' }, playBtn, scrub, label));

  const range = () => (st.useRendered && st.renderedUrl ? { a: 0, b: vid.duration && isFinite(vid.duration) ? vid.duration : st.end - st.start } : { a: st.start, b: st.end });
  const setPlayIcon = () => { playBtn.innerHTML = vid.paused ? icon('play').replace('<svg ', '<svg fill="currentColor" ') : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>'; };
  function toggle() {
    if (vid.paused) {
      const r = range();
      if (vid.currentTime < r.a - 0.05 || vid.currentTime >= r.b - 0.05) seek(r.a);
      vid.play().catch(() => {});
    } else vid.pause();
  }
  function seek(t) { const r = range(); t = clamp(t, r.a, r.b); try { vid.currentTime = t; if (usingBg()) bg.currentTime = t; } catch (_) { /* metadata not loaded yet */ } tick(); }
  const usingBg = () => st.reframe === 'blur' && !(st.useRendered && st.renderedUrl) && st.aspect !== '16:9';

  function loop() {
    tick();
    raf = vid.paused ? 0 : requestAnimationFrame(loop);
  }
  function tick() {
    const r = range();
    let t = vid.currentTime;
    if (!vid.paused && t >= r.b - 0.02) { vid.pause(); t = r.b; }
    if (usingBg()) { if (Math.abs(bg.currentTime - t) > 0.35) { try { bg.currentTime = t; } catch (_) { /* ignore */ } } }
    const frac = r.b > r.a ? clamp((t - r.a) / (r.b - r.a), 0, 1) : 0;
    scrub.value = Math.round(frac * 1000);
    label.textContent = fmtTime(Math.max(0, t - r.a), true) + ' / ' + fmtTime(r.b - r.a);
    drawCaption(t);
    listeners.forEach((fn) => fn(t));
  }

  function layout() {
    const w = frame.clientWidth || 300, hh = frame.clientHeight || 300;
    return { w, h: hh, vertical: hh > w * 1.2, square: Math.abs(hh - w) < w * 0.1 };
  }
  function drawCaption(t) {
    if (!st.captions || st.useRendered || !st.words.length) { cap.replaceChildren(); return; }
    const style = st.caption.style || 'pop';
    const key = style + '|' + st.words.length + '|' + (st.words[0] && st.words[0].s) + '|' + st.words.map((w) => w.w).join(' ').length;
    if (key !== pagesKey) { pages = buildPages(st.words, PAGE_WORDS[style] || 4); pagesKey = key; }
    const page = pages.find((p) => t >= p[0].s - 0.05 && t <= p[p.length - 1].e + 0.25);
    if (!page) { cap.replaceChildren(); return; }
    const L = layout(); const def = styles[style] || {};
    const base = (L.vertical ? L.w * 0.078 : L.square ? L.w * 0.066 : L.h * 0.062) * ((st.caption.size || 100) / 100) * (style === 'impact' ? 1.12 : 1);
    const o = Math.max(1, base * 0.07);
    const pos = st.caption.position || 'auto';
    cap.style.fontSize = base.toFixed(1) + 'px';
    cap.style.top = pos === 'top' ? '12%' : pos === 'middle' ? '50%' : 'auto';
    cap.style.bottom = pos === 'top' || pos === 'middle' ? 'auto' : (L.h * (L.vertical ? 0.2 : L.square ? 0.09 : 0.075)).toFixed(0) + 'px';
    cap.style.transform = pos === 'middle' ? 'translateY(-50%)' : 'none';
    cap.style.fontFamily = st.caption.font ? '"' + st.caption.font + '", system-ui, sans-serif' : 'system-ui, sans-serif';
    cap.style.fontWeight = def.bold ? '800' : '600';
    const kws = new Set((st.caption.keywords || []).map(norm));
    const shadow = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 2]].map(([x, y]) => (x * o).toFixed(1) + 'px ' + (y * o).toFixed(1) + 'px 0 ' + (st.caption.outline || '#000')).join(',');
    const line = h('div', { style: { textShadow: def.box ? 'none' : shadow, background: def.box ? 'rgba(0,0,0,.5)' : 'none', borderRadius: '8px', padding: def.box ? '.15em .45em' : '0' } });
    page.forEach((w, i) => {
      const active = def.perWord && t >= w.s && t < (page[i + 1] ? page[i + 1].s : w.e + 0.25);
      const emph = kws.has(norm(w.w)) && st.caption.highlight;
      const txt = st.caption.upper ? w.w.toUpperCase() : w.w;
      const colored = (active || emph) && st.caption.highlight;
      line.append(h('span', { class: active ? 'hl' : '', style: { color: colored ? st.caption.highlight : st.caption.color } }, txt), i < page.length - 1 ? ' ' : '');
    });
    cap.replaceChildren(line);
  }

  function applySource() {
    const want = st.useRendered && st.renderedUrl ? st.renderedUrl : sourceUrl;
    if (want !== src) {
      src = want;
      vid.src = want; vid.load();
      if (usingBg() || st.reframe === 'blur') { bg.src = sourceUrl; bg.load(); }
      vid.addEventListener('loadedmetadata', () => { seek(range().a); }, { once: true });
    }
  }
  function applyFrame() {
    frame.className = 'frame ' + (st.aspect === '16:9' ? 'a169' : st.aspect === '1:1' ? 'a11' : 'a916');
    const blur = usingBg();
    bg.style.display = blur ? '' : 'none';
    vid.className = blur ? 'contain' : 'cover';
    if (blur && !bg.src) { bg.src = sourceUrl; bg.load(); }
  }

  vid.addEventListener('play', () => { setPlayIcon(); if (usingBg()) bg.play().catch(() => {}); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  vid.addEventListener('pause', () => { setPlayIcon(); bg.pause(); tick(); });
  vid.addEventListener('seeked', tick);
  vid.addEventListener('ended', () => { setPlayIcon(); tick(); });
  vid.addEventListener('timeupdate', tick);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => tick()) : null;
  if (ro) ro.observe(frame);
  setPlayIcon();

  return {
    el, video: vid,
    update(patch) {
      const prevStart = st.start, prevRendered = st.useRendered && st.renderedUrl;
      st = Object.assign({}, st, patch);
      if (patch.caption) st.caption = Object.assign({}, st.caption, patch.caption);
      applyFrame(); applySource();
      const nowRendered = st.useRendered && st.renderedUrl;
      if ((patch.start !== undefined && patch.start !== prevStart && !nowRendered) || prevRendered !== nowRendered) { if (vid.readyState >= 1) seek(range().a); }
      tick();
    },
    seek, toggle, pause: () => vid.pause(),
    time: () => vid.currentTime,
    onTime(fn) { listeners.push(fn); },
    destroy() { cancelAnimationFrame(raf); if (ro) ro.disconnect(); vid.pause(); vid.removeAttribute('src'); bg.removeAttribute('src'); vid.load(); bg.load(); listeners = []; }
  };
}
