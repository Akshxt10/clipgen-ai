/*
  ClipGen AI · Phase 1 · app (router, views, import, clips, audio analysis UI).
  Hash routes:  #/  (projects)   #/p/<id>  (one project).  The iPhone swipe-back gesture works.

  Honest status of this phase:
    BUILT      import (MP4/MOV), preview, file info, local projects (IndexedDB), manual clip list, loudness map
    NOT BUILT  automatic highlight detection, captions, studio editing, export  (the UI says so)
*/

import { db } from './db.js';
import { Timeline } from './timeline.js';
import { startAnalysis } from './audio.js';

const APP_VERSION = 'phase1-v1';
const VIDEO_EXTS = ['mp4', 'mov', 'm4v'];
const VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v'];
const MIN_CLIP_SEC = 0.5;

/* ======================= helpers ======================= */
const $ = (s, r) => (r || document).querySelector(s);
const view = $('#view');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad2 = (n) => (n < 10 ? '0' : '') + n;
function fmtClock(sec, dec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const total = dec ? Math.round(sec * 10) / 10 : Math.round(sec);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const sStr = dec ? (s < 10 ? '0' : '') + s.toFixed(1) : pad2(Math.floor(s));
  return h ? h + ':' + pad2(m) + ':' + sStr : m + ':' + sStr;
}
function fmtSize(b) {
  if (b == null || !isFinite(b)) return '—';
  if (b < 1e3) return b + ' B';
  if (b < 1e6) return Math.round(b / 1e3) + ' KB';
  if (b < 1e9) return (b / 1e6).toFixed(1) + ' MB';
  return (b / 1e9).toFixed(2) + ' GB';
}
function fmtDate(ts) {
  try { return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ts)); }
  catch (_) { return new Date(ts).toLocaleString(); }
}
const fmtDb = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toFixed(1) + ' dB');
const roundT = (t) => Math.round(t * 10) / 10;
const uid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
const extOf = (name) => { const m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; };
const stripExt = (name) => (name || 'Untitled').replace(/\.[A-Za-z0-9]+$/, '') || 'Untitled';
const typeForExt = (e) => (e === 'mov' ? 'video/quicktime' : 'video/mp4');
const errText = (e) => { try { return (e && e.message) ? e.message : String(e); } catch (_) { return 'unknown error'; } };
function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } }

function toast(text, kind) {
  const d = document.createElement('div');
  d.className = 'toast ' + (kind || '');
  d.textContent = text;
  $('#toasts').appendChild(d);
  setTimeout(() => d.remove(), kind === 'bad' ? 6500 : 3200);
}
function busy(text) {
  const b = $('#busy');
  if (text) { $('#busyText').textContent = text; b.classList.remove('hidden'); } else b.classList.add('hidden');
}
async function keepAwake() {
  try { if ('wakeLock' in navigator) return await navigator.wakeLock.request('screen'); } catch (_) { /* ignore */ }
  return null;
}
function validateVideoFile(file) {
  if (!file) return 'No file was chosen.';
  const okExt = VIDEO_EXTS.indexOf(extOf(file.name)) >= 0;
  const okType = VIDEO_TYPES.indexOf(file.type) >= 0;
  if (!okExt && !okType) return '“' + (file.name || 'This file') + '” is not an MP4 or MOV video. Please choose a .mp4 or .mov file.';
  if (!file.size) return 'That file is empty (0 bytes). If it is in iCloud, wait for it to finish downloading, then try again.';
  return null;
}
const ensureType = (blob, name, wantedType) => {
  if (blob && blob.type) return blob;
  return new Blob([blob], { type: wantedType || typeForExt(extOf(name)) });
};

/* ======================= state ======================= */
const state = {
  token: 0,                 // increments on every route change; stale async work checks it
  files: new Map(),         // projectId -> File/Blob kept in memory for this tab
  jobs: new Map(),          // projectId -> running analysis { progress, startedAt, logs, cancel }
  ctx: null,                // current project-view context
  thumbUrls: [],
  keepCopy: lsGet('clipgen.p1.keepCopy') !== '0'
};

/* ======================= storage chip ======================= */
async function updateStorageChip() {
  const chip = $('#storageChip');
  const info = db.info();
  if (!info.persistent) { chip.className = 'chip warn'; chip.textContent = 'Not saving'; return; }
  const est = await db.storageEstimate();
  chip.className = 'chip ok';
  chip.textContent = 'Saved on device' + (est.usage != null ? ' · ' + fmtSize(est.usage) : '');
}
$('#storageChip').addEventListener('click', () => {
  const info = db.info();
  toast(info.persistent
    ? 'Projects are stored in this browser (IndexedDB) — nothing is uploaded anywhere.'
    : 'Not saving: ' + (info.reason || 'storage is unavailable') + '. Everything is lost when this tab closes.', info.persistent ? 'ok' : 'bad');
});

