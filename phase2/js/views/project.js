/* One video: clip-generation settings → AI analysis progress → generated clips dashboard */
import { h, fmtTime, fmtLong, fmtBytes, timeLeft, isAbort, debounce } from '../util.js';
import { icon } from '../icons.js';
import { conn } from '../conn.js';
import { getSettings, saveSettings, addHistory } from '../state.js';
import * as api from '../api.js';
import { progressBar, empty, notice, btn, toast, modal, triggerDownload, setTitle } from '../ui.js';
import { createPreview } from '../preview.js';
import { captionDefaults, splitKeywords } from '../components.js';

const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic'], ['tr', 'Turkish'], ['id', 'Indonesian']];
const HOOKS = [['balanced', 'Balanced'], ['strong', 'Prefer strong opening lines'], ['question', 'Prefer questions & answers'], ['off', 'Ignore hooks']];
const INTENSITY_TEXT = { conservative: 'Fewer clips, only clearly strong moments.', balanced: 'A good mix of quality and quantity.', aggressive: 'More clips, including decent moments close together.' };
const REFRAME = [['smart', 'Smart'], ['center', 'Center'], ['blur', 'Blur fill']];
const REFRAME_TEXT = { smart: 'Follows the speaker (face detection when available, otherwise motion) with smooth movement.', center: 'Fixed center crop.', blur: 'Whole picture kept, with a blurred copy filling the frame.' };

