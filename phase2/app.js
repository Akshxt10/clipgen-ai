/*
  ClipGen AI · Phase 2 · app (router, views, YouTube links, import, clips, audio analysis UI).
  Hash routes:  #/  (projects)   #/p/<id>  (one project).  The iPhone swipe-back gesture works.

  Phase 2 = Phase 1 (unchanged behaviour for uploads) + YouTube links + creator authorization:
    - a pasted YouTube link becomes a project that shows YouTube's OFFICIAL embedded player
    - ClipGen checks whether the video's creator is registered, verified and has approved THIS video (authz.js)
    - if yes, the creator's own original file is fetched from the creator's host and checked against the creator's
      signed SHA-256 (source-fetch.js); if not, the user provides a file and says so themselves ("self-declared",
      shown as NOT verified)
    - that file goes through the same Phase 1 engine (preview, loudness map, manual clips)
    - ClipGen AI never downloads, records or extracts anything from YouTube

  Honest status of this phase (also shown in the UI, driven by pipeline.js):
    BUILT      YouTube link + official player, creator registry + signed manifests, source file, upload, local projects, manual clips
    EXPERIMENTAL  loudness map, YouTube title/channel (best effort, not saved)
    PLANNED    transcription, automatic highlight detection, auto clips, captions, 9:16 export
*/

import { db } from './db.js';
import { Timeline } from './timeline.js';
import { startAnalysis } from './audio.js';
import { parseYouTubeUrl, embedSrc, fetchOEmbed, KIND_LABEL } from './youtube.js';
import { STAGES, STATUS_LABEL, STATUS_PILL } from './pipeline.js';
import { validateRegistry, fetchJsonLimited, evaluateYouTubeSource, fileMatchesGrant, creatorInviteText, REGISTRY_URL, BLOCKING_CODES } from './authz.js';
import { sha256OfBlob } from './crypto-utils.js';
import { fetchSourceFile, MAX_SOURCE_BYTES } from './source-fetch.js';