/* ======================= router ======================= */
function parseHash() {
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  return m ? { name: 'project', id: m[1] } : { name: 'home' };
}
function teardown() {
  const c = state.ctx;
  if (c) {
    c.alive = false;
    if (c.raf) cancelAnimationFrame(c.raf);
    if (c.timer) clearInterval(c.timer);
    if (c.timeline) c.timeline.destroy();
    if (c.url) URL.revokeObjectURL(c.url);
    const v = $('#video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ } }
    state.ctx = null;
  }
  state.thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  state.thumbUrls = [];
}
async function route() {
  const token = ++state.token;
  teardown();
  const r = parseHash();
  try {
    if (r.name === 'project') await showProject(r.id, token); else await showHome(token);
  } catch (e) {
    view.innerHTML = '<div class="banner banner-bad"><b>Something went wrong</b>' + esc(errText(e)) + '</div>';
  }
  if (token === state.token) window.scrollTo(0, 0);
}

/* ======================= HOME ======================= */
const ICON_UPLOAD = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#05070d" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/></svg>';

function analysisBadge(p) {
  switch (p.analysisStatus) {
    case 'ready': return '<span class="pill pill-ok">Loudness map ready</span>';
    case 'no-audio': return '<span class="pill pill-warn">No audio track</span>';
    case 'failed': return '<span class="pill pill-bad">Analysis failed</span>';
    default: return '<span class="pill">Not analyzed</span>';
  }
}
function projectCard(p) {
  let thumb = '';
  if (p.thumb) { const u = URL.createObjectURL(p.thumb); state.thumbUrls.push(u); thumb = '<img src="' + u + '" alt="" loading="lazy">'; }
  const v = p.video || {};
  const meta = [v.duration ? fmtClock(v.duration, 0) : null, fmtSize(v.size), fmtDate(p.updatedAt)].filter(Boolean).join(' · ');
  const copy = p.hasBlob ? '' : '<span class="pill pill-warn">No saved copy</span>';
  return '<a class="pcard" href="#/p/' + esc(p.id) + '" data-id="' + esc(p.id) + '">' +
    '<div class="pthumb" aria-hidden="true">' + esc((p.name || '?').trim().slice(0, 1).toUpperCase()) + thumb + '</div>' +
    '<div style="min-width:0"><div class="ptitle">' + esc(p.name) + '</div><div class="pmeta num">' + esc(meta) + '</div>' +
    '<div class="badges">' + analysisBadge(p) + '<span class="pill">' + (p.clipCount || 0) + ' clip' + (p.clipCount === 1 ? '' : 's') + '</span>' + copy + '</div></div></a>';
}
function statusRow(title, sub, pillClass, pillText) {
  return '<li><div><div class="s-title">' + title + '</div><div class="s-sub">' + sub + '</div></div><span class="pill ' + pillClass + '">' + pillText + '</span></li>';
}
function homeHtml(projects) {
  const info = db.info();
  const warn = info.persistent ? '' :
    '<div class="banner banner-warn"><b>Projects cannot be saved in this browser</b>' + esc(info.reason || 'IndexedDB is unavailable') +
    '. The app still works, but everything is forgotten when this tab closes. Try a normal (non-private) Safari tab.</div>';
  return '' +
    '<section class="hero"><h1>Turn long streams into <span class="grad">short clips</span></h1>' +
    '<p class="lead">Import a recording, preview it, read its audio and build your clip list. Free, private, right on your iPhone.</p></section>' + warn +
    '<section class="card" style="margin-top:16px" id="uploadCard">' +
      '<label class="dropzone" id="dropzone" for="fileInput"><span class="dz-icon">' + ICON_UPLOAD + '</span>' +
      '<span class="dz-title">Choose a video</span><span class="dz-sub">MP4 or MOV · stays on this device</span></label>' +
      '<input class="sr-only" id="fileInput" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">' +
      '<label class="opt"><input type="checkbox" id="keepCopy"' + (state.keepCopy ? ' checked' : '') + '><span><b>Keep a copy in this browser</b><br>' +
      'Lets the project reopen instantly. Turn off for very large files (over ~1 GB) and re-attach the file when you come back.</span></label>' +
      '<div id="uploadMsg" aria-live="polite"></div>' +
    '</section>' +
    '<div class="section-head"><h2>Your projects</h2><span class="muted small">' + projects.length + '</span></div>' +
    (projects.length ? '<div class="plist">' + projects.map(projectCard).join('') + '</div>'
      : '<div class="empty">No projects yet.<br>Choose a video above to create your first one.</div>') +
    '<div class="section-head"><h2>What is built — and what is not</h2></div>' +
    '<section class="card"><ul class="status-list">' +
      statusRow('Import MP4 / MOV &amp; preview', 'File name, duration, size, resolution', 'pill-ok', 'Built') +
      statusRow('Local projects', 'Saved in this browser (IndexedDB)', 'pill-ok', 'Built') +
      statusRow('Clip list', 'Add clips by hand with IN / OUT', 'pill-ok', 'Built') +
      statusRow('Audio loudness map', 'Measures loudness every 0.5 s. Foundation only.', 'pill-accent', 'Experimental') +
      statusRow('Automatic highlight detection', 'Not implemented. Nothing in the app finds highlights yet.', '', 'Not built yet') +
      statusRow('Animated captions', 'Phase 2+', '', 'Not built yet') +
      statusRow('Studio editing &amp; 9:16 export', 'Phase 2+', '', 'Not built yet') +
    '</ul></section>' +
    '<div class="section-head"><h2>Local storage</h2></div>' +
    '<section class="card" id="storagePanel"><div class="muted small">Checking…</div></section>';
}
async function refreshStoragePanel() {
  const box = $('#storagePanel');
  if (!box) return;
  const est = await db.storageEstimate();
  const info = db.info();
  const pct = est.usage != null && est.quota ? Math.max(1, Math.min(100, (est.usage / est.quota) * 100)) : 0;
  box.innerHTML =
    '<div class="card-head" style="margin-bottom:0"><h2>' + (info.persistent ? 'Saved in this browser' : 'Not saving') + '</h2>' +
    (est.persisted ? '<span class="pill pill-ok">Protected</span>' : '<span class="pill">Not protected</span>') + '</div>' +
    (est.usage != null ? '<div class="meter"><i style="width:' + pct.toFixed(1) + '%"></i></div><div class="muted small num">' + fmtSize(est.usage) + ' used' + (est.quota ? ' of about ' + fmtSize(est.quota) : '') + '</div>' : '') +
    '<p class="card-note">Safari can clear website data for pages you have not opened for a while. “Protect my data” asks Safari to keep it; adding ClipGen AI to your Home Screen helps too.</p>' +
    '<div class="row"><button class="btn btn-sm" id="btnPersist" type="button">Protect my data</button><button class="btn btn-sm btn-danger" id="btnWipe" type="button">Delete all local data</button></div>';
  $('#btnPersist').addEventListener('click', async () => {
    const ok = await db.requestPersist();
    toast(ok ? 'Done — Safari will try to keep your data.' : 'Safari did not grant it. Adding this page to your Home Screen helps.', ok ? 'ok' : '');
    refreshStoragePanel();
  });
  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL projects, clips and saved videos from this browser? This cannot be undone.')) return;
    state.jobs.forEach((j) => { try { j.cancel(); } catch (_) { /* ignore */ } });
    await db.clearAll();
    state.files.clear();
    toast('All local data deleted.');
    updateStorageChip();
    route();
  });
}
async function showHome(token) {
  const projects = await db.listProjects();
  if (token !== state.token) return;
  view.innerHTML = homeHtml(projects);
  wireHome();
  refreshStoragePanel();
  updateStorageChip();
}
function showUploadMsg(text, kind) {
  const box = $('#uploadMsg');
  if (box) box.innerHTML = text ? '<div class="msg ' + (kind === 'bad' ? 'msg-bad' : 'msg-info') + '">' + esc(text) + '</div>' : '';
}
function wireHome() {
  const input = $('#fileInput'), dz = $('#dropzone');
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) importFile(f);
  });
  $('#keepCopy').addEventListener('change', (e) => { state.keepCopy = e.target.checked; lsSet('clipgen.p1.keepCopy', state.keepCopy ? '1' : '0'); });
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) importFile(f); });
}