export async function mount(root, ctx) {
  const id = ctx.params[0];
  let dead = false;
  const ac = new AbortController();
  let data = null;                           // { project, analysis }
  let cleanupPage = null;

  const refresh = async () => { data = await api.getProject(id); return data; };
  const go = (sub) => { location.hash = '#/project/' + id + '/' + sub; };

  root.replaceChildren(h('div', { class: 'skeleton', style: { height: '120px' } }), h('div', { class: 'skeleton', style: { height: '260px', marginTop: '14px' } }));
  try { await refresh(); } catch (e) {
    if (dead) return () => {};
    root.replaceChildren(e instanceof api.ApiError && e.status === 404
      ? empty({ art: 'film', title: 'This video is no longer on the server', text: 'Videos are deleted automatically after a while to save space (or the server was reset). Add the video again to continue.', actions: [btn('Add a video', { cls: 'primary', href: '#/', ic: 'plus' })] })
      : notice('bad', e.message, h('div', { class: 'row' }, btn('Try again', { cls: 'sm', onclick: () => location.reload() }))));
    return () => {};
  }
  if (dead) return () => {};

  function pickSub() {
    const sub = ctx.params[1];
    const p = data.project;
    if (p.activeJob) return 'analysis';
    if (sub === 'clips' && !data.analysis) return 'generate';
    if (sub === 'analysis' && !p.activeJob) return data.analysis ? 'clips' : 'generate';
    if (sub) return sub;
    return data.analysis ? 'clips' : 'generate';
  }

  function header(sub) {
    const p = data.project;
    const steps = h('div', { class: 'steps' },
      h('a', { href: '#/project/' + id + '/generate', class: sub === 'generate' ? 'on' : '' }, '1 · Settings'),
      h('a', { href: '#/project/' + id + '/analysis', class: (sub === 'analysis' ? 'on' : '') + (p.activeJob ? '' : ' off') }, '2 · AI analysis'),
      h('a', { href: '#/project/' + id + '/clips', class: (sub === 'clips' ? 'on' : '') + (data.analysis ? '' : ' off') }, '3 · Clips'));
    return h('div', null,
      h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Dashboard'), '›', h('span', { class: 'ellipsis' }, p.name)),
      h('div', { class: 'page-head' },
        h('div', { class: 'grow' }, h('h1', { style: { fontSize: 'clamp(22px,5vw,32px)' } }, p.name),
          h('div', { class: 'chips', style: { marginTop: '10px' } },
            p.media ? h('span', { class: 'chip' }, fmtLong(p.media.duration)) : null,
            p.media ? h('span', { class: 'chip' }, p.media.width + '×' + p.media.height) : null,
            p.source.bytes ? h('span', { class: 'chip' }, fmtBytes(p.source.bytes)) : null,
            h('span', { class: 'chip' }, p.source.kind === 'url' ? 'From link' : 'Uploaded'),
            p.media && !p.media.hasAudio ? h('span', { class: 'chip bad' }, 'No audio') : null,
            h('span', { class: 'chip' }, timeLeft(p.expiresAt)))),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
          if (!confirm('Delete this video and all its clips from the server?')) return;
          try { await api.deleteProject(id); toast('Deleted.'); location.hash = '#/'; } catch (e) { toast(e.message, { kind: 'bad' }); }
        } }, h('span', { html: icon('trash'), style: { display: 'inline-flex' } }), 'Delete')),
      steps);
  }

  async function show() {
    if (dead) return;
    if (cleanupPage) { cleanupPage(); cleanupPage = null; }
    const sub = pickSub();
    setTitle(data.project.name);
    const body = h('div');
    root.replaceChildren(header(sub), body);
    const fn = { generate: generatePage, analysis: analysisPage, clips: clipsPage }[sub] || generatePage;
    cleanupPage = (await fn(body)) || null;
  }

  /* =================== 1 · settings =================== */
  function generatePage(body) {
    const p = data.project;
    const caps = conn.caps || { platforms: {}, captionStyles: {}, transcription: { available: false } };
    const base = data.analysis ? Object.assign({}, getSettings().gen, data.analysis.settings, { keywords: (data.analysis.settings.keywords || []).join(', ') }) : getSettings().gen;
    const g = Object.assign({}, base);
    const dur = p.media ? p.media.duration : 0;

    if (p.status === 'error') { body.append(notice('bad', p.error ? p.error.message : 'This video could not be prepared.')); return; }
    if (!p.media) { body.append(notice('', 'The video is still being prepared …', h('div', { class: 'row' }, btn('Refresh', { cls: 'sm', onclick: async () => { await refresh(); show(); } })))); return; }

    const player = h('video', { src: api.mediaUrl(p.urls.source), poster: p.urls.poster ? api.mediaUrl(p.urls.poster) : undefined, controls: true, playsinline: '', preload: 'metadata', style: { width: '100%', maxHeight: '300px', borderRadius: '14px', background: '#000' } });
    const set = (k, v) => { g[k] = v; renderControls(); };
    const controls = h('div', { class: 'stack' });

    function seg(items, key, text) {
      return h('div', null, h('div', { class: 'seg' }, items.map(([val, lab]) => h('button', { type: 'button', class: g[key] === val ? 'on' : '', onclick: () => set(key, val) }, lab))), text && text[g[key]] ? h('div', { class: 'hint' }, text[g[key]]) : null);
    }
    function renderControls() {
      const platforms = Object.entries(caps.platforms || {});
      const styles = Object.entries(caps.captionStyles || {});
      controls.replaceChildren(
        field('Target platform', h('div', { class: 'pickgrid' }, platforms.map(([k, v]) => h('button', { type: 'button', class: 'pick' + (g.platform === k ? ' on' : ''), onclick: () => { g.platform = k; if (k !== 'custom') { g.minDuration = v.min; g.maxDuration = Math.min(v.max, dur || v.max); g.aspect = v.aspect; } renderControls(); } }, h('b', null, v.label.replace('YouTube ', 'YT ').replace('Instagram ', 'IG ')), h('small', null, v.aspect))))),
        h('div', { class: 'fields two' },
          field('Number of clips', h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'Fewer clips', onclick: () => set('numClips', Math.max(1, g.numClips - 1)) }, '−'), h('output', null, String(g.numClips)), h('button', { type: 'button', 'aria-label': 'More clips', onclick: () => set('numClips', Math.min(conn.caps ? conn.caps.limits.maxClips : 20, g.numClips + 1)) }, '+'))),
          field('Aspect ratio', seg([['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1']], 'aspect'))),
        h('div', { class: 'fields two' },
          field('Shortest clip (seconds)', numInput('minDuration', 5, 600)),
          field('Longest clip (seconds)', numInput('maxDuration', 5, 900), dur ? 'Video length: ' + fmtLong(dur) : null)),
        field('Framing', seg(REFRAME, 'reframe', REFRAME_TEXT)),
        h('div', null, h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: g.captions, onchange: (e) => set('captions', e.target.checked) }), h('span', { class: 'track' }), 'Burn in captions')),
        g.captions ? field('Caption style', h('div', { class: 'pickgrid' }, styles.map(([k, v]) => h('button', { type: 'button', class: 'pick' + (g.captionStyle === k ? ' on' : ''), onclick: () => set('captionStyle', k) }, h('b', { style: { color: v.color, textShadow: '0 1px 2px #000', textTransform: v.upper ? 'uppercase' : 'none' } }, 'Aa'), h('small', null, v.label))))) : null,
        g.captions ? field('Words to highlight (optional)', h('input', { class: 'input', type: 'text', value: g.keywords || '', placeholder: 'secret, free, never …', autocapitalize: 'off', oninput: (e) => { g.keywords = e.target.value; } }), 'Comma-separated. These words get the highlight colour in captions.') : null,
        h('div', { class: 'fields two' },
          field('Hook preference', select(HOOKS, 'hook')),
          field('Spoken language', select(LANGS, 'language'), caps.transcription && caps.transcription.available && !caps.transcription.multilingual ? 'The installed speech model is English-only.' : null)),
        field('AI selection intensity', seg([['conservative', 'Conservative'], ['balanced', 'Balanced'], ['aggressive', 'Aggressive']], 'intensity', INTENSITY_TEXT)));
    }
    const field = (label, el, hint) => h('div', null, h('label', { class: 'lbl' }, label), el, hint ? h('div', { class: 'hint' }, hint) : null);
    const numInput = (key, a, b) => h('input', { class: 'input num', type: 'number', inputmode: 'numeric', min: a, max: b, value: g[key], onchange: (e) => { g[key] = Math.min(b, Math.max(a, Number(e.target.value) || a)); e.target.value = g[key]; g.platform = g.platform === 'custom' ? 'custom' : g.platform; } });
    const select = (items, key) => h('select', { class: 'input', onchange: (e) => { g[key] = e.target.value; } }, items.map(([v, l]) => h('option', { value: v, selected: g[key] === v }, l)));
    renderControls();

    const tr = caps.transcription;
    const start = btn(data.analysis ? 'Analyse again' : 'Analyse & generate clips', { cls: 'primary lg block', ic: 'sparkle', onclick: async () => {
      start.disabled = true;
      const keywords = splitKeywords(g.keywords);
      const payload = Object.assign({}, g, { keywords });
      saveSettings({ gen: Object.assign({}, g, { keywords: g.keywords || '' }) });
      try { await api.analyze(id, payload); await refresh(); go('analysis'); } catch (e) { start.disabled = false; toast(e.message, { kind: 'bad' }); }
    } });
    body.append(h('div', { class: 'stack' },
      p.notice ? notice('warn', p.notice) : null,
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h3', null, 'Source video')), player),
      tr && !tr.available ? notice('warn', h('b', null, 'Speech recognition is not installed on this server. '), 'Moments will be picked from loudness and scene changes only, and captions will be unavailable. See the backend setup guide to enable transcription.') : null,
      h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'Clip generation'), h('span', { class: 'sub' }, 'saved as your defaults')), controls),
      start));
    return () => { player.pause(); player.removeAttribute('src'); player.load(); };
  }

  /* =================== 2 · analysis progress =================== */
  function analysisPage(body) {
    const j0 = data.project.activeJob;
    if (!j0) { body.append(empty({ art: 'sparkle', title: 'Nothing is running', text: 'Start an analysis from the settings page.', actions: [btn('Go to settings', { cls: 'primary', href: '#/project/' + id + '/generate' })] })); return; }
    const caps = conn.caps || {};
    const isIngest = j0.type === 'ingest';
    const STAGES = isIngest
      ? [['download', 'Downloading the video'], ['probe', 'Reading the video']]
      : [['audio', 'Extracting audio'], ['loudness', 'Measuring loudness'], ['scenes', 'Detecting scene changes'], ['transcribe', 'Transcribing speech'], ['score', 'Scoring candidate moments'], ...(caps.llmReview && caps.llmReview.available ? [['review', 'AI review of the best moments']] : []), ['thumbs', 'Creating thumbnails']];
    const pct = h('div', { class: 'bigpct' }, '0%');
    const msg = h('div', { class: 'muted', style: { marginTop: '4px' } }, j0.message || '');
    const bar = progressBar(0);
    const list = h('div', { class: 'stages' });
    const elapsed = h('span', { class: 'small muted num' });
    const t0 = j0.startedAt || j0.createdAt || Date.now();
    function paint(j) {
      const cur = STAGES.findIndex(([k]) => k === j.stage);
      pct.textContent = Math.round((j.progress || 0) * 100) + '%';
      bar.set(j.state === 'queued' ? null : j.progress);
      msg.textContent = j.message || '';
      list.replaceChildren(...STAGES.map(([k, label], i) => h('div', { class: 'stage ' + (i < cur || j.state === 'done' ? 'done' : i === cur ? 'now' : '') }, h('span', { class: 'mk', html: i < cur ? icon('check').replace('stroke-width="1.9"', 'stroke-width="3"') : '' }, i === cur ? h('span', { class: 'spinner', style: { width: '12px', height: '12px', borderWidth: '2px' } }) : ''), label)));
    }
    paint(j0);
    const tick = setInterval(() => { elapsed.textContent = 'Elapsed ' + fmtLong((Date.now() - t0) / 1000); }, 1000);
    const cancel = btn('Cancel', { cls: 'sm', onclick: async () => { cancel.disabled = true; try { await api.cancelJob(j0.id); } catch (_) { /* polling will show the state */ } } });
    body.append(h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', null, isIngest ? 'Preparing your video' : 'AI analysis'), cancel),
      pct, msg, h('div', { style: { margin: '14px 0 4px' } }, bar), elapsed, list,
      h('p', { class: 'hint', style: { marginTop: '14px' } }, 'You can close this page; the work continues on the server. Open the video again later to see the result.')));
    (async () => {
      const t = Date.now();
      try {
        await api.pollJob(j0.id, paint, { signal: ac.signal });
        if (dead) return;
        await refresh();
        if (!isIngest) addHistory({ kind: 'analyze', ok: true, projectId: id, name: data.project.name, message: (data.analysis ? data.analysis.clips.length : 0) + ' clips found', ms: Date.now() - t0 });
        if (!dead) { if (isIngest) show(); else go('clips'); }
      } catch (e) {
        if (isAbort(e) || dead) return;
        if (!isIngest) addHistory({ kind: 'analyze', ok: false, projectId: id, name: data.project.name, message: e.message, ms: Date.now() - t0 });
        try { await refresh(); } catch (_) { /* may be gone */ }
        if (dead) return;
        body.replaceChildren(notice('bad', h('b', null, e.code === 'cancelled' ? 'Cancelled. ' : 'Analysis did not finish. '), e.code === 'cancelled' ? '' : e.message,
          h('div', { class: 'row' }, btn('Back to settings', { cls: 'sm primary', href: '#/project/' + id + '/generate' }))));
      }
    })();
    return () => clearInterval(tick);
  }

  /* =================== 3 · generated clips =================== */
  function clipsPage(body) {
    const a = data.analysis;
    const p = data.project;
    const caps = conn.caps || {};
    const sel = new Set();
    let sort = 'rank';
    const busy = new Map();                          // clipId -> {bar,msg}
    const grid = h('div', { class: 'clip-grid' });
    const bulk = h('div');
    const selCount = h('span');
    const actions = h('div', { class: 'sticky-actions' });
    const warn = (a.warnings || []).map((w) => notice('warn', w));

    const defaultsFor = (c) => {
      const st = (c.edit && c.edit.caption && c.edit.caption.style) || a.settings.captionStyle;
      return { aspect: (c.edit && c.edit.aspect) || a.settings.aspect, reframe: (c.edit && c.edit.reframe) || a.settings.reframe, captions: c.edit && c.edit.captions !== undefined ? c.edit.captions : a.settings.captions && p.hasTranscript, caption: Object.assign(captionDefaults(st, caps, a.settings.keywords || []), (c.edit && c.edit.caption) || {}) };
    };

    async function waitRender(c, jobId) {
      const ui = busy.get(c.id);
      await api.pollJob(jobId, (j) => { if (ui) { ui.bar.set(j.state === 'queued' ? null : j.progress); ui.msg.textContent = j.state === 'queued' ? 'Waiting for a free worker …' : (j.message || 'Rendering …'); } }, { signal: ac.signal });
    }
    async function ensureRendered(c) {
      if (c.renderUrl && c.renderCurrent) return c;
      const ui = { bar: progressBar(null), msg: h('div', { class: 'small muted' }, 'Starting …') };
      busy.set(c.id, ui); paintCards();
      const t0 = Date.now();
      try {
        const { job } = await api.renderClip(id, c.id, {});
        await waitRender(c, job.id);
        await refresh();
        addHistory({ kind: 'render', ok: true, projectId: id, name: p.name + ' · clip ' + c.rank, message: 'Clip rendered', ms: Date.now() - t0 });
      } catch (e) {
        if (!isAbort(e)) addHistory({ kind: 'render', ok: false, projectId: id, name: p.name + ' · clip ' + c.rank, message: e.message, ms: Date.now() - t0 });
        throw e;
      } finally { busy.delete(c.id); }
      return data.analysis.clips.find((x) => x.id === c.id);
    }
    async function download(c) {
      try {
        const done = await ensureRendered(c);
        paintCards();
        triggerDownload(api.mediaUrl(done.downloadUrl));
        toast('Download started for clip ' + done.rank + '.', { kind: 'ok', action: { label: 'Save again', run: () => triggerDownload(api.mediaUrl(done.downloadUrl)) } });
      } catch (e) { if (!isAbort(e)) { toast(e.message, { kind: 'bad' }); paintCards(); } }
    }
    async function regenerate(c) {
      try { const r = await api.regenerateClip(id, c.id); await refresh(); paintCards(); toast('Replaced with the next best distinct moment.', { kind: 'ok' }); return r; }
      catch (e) { toast(e.message, { kind: 'bad' }); }
    }

    async function preview(c) {
      const d = defaultsFor(c);
      let words = (c.edit && c.edit.words) || [];
      if (!words.length && p.hasTranscript) { try { words = (await api.words(id, c.start, c.end)).words; } catch (_) { words = []; } }
      const pv = createPreview({ sourceUrl: api.mediaUrl(p.urls.source), styles: caps.captionStyles || {} });
      const useRendered = !!(c.renderUrl && c.renderCurrent);
      const closeRef = {};
      const sheet = h('div', { class: 'stack' },
        h('div', { class: 'row between nowrap' }, h('h3', { class: 'ellipsis' }, 'Clip ' + c.rank + ' · ' + c.title), btn('', { cls: 'iconbtn ghost', ic: 'x', onclick: () => closeRef.close() })),
        pv.el,
        h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, fmtTime(c.start) + ' – ' + fmtTime(c.end)), h('span', { class: 'chip' }, Math.round(c.duration) + ' s'), h('span', { class: 'chip accent' }, 'Score ' + Math.round(c.score)), useRendered ? h('span', { class: 'chip ok' }, 'Rendered file') : h('span', { class: 'chip' }, 'Live preview')),
        h('div', { class: 'row' }, btn('Edit', { cls: 'grow', ic: 'edit', href: '#/project/' + id + '/edit/' + c.id, onclick: () => closeRef.close() }), btn('Download', { cls: 'primary grow', ic: 'download', onclick: () => { closeRef.close(); download(c); } })));
      closeRef.close = modal(sheet, { onClose: () => pv.destroy() });
      pv.update({ start: c.start, end: c.end, aspect: d.aspect, reframe: d.reframe, captions: d.captions, caption: d.caption, words, renderedUrl: useRendered ? api.mediaUrl(c.renderUrl) : '', useRendered });
      pv.toggle();
    }

    function card(c) {
      const ui = busy.get(c.id);
      const d = defaultsFor(c);
      const selected = sel.has(c.id);
      const ring = h('div', { class: 'ring', style: { '--p': Math.round(c.score) } }, h('span', null, String(Math.round(c.score))));
      return h('article', { class: 'clip' + (selected ? ' sel' : ''), 'data-id': c.id },
        h('div', { style: { position: 'relative' } },
          h('button', { class: 'pic', type: 'button', 'aria-label': 'Preview clip ' + c.rank, onclick: () => preview(c) },
            c.thumbUrl ? h('img', { src: api.mediaUrl(c.thumbUrl), alt: '', loading: 'lazy' }) : null,
            h('div', { class: 'play' }, h('span', { html: icon('play') })), h('span', { class: 'badge-n' }, 'Clip ' + c.rank), h('span', { class: 'badge-d num' }, fmtTime(c.duration))),
          h('button', { class: 'selbox' + (selected ? ' on' : ''), type: 'button', 'aria-label': (selected ? 'Deselect' : 'Select') + ' clip ' + c.rank, 'aria-pressed': String(selected), onclick: () => { selected ? sel.delete(c.id) : sel.add(c.id); paintCards(); }, html: icon('check') })),
        h('div', { class: 'body' },
          h('div', { class: 'score' }, ring, h('div', { class: 'why' }, h('b', { style: { color: 'var(--text)' } }, 'Engagement score'), h('div', null, c.reasons && c.reasons[0] ? c.reasons[0] : ''))),
          h('div', { class: 'chips' }, (c.categories || []).map((k) => h('span', { class: 'chip accent' }, k)), h('span', { class: 'chip num' }, fmtTime(c.start) + ' → ' + fmtTime(c.end)), c.renderUrl && c.renderCurrent ? h('span', { class: 'chip ok' }, 'Rendered') : null),
          h('div', { class: 'ttl' }, c.title),
          c.transcript ? h('div', { class: 'tx' }, '“' + c.transcript + '”') : h('div', { class: 'tx faint' }, 'No transcript for this moment.'),
          h('div', { class: 'actions' },
            btn('Preview', { cls: 'sm', ic: 'play', onclick: () => preview(c) }),
            btn('Edit', { cls: 'sm', ic: 'edit', href: '#/project/' + id + '/edit/' + c.id }),
            ui ? h('div', { class: 'wide' }, ui.bar, ui.msg) : btn(c.renderUrl && c.renderCurrent ? 'Download MP4' : 'Render & download', { cls: 'sm primary wide', ic: 'download', onclick: () => download(c) }),
            btn('Regenerate this clip', { cls: 'sm ghost wide', ic: 'refresh', disabled: !!ui, onclick: () => regenerate(c) }))));
    }

    function paintCards() {
      if (dead) return;
      const clips = (data.analysis ? data.analysis.clips : []).slice();
      if (sort === 'time') clips.sort((x, y) => x.start - y.start); else clips.sort((x, y) => x.rank - y.rank);
      grid.replaceChildren(...clips.map(card));
      selCount.textContent = sel.size ? sel.size + ' selected' : 'None selected';
      actions.replaceChildren(h('div', { class: 'inner' },
        btn(sel.size ? 'Download selected (ZIP)' : 'Download all (ZIP)', { cls: 'primary', ic: 'zip', onclick: () => downloadZip() }),
        sel.size ? btn('Clear', { cls: 'ghost', onclick: () => { sel.clear(); paintCards(); } }) : null));
    }

    async function downloadZip() {
      const clips = data.analysis.clips;
      const ids = sel.size ? clips.filter((c) => sel.has(c.id)).map((c) => c.id) : clips.map((c) => c.id);
      if (!ids.length) return;
      const bar = progressBar(null), msg = h('div', { class: 'small muted' }, 'Rendering clips …'), cancel = btn('Cancel', { cls: 'sm' });
      bulk.replaceChildren(h('div', { class: 'card', style: { marginBottom: '14px' } }, h('div', { class: 'row between' }, h('b', null, 'Preparing ' + ids.length + ' clip' + (ids.length > 1 ? 's' : '')), cancel), h('div', { style: { margin: '10px 0 6px' } }, bar), msg));
      const t0 = Date.now();
      let jobId = null;
      cancel.onclick = async () => { if (jobId) try { await api.cancelJob(jobId); } catch (_) { /* ignore */ } };
      try {
        const { job } = await api.renderAll(id, ids, {});
        jobId = job.id;
        const res = await api.pollJob(job.id, (j) => { bar.set(j.state === 'queued' ? null : j.progress); msg.textContent = j.message || ''; }, { signal: ac.signal });
        await refresh();
        const failed = (res.result && res.result.failed) || [];
        const z = await api.zipLink(id, ids);
        triggerDownload(api.mediaUrl(z.url));
        addHistory({ kind: 'zip', ok: true, projectId: id, name: p.name, message: z.clips + ' clips zipped' + (failed.length ? ' (' + failed.length + ' failed)' : ''), ms: Date.now() - t0 });
        toast(z.clips + ' clips ready.' + (failed.length ? ' ' + failed.length + ' could not be rendered.' : ''), { kind: failed.length ? '' : 'ok', action: { label: 'Save again', run: () => triggerDownload(api.mediaUrl(z.url)) } });
      } catch (e) {
        if (!isAbort(e)) { addHistory({ kind: 'zip', ok: false, projectId: id, name: p.name, message: e.message, ms: Date.now() - t0 }); toast(e.code === 'cancelled' ? 'Cancelled.' : e.message, { kind: e.code === 'cancelled' ? '' : 'bad' }); }
      } finally { bulk.replaceChildren(); if (!dead) paintCards(); }
    }

    if (!a.clips.length) {
      body.append(...warn, empty({ art: 'clips', title: 'No clips were found', text: (a.stats && a.stats.note) || 'Nothing in this video scored high enough. Try “Aggressive” intensity, a shorter minimum length, or check that the video has clear speech.', actions: [btn('Change settings', { cls: 'primary', href: '#/project/' + id + '/generate' })] }));
      return;
    }
    const eng = a.engine || {};
    body.append(h('div', { class: 'stack' },
      ...warn,
      h('div', { class: 'card flat' },
        h('div', { class: 'row between' },
          h('div', null, h('h2', null, a.clips.length + ' clip' + (a.clips.length > 1 ? 's' : '') + ' generated'), h('div', { class: 'chips', style: { marginTop: '8px' } },
            h('span', { class: 'chip' }, a.mode === 'transcript' ? 'Speech + audio + scenes' : 'Audio + scenes only'),
            eng.transcription ? h('span', { class: 'chip ok' }, 'Transcript: ' + eng.transcription.name + ' ' + (eng.transcription.model || '').replace(/^ggml-|\.bin$/g, '')) : h('span', { class: 'chip warn' }, 'No transcript'),
            eng.llm ? h('span', { class: 'chip ok' }, 'AI review: ' + eng.llm.model) : null)),
          btn('Analyse again', { cls: 'sm', ic: 'refresh', href: '#/project/' + id + '/generate' }))),
      bulk,
      h('div', { class: 'toolbar' },
        h('div', { class: 'seg', style: { minWidth: '220px' } }, [['rank', 'Best first'], ['time', 'Timeline']].map(([k, l]) => h('button', { type: 'button', class: sort === k ? 'on' : '', onclick: (e) => { sort = k; [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); paintCards(); } }, l))),
        btn('Select all', { cls: 'sm', onclick: () => { data.analysis.clips.forEach((c) => sel.add(c.id)); paintCards(); } }), selCount),
      grid, actions));
    paintCards();
  }

  show();
  window.addEventListener('hashchange', onHash);
  function onHash() { /* the router re-mounts this view when the hash changes */ }
  return () => { dead = true; ac.abort(); window.removeEventListener('hashchange', onHash); if (cleanupPage) cleanupPage(); };
}