const APP_VERSION = 'phase2-v2';
const ALLOW_LOCAL_HTTP = ['localhost', '127.0.0.1'].indexOf(location.hostname) >= 0;   // dev/test only; never true on GitHub Pages
const AUTO_FETCH_MAX = 200 * 1024 * 1024;       // a verified file up to this size downloads by itself; bigger ones wait for a tap
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
const isYt = (p) => !!(p && p.source && p.source.kind === 'youtube');
const AUTH_STATEMENT = 'I own this video or have the owner’s permission to process it.';
const blankVideo = () => ({ name: '', size: null, type: '', lastModified: null, duration: null, width: null, height: null });
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

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
  registry: null,           // Promise of validateRegistry() result (loaded once per page, reloadable)
  keepCopy: lsGet('clipgen.p2.keepCopy') !== '0'
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
  const yt = isYt(p);
  let thumb = '';
  if (p.thumb) { const u = URL.createObjectURL(p.thumb); state.thumbUrls.push(u); thumb = '<img src="' + u + '" alt="" loading="lazy">'; }
  const v = p.video || {};
  const meta = yt && !v.name
    ? 'YouTube · ' + p.source.videoId + ' · ' + fmtDate(p.updatedAt)
    : [v.duration ? fmtClock(v.duration, 0) : null, fmtSize(v.size), fmtDate(p.updatedAt)].filter(Boolean).join(' · ');
  const copy = yt ? (v.name ? (p.hasBlob ? '' : '<span class="pill pill-warn">No saved copy</span>') : '<span class="pill pill-warn">Needs source file</span>')
                  : (p.hasBlob ? '' : '<span class="pill pill-warn">No saved copy</span>');
  const tag = yt ? '<span class="pill pill-yt">YouTube</span>' : '';
  return '<a class="pcard" href="#/p/' + esc(p.id) + '" data-id="' + esc(p.id) + '">' +
    '<div class="pthumb" aria-hidden="true">' + (yt ? '▶' : esc((p.name || '?').trim().slice(0, 1).toUpperCase())) + thumb + '</div>' +
    '<div style="min-width:0"><div class="ptitle">' + esc(p.name) + '</div><div class="pmeta num">' + esc(meta) + '</div>' +
    '<div class="badges">' + tag + analysisBadge(p) + '<span class="pill">' + (p.clipCount || 0) + ' clip' + (p.clipCount === 1 ? '' : 's') + '</span>' + copy + '</div></div></a>';
}
function statusRow(title, sub, pillClass, pillText) {
  return '<li><div><div class="s-title">' + title + '</div><div class="s-sub">' + sub + '</div></div><span class="pill ' + pillClass + '">' + pillText + '</span></li>';
}
function roadmapHtml() {
  return '<ul class="status-list">' + STAGES.map((st) =>
    statusRow(esc(st.title), esc(st.detail) + (st.risk ? ' <span class="faint">Risk: ' + esc(st.risk) + '</span>' : ''), STATUS_PILL[st.status], STATUS_LABEL[st.status])).join('') + '</ul>';
}
function homeHtml(projects) {
  const info = db.info();
  const warn = info.persistent ? '' :
    '<div class="banner banner-warn"><b>Projects cannot be saved in this browser</b>' + esc(info.reason || 'IndexedDB is unavailable') +
    '. The app still works, but everything is forgotten when this tab closes. Try a normal (non-private) Safari tab.</div>';
  return '' +
    '<section class="hero"><h1>Turn long streams into <span class="grad">short clips</span></h1>' +
    '<p class="lead">Link a YouTube video or import a recording, then build your clip list. Free, private, right on your iPhone.</p></section>' + warn +
    '<section class="card" style="margin-top:16px" id="linkCard">' +
      '<div class="card-head"><h2>YouTube link</h2><span class="pill pill-accent">Official player</span></div>' +
      '<form id="linkForm" novalidate>' +
        '<div class="linkrow"><input class="text-input" id="linkInput" type="text" inputmode="url" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" enterkeyhint="go" placeholder="Paste a YouTube link" aria-label="YouTube link">' +
        '<button class="btn btn-primary" type="submit" id="linkGo">Add link</button></div>' +
        '<div class="link-hint" id="linkHint" aria-live="polite"></div>' +
      '</form>' +
      '<p class="card-note">Accepts youtube.com/watch?v=… · youtu.be/… · youtube.com/live/… · youtube.com/shorts/…</p>' +
      '<div class="rule-box"><b>A link alone cannot make clips.</b> It lets YouTube’s own player show the video here. ClipGen AI never downloads or extracts anything from YouTube. If the creator is registered and has approved the video, ClipGen AI fetches their own original file automatically; otherwise you provide a file you own or are allowed to use.</div>' +
    '</section>' +
    '<div class="or-sep"><span>or</span></div>' +
    '<section class="card" id="uploadCard">' +
      '<label class="dropzone" id="dropzone" for="fileInput"><span class="dz-icon">' + ICON_UPLOAD + '</span>' +
      '<span class="dz-title">Choose a video</span><span class="dz-sub">MP4 or MOV · stays on this device</span></label>' +
      '<input class="sr-only" id="fileInput" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">' +
      '<label class="opt"><input type="checkbox" id="keepCopy"' + (state.keepCopy ? ' checked' : '') + '><span><b>Keep a copy in this browser</b><br>' +
      'Lets the project reopen instantly. Turn off for very large files (over ~1 GB) and re-attach the file when you come back.</span></label>' +
      '<div id="uploadMsg" aria-live="polite"></div>' +
    '</section>' +
    '<section class="card" style="margin-top:14px" id="creatorCard"><div class="card-head"><h2>Creators</h2><span class="pill">Checking…</span></div><div class="muted small">Loading the creator registry …</div></section>' +
    '<div class="section-head"><h2>Your projects</h2><span class="muted small">' + projects.length + '</span></div>' +
    (projects.length ? '<div class="plist">' + projects.map(projectCard).join('') + '</div>'
      : '<div class="empty">No projects yet.<br>Paste a YouTube link or choose a video above.</div>') +
    '<div class="section-head"><h2>What is built — and what is planned</h2></div>' +
    '<section class="card">' + roadmapHtml() +
      '<p class="card-note">“Planned” means it does not exist yet: nothing in this app transcribes, finds highlights, makes automatic clips, adds captions or exports 9:16 today.</p></section>' +
    '<div class="section-head"><h2>Local storage</h2></div>' +
    '<section class="card" id="storagePanel"><div class="muted small">Checking…</div></section>';
}
async function refreshCreatorCard(token) {
  const reg = await loadRegistry();
  const box = $('#creatorCard');
  if (!box || token !== state.token) return;
  const verified = reg.ok ? reg.creators.filter((c) => c.status === 'verified').length : 0;
  const pending = reg.ok ? reg.creators.filter((c) => c.status === 'pending').length : 0;
  box.innerHTML =
    '<div class="card-head"><h2>Creators</h2>' + (reg.ok ? '<span class="pill ' + (verified ? 'pill-ok' : '') + '">' + verified + ' verified</span>' : '<span class="pill pill-warn">Registry unavailable</span>') + '</div>' +
    (reg.ok
      ? '<p class="card-note" style="margin-top:0">' + (verified ? verified + ' creator' + (verified === 1 ? ' has' : 's have') + ' registered and been verified' + (pending ? ' (' + pending + ' waiting for verification)' : '') + '. Videos from these creators that they approved can be clipped without you downloading or uploading anything.'
          : '<b>No creators are registered yet</b>' + (pending ? ' (' + pending + ' waiting for verification)' : '') + ', so nothing can be verified automatically today. Until then, YouTube links work with a file you provide yourself.') + '</p>'
      : '<p class="card-note" style="margin-top:0">The creator registry could not be loaded (' + esc(reg.message || 'unknown error') + '), so no video can be verified right now.</p>') +
    (reg.ok && reg.rejected && reg.rejected.length ? '<div class="msg msg-info">' + reg.rejected.length + ' registry entr' + (reg.rejected.length === 1 ? 'y was' : 'ies were') + ' ignored because ' + (reg.rejected.length === 1 ? 'it is' : 'they are') + ' invalid.</div>' : '') +
    '<div class="row"><a class="btn btn-sm" href="creator.html">Creator Studio — for creators ›</a></div>';
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
    '<div class="row"><button class="btn btn-sm" id="btnPersist" type="button">Protect my data</button><button class="btn btn-sm btn-danger" id="btnWipe" type="button">Delete all Phase 2 data</button></div>';
  $('#btnPersist').addEventListener('click', async () => {
    const ok = await db.requestPersist();
    toast(ok ? 'Done — Safari will try to keep your data.' : 'Safari did not grant it. Adding this page to your Home Screen helps.', ok ? 'ok' : '');
    refreshStoragePanel();
  });
  $('#btnWipe').addEventListener('click', async () => {
    if (!confirm('Delete ALL Phase 2 projects, clips and saved videos from this browser? (Phase 1 projects are separate and are not touched.) This cannot be undone.')) return;
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
  refreshCreatorCard(token);
  refreshStoragePanel();
  updateStorageChip();
}
function showUploadMsg(text, kind) {
  const box = $('#uploadMsg');
  if (box) box.innerHTML = text ? '<div class="msg ' + (kind === 'bad' ? 'msg-bad' : 'msg-info') + '">' + esc(text) + '</div>' : '';
}
function wireHome() {
  wireLink();
  const input = $('#fileInput'), dz = $('#dropzone');
  input.addEventListener('change', () => {
    const f = input.files && input.files[0];
    input.value = '';
    if (f) importFile(f);
  });
  $('#keepCopy').addEventListener('change', (e) => { state.keepCopy = e.target.checked; lsSet('clipgen.p2.keepCopy', state.keepCopy ? '1' : '0'); });
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
    source: { kind: 'upload' }, authorization: null,
    hasBlob: false, thumb: null, clipCount: 0, analysisStatus: 'none', analysisSummary: null, analysisError: null, schema: 3
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

/* ======================= YOUTUBE LINK (home) ======================= */
function setLinkHint(text, kind) {
  const h = $('#linkHint');
  if (!h) return;
  h.className = 'link-hint' + (kind ? ' ' + kind : '');
  h.textContent = text || '';
}
function wireLink() {
  const form = $('#linkForm'), input = $('#linkInput');
  input.addEventListener('input', () => {
    const v = input.value.trim();
    if (!v) { setLinkHint(''); return; }
    const r = parseYouTubeUrl(v);
    if (r.ok) setLinkHint('✓ ' + (KIND_LABEL[r.kind] || 'Video') + ' · ID ' + r.videoId + (r.startSec ? ' · starts at ' + fmtClock(r.startSec, 0) : ''), 'ok');
    else setLinkHint('');            // do not nag while the link is still being typed or pasted
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); addYouTubeLink(input.value); });
}
async function addYouTubeLink(text) {
  const r = parseYouTubeUrl(text);
  if (!r.ok) { setLinkHint(r.message, 'bad'); return; }
  let existing = null;
  try { existing = (await db.listProjects()).find((p) => isYt(p) && p.source.videoId === r.videoId); } catch (_) { /* ignore */ }
  if (existing) { toast('You already have a project for this video — opening it.'); location.hash = '#/p/' + existing.id; return; }
  const now = Date.now();
  const project = {
    id: uid(), name: 'YouTube ' + (KIND_LABEL[r.kind] || 'video').toLowerCase().split(' ')[0] + ' · ' + r.videoId, createdAt: now, updatedAt: now,
    source: { kind: 'youtube', videoId: r.videoId, linkKind: r.kind, startSec: r.startSec, url: r.canonicalUrl, addedAt: now },
    authorization: null, video: blankVideo(),
    hasBlob: false, thumb: null, clipCount: 0, analysisStatus: 'none', analysisSummary: null, analysisError: null, schema: 3
  };
  try { await db.saveProject(project); }
  catch (err) { setLinkHint('Could not create the project: ' + errText(err), 'bad'); return; }
  location.hash = '#/p/' + project.id;
}

/* ======================= PROJECT VIEW ======================= */
const fmtFormat = (v) => (extOf(v.name) ? extOf(v.name).toUpperCase() : (v.type || '').replace('video/', '').toUpperCase() || '—');

function ytCardHtml(ctx) {
  const s = ctx.project.source;
  let src;
  try { src = embedSrc(s.videoId, { startSec: s.startSec }); }
  catch (_) { return '<section class="card" id="ytCard"><div class="msg msg-bad">This project has an invalid YouTube video ID, so the player cannot be shown.</div></section>'; }
  const watch = 'https://www.youtube.com/watch?v=' + s.videoId + (s.startSec ? '&t=' + s.startSec + 's' : '');
  return '<section class="card" id="ytCard"><div class="card-head"><h2>YouTube video</h2><span class="pill pill-accent">Official player</span></div>' +
    '<div class="yt-frame"><iframe id="ytFrame" src="' + esc(src) + '" title="YouTube video player" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>' +
    '<div class="meta-chips" id="ytMeta"></div>' +
    '<div class="row"><a class="btn btn-sm" id="ytOpen" href="' + esc(watch) + '" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div>' +
    '<p class="card-note">This is YouTube’s own player. ClipGen AI cannot read, download or cut what plays here. To make clips, ClipGen AI needs the creator’s approved original file or a file you are allowed to use (next card).</p></section>';
}
function projectHtml(ctx) {
  const p = ctx.project;
  const yt = isYt(p);
  const warn = db.info().persistent ? '' :
    '<div class="banner banner-warn"><b>Not saving</b>This browser session cannot store projects. Changes are lost when you close the tab.</div>';
  return '' +
    '<div class="pv-head"><a class="iconbtn back" href="#/" aria-label="Back to projects">‹</a>' +
    '<input class="title-input" id="titleInput" value="' + esc(p.name) + '" maxlength="120" aria-label="Project name" enterkeyhint="done">' +
    '<button class="iconbtn danger" id="btnDelete" type="button" aria-label="Delete project">🗑</button></div>' + warn +
    '<div class="pv-grid">' +
      '<div class="col-main">' +
        (yt ? ytCardHtml(ctx) + '<section class="card" id="sourceCard"></section>' : '') +
        '<section class="card' + (yt ? ' hidden' : '') + '" id="videoCard"><div class="video-wrap" id="videoWrap"><video id="video" playsinline controls preload="metadata"></video>' +
        '<div class="video-msg soft" id="videoMsg">Loading preview …</div></div><div class="meta-chips" id="metaChips"></div></section>' +
        '<section class="card' + (yt ? ' hidden' : '') + '" id="timelineCard"><div class="card-head"><h2>Timeline</h2><span class="muted small num" id="tlPos">0:00 / 0:00</span></div>' +
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
        '<section class="card card-disabled" id="autoCard"><div class="card-head" style="margin-bottom:6px"><h2>Automatic highlights</h2><span class="pill">Planned</span></div>' +
          '<p class="card-note" style="margin-top:0">Not implemented, so nothing here finds highlights — including for YouTube projects. It will be built on top of the audio data and transcription, and only switched on once it is tested.</p>' +
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
  if (isYt(project)) {
    ctx.authzChecking = true;
    renderSource(ctx);
    $('#sourceCard').addEventListener('change', (e) => onSourceChange(ctx, e));
    $('#sourceCard').addEventListener('click', (e) => onSourceClick(ctx, e));
    loadYtMeta(ctx);
  }
  await attachVideo(ctx);
  if (isYt(project)) runAuthzCheck(ctx);           // creator-approval check; may block, verify or offer the creator's file
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
  if (!src) {
    if (isYt(ctx.project)) { ctx.noSrc = true; setLocalVisible(ctx, false); renderSource(ctx); renderClips(ctx); renderAnalysis(ctx); }   // the Source card handles choosing the file
    else showNeedFile(ctx);
    return;
  }
  if (ctx.blocked) { setLocalVisible(ctx, false); renderSource(ctx); renderAnalysis(ctx); return; }
  src = ensureType(src, ctx.project.video.name, ctx.project.video.type);
  ctx.noSrc = false;
  if (ctx.url) { URL.revokeObjectURL(ctx.url); ctx.url = null; }
  ctx.source = src;
  ctx.url = URL.createObjectURL(src);
  if (!ctx.videoWired) {
    ctx.videoWired = true;
    video.addEventListener('loadedmetadata', () => onMeta(ctx));
    video.addEventListener('error', () => onVideoError(ctx));
    video.addEventListener('play', () => { if (!ctx.raf) rafLoop(ctx); });
    ['pause', 'ended', 'seeked', 'timeupdate'].forEach((ev) => video.addEventListener(ev, () => { if (ctx.alive && !ctx.raf) syncPlayhead(ctx); }));
  }
  if (isYt(ctx.project)) {
    setLocalVisible(ctx, true);
    if (!$('#videoMsg')) { const msg = document.createElement('div'); msg.className = 'video-msg soft'; msg.id = 'videoMsg'; msg.textContent = 'Loading preview …'; $('#videoWrap').appendChild(msg); }
    renderMeta(ctx);
  }
  video.src = ctx.url;
  renderAnalysis(ctx);
  renderClips(ctx);
  if (isYt(ctx.project)) renderSource(ctx);
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
  if (isYt(p)) { renderSource(ctx); renderYtMeta(ctx, ctx.yt || null); }
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
       : (isYt(ctx.project) && !ctx.source
          ? '<div class="empty">No clips yet.<br>Clips are cut from your own source file. Choose it in <b>Source file</b> first.</div>'
          : '<div class="empty">No clips yet.<br>Play the video, tap <b>Set IN</b> and <b>Set OUT</b>, then <b>Add clip</b>.</div>')) +
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

/* ======================= YOUTUBE CARD + AUTHORIZED SOURCE FILE ======================= */
function setLocalVisible(ctx, visible) {
  ['#videoCard', '#timelineCard'].forEach((sel) => { const el = $(sel); if (el) el.classList.toggle('hidden', !visible); });
  if (visible && ctx.timeline) { ctx.timeline.resize(); refreshTimeline(ctx); }
}
async function loadYtMeta(ctx) {
  renderYtMeta(ctx, null);
  ctx.ytPromise = fetchOEmbed('https://www.youtube.com/watch?v=' + ctx.project.source.videoId);
  const res = await ctx.ytPromise;
  if (!ctx.alive) return;
  ctx.yt = res;
  renderYtMeta(ctx, res);
  updateDiag(ctx);
}
function renderYtMeta(ctx, res) {
  const box = $('#ytMeta');
  if (!box) return;
  const s = ctx.project.source;
  const chip = (k, valHtml, cls) => '<div class="mchip' + (cls ? ' ' + cls : '') + '"><div class="k">' + k + '</div><div class="v">' + valHtml + '</div></div>';
  let html = '';
  if (!res) html += chip('Title', '<span class="muted">Loading from YouTube …</span>', 'wide wrapv') + chip('Channel', '<span class="muted">…</span>', 'wide');
  else if (res.ok) {
    html += chip('Title', esc(res.title || '—'), 'wide wrapv');
    html += chip('Channel', res.authorUrl ? '<a class="lnk" href="' + esc(res.authorUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(res.authorName || 'Channel') + '</a>' : esc(res.authorName || '—'), 'wide');
  } else {
    html += '<div class="msg msg-info mchip-msg">Title and channel are unavailable: ' + esc(res.message) + ' The player above and your clipping workflow still work.</div>';
  }
  html += chip('Type', esc(KIND_LABEL[s.linkKind] || 'Video')) + chip('Video ID', esc(s.videoId));
  if (s.startSec) html += chip('Link starts at', fmtClock(s.startSec, 0));
  html += chip('Duration', ctx.project.video.duration ? fmtClock(ctx.project.video.duration, 0) + ' <span class="muted small">(your file)</span>' : '<span class="muted">From your file</span>');
  box.innerHTML = html;
}

/* ---- creator registry (same-origin file, loaded once per page) ---- */
function loadRegistry(force) {
  if (!state.registry || force) {
    state.registry = (async () => {
      const r = await fetchJsonLimited(new URL(REGISTRY_URL, location.href).href, { timeoutMs: 10000 });
      if (!r.ok) return { ok: false, creators: [], rejected: [], updatedAt: null, message: r.message };
      return validateRegistry(r.json, { allowLocalHttp: ALLOW_LOCAL_HTTP });
    })();
  }
  return state.registry;
}
async function logAuth(ctx, entry) {
  try { await db.logAuth(ctx.id, entry); ctx.authLog = (await db.listAuthLog(ctx.id)).slice(0, 12); if (ctx.alive) updateDiag(ctx); } catch (_) { /* the log is best effort */ }
}

const selfDeclared = () => ({ method: 'self-declared', confirmed: true, at: Date.now(), statement: AUTH_STATEMENT, version: 1 });
const isGrantAuth = (a) => !!(a && a.method === 'creator-grant');
function verifiedAuth(ctx) {
  const az = ctx.authz;
  return {
    method: 'creator-grant', creatorId: az.creator.id, displayName: az.creator.displayName, keyId: az.creator.keyId, verifiedAt: az.creator.verifiedAt,
    identity: az.identity, grant: az.grant, fileVerified: true, at: Date.now(), version: 2
  };
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return '—'; } };

/* Asks the question "may ClipGen process this YouTube video, and where is the creator's file?" (authz.js decides). */
async function runAuthzCheck(ctx) {
  if (!isYt(ctx.project) || !ctx.alive) return;
  const wasBlocked = !!ctx.blocked;
  ctx.authzChecking = true; ctx.authz = null; ctx.softWarn = null;
  renderSource(ctx);
  const [registry, yt] = await Promise.all([loadRegistry(), ctx.ytPromise || Promise.resolve(null)]);
  if (!ctx.alive) return;
  const p = ctx.project, a = p.authorization;
  let res;
  try {
    res = await evaluateYouTubeSource({
      videoId: p.source.videoId, authorUrl: yt && yt.ok ? yt.authorUrl : null, registry,
      fetchManifest: (e) => fetchJsonLimited(e.manifestUrl, { timeoutMs: 12000 }),
      allowLocalHttp: ALLOW_LOCAL_HTTP, hintCreatorId: isGrantAuth(a) ? a.creatorId : undefined
    });
  } catch (e) {
    res = { status: 'unverified', code: 'check-failed', message: 'The check failed unexpectedly: ' + errText(e), need: [], creator: null, grant: null, identity: null, checks: [] };
  }
  if (!ctx.alive) return;
  ctx.authz = res; ctx.authzChecking = false;
  ctx.blocked = (res.code === 'creator-revoked' || (isGrantAuth(a) && BLOCKING_CODES.has(res.code))) ? res : null;
  if (!ctx.blocked && isGrantAuth(a) && res.status !== 'verified') ctx.softWarn = res;   // e.g. offline: keep working, say it could not be re-checked
  let last = null;
  try { last = (await db.listAuthLog(ctx.id)).find((x) => x.event === 'check'); } catch (_) { /* ignore */ }
  if (!last || last.code !== res.code) await logAuth(ctx, { event: 'check', code: res.code, creatorId: res.creator ? res.creator.id : (isGrantAuth(a) ? a.creatorId : null), keyId: res.creator ? res.creator.keyId || null : null, detail: res.status });
  if (res.status === 'verified' && isGrantAuth(a)) {           // keep the stored grant current (URL / terms may have been updated by the creator)
    p.authorization = Object.assign({}, a, { grant: res.grant, verifiedAt: res.creator.verifiedAt, displayName: res.creator.displayName });
    try { await db.saveProject(p); } catch (_) { /* ignore */ }
  }
  if (ctx.blocked) applyBlock(ctx);
  else if (wasBlocked) await attachVideo(ctx);          // approval is back: bring the video back
  if (!ctx.alive) return;
  renderSource(ctx); renderAnalysis(ctx); updateDiag(ctx);
  const noFile = !ctx.source && !state.files.has(ctx.id) && !(p.hasBlob && !ctx.noSrc);
  const saveData = !!(navigator.connection && navigator.connection.saveData);
  if (res.status === 'verified' && noFile && !ctx.autoTried && !saveData && res.grant.source.size <= AUTO_FETCH_MAX) { ctx.autoTried = true; downloadSource(ctx); }
}
function applyBlock(ctx) {
  const j = state.jobs.get(ctx.id);
  if (j) { try { j.cancel(); } catch (_) { /* ignore */ } }
  const v = $('#video');
  if (v) { try { v.pause(); } catch (_) { /* ignore */ } }
  ctx.playClip = null;
  setLocalVisible(ctx, false);
}

/* ---- rendering ---- */
function checklistHtml(checks) {
  if (!checks || !checks.length) return '';
  return '<ul class="checks">' + checks.map((c) => '<li class="' + (c.ok === true ? 'ok' : c.ok === false ? 'bad' : 'unk') + '"><span class="ck" aria-hidden="true">' + (c.ok === true ? '✓' : c.ok === false ? '✗' : '?') + '</span><span>' + esc(c.label) + '</span></li>').join('') + '</ul>';
}
function termsHtml(g) {
  if (!g || !g.terms) return '';
  const t = g.terms, bits = [];
  bits.push('Clipping: ' + (t.clipping ? 'allowed' : 'not allowed'));
  bits.push('Captions: ' + (t.captions ? 'allowed' : 'not allowed'));
  bits.push('Vertical (9:16) export: ' + (t.verticalExport ? 'allowed' : 'not allowed'));
  if (t.expiresAt) bits.push('Approval valid until ' + fmtDate(Date.parse(t.expiresAt)));
  return '<p class="card-note"><b>Creator’s terms:</b> ' + esc(bits.join(' · ')) + '.' +
    (t.attributionRequired ? ' <b>Attribution required:</b> “' + esc(t.attributionText || 'credit the creator') + '”.' : '') + '</p>';
}
const FILE_INPUT = '<input class="sr-only" id="srcFile" type="file" accept="video/mp4,video/quicktime,.mp4,.mov,.m4v">';
const HOWTO =
  '<details class="howto"><summary>How do I get the file?</summary><div class="howto-body">' +
  '<p><b>Your own upload:</b> in YouTube Studio open <i>Content</i>, open the video’s menu and choose <i>Download</i> (YouTube offers this for videos you uploaded; it is not offered for every video). On iPhone you can try studio.youtube.com in Safari with “Request Desktop Website”.</p>' +
  '<p><b>Your own livestream:</b> use the recording saved by your streaming or capture app (for example OBS).</p>' +
  '<p><b>Someone else’s video:</b> the creator can register in Creator Studio so ClipGen AI can fetch their original file safely. Or ask them to send you the file. Do not use downloader sites or apps — they break YouTube’s rules and ClipGen AI will not help with that.</p>' +
  '<p class="muted small">Files must be MP4 or MOV. <a class="lnk" href="https://support.google.com/youtube/answer/56100" target="_blank" rel="noopener noreferrer">YouTube Help: download your uploaded videos ↗</a></p></div></details>';

function renderSource(ctx) {
  const el = $('#sourceCard');
  if (!el || !ctx.alive) return;
  const p = ctx.project, v = p.video, auth = p.authorization, az = ctx.authz;
  const hasFile = !!ctx.source || state.files.has(ctx.id) || (p.hasBlob && !ctx.noSrc);

  if (ctx.blocked) {
    const b = ctx.blocked;
    el.innerHTML =
      '<div class="card-head"><h2>Source file</h2><span class="pill pill-bad">Blocked</span></div>' +
      '<div class="msg msg-bad"><b>' + (b.code === 'creator-revoked' ? 'Approval withdrawn' : 'Approval no longer valid') + '.</b> ' + esc(b.message) + '</div>' +
      '<p class="card-note">The video file is not being used. Your clips stay saved. It becomes usable again only if the creator approves this video again.</p>' +
      (b.checks && b.checks.length ? '<details class="howto"><summary>What was checked</summary><div class="howto-body">' + checklistHtml(b.checks) + '</div></details>' : '') +
      (hasFile ? '<div class="row"><button class="btn btn-sm btn-danger" type="button" data-act="removeFile">Remove file from this device</button><button class="btn btn-sm" type="button" data-act="recheck">Check again</button></div>' : '<div class="row"><button class="btn btn-sm" type="button" data-act="recheck">Check again</button></div>');
    return;
  }

  if (hasFile) {
    const verified = isGrantAuth(auth) && auth.fileVerified;
    let head, body = '';
    if (verified) {
      head = '<span class="pill pill-ok">Verified source</span>';
      body += '<p class="card-note" style="margin-top:8px">✓ Approved by <b>' + esc(auth.displayName) + '</b>. This file’s size and SHA-256 equal the values the creator signed (' + esc((auth.grant.source.sha256 || '').slice(0, 12)) + '…).</p>';
      body += termsHtml(auth.grant);
      if (auth.identity === 'unconfirmed') body += '<div class="msg msg-info">YouTube could not confirm who made this video when it was checked, so the match is by video ID and the creator’s signature only.</div>';
      if (ctx.authzChecking) body += '<p class="card-note">Re-checking the creator’s approval …</p>';
      else if (az && az.status === 'verified') body += '<p class="card-note">✓ Approval re-checked just now: still valid.</p>';
      else if (ctx.softWarn) body += '<div class="msg msg-info">Could not re-check the creator’s approval right now (' + esc(ctx.softWarn.message) + ') Last verified ' + esc(fmtDate(auth.at)) + '. It will be checked again next time you open this project online.</div>';
    } else {
      head = '<span class="pill pill-warn">Self-declared · not verified</span>';
      body += '<p class="card-note" style="margin-top:8px">Processed on this device only. ClipGen AI cannot verify that this file is the video above or that you may use it — that is your responsibility.' +
        (auth && auth.at ? ' You confirmed on ' + esc(fmtDate(auth.at)) + ': “' + esc(auth.statement || AUTH_STATEMENT) + '”' : '') + '</p>';
      if (az && az.status === 'verified') body += '<div class="msg msg-info">The creator has approved this video. You can switch to their verified file.</div><div class="row"><button class="btn btn-sm btn-primary" type="button" data-act="fetch">Use the creator’s verified file</button></div>';
    }
    el.innerHTML =
      '<div class="card-head"><h2>Source file</h2>' + head + '</div>' +
      '<div class="file-line"><b>' + esc(v.name || 'Video file') + '</b><span class="muted small num">' + esc(fmtSize(v.size)) + (v.duration ? ' · ' + fmtClock(v.duration, 0) : '') + '</span></div>' + body +
      '<div class="row"><label class="btn btn-sm" for="srcFile">Replace file</label><button class="btn btn-sm btn-danger" type="button" data-act="removeFile">Remove file</button></div>' + FILE_INPUT;
    return;
  }

  if (ctx.dl) {
    const g = az && az.grant ? az.grant : null;
    el.innerHTML =
      '<div class="card-head"><h2>Source file</h2><span class="pill pill-accent">Fetching</span></div>' +
      '<p class="card-note" style="margin-top:0">Downloading the creator’s original file from <b>' + esc(hostOf(g && g.source.url)) + '</b> and checking it against the creator’s signed SHA-256 …</p>' +
      '<div class="progress"><i id="dlBar"></i></div><div class="readout"><span id="dlText" class="num"></span></div>' +
      '<div class="row"><button class="btn btn-sm btn-danger" type="button" data-act="cancelFetch">Cancel</button></div><p class="card-note">Keep this page open and the screen on.</p>';
    updateDlUi(ctx);
    return;
  }

  if (ctx.authzChecking || !az) {
    el.innerHTML =
      '<div class="card-head"><h2>Source file</h2><span class="pill pill-accent">Checking…</span></div>' +
      '<p class="card-note" style="margin-top:0">Checking whether this video’s creator has registered with ClipGen AI and approved clipping …</p><div class="progress indeterminate"><i></i></div>';
    return;
  }

  if (az.status === 'verified') {
    const g = az.grant, s = g.source;
    el.innerHTML =
      '<div class="card-head"><h2>Source file</h2><span class="pill pill-ok">Creator approved</span></div>' +
      '<p class="card-note" style="margin-top:0"><b>' + esc(az.creator.displayName) + '</b> is a verified ClipGen AI creator and has approved this video for clipping. No confirmation is needed from you.</p>' +
      '<div class="file-line"><b>' + esc(s.name) + '</b><span class="muted small num">' + esc(fmtSize(s.size)) + ' · from ' + esc(hostOf(s.url)) + '</span></div>' +
      (ctx.dlError ? '<div class="msg msg-bad">' + esc(ctx.dlError) + '</div>' : '') +
      '<div class="row"><button class="btn btn-primary" type="button" data-act="fetch">' + (ctx.dlError ? 'Try again — ' : 'Get the creator’s file · ') + esc(fmtSize(s.size)) + '</button></div>' +
      '<p class="card-note">The file comes straight from the creator’s own host, never from YouTube, and is rejected unless it matches the SHA-256 the creator signed.' +
      (s.size > AUTO_FETCH_MAX ? ' It is large, so it waits for your tap.' : '') + '</p>' +
      termsHtml(g) +
      (az.identity === 'unconfirmed' ? '<div class="msg msg-info">YouTube could not confirm who made this video, so the match is by video ID and the creator’s signature only.</div>' : '') +
      '<details class="howto"><summary>What was checked</summary><div class="howto-body">' + checklistHtml(az.checks) + '</div></details>' +
      '<details class="howto"><summary>I already have this exact file</summary><div class="howto-body"><p>Choose it and ClipGen AI will check it against the creator’s signed SHA-256. A different file is not verified.</p>' +
      '<label class="btn btn-sm" for="srcFile">Choose file</label>' + FILE_INPUT + '</div></details>';
    return;
  }

  /* not verified: say exactly why and what is needed */
  const authed = !!(auth && auth.method === 'self-declared' && auth.confirmed);
  const canRetry = ['registry-unavailable', 'manifest-unavailable', 'creator-unknown', 'check-failed'].indexOf(az.code) >= 0;
  el.innerHTML =
    '<div class="card-head"><h2>Source file</h2><span class="pill pill-warn">' + (az.status === 'pending' ? 'Creator pending' : 'Not verified') + '</span></div>' +
    '<div class="msg msg-info" style="margin-top:0"><b>' + esc(az.message) + '</b></div>' +
    '<p class="card-note"><b>What is needed to process this video automatically:</b></p>' +
    '<ul class="need">' + (az.need && az.need.length ? az.need.map((n) => '<li>' + esc(n) + '</li>').join('') : '<li>A creator-approved source file.</li>') + '</ul>' +
    '<div class="row">' + (canRetry ? '<button class="btn btn-sm" type="button" data-act="recheck">Check again</button>' : '') +
    (az.code !== 'registry-unavailable' ? '<button class="btn btn-sm" type="button" data-act="invite">Message for the creator</button>' : '') + '</div>' +
    (ctx.inviteText ? '<textarea class="text-input invite" id="inviteBox" readonly rows="6" aria-label="Message for the creator">' + esc(ctx.inviteText) + '</textarea>' : '') +
    (az.checks && az.checks.length ? '<details class="howto"><summary>What was checked</summary><div class="howto-body">' + checklistHtml(az.checks) + '</div></details>' : '') +
    '<details class="howto"' + (authed || ctx.showSelf ? ' open' : '') + '><summary>I own this video, or the creator gave me the file</summary><div class="howto-body">' +
      '<div class="rule-box"><b>Self-declared, not verified.</b> ClipGen AI cannot check this. Only use a video you own or are allowed to process. It does not download from YouTube and cannot fetch the video for you.</div>' +
      '<label class="opt"><input type="checkbox" id="authChk"' + (authed ? ' checked' : '') + '><span><b>' + esc(AUTH_STATEMENT) + '</b><br>I will only choose a file I am allowed to use.</span></label>' +
      (authed
        ? '<label class="btn btn-primary btn-block" for="srcFile" style="margin-top:12px">Choose video file (MP4 or MOV)</label>' + FILE_INPUT
        : '<button class="btn btn-block" type="button" disabled aria-disabled="true" style="margin-top:12px">Choose video file (confirm above first)</button>') +
      HOWTO + '</div></details>';
}
function updateDlUi(ctx) {
  const d = ctx.dl;
  if (!d) return;
  const bar = $('#dlBar'), txt = $('#dlText');
  const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
  if (bar) bar.style.width = pct.toFixed(1) + '%';
  if (txt) txt.textContent = fmtSize(d.received) + ' of ' + fmtSize(d.total) + ' · ' + pct.toFixed(0) + '%';
}

/* ---- events ---- */
async function onSourceChange(ctx, e) {
  const t = e.target;
  if (t.id === 'authChk') {
    ctx.project.authorization = t.checked ? selfDeclared() : null;
    ctx.showSelf = true;
    try { await db.saveProject(ctx.project); } catch (err) { toast('Could not save: ' + errText(err), 'bad'); }
    if (t.checked) logAuth(ctx, { event: 'self-declared', code: 'checkbox', detail: 'User confirmed ownership/permission (not verified).' });
    renderSource(ctx);
  } else if (t.id === 'srcFile') {
    const f = t.files && t.files[0];
    t.value = '';
    if (f) chooseSourceFile(ctx, f);
  }
}
function onSourceClick(ctx, e) {
  const btn = e.target.closest ? e.target.closest('[data-act]') : null;
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  if (act === 'removeFile') removeSourceFile(ctx);
  else if (act === 'fetch') downloadSource(ctx);
  else if (act === 'cancelFetch') { if (ctx.dl && ctx.dl.abort) ctx.dl.abort.abort(); }
  else if (act === 'recheck') { loadRegistry(true); ctx.inviteText = null; runAuthzCheck(ctx); }
  else if (act === 'invite') inviteCreator(ctx);
}
async function inviteCreator(ctx) {
  const s = ctx.project.source;
  const text = creatorInviteText(new URL('creator.html', location.href).href, ctx.yt && ctx.yt.ok ? ctx.yt.authorName : '', 'https://www.youtube.com/watch?v=' + s.videoId);
  try { await navigator.clipboard.writeText(text); toast('Message copied — paste it to the creator.', 'ok'); }
  catch (_) { toast('Select the message below and copy it.'); }
  ctx.inviteText = text;
  renderSource(ctx);
}

/* Fetches the creator's file (from the SIGNED url only) and adopts it if the hash matches. */
async function downloadSource(ctx) {
  const az = ctx.authz;
  if (!az || az.status !== 'verified' || ctx.dl || ctx.blocked) return;
  const g = az.grant, ac = new AbortController();
  ctx.dlError = null;
  ctx.dl = { received: 0, total: g.source.size, abort: ac };
  renderSource(ctx);
  const wake = await keepAwake();
  try {
    const file = await fetchSourceFile(g.source, { signal: ac.signal, allowLocalHttp: ALLOW_LOCAL_HTTP, onProgress: (pr) => { ctx.dl.received = pr.received; updateDlUi(ctx); } });
    ctx.dl = null;
    if (!ctx.alive) return;
    await adoptFile(ctx, file, verifiedAuth(ctx));
  } catch (e) {
    ctx.dl = null;
    if (e && e.name === 'AbortError') toast('Download cancelled.');
    else {
      ctx.dlError = errText(e);
      logAuth(ctx, { event: 'file-rejected', code: (e && e.code) || 'error', creatorId: az.creator.id, keyId: az.creator.keyId || null, detail: errText(e) });
    }
    if (ctx.alive) renderSource(ctx);
  } finally { if (wake) { try { await wake.release(); } catch (_) { /* ignore */ } } }
}

/* The user chose a file: verified if it equals the creator's signed grant, otherwise only ever self-declared. */
async function chooseSourceFile(ctx, f) {
  const p = ctx.project;
  if (ctx.blocked) { toast('This video is blocked until the creator approves it again.', 'bad'); return; }
  const problem = validateVideoFile(f);
  if (problem) { toast(problem, 'bad'); return; }
  const az = ctx.authz, auth = p.authorization;
  const grant = az && az.status === 'verified' ? az.grant : (isGrantAuth(auth) ? auth.grant : null);
  if (grant) {
    if (f.size === grant.source.size) {
      busy('Checking the file against the creator’s signed SHA-256 … 0%');
      let hex = null;
      try {
        hex = await sha256OfBlob(f, { onProgress: (x) => { const t = $('#busyText'); if (t) t.textContent = 'Checking the file against the creator’s signed SHA-256 … ' + Math.round(x * 100) + '%'; } });
      } catch (err) { busy(null); toast('Could not read the file: ' + errText(err), 'bad'); return; }
      busy(null);
      if (fileMatchesGrant(f, hex, grant)) {
        const a = az && az.status === 'verified' ? verifiedAuth(ctx) : Object.assign({}, auth, { fileVerified: true, at: Date.now() });
        await adoptFile(ctx, f, a);
        return;
      }
    }
    toast('This is not the file the creator approved (its size or SHA-256 differs), so it is NOT verified.', 'bad');
    logAuth(ctx, { event: 'file-rejected', code: 'hash-mismatch', creatorId: isGrantAuth(auth) ? auth.creatorId : (az && az.creator ? az.creator.id : null), detail: f.name + ' · ' + f.size + ' bytes' });
  }
  let useAuth = auth && auth.method === 'self-declared' && auth.confirmed ? auth : null;
  if (!useAuth) {
    if (!confirm('This file is not verified against a creator approval. Use it only if you own this video or have the owner’s permission to process it.\n\nContinue and mark it as self-declared?')) { ctx.showSelf = true; renderSource(ctx); return; }
    useAuth = selfDeclared();
    logAuth(ctx, { event: 'self-declared', code: 'confirm-dialog', detail: 'User confirmed ownership/permission for a file that is not verified.' });
  }
  await adoptFile(ctx, f, useAuth);
}
async function adoptFile(ctx, f, auth) {
  const p = ctx.project, prev = p.video;
  const same = prev.name === f.name && prev.size === f.size;
  if (prev.name && !same && !confirm('This file (' + f.name + ', ' + fmtSize(f.size) + ') differs from the previous one (' + prev.name + ', ' + fmtSize(prev.size) + '). Your clips and loudness map belong to the previous file. Use the new file anyway?')) return;
  const j = state.jobs.get(ctx.id);
  if (j) { try { j.cancel(); } catch (_) { /* ignore */ } }
  state.files.set(ctx.id, f);
  const e = extOf(f.name);
  p.video = { name: f.name, size: f.size, type: f.type || typeForExt(e), lastModified: f.lastModified || null, duration: same ? prev.duration : null, width: same ? prev.width : null, height: same ? prev.height : null };
  if (!same) p.thumb = null;
  p.hasBlob = false;
  p.authorization = auth;
  p.schema = 3;
  busy('Preparing your file …');
  try { await db.deleteBlob(ctx.id); } catch (_) { /* ignore */ }
  if (state.keepCopy && db.info().persistent) {
    busy('Saving a copy in this browser (' + fmtSize(f.size) + ') …');
    try { await db.saveBlob(ctx.id, f); p.hasBlob = true; }
    catch (err) { toast('Could not keep a copy (' + errText(err) + '). Fetch or choose the file again next time.', 'bad'); }
  }
  try { await db.saveProject(p); } catch (err) { toast('Could not save the project: ' + errText(err), 'bad'); }
  logAuth(ctx, { event: auth.method === 'creator-grant' ? 'file-verified' : 'file-self-declared', code: auth.method, creatorId: auth.creatorId || null, keyId: auth.keyId || null, detail: f.name + ' · ' + f.size + ' bytes' + (auth.method === 'creator-grant' ? ' · SHA-256 matched the creator’s signature' : ' · not verified') });
  busy(null);
  if (!ctx.alive) return;
  await attachVideo(ctx);
  if (ctx.alive) { if (auth.method === 'creator-grant') toast('Verified: the file matches the creator’s signed approval.', 'ok'); renderSource(ctx); }
}
async function removeSourceFile(ctx) {
  if (!confirm('Remove the video file from this project? The YouTube link and your clips stay. You can choose or fetch a file again later.')) return;
  const p = ctx.project;
  const j = state.jobs.get(ctx.id);
  if (j) { try { j.cancel(); } catch (_) { /* ignore */ } }
  state.files.delete(ctx.id);
  try { await db.deleteBlob(ctx.id); } catch (_) { /* ignore */ }
  const vEl = $('#video');
  if (vEl) { try { vEl.pause(); vEl.removeAttribute('src'); vEl.load(); } catch (_) { /* ignore */ } }
  if (ctx.url) { URL.revokeObjectURL(ctx.url); ctx.url = null; }
  ctx.source = null; ctx.playClip = null; ctx.noSrc = true;
  p.hasBlob = false; p.video = blankVideo(); p.thumb = null;
  if (isGrantAuth(p.authorization)) p.authorization = null;       // a verified file is gone; the approval is re-checked from the link next time
  try { await db.saveProject(p); } catch (err) { toast('Could not save: ' + errText(err), 'bad'); }
  setLocalVisible(ctx, false);
  renderSource(ctx); renderClips(ctx); renderAnalysis(ctx); renderYtMeta(ctx, ctx.yt || null);
  toast('File removed.');
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
    const can = !!ctx.source && !ctx.blocked;
    html += '<div class="row"><button class="btn btn-primary" type="button" data-act="analyze"' + (can ? '' : ' disabled aria-disabled="true"') + '>' + (a ? 'Analyze again' : 'Analyze audio') + '</button></div>';
    if (!can) html += '<p class="card-note">' + (isYt(p) ? 'Get or choose the source file first (see Source file above). The YouTube player cannot be analyzed.' : 'Attach the video file first (see the preview above).') + '</p>';
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
  if (ctx.blocked) { toast('This video is blocked until the creator approves it again.', 'bad'); return; }
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
  lines.push('Source: ' + JSON.stringify({ kind: p.source ? p.source.kind : 'upload', videoId: isYt(p) ? p.source.videoId : undefined, selfDeclared: !!(p.authorization && p.authorization.method === 'self-declared') }));
  if (ctx.authz) lines.push('Creator check: ' + JSON.stringify({ status: ctx.authz.status, code: ctx.authz.code, creator: ctx.authz.creator ? ctx.authz.creator.id : null, identity: ctx.authz.identity, blocked: !!ctx.blocked }));
  lines.push('Authorization: ' + JSON.stringify(p.authorization ? { method: p.authorization.method, creatorId: p.authorization.creatorId, fileVerified: p.authorization.fileVerified, at: p.authorization.at } : null));
  if (ctx.dlError) lines.push('Last fetch error: ' + ctx.dlError);
  if (ctx.authLog && ctx.authLog.length) { lines.push('--- authorization history (newest first) ---'); ctx.authLog.forEach((x) => lines.push(new Date(x.at).toISOString() + ' ' + x.event + ' ' + x.code + (x.creatorId ? ' [' + x.creatorId + ']' : '') + (x.detail ? ' · ' + x.detail : ''))); }
  if (ctx.yt) lines.push('YouTube details: ' + (ctx.yt.ok ? 'loaded' : 'unavailable (' + ctx.yt.code + ')'));
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