/* ======================= IMPORT ======================= */
async function importFile(file) {
  const problem = validateVideoFile(file);
  if (problem) { showUploadMsg(problem, 'bad'); return; }
  showUploadMsg('');
  const id = uid();
  const now = Date.now();
  const e = extOf(file.name);
  const project = {
    id, name: stripExt(file.name), createdAt: now, updatedAt: now,
    video: { name: file.name, size: file.size, type: file.type || typeForExt(e), lastModified: file.lastModified || null, duration: null, width: null, height: null },
    hasBlob: false, thumb: null, clipCount: 0, analysisStatus: 'none', analysisSummary: null, analysisError: null, schema: 1
  };
  try {
    busy('Creating project …');
    await db.saveProject(project);
    state.files.set(id, file);
    if (state.keepCopy) {
      busy('Saving a copy in this browser (' + fmtSize(file.size) + ') …');
      try {
        await db.saveBlob(id, file);
        project.hasBlob = true;
        await db.saveProject(project);
      } catch (err) {
        toast('Could not keep a copy (' + errText(err) + '). The project is saved; re-attach the file next time.', 'bad');
      }
    }
  } catch (err) {
    busy(null);
    showUploadMsg('Could not create the project: ' + errText(err), 'bad');
    return;
  }
  busy(null);
  location.hash = '#/p/' + id;
}

/* ======================= PROJECT VIEW ======================= */
const fmtFormat = (v) => (extOf(v.name) ? extOf(v.name).toUpperCase() : (v.type || '').replace('video/', '').toUpperCase() || '—');

function projectHtml(ctx) {
  const p = ctx.project;
  const warn = db.info().persistent ? '' :
    '<div class="banner banner-warn"><b>Not saving</b>This browser session cannot store projects. Changes are lost when you close the tab.</div>';
  return '' +
    '<div class="pv-head"><a class="iconbtn back" href="#/" aria-label="Back to projects">‹</a>' +
    '<input class="title-input" id="titleInput" value="' + esc(p.name) + '" maxlength="120" aria-label="Project name" enterkeyhint="done">' +
    '<button class="iconbtn danger" id="btnDelete" type="button" aria-label="Delete project">🗑</button></div>' + warn +
    '<div class="pv-grid">' +
      '<div class="col-main">' +
        '<section class="card"><div class="video-wrap" id="videoWrap"><video id="video" playsinline controls preload="metadata"></video>' +
        '<div class="video-msg soft" id="videoMsg">Loading preview …</div></div><div class="meta-chips" id="metaChips"></div></section>' +
        '<section class="card"><div class="card-head"><h2>Timeline</h2><span class="muted small num" id="tlPos">0:00 / 0:00</span></div>' +
          '<canvas class="timeline" id="timeline"></canvas>' +
          '<div class="legend"><span><i style="background:#8b7bff"></i>Loudness</span><span><i style="background:rgba(139,123,255,.6)"></i>Clip</span>' +
          '<span><i style="background:#3ddc97"></i>IN / OUT</span><span><i style="background:#ffc857"></i>Loudest moment</span></div>' +
          '<div class="markbar"><button class="btn btn-sm" id="btnIn" type="button">⇥ Set IN</button><button class="btn btn-sm" id="btnOut" type="button">Set OUT ⇤</button>' +
          '<button class="btn btn-primary add" id="btnAddClip" type="button" disabled>＋ Add clip</button></div>' +
          '<div class="readout"><span>Playhead <b id="phNow">0:00.0</b></span><span id="markInfo">Pick IN and OUT on the video, then add the clip.</span></div>' +
        '</section>' +
      '</div>' +
      '<div class="col-side">' +
        '<section class="card" id="clipsCard"></section>' +
        '<section class="card" id="analysisCard"></section>' +
        '<section class="card card-disabled" id="autoCard"><div class="card-head" style="margin-bottom:6px"><h2>Automatic highlights</h2><span class="pill">Not built yet</span></div>' +
          '<p class="card-note" style="margin-top:0">Highlight detection is not implemented, so nothing here finds highlights. It will be built on top of the audio data and, later, transcription — and only switched on once it is tested.</p>' +
          '<button class="btn btn-block" type="button" disabled aria-disabled="true">Find highlights (not available)</button></section>' +
        '<details class="card diag" id="diagCard"><summary>Diagnostics</summary><pre id="diagText"></pre>' +
          '<div class="row"><button class="btn btn-sm" id="btnCopyDiag" type="button">Copy diagnostics</button></div></details>' +
      '</div>' +
    '</div>';
}

