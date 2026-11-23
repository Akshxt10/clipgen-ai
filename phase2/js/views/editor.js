/* Clip editor: trim, captions (text + style), format, live preview, render, download, regenerate */
import { h, fmtTime, fmtLong, fmtBytes, clamp, debounce, isAbort } from '../util.js';
import { icon } from '../icons.js';
import { conn } from '../conn.js';
import * as api from '../api.js';
import { addHistory, getSettings } from '../state.js';
import { createPreview, buildPages } from '../preview.js';
import { progressBar, notice, btn, toast, triggerDownload, setTitle, empty } from '../ui.js';
import { captionDefaults, splitKeywords } from '../components.js';

const r1 = (n) => Math.round(n * 10) / 10;

export async function mount(root, ctx) {
  const [id, cid] = ctx.params;
  let dead = false;
  const ac = new AbortController();
  const caps = conn.caps || { captionStyles: {}, fonts: [] };
  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '420px' } }));
  let data;
  try { data = await api.getProject(id); } catch (e) { root.replaceChildren(notice('bad', e.message, h('div', { class: 'row' }, btn('Back', { cls: 'sm', href: '#/' })))); return () => {}; }
  if (dead) return () => {};
  const project = data.project, analysis = data.analysis;
  let clip = analysis && analysis.clips.find((c) => c.id === cid);
  if (!clip) { root.replaceChildren(empty({ art: 'clips', title: 'Clip not found', text: 'It may have been replaced or the video expired.', actions: [btn('Back to clips', { cls: 'primary', href: '#/project/' + id + '/clips' })] })); return () => {}; }
  setTitle('Edit clip ' + clip.rank);
  const duration = project.media.duration;
  const s = analysis.settings;
  const hasWords = !!project.hasTranscript;

  /* ---------- editor state ---------- */
  const e0 = clip.edit || {};
  const st = {
    start: clip.start, end: clip.end,
    aspect: e0.aspect || s.aspect, reframe: e0.reframe || s.reframe, quality: e0.quality || '720',
    captions: e0.captions !== undefined ? e0.captions : (s.captions && hasWords),
    caption: Object.assign(captionDefaults((e0.caption && e0.caption.style) || s.captionStyle, caps, s.keywords || []), e0.caption || {}),
    words: e0.words || [], title: clip.title
  };
  if (!st.words.length && hasWords) { try { st.words = (await api.words(id, st.start, st.end)).words; } catch (_) { st.words = []; } }
  if (dead) return () => {};
  const auto = clip.auto || { start: clip.start, end: clip.end };
  const sig = () => JSON.stringify([st.start, st.end, st.aspect, st.reframe, st.quality, st.captions, st.caption, st.words.map((w) => [w.w, w.s, w.e])]);
  let renderedSig = clip.renderUrl && clip.renderCurrent ? sig() : null;
  let renderedUrl = clip.renderUrl ? api.mediaUrl(clip.renderUrl) : '', downloadUrl = clip.downloadUrl ? api.mediaUrl(clip.downloadUrl) : '', renderBytes = clip.render && clip.render.bytes;
  let savedRange = { start: clip.start, end: clip.end };
  let useRendered = false, tab = 'trim', rendering = false;

  /* ---------- preview ---------- */
  const pv = createPreview({ sourceUrl: api.mediaUrl(project.urls.source), styles: caps.captionStyles || {} });
  let errShown = false;
  pv.video.addEventListener('error', () => { if (!errShown && !dead && !useRendered) { errShown = true; toast('The preview link expired. Reloading …'); ctx.remount(); } });
  const pushPreview = () => pv.update({ start: st.start, end: st.end, aspect: st.aspect, reframe: st.reframe, captions: st.captions, caption: st.caption, words: st.words, renderedUrl, useRendered: useRendered && !!renderedUrl && renderedSig === sig() });
  const timelineWin = h('div', { class: 'win' }), timelineHead = h('div', { class: 'head' });
  const timeline = h('div', { class: 'timeline', 'aria-hidden': 'true' }, timelineWin, timelineHead);
  pv.onTime((t) => { timelineHead.style.left = (clamp(t, 0, duration) / duration * 100) + '%'; markCurrentRow(t); });

  /* ---------- saving ---------- */
  const saveState = h('span', { class: 'small muted' }, '');
  const save = debounce(async () => {
    if (dead) return;
    const body = { aspect: st.aspect, reframe: st.reframe, quality: st.quality, captions: st.captions, caption: st.caption, title: st.title };
    if (hasWords) body.words = st.words;
    if (st.start !== savedRange.start || st.end !== savedRange.end) { body.start = st.start; body.end = st.end; }
    saveState.textContent = 'Saving …';
    try { await api.patchClip(id, cid, body); savedRange = { start: st.start, end: st.end }; saveState.textContent = 'Saved'; }
    catch (e) { saveState.textContent = 'Not saved: ' + e.message; }
  }, 900);
  const changed = () => { saveState.textContent = 'Unsaved changes'; save(); pushPreview(); renderStatus(); paintTimeline(); };

  /* ---------- trimming ---------- */
  async function setRange(start, end, seekTo) {
    start = r1(clamp(start, 0, duration - 1)); end = r1(clamp(end, start + 1, duration));
    if (end - start > 600) end = r1(start + 600);
    const oldS = st.start, oldE = st.end;
    st.start = start; st.end = end;
    st.words = st.words.filter((w) => w.e > start && w.s < end);
    changed(); paintTrim();
    pv.seek(seekTo === 'end' ? Math.max(start, end - 2) : start);
    if (hasWords) {
      try {
        const add = [];
        if (start < oldS) add.push(...(await api.words(id, start, oldS)).words);
        if (end > oldE) add.push(...(await api.words(id, oldE, end)).words);
        if (add.length && !dead && st.start === start && st.end === end) {
          const have = new Set(st.words.map((w) => w.s + ':' + w.e));
          st.words = [...st.words, ...add.filter((w) => !have.has(w.s + ':' + w.e) && w.e > start && w.s < end)].sort((a, b) => a.s - b.s);
          changed(); paintCaptions();
        }
      } catch (_) { /* captions for the new part may be missing; the clip itself is fine */ }
    }
    paintCaptions();
  }

  /* ---------- panels ---------- */
  const panel = h('div');
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const TABS = [['trim', 'Trim'], ['captions', 'Captions'], ['style', 'Style'], ['format', 'Format']];
  const paintTabs = () => { tabsEl.replaceChildren(...TABS.map(([k, l]) => h('button', { type: 'button', role: 'tab', class: tab === k ? 'on' : '', 'aria-selected': String(tab === k), onclick: () => { tab = k; paintTabs(); paintPanel(); } }, l))); };
  const durChip = h('span', { class: 'chip accent num' });
  let rowsEl = null, rowRanges = [];

  function numField(label, getv, onset) {
    const inp = h('input', { class: 'input num', type: 'number', step: '0.1', min: '0', max: String(r1(duration)), value: getv().toFixed(1), 'aria-label': label, onchange: () => { const v = Number(inp.value); if (Number.isFinite(v)) onset(v); inp.value = getv().toFixed(1); } });
    inp.refresh = () => { inp.value = getv().toFixed(1); };
    return inp;
  }
  let startIn, endIn, startR, endR;
  function paintTimeline() {
    timelineWin.style.left = (st.start / duration * 100) + '%'; timelineWin.style.width = Math.max(0.5, (st.end - st.start) / duration * 100) + '%';
    durChip.textContent = Math.round((st.end - st.start) * 10) / 10 + ' s';
  }
  function paintTrim() { paintTimeline(); if (startIn) { startIn.refresh(); endIn.refresh(); startR.value = st.start; endR.value = st.end; } }
  const nudgeRow = (which) => h('div', { class: 'nudge' }, [-1, -0.1, 0.1, 1].map((d) => h('button', { class: 'btn', type: 'button', onclick: () => which === 'start' ? setRange(st.start + d, st.end) : setRange(st.start, st.end + d, 'end') }, (d > 0 ? '+' : '−') + Math.abs(d) + ' s')));

  function trimPanel() {
    startIn = numField('Start (seconds)', () => st.start, (v) => setRange(v, st.end));
    endIn = numField('End (seconds)', () => st.end, (v) => setRange(st.start, v, 'end'));
    startR = h('input', { type: 'range', min: '0', max: String(duration), step: '0.1', value: st.start, 'aria-label': 'Start position', oninput: () => { const v = Math.min(Number(startR.value), st.end - 1); setRange(v, st.end); } });
    endR = h('input', { type: 'range', min: '0', max: String(duration), step: '0.1', value: st.end, 'aria-label': 'End position', oninput: () => { const v = Math.max(Number(endR.value), st.start + 1); setRange(st.start, v, 'end'); } });
    return h('div', { class: 'stack' },
      h('div', null, h('label', { class: 'lbl' }, 'Title'), h('input', { class: 'input', type: 'text', value: st.title, maxlength: '120', oninput: (e) => { st.title = e.target.value; saveState.textContent = 'Unsaved changes'; save(); } })),
      h('div', null, h('div', { class: 'row between' }, h('label', { class: 'lbl' }, 'Position in the full video'), durChip), timeline),
      h('div', { class: 'fields two' },
        h('div', null, h('label', { class: 'lbl' }, 'Start (s)'), startIn, startR, nudgeRow('start'), h('div', { style: { marginTop: '8px' } }, btn('Set to playhead', { cls: 'sm', onclick: () => setRange(pv.time(), st.end) }))),
        h('div', null, h('label', { class: 'lbl' }, 'End (s)'), endIn, endR, nudgeRow('end'), h('div', { style: { marginTop: '8px' } }, btn('Set to playhead', { cls: 'sm', onclick: () => setRange(st.start, pv.time(), 'end') })))),
      h('div', { class: 'row' }, btn('Reset to AI suggestion', { cls: 'sm', ic: 'refresh', onclick: () => setRange(auto.start, auto.end) }), h('span', { class: 'hint' }, 'AI suggestion: ' + fmtTime(auto.start, true) + ' – ' + fmtTime(auto.end, true))),
      clip.reasons && clip.reasons.length ? h('div', { class: 'notice' }, h('b', null, 'Why this moment: '), clip.reasons.join(' · ')) : null);
  }

  /* captions text editing: rows of ~6 words; editing a row keeps timings (re-spread if the word count changes) */
  function markCurrentRow(t) {
    if (!rowsEl || tab !== 'captions') return;
    [...rowsEl.children].forEach((r, i) => r.classList.toggle('cur', !!rowRanges[i] && t >= rowRanges[i][0] - 0.05 && t <= rowRanges[i][1] + 0.2));
  }
  function applyRow(rowWords, text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    const rs = new Set(rowWords);
    const first = rowWords[0], last = rowWords[rowWords.length - 1];
    let repl;
    if (toks.length === rowWords.length) repl = rowWords.map((w, i) => ({ w: toks[i], s: w.s, e: w.e }));
    else if (!toks.length) repl = [];
    else {
      const total = toks.reduce((a, t) => a + t.length + 1, 0); let cur = first.s;
      repl = toks.map((t) => { const span = (last.e - first.s) * ((t.length + 1) / total); const w = { w: t, s: r1k(cur), e: r1k(cur + span) }; cur += span; return w; });
    }
    const idx = st.words.indexOf(first);
    st.words = [...st.words.slice(0, idx), ...repl, ...st.words.slice(idx + rowWords.length)];
    void rs;
    changed(); paintCaptions();
  }
  const r1k = (n) => Math.round(n * 1000) / 1000;
  function captionsPanel() {
    if (!hasWords) return h('div', { class: 'stack' }, notice('warn', h('b', null, 'No transcript for this video. '), 'Captions need speech recognition. Ask the server owner to enable it (see the backend setup guide), then analyse the video again.'));
    rowsEl = h('div', { class: 'caprows' });
    const wrap = h('div', { class: 'stack' },
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.captions, onchange: (e) => { st.captions = e.target.checked; changed(); } }), h('span', { class: 'track' }), 'Burn captions into the clip'),
      h('p', { class: 'hint' }, 'Fix any misheard words. Timing is kept; if you add or remove words the timing is spread across the line.'), rowsEl);
    paintCaptions();
    return wrap;
  }
  function paintCaptions() {
    if (!rowsEl || tab !== 'captions') return;
    const pages = buildPages(st.words, 6);
    rowRanges = pages.map((p) => [p[0].s, p[p.length - 1].e]);
    rowsEl.replaceChildren(...pages.map((p) => {
      const inp = h('input', { class: 'input', type: 'text', value: p.map((w) => w.w).join(' '), 'aria-label': 'Caption line at ' + fmtTime(p[0].s - st.start, true), autocapitalize: 'off', spellcheck: 'true' });
      inp.addEventListener('focus', () => pv.seek(p[0].s));
      inp.addEventListener('change', () => applyRow(p, inp.value));
      return h('div', { class: 'caprow' }, h('span', { class: 't' }, fmtTime(p[0].s - st.start, true)), inp);
    }));
    if (!pages.length) rowsEl.replaceChildren(h('div', { class: 'muted small' }, 'No speech in the selected range.'));
  }

  function stylePanel() {
    const c = st.caption;
    const setC = (patch) => { Object.assign(st.caption, patch); changed(); };
    const colorIn = (label, key) => h('div', null, h('label', { class: 'lbl' }, label), h('input', { class: 'input', type: 'color', value: c[key] || '#ffffff', 'aria-label': label, oninput: (e) => setC({ [key]: e.target.value.toUpperCase() }) }));
    const fonts = caps.fonts && caps.fonts.length ? caps.fonts : [];
    return h('div', { class: 'stack' },
      !hasWords ? notice('warn', 'Captions are unavailable because this video has no transcript.') : null,
      h('div', null, h('label', { class: 'lbl' }, 'Template'), h('div', { class: 'pickgrid' }, Object.entries(caps.captionStyles || {}).map(([k, v]) => h('button', { type: 'button', class: 'pick' + (c.style === k ? ' on' : ''), onclick: () => { Object.assign(st.caption, captionDefaults(k, caps, c.keywords), { font: c.font, position: c.position, size: c.size }); changed(); paintPanel(); } }, h('b', { style: { color: v.color, textShadow: '0 1px 2px #000', textTransform: v.upper ? 'uppercase' : 'none' } }, 'Aa'), h('small', null, v.label))))),
      h('div', { class: 'fields two' },
        h('div', null, h('label', { class: 'lbl' }, 'Font'), h('select', { class: 'input', onchange: (e) => setC({ font: e.target.value }) }, h('option', { value: '' }, 'Template default'), fonts.map((f) => h('option', { value: f, selected: c.font === f }, f)))),
        h('div', null, h('label', { class: 'lbl' }, 'Position'), h('select', { class: 'input', onchange: (e) => setC({ position: e.target.value }) }, [['auto', 'Automatic (clear of app buttons)'], ['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']].map(([v, l]) => h('option', { value: v, selected: c.position === v }, l))))),
      h('div', null, h('label', { class: 'lbl' }, 'Size · ' + c.size + '%'), h('input', { type: 'range', min: '60', max: '160', step: '5', value: c.size, 'aria-label': 'Caption size', oninput: (e) => { c.size = Number(e.target.value); e.target.previousSibling.textContent = 'Size · ' + c.size + '%'; changed(); } })),
      h('div', { class: 'fields three' }, colorIn('Text colour', 'color'), colorIn('Highlight colour', 'highlight'), colorIn('Outline colour', 'outline')),
      h('div', null, h('label', { class: 'lbl' }, 'Highlighted keywords'), h('input', { class: 'input', type: 'text', value: (c.keywords || []).join(', '), placeholder: 'secret, free, never …', autocapitalize: 'off', onchange: (e) => setC({ keywords: splitKeywords(e.target.value) }) }), h('div', { class: 'hint' }, 'Comma-separated; these words are drawn in the highlight colour.')),
      h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: c.upper, onchange: (e) => setC({ upper: e.target.checked }) }), h('span', { class: 'track' }), 'UPPERCASE'),
      h('p', { class: 'hint' }, 'The preview is an approximation. The rendered MP4 uses the exact font, outline and timing.'));
  }

  const REFRAME = [['smart', 'Smart'], ['center', 'Center'], ['blur', 'Blur fill']];
  function formatPanel() {
    const seg = (items, key) => h('div', { class: 'seg' }, items.map(([v, l]) => h('button', { type: 'button', class: st[key] === v ? 'on' : '', onclick: () => { st[key] = v; changed(); paintPanel(); } }, l)));
    return h('div', { class: 'stack' },
      h('div', null, h('label', { class: 'lbl' }, 'Aspect ratio'), seg([['9:16', '9:16 vertical'], ['1:1', '1:1 square'], ['16:9', '16:9 wide']], 'aspect')),
      h('div', null, h('label', { class: 'lbl' }, 'Framing'), seg(REFRAME, 'reframe'), h('div', { class: 'hint' }, st.reframe === 'smart' ? 'The final render follows the speaker. The live preview shows a center crop.' : st.reframe === 'blur' ? 'Keeps the whole picture, filling the frame with a blurred copy.' : 'Fixed center crop.')),
      h('div', null, h('label', { class: 'lbl' }, 'Resolution'), seg([['720', '720p (faster)'], ['1080', '1080p']], 'quality')),
      h('div', { class: 'hint' }, 'Original audio is always kept.'));
  }
  function paintPanel() {
    rowsEl = null;
    panel.replaceChildren(tab === 'trim' ? trimPanel() : tab === 'captions' ? captionsPanel() : tab === 'style' ? stylePanel() : formatPanel());
    if (tab === 'trim') paintTrim();
  }

  /* ---------- render / download ---------- */
  const statusBox = h('div');
  const renderBar = progressBar(null), renderMsg = h('div', { class: 'small muted' });
  const current = () => renderedSig !== null && renderedSig === sig();
  function renderStatus() {
    if (dead) return;
    if (rendering) { statusBox.replaceChildren(h('div', { class: 'notice' }, h('div', { class: 'row between nowrap' }, h('b', null, 'Rendering'), h('span', { class: 'small muted' }, 'FFmpeg on the server')), h('div', { style: { margin: '8px 0 4px' } }, renderBar), renderMsg)); return; }
    const cur = current();
    const node = (
      renderedUrl && cur ? notice('ok', h('b', null, 'Rendered' ), renderBytes ? ' · ' + fmtBytes(renderBytes) : '', h('div', { class: 'row' }, btn(useRendered ? 'Show live preview' : 'Play rendered file', { cls: 'sm', ic: 'play', onclick: () => { useRendered = !useRendered; pushPreview(); renderStatus(); } })))
        : renderedUrl ? notice('warn', 'You changed something since the last render. Render again to update the file.') : null);
    statusBox.replaceChildren(...(node ? [node] : []));
    renderBtn.textContent = cur ? 'Render again' : 'Render clip';
    dlBtn.disabled = rendering;
  }
  async function doRender() {
    if (rendering) return false;
    rendering = true; save.cancel(); useRendered = false; renderBar.set(null); renderMsg.textContent = 'Starting …'; renderStatus(); renderBtn.disabled = true; dlBtn.disabled = true;
    const sigAtStart = sig(); const t0 = Date.now();
    try {
      const body = { start: st.start, end: st.end, aspect: st.aspect, reframe: st.reframe, quality: st.quality, captions: st.captions, caption: st.caption, title: st.title };
      if (hasWords) body.words = st.words;
      const { job } = await api.renderClip(id, cid, body);
      await api.pollJob(job.id, (j) => { renderBar.set(j.state === 'queued' ? null : j.progress); renderMsg.textContent = j.state === 'queued' ? 'Waiting for a free worker …' : (j.message || ''); }, { signal: ac.signal });
      const fresh = await api.getProject(id);
      clip = fresh.analysis.clips.find((c) => c.id === cid) || clip;
      renderedUrl = api.mediaUrl(clip.renderUrl); downloadUrl = api.mediaUrl(clip.downloadUrl); renderBytes = clip.render && clip.render.bytes; renderedSig = sigAtStart; savedRange = { start: st.start, end: st.end };
      addHistory({ kind: 'render', ok: true, projectId: id, name: project.name + ' · clip ' + clip.rank, message: 'Clip rendered', ms: Date.now() - t0 });
      return true;
    } catch (e) {
      if (!isAbort(e)) { addHistory({ kind: 'render', ok: false, projectId: id, name: project.name + ' · clip ' + clip.rank, message: e.message, ms: Date.now() - t0 }); toast(e.message, { kind: 'bad', ms: 9000 }); }
      return false;
    } finally { rendering = false; if (!dead) { renderBtn.disabled = false; dlBtn.disabled = false; renderStatus(); pushPreview(); saveState.textContent = 'Saved'; } }
  }
  const renderBtn = btn('Render clip', { cls: 'primary', ic: 'film', onclick: async () => { if (await doRender()) { useRendered = true; pushPreview(); renderStatus(); } } });
  const dlBtn = btn('Download MP4', { cls: '', ic: 'download', onclick: async () => {
    if (!current()) { if (!(await doRender())) return; }
    triggerDownload(downloadUrl);
    toast('Download started.', { kind: 'ok', action: { label: 'Save again', run: () => triggerDownload(downloadUrl) } });
  } });
  const regenBtn = btn('Regenerate clip', { cls: 'ghost', ic: 'refresh', onclick: async () => {
    regenBtn.disabled = true;
    try { await api.regenerateClip(id, cid); toast('Replaced with the next best distinct moment.', { kind: 'ok' }); ctx.remount(); }
    catch (e) { regenBtn.disabled = false; toast(e.message, { kind: 'bad' }); }
  } });

  /* ---------- layout ---------- */
  const order = analysis.clips.slice().sort((a, b) => a.rank - b.rank);
  const idx = order.findIndex((c) => c.id === cid);
  const nav = (c, label, ic) => c ? h('a', { class: 'btn sm ghost', href: '#/project/' + id + '/edit/' + c.id }, label) : null;
  root.replaceChildren(
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Dashboard'), '›', h('a', { href: '#/project/' + id + '/clips' }, project.name), '›', h('span', null, 'Clip ' + clip.rank)),
    h('div', { class: 'page-head' }, h('div', { class: 'grow' }, h('h1', { style: { fontSize: 'clamp(22px,5vw,30px)' } }, 'Clip editor'), h('div', { class: 'chips', style: { marginTop: '8px' } }, h('span', { class: 'chip accent' }, 'Score ' + Math.round(clip.score)), (clip.categories || []).map((k) => h('span', { class: 'chip' }, k)), saveState)),
      h('div', { class: 'row' }, nav(order[idx - 1], '← Previous'), nav(order[idx + 1], 'Next →'))),
    h('div', { class: 'editor' },
      h('div', { class: 'previewcol' }, pv.el, h('div', { class: 'stack', style: { marginTop: '14px' } }, statusBox, h('div', { class: 'row' }, renderBtn, dlBtn), regenBtn)),
      h('div', { class: 'card' }, tabsEl, panel)));
  paintTabs(); paintPanel(); renderStatus(); pushPreview(); paintTimeline();
  window.addEventListener('beforeunload', flush);
  function flush() { save.cancel(); }
  return () => { dead = true; ac.abort(); window.removeEventListener('beforeunload', flush); /* make sure pending edits are stored */ if (saveState.textContent === 'Unsaved changes') { const body = { aspect: st.aspect, reframe: st.reframe, quality: st.quality, captions: st.captions, caption: st.caption, title: st.title }; if (hasWords) body.words = st.words; if (st.start !== savedRange.start || st.end !== savedRange.end) { body.start = st.start; body.end = st.end; } api.patchClip(id, cid, body).catch(() => {}); } pv.destroy(); };
}