async function showProject(id, token) {
  const project = await db.getProject(id);
  if (token !== state.token) return;
  if (!project) {
    view.innerHTML = '<div class="pv-head"><a class="iconbtn back" href="#/" aria-label="Back">‹</a><h2>Project not found</h2></div><div class="empty">This project does not exist (it may have been deleted).<br><a href="#/" style="color:var(--accent-2)">Back to projects</a></div>';
    return;
  }
  const [clips, analysis] = await Promise.all([db.listClips(id), db.getAnalysis(id)]);
  if (token !== state.token) return;
  const ctx = state.ctx = {
    id, project, clips, analysis: analysis || null, selClip: null, markIn: null, markOut: null,
    source: null, url: null, timeline: null, playClip: null, raf: 0, timer: 0, alive: true, diag: [], thumbBusy: false
  };
  view.innerHTML = projectHtml(ctx);
  ctx.timeline = new Timeline($('#timeline'), { onSeek: (t) => seekVideo(ctx, t) });
  wireProject(ctx);
  renderMeta(ctx);
  renderClips(ctx);
  renderAnalysis(ctx);
  refreshTimeline(ctx);
  updateMarkUi(ctx);
  updateDiag(ctx);
  ctx.timer = setInterval(() => { if (state.jobs.has(ctx.id)) updateJobUi(ctx); }, 500);
  await attachVideo(ctx);
}

/* ---- meta chips ---- */
function renderMeta(ctx) {
  const v = ctx.project.video;
  const chip = (k, val, wide) => '<div class="mchip' + (wide ? ' wide' : '') + '"><div class="k">' + k + '</div><div class="v" title="' + esc(val) + '">' + esc(val) + '</div></div>';
  $('#metaChips').innerHTML =
    chip('File', v.name, true) + chip('Duration', v.duration ? fmtClock(v.duration, 0) : '…') + chip('Size', fmtSize(v.size)) +
    chip('Resolution', v.width ? v.width + '×' + v.height : '…') + chip('Format', fmtFormat(v));
}

/* ---- video ---- */
const durationOf = (ctx) => {
  const v = $('#video');
  return (v && isFinite(v.duration) && v.duration > 0 ? v.duration : 0) || ctx.project.video.duration || (ctx.analysis && ctx.analysis.durationSec) || 0;
};
function seekVideo(ctx, t) {
  const v = $('#video');
  if (!v || v.readyState < 1) { ctx.timeline.setPlayhead(t); return; }
  ctx.playClip = null;
  v.currentTime = Math.max(0, Math.min(durationOf(ctx) || t, t));
  syncPlayhead(ctx);
}
function syncPlayhead(ctx) {
  if (!ctx.alive) return;
  const v = $('#video');
  if (!v) return;
  const t = v.currentTime || 0;
  ctx.timeline.setPlayhead(t);
  const d = durationOf(ctx);
  $('#tlPos').textContent = fmtClock(t, 0) + ' / ' + fmtClock(d, 0);
  $('#phNow').textContent = fmtClock(t, 1);
  if (ctx.playClip && t >= ctx.playClip.end - 0.04) { v.pause(); ctx.playClip = null; }
}
function rafLoop(ctx) {
  if (!ctx.alive) return;
  syncPlayhead(ctx);
  const v = $('#video');
  if (v && !v.paused && !v.ended) ctx.raf = requestAnimationFrame(() => rafLoop(ctx)); else ctx.raf = 0;
}
function refreshTimeline(ctx) {
  const tl = ctx.timeline;
  tl.setDuration(durationOf(ctx));
  tl.setEnvelope(ctx.analysis ? { rmsDb: ctx.analysis.rmsDb, windowSec: ctx.analysis.windowSec } : null);
  tl.setMoments(ctx.analysis ? ctx.analysis.moments : []);
  tl.setClips(ctx.clips, ctx.selClip);
  tl.setMarks(ctx.markIn, ctx.markOut);
}
async function attachVideo(ctx) {
  const video = $('#video');
  let src = state.files.get(ctx.id) || null;
  if (!src && ctx.project.hasBlob) {
    try { src = await db.getBlob(ctx.id); } catch (e) { ctx.diag.push('Reading the saved video failed: ' + errText(e)); }
  }
  if (!ctx.alive) return;
  if (!src) { showNeedFile(ctx); return; }
  src = ensureType(src, ctx.project.video.name, ctx.project.video.type);
  ctx.source = src;
  ctx.url = URL.createObjectURL(src);
  video.addEventListener('loadedmetadata', () => onMeta(ctx));
  video.addEventListener('error', () => onVideoError(ctx));
  video.addEventListener('play', () => { if (!ctx.raf) rafLoop(ctx); });
  ['pause', 'ended', 'seeked', 'timeupdate'].forEach((ev) => video.addEventListener(ev, () => { if (ctx.alive && !ctx.raf) syncPlayhead(ctx); }));
  video.src = ctx.url;
  renderAnalysis(ctx);
  updateDiag(ctx);
}
function showNeedFile(ctx) {
  const wrap = $('#videoWrap');
  const old = $('#videoMsg');
  if (old) old.remove();
  const box = document.createElement('div');
  box.className = 'video-msg';
  box.id = 'videoMsg';
  box.innerHTML = '<div><b>The video file is not stored in this browser.</b><br><span class="muted">Choose the same file to preview and analyze it. Your clips are safe.</span></div>' +
    '<label class="btn btn-primary" for="reattach">Choose video file</label>' +
    '<input class="sr-only" id="reattach" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">';
  wrap.appendChild(box);
  $('#reattach').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const problem = validateVideoFile(f);
    if (problem) { toast(problem, 'bad'); return; }
    const v = ctx.project.video;
    if ((f.size !== v.size || f.name !== v.name) && !confirm('This file (' + f.name + ', ' + fmtSize(f.size) + ') differs from the original (' + v.name + ', ' + fmtSize(v.size) + '). Use it anyway?')) return;
    state.files.set(ctx.id, f);
    if (state.keepCopy && db.info().persistent) {
      busy('Saving a copy in this browser …');
      try { await db.saveBlob(ctx.id, f); ctx.project.hasBlob = true; await db.saveProject(ctx.project); }
      catch (err) { toast('Could not keep a copy: ' + errText(err), 'bad'); }
      busy(null);
    }
    const m = $('#videoMsg'); if (m) m.remove();
    const msg = document.createElement('div'); msg.className = 'video-msg soft'; msg.id = 'videoMsg'; msg.textContent = 'Loading preview …'; wrap.appendChild(msg);
    await attachVideo(ctx);
  });
  renderAnalysis(ctx);
}
async function onMeta(ctx) {
  if (!ctx.alive) return;
  const v = $('#video');
  const m = $('#videoMsg'); if (m) m.remove();
  const p = ctx.project;
  const dur = isFinite(v.duration) ? roundT(v.duration * 10) / 10 : null;
  let changed = false;
  if (dur && p.video.duration !== dur) { p.video.duration = dur; changed = true; }
  if (v.videoWidth && (p.video.width !== v.videoWidth || p.video.height !== v.videoHeight)) { p.video.width = v.videoWidth; p.video.height = v.videoHeight; changed = true; }
  renderMeta(ctx);
  refreshTimeline(ctx);
  syncPlayhead(ctx);
  if (changed) { try { await db.saveProject(p); } catch (_) { /* ignore */ } }
  maybeThumb(ctx);
}
const MEDIA_ERR = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'format or codec not supported' };
function onVideoError(ctx) {
  if (!ctx.alive) return;
  const v = $('#video');
  const e = v && v.error;
  ctx.diag.push('Video element error: ' + (e ? (MEDIA_ERR[e.code] || 'code ' + e.code) + (e.message ? ' — ' + e.message : '') : 'unknown'));
  const m = $('#videoMsg');
  if (m) {
    m.className = 'video-msg';
    m.innerHTML = '<div><b>This browser cannot play this video.</b><br><span class="muted">The format or codec is not supported for preview. You can still analyze the audio.</span></div>';
  }
  updateDiag(ctx);
}
function seekTo(v, t, timeout) {
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(to); v.removeEventListener('seeked', done); resolve(); };
    const to = setTimeout(() => { v.removeEventListener('seeked', done); reject(new Error('seek timed out')); }, timeout);
    v.addEventListener('seeked', done);
    v.currentTime = t;
  });
}
async function maybeThumb(ctx) {
  const p = ctx.project;
  if (p.thumb || ctx.thumbBusy) return;
  const v = $('#video');
  if (!v || !v.videoWidth || !isFinite(v.duration) || !v.paused) return;
  ctx.thumbBusy = true;
  try {
    const keep = v.currentTime || 0;
    await seekTo(v, Math.min(Math.max(1, v.duration * 0.05), Math.max(0, v.duration - 0.2)), 5000);
    const w = 320, h = Math.max(1, Math.round(w * v.videoHeight / v.videoWidth));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
    if (blob && ctx.alive) { p.thumb = blob; await db.saveProject(p); }
    await seekTo(v, keep, 3000).catch(() => {});
  } catch (e) { ctx.diag.push('Thumbnail skipped: ' + errText(e)); }
  ctx.thumbBusy = false;
}

/* ---- wiring ---- */
function wireProject(ctx) {
  const title = $('#titleInput');
  title.addEventListener('change', async () => {
    const name = title.value.trim();
    if (!name) { title.value = ctx.project.name; return; }
    ctx.project.name = name;
    await db.saveProject(ctx.project);
    toast('Renamed.');
  });
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') title.blur(); });
  $('#btnDelete').addEventListener('click', async () => {
    if (!confirm('Delete “' + ctx.project.name + '” with its clips, analysis and saved video?')) return;
    const j = state.jobs.get(ctx.id);
    if (j) { try { j.cancel(); } catch (_) { /* ignore */ } }
    await db.deleteProject(ctx.id);
    state.files.delete(ctx.id);
    toast('Project deleted.');
    location.hash = '#/';
  });
  $('#btnIn').addEventListener('click', () => setMark(ctx, 'in'));
  $('#btnOut').addEventListener('click', () => setMark(ctx, 'out'));
  $('#btnAddClip').addEventListener('click', () => {
    if (ctx.markIn == null || ctx.markOut == null) return;
    addClip(ctx, { start: ctx.markIn, end: ctx.markOut, source: 'manual' }).then((ok) => { if (ok) { ctx.markIn = null; ctx.markOut = null; updateMarkUi(ctx); } });
  });
  $('#clipsCard').addEventListener('click', (e) => onClipClick(ctx, e));
  $('#clipsCard').addEventListener('change', (e) => onClipChange(ctx, e));
  $('#analysisCard').addEventListener('click', (e) => onAnalysisClick(ctx, e));
  $('#btnCopyDiag').addEventListener('click', async () => {
    updateDiag(ctx);
    const text = $('#diagText').textContent;
    try { await navigator.clipboard.writeText(text); toast('Diagnostics copied.', 'ok'); }
    catch (_) { const r = document.createRange(); r.selectNodeContents($('#diagText')); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); toast('Selected — press and hold, then Copy.'); }
  });
  $('#diagCard').addEventListener('toggle', () => updateDiag(ctx));
}

/* ---- IN / OUT marks ---- */
function setMark(ctx, which) {
  const v = $('#video');
  if (!v || v.readyState < 1) { toast('The video is still loading.'); return; }
  const t = roundT(v.currentTime || 0);
  if (which === 'in') {
    ctx.markIn = t;
    if (ctx.markOut != null && ctx.markOut <= t + MIN_CLIP_SEC - 0.001) ctx.markOut = null;
  } else {
    if (ctx.markIn == null) { toast('Set IN first, then move to the end and set OUT.'); return; }
    if (t < ctx.markIn + MIN_CLIP_SEC) { toast('OUT must be at least ' + MIN_CLIP_SEC + ' s after IN.'); return; }
    ctx.markOut = t;
  }
  updateMarkUi(ctx);
}
function updateMarkUi(ctx) {
  $('#btnIn').textContent = '⇥ IN ' + (ctx.markIn != null ? fmtClock(ctx.markIn, 1) : '—');
  $('#btnOut').textContent = 'OUT ' + (ctx.markOut != null ? fmtClock(ctx.markOut, 1) : '—') + ' ⇤';
  const ok = ctx.markIn != null && ctx.markOut != null && ctx.markOut - ctx.markIn >= MIN_CLIP_SEC;
  $('#btnAddClip').disabled = !ok;
  $('#markInfo').textContent = ok ? 'Clip length ' + (ctx.markOut - ctx.markIn).toFixed(1) + ' s' : 'Pick IN and OUT on the video, then add the clip.';
  ctx.timeline.setMarks(ctx.markIn, ctx.markOut);
}

/* ---- clips ---- */
async function syncClipCount(ctx) {
  ctx.project.clipCount = ctx.clips.length;
  await db.saveProject(ctx.project);
}
async function addClip(ctx, o) {
  const dur = durationOf(ctx);
  let start = roundT(Math.max(0, o.start)), end = roundT(dur ? Math.min(dur, o.end) : o.end);
  if (end - start < MIN_CLIP_SEC) { toast('A clip must be at least ' + MIN_CLIP_SEC + ' s long.', 'bad'); return false; }
  const clip = {
    id: uid(), projectId: ctx.id, start, end,
    label: o.label || 'Clip ' + (ctx.clips.length + 1), source: o.source || 'manual', createdAt: Date.now()
  };
  try {
    await db.saveClip(clip);
    ctx.clips.push(clip);
    ctx.clips.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    await syncClipCount(ctx);
  } catch (e) { toast('Could not save the clip: ' + errText(e), 'bad'); return false; }
  renderClips(ctx);
  ctx.timeline.setClips(ctx.clips, ctx.selClip);
  toast('Clip added.', 'ok');
  return true;
}
function clipHtml(c, i, sel) {
  const loud = c.source === 'loudness';
  return '<li class="clip' + (sel ? ' sel' : '') + '" data-id="' + esc(c.id) + '">' +
    '<div class="clip-top"><span class="clip-idx">' + (i + 1) + '</span>' +
    '<input class="clip-label" value="' + esc(c.label) + '" maxlength="80" aria-label="Clip name" data-act="label" enterkeyhint="done">' +
    '<span class="pill ' + (loud ? 'pill-warn' : 'pill-accent') + '">' + (loud ? 'Loud moment' : 'Manual') + '</span></div>' +
    '<div class="clip-time"><span>' + fmtClock(c.start, 1) + ' → ' + fmtClock(c.end, 1) + '</span><span>·</span><span>' + (c.end - c.start).toFixed(1) + ' s</span></div>' +
    '<div class="clip-actions"><button class="btn btn-sm btn-primary" type="button" data-act="play">▶ Play</button>' +
    '<button class="btn btn-sm" type="button" data-act="select">' + (sel ? 'Done' : 'Adjust') + '</button>' +
    '<button class="iconbtn danger" type="button" data-act="delete" aria-label="Delete clip">🗑</button></div>' +
    (sel ? '<div class="clip-edit"><button class="btn btn-sm" type="button" data-act="setStart">Start = playhead</button><button class="btn btn-sm" type="button" data-act="setEnd">End = playhead</button></div>' : '') +
    '</li>';
}
function renderClips(ctx) {
  const n = ctx.clips.length;
  $('#clipsCard').innerHTML =
    '<div class="card-head"><h2>Clips <span class="muted">(' + n + ')</span></h2><button class="btn btn-sm btn-ghost" type="button" disabled aria-disabled="true" title="Export arrives in a later phase">Export · later</button></div>' +
    (n ? '<ul class="clip-list">' + ctx.clips.map((c, i) => clipHtml(c, i, c.id === ctx.selClip)).join('') + '</ul>'
       : '<div class="empty">No clips yet.<br>Play the video, tap <b>Set IN</b> and <b>Set OUT</b>, then <b>Add clip</b>.</div>') +
    '<p class="card-note">Clips are saved on this device. Automatic clip suggestions do not exist yet — you choose every clip.</p>';
}
function clipFromEvent(ctx, e) {
  const li = e.target.closest ? e.target.closest('li.clip') : null;
  return li ? ctx.clips.find((c) => c.id === li.getAttribute('data-id')) : null;
}
async function onClipClick(ctx, e) {
  const btn = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const clip = clipFromEvent(ctx, e);
  if (!clip || act === 'label') return;
  const v = $('#video');
  if (act === 'play') {
    if (!v || v.readyState < 1) { toast('The video is not loaded yet.'); return; }
    ctx.playClip = { id: clip.id, end: clip.end };
    v.currentTime = clip.start;
    const pr = v.play();
    if (pr && pr.catch) pr.catch(() => { ctx.playClip = null; toast('Tap the video’s play button once (iOS needs a tap to start playback).'); });
  } else if (act === 'select') {
    ctx.selClip = ctx.selClip === clip.id ? null : clip.id;
    if (ctx.selClip && v && v.readyState >= 1) { ctx.playClip = null; v.currentTime = clip.start; }
    renderClips(ctx);
    ctx.timeline.setClips(ctx.clips, ctx.selClip);
  } else if (act === 'delete') {
    try { await db.deleteClip(clip.id); } catch (err) { toast('Could not delete: ' + errText(err), 'bad'); return; }
    ctx.clips = ctx.clips.filter((c) => c.id !== clip.id);
    if (ctx.selClip === clip.id) ctx.selClip = null;
    await syncClipCount(ctx);
    renderClips(ctx);
    ctx.timeline.setClips(ctx.clips, ctx.selClip);
    toast('Clip deleted.');
  } else if (act === 'setStart' || act === 'setEnd') {
    if (!v || v.readyState < 1) return;
    const t = roundT(v.currentTime || 0);
    const ns = act === 'setStart' ? t : clip.start, ne = act === 'setEnd' ? t : clip.end;
    if (ne - ns < MIN_CLIP_SEC) { toast('A clip must stay at least ' + MIN_CLIP_SEC + ' s long.', 'bad'); return; }
    clip.start = ns; clip.end = ne;
    try { await db.saveClip(clip); } catch (err) { toast('Could not save: ' + errText(err), 'bad'); return; }
    ctx.clips.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
    renderClips(ctx);
    ctx.timeline.setClips(ctx.clips, ctx.selClip);
  }
}
async function onClipChange(ctx, e) {
  const input = e.target;
  if (!input.classList || !input.classList.contains('clip-label')) return;
  const clip = clipFromEvent(ctx, e);
  if (!clip) return;
  const label = input.value.trim();
  if (!label) { input.value = clip.label; return; }
  clip.label = label;
  try { await db.saveClip(clip); } catch (err) { toast('Could not save the name: ' + errText(err), 'bad'); }
}

/* ======================= AUDIO ANALYSIS UI ======================= */
function statusPill(ctx, job) {
  if (job) return '<span class="pill pill-accent">Analyzing…</span>';
  switch (ctx.project.analysisStatus) {
    case 'ready': return '<span class="pill pill-ok">Ready</span>';
    case 'no-audio': return '<span class="pill pill-warn">No audio track</span>';
    case 'failed': return '<span class="pill pill-bad">Failed</span>';
    default: return '<span class="pill">Not analyzed</span>';
  }
}
function renderAnalysis(ctx) {
  const el = $('#analysisCard');
  if (!el || !ctx.alive) return;
  const job = state.jobs.get(ctx.id);
  const a = ctx.analysis;
  const p = ctx.project;
  let html = '<div class="card-head"><h2>Audio loudness</h2>' + statusPill(ctx, job) + '</div>' +
    '<p class="card-note" style="margin-top:0">Reads the audio track and measures how loud it is every 0.5 s. This is the <b>foundation</b> for highlight detection — it does not find highlights by itself.</p>';

  if (job) {
    html += '<div class="progress' + (job.progress.fraction == null ? ' indeterminate' : '') + '" id="anaBarWrap"><i id="anaBar" style="width:' + Math.round((job.progress.fraction || 0) * 100) + '%"></i></div>' +
      '<div class="readout"><span id="anaText">' + esc(job.progress.text || 'Working…') + '</span><span id="anaElapsed"></span></div>' +
      '<div class="row"><button class="btn btn-sm btn-danger" type="button" data-act="cancelAna">Cancel</button></div>' +
      '<p class="card-note">Keep this page open and the screen on. The first run downloads the ~32 MB video engine once.</p>';
  } else {
    const can = !!ctx.source;
    html += '<div class="row"><button class="btn btn-primary" type="button" data-act="analyze"' + (can ? '' : ' disabled aria-disabled="true"') + '>' + (a ? 'Analyze again' : 'Analyze audio') + '</button></div>';
    if (!can) html += '<p class="card-note">Attach the video file first (see the preview above).</p>';
    else if (!a) html += '<p class="card-note">First run downloads the ~32 MB video engine (kept by your browser afterwards). Long videos take a few minutes.</p>';
    if (p.analysisStatus === 'failed' && p.analysisError) html += '<div class="msg msg-bad">' + esc(p.analysisError) + '</div>';
    if (p.analysisStatus === 'no-audio') html += '<div class="msg msg-info">This video has no audio track, so there is nothing to measure.</div>';
  }

  if (a && a.stats && !job) {
    const s = a.stats;
    html += '<div class="stats">' +
      '<div class="stat"><div class="k">Analyzed</div><div class="v">' + fmtClock(s.durationSec, 0) + '</div></div>' +
      '<div class="stat"><div class="k">Average</div><div class="v">' + fmtDb(s.meanDb) + '</div></div>' +
      '<div class="stat"><div class="k">Background</div><div class="v">' + fmtDb(s.medianDb) + '</div></div>' +
      '<div class="stat"><div class="k">Loudest</div><div class="v">' + fmtDb(s.maxDb) + '</div></div>' +
      '<div class="stat"><div class="k">Quiet share</div><div class="v">' + Math.round(s.quietShare * 100) + '%</div></div>' +
      '<div class="stat"><div class="k">Window</div><div class="v">' + a.windowSec + ' s</div></div></div>' +
      '<h3 class="sub-h">Loudest moments</h3>' +
      '<p class="card-note" style="margin-top:4px">Plain loudness peaks — <b>not</b> highlight detection. A loud moment may be a great play, a jump-scare, or just music. You decide what to keep.</p>';
    if (a.moments && a.moments.length) {
      html += '<ul class="moments">' + a.moments.map((m, i) =>
        '<li class="moment"><span class="rank">' + (i + 1) + '</span><div><div class="t">' + fmtClock(m.timeSec, 1) + '</div><div class="d">+' + m.aboveBackgroundDb.toFixed(1) + ' dB above background</div></div>' +
        '<button class="btn btn-sm" type="button" data-act="goMoment" data-i="' + i + '">Go</button>' +
        '<button class="btn btn-sm" type="button" data-act="clipMoment" data-i="' + i + '">＋ Clip</button></li>').join('') + '</ul>';
    } else {
      html += '<div class="empty" style="margin-top:8px">No moment stands out clearly from the background level.</div>';
    }
  }
  el.innerHTML = html;
}
function updateJobUi(ctx) {
  const job = state.jobs.get(ctx.id);
  const bar = $('#anaBar');
  if (!job || !bar) { renderAnalysis(ctx); return; }
  const wrap = $('#anaBarWrap');
  const frac = job.progress.fraction;
  wrap.classList.toggle('indeterminate', frac == null);
  bar.style.width = Math.round((frac || 0) * 100) + '%';
  $('#anaText').textContent = job.progress.text || 'Working…';
  $('#anaElapsed').textContent = fmtClock((performance.now() - job.startedAt) / 1000, 0) + ' elapsed';
}
function onAnalysisClick(ctx, e) {
  const btn = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'analyze') runAnalysis(ctx);
  else if (act === 'cancelAna') { const j = state.jobs.get(ctx.id); if (j) j.cancel(); }
  else if (act === 'goMoment' || act === 'clipMoment') {
    const m = ctx.analysis && ctx.analysis.moments[Number(btn.getAttribute('data-i'))];
    if (!m) return;
    if (act === 'goMoment') seekVideo(ctx, Math.max(0, m.timeSec - 2));
    else {
      const dur = durationOf(ctx) || m.timeSec + 10;
      addClip(ctx, { start: Math.max(0, m.timeSec - 10), end: Math.min(dur, m.timeSec + 10), source: 'loudness', label: 'Loud moment ' + fmtClock(m.timeSec, 0) });
    }
  }
}
async function runAnalysis(ctx) {
  const id = ctx.id;
  if (state.jobs.has(id)) return;
  if (!ctx.source) { toast('Attach the video file first.', 'bad'); return; }
  const rec = { progress: { phase: 'engine', fraction: null, text: 'Starting …' }, startedAt: performance.now(), logs: [], cancel: () => {} };
  state.jobs.set(id, rec);
  ctx.project.analysisError = null;
  renderAnalysis(ctx);
  const wake = await keepAwake();
  const job = startAnalysis(ctx.source, {
    durationHint: ctx.project.video.duration,
    onProgress: (pr) => { rec.progress = pr; if (state.ctx && state.ctx.id === id) updateJobUi(state.ctx); },
    onLog: (line) => { rec.logs.push(line); if (rec.logs.length > 300) rec.logs.shift(); }
  });
  rec.cancel = job.cancel;
  const project = ctx.project;
  try {
    const res = await job.promise;
    if (res.status === 'no-audio') {
      project.analysisStatus = 'no-audio';
      project.analysisSummary = null;
      await db.deleteAnalysis(id);
      if (ctx.alive) ctx.analysis = null;
    } else {
      const record = {
        version: res.version, windowSec: res.windowSec, sampleRate: res.sampleRate, chunkSec: res.chunkSec, durationSec: res.durationSec,
        windows: res.windows, rmsDb: res.rmsDb, peakDb: res.peakDb, stats: res.stats, moments: res.moments, probe: res.probe,
        engine: res.engine, mode: res.mode, ms: res.ms, analyzedAt: res.analyzedAt
      };
      await db.saveAnalysis(id, record);
      project.analysisStatus = 'ready';
      project.analysisSummary = { medianDb: res.stats.medianDb, maxDb: res.stats.maxDb, moments: res.moments.length };
      if (ctx.alive) ctx.analysis = Object.assign({ projectId: id }, record);
      if (!project.video.duration && res.durationSec) project.video.duration = res.durationSec;
      toast('Audio analysis finished.', 'ok');
    }
    project.analysisError = null;
    await db.saveProject(project);
  } catch (e) {
    if (e && e.cancelled) toast('Analysis cancelled.');
    else {
      project.analysisStatus = 'failed';
      project.analysisError = errText(e);
      try { await db.saveProject(project); } catch (_) { /* ignore */ }
      toast('Analysis failed — see the message in the card.', 'bad');
    }
  } finally {
    state.jobs.delete(id);
    if (wake) { try { await wake.release(); } catch (_) { /* ignore */ } }
  }
  if (state.ctx && state.ctx.id === id && state.ctx.alive) {
    renderAnalysis(state.ctx);
    refreshTimeline(state.ctx);
    renderMeta(state.ctx);
    updateDiag(state.ctx);
  }
}

/* ---- diagnostics ---- */
function updateDiag(ctx) {
  const pre = $('#diagText');
  if (!pre) return;
  const p = ctx.project, a = ctx.analysis, job = state.jobs.get(ctx.id);
  const ua = navigator.userAgent || '';
  const ios = /OS (\d+)[_.](\d+)/.exec(ua);
  const lines = [];
  lines.push('ClipGen AI ' + APP_VERSION + ' · ' + new Date().toISOString());
  lines.push('Device: ' + (ios ? 'iOS ' + ios[1] + '.' + ios[2] : 'non-iOS') + ' · ' + ua);
  lines.push('Storage: ' + (db.info().persistent ? 'IndexedDB OK' : 'MEMORY ONLY (' + db.info().reason + ')'));
  lines.push('Project: ' + JSON.stringify({ id: p.id, video: p.video, hasBlob: p.hasBlob, clips: p.clipCount, analysisStatus: p.analysisStatus, analysisError: p.analysisError }));
  if (a) lines.push('Analysis: ' + JSON.stringify({ engine: a.engine, mode: a.mode, ms: a.ms, windows: a.windows, durationSec: a.durationSec, stats: a.stats, probe: a.probe, moments: a.moments }));
  ctx.diag.forEach((d) => lines.push('Note: ' + d));
  if (job) lines.push('Running: ' + (job.progress.text || '') + ' · ' + fmtClock((performance.now() - job.startedAt) / 1000, 0));
  const logs = (job && job.logs) || [];
  if (logs.length) { lines.push('--- last engine log lines ---'); lines.push(logs.slice(-40).join('\n')); }
  pre.textContent = lines.join('\n');
}

/* ======================= boot ======================= */
async function boot() {
  $('#appVersion').textContent = APP_VERSION;
  view.innerHTML = '<div class="empty" style="margin-top:24px">Loading …</div>';
  await db.init();
  updateStorageChip();
  window.addEventListener('hashchange', route);
  route();
}
boot();
