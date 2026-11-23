/* "Paste your video link" + upload: the entry point of the whole workflow (used by Dashboard, Video input, Upload) */
import { h, debounce, fmtBytes, fmtLong, isAbort } from './util.js';
import { icon } from './icons.js';
import { conn } from './conn.js';
import { inspectLink, addByLink, pollJob, uploadFile, abandonUpload, cancelJob, ApiError } from './api.js';
import { getPendingUpload, addHistory } from './state.js';
import { progressBar, notice, btn, toast } from './ui.js';

const PLATFORM_HINT = [
  ['YouTube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']], ['Vimeo', ['vimeo.com']], ['TikTok', ['tiktok.com']], ['Instagram', ['instagram.com']],
  ['Facebook', ['facebook.com', 'fb.watch', 'fb.com']], ['X (Twitter)', ['twitter.com', 'x.com', 't.co']], ['Twitch', ['twitch.tv']], ['Dailymotion', ['dailymotion.com', 'dai.ly']],
  ['Reddit', ['reddit.com', 'redd.it']], ['Kick', ['kick.com']], ['Rumble', ['rumble.com']], ['Bilibili', ['bilibili.com', 'b23.tv']], ['LinkedIn', ['linkedin.com']], ['Snapchat', ['snapchat.com']]
];
const ACCEPT = 'video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.mpg,.mpeg,.ts,.mts,.m2ts,.3gp,.flv,.wmv,.ogv';

export function parseLink(raw) {
  let v = String(raw || '').trim();
  if (!v) return { empty: true };
  if (/\s/.test(v)) return { error: 'A link cannot contain spaces.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) { if (/^[^/]+\.[a-z]{2,}(\/|$)/i.test(v)) v = 'https://' + v; else return { error: 'That does not look like a link. It should start with https://' }; }
  let u;
  try { u = new URL(v); } catch (_) { return { error: 'That does not look like a valid link.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http:// and https:// links are supported.' };
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const p = PLATFORM_HINT.find(([, hs]) => hs.some((x) => host === x || host.endsWith('.' + x)));
  return { url: u.href, host, platform: p ? p[0] : null };
}

export function createAddBox({ mode = 'both', navigate }) {
  let busy = false, ac = null, inspectAc = null, lastCheck = null;
  const root = h('div');
  const pendingBox = h('div');
  const statusBox = h('div');
  const taskBox = h('div');

  /* ---------- link part ---------- */
  const input = h('input', { class: 'input', type: 'text', inputmode: 'url', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'Paste your video link here', 'aria-label': 'Video link', enterkeyhint: 'go' });
  const addBtn = btn('Add video', { cls: 'primary lg', ic: 'plus', onclick: () => submitLink() });
  const check = debounce(() => runCheck(), 550);
  input.addEventListener('input', () => { lastCheck = null; check(); });
  input.addEventListener('paste', () => setTimeout(() => { check.cancel(); runCheck(); }, 30));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitLink(); } });

  const linkPart = h('div', null, h('div', { class: 'lrow' }, input, addBtn), statusBox);

  function card(kind, title, body, extra) {
    return h('div', { class: 'source-status ' + kind, role: 'status' },
      extra && extra.img ? h('img', { src: extra.img, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
      h('div', { class: 'grow' }, h('div', { class: 'row', style: { marginBottom: '4px' } }, h('b', null, title), extra && extra.chip ? extra.chip : null), body, extra && extra.actions ? h('div', { class: 'row', style: { marginTop: '10px' } }, extra.actions) : null));
  }
  const chip = (cls, t) => h('span', { class: 'chip ' + cls }, t);
  const uploadInstead = () => btn('Upload the video instead', { cls: 'sm', ic: 'upload', onclick: () => fileInput.click() });

  function renderInspect(res, parsed) {
    if (res.kind === 'platform') {
      const pv = res.preview;
      return card('warn', res.platformName + ' link detected', h('div', null, pv && pv.title ? h('div', { style: { marginBottom: '6px' } }, h('b', null, pv.title), pv.author ? h('span', { class: 'muted' }, ' · ' + pv.author) : null) : null, h('p', { class: 'small muted' }, res.message)),
        { img: pv && pv.thumbnail, chip: chip('warn', 'Not downloadable'), actions: [uploadInstead()] });
    }
    if (res.supported) {
      const rows = [['File', res.name], ['Type', res.type || 'unknown'], ['Size', res.bytes ? fmtBytes(res.bytes) : 'not reported'], ['Seekable', res.rangeSupported ? 'yes' : 'unknown']];
      return card('ok', 'Direct video file', h('dl', { class: 'kv small' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)]).flat()), { chip: chip('ok', 'Source reachable') });
    }
    return card('bad', res.status === 'forbidden' ? 'The other server refuses this file' : res.status === 'not-media' ? 'This is not a video file' : res.status === 'not-found' ? 'Nothing found at this link' : 'Cannot use this link', h('p', { class: 'small muted' }, res.message), { chip: chip('bad', 'Unavailable'), actions: [uploadInstead()] });
  }

  async function runCheck() {
    if (busy) return;
    const p = parseLink(input.value);
    if (inspectAc) inspectAc.abort();
    if (p.empty) { statusBox.replaceChildren(); lastCheck = null; return; }
    if (p.error) { statusBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('warn', p.error))); lastCheck = null; return; }
    if (conn.status !== 'ok') { statusBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('warn', 'Connect to your ClipGen backend first (Settings).'))); return; }
    statusBox.replaceChildren(h('div', { class: 'source-status' }, h('div', { class: 'spinner' }), h('div', { class: 'muted small' }, p.platform ? 'Looking up ' + p.platform + ' preview …' : 'Checking the link …')));
    inspectAc = new AbortController();
    try {
      const res = await inspectLink(p.url, inspectAc.signal);
      lastCheck = { url: p.url, res };
      statusBox.replaceChildren(renderInspect(res, p));
    } catch (e) {
      if (isAbort(e)) return;
      statusBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('bad', e.message)));
    }
  }

  async function submitLink() {
    if (busy) return;
    const p = parseLink(input.value);
    if (p.empty) { input.focus(); statusBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('', 'Paste a link to a video first.'))); return; }
    if (p.error) { input.focus(); return runCheck(); }
    if (conn.status !== 'ok') return runCheck();
    if (!lastCheck || lastCheck.url !== p.url) { check.cancel(); await runCheck(); }
    if (lastCheck && lastCheck.res && !lastCheck.res.supported) { input.focus(); return; }   // the status card already explains why
    await ingest(p);
  }

  async function ingest(p) {
    setBusy(true);
    ac = new AbortController();
    const msg = h('div', { class: 'muted small' }, 'Contacting the server …');
    const bar = progressBar(null);
    let jobId = null;
    const cancelBtn = btn('Cancel', { cls: 'sm', onclick: async () => { ac.abort(); if (jobId) { try { await cancelJob(jobId); } catch (_) { /* ignore */ } } } });
    statusBox.replaceChildren(h('div', { class: 'source-status' }, h('div', { class: 'grow' }, h('div', { class: 'row between nowrap' }, h('b', null, 'Fetching your video'), cancelBtn), bar, h('div', { style: { marginTop: '8px' } }, msg))));
    const t0 = Date.now();
    try {
      const { project, job } = await addByLink(p.url);
      jobId = job.id;
      await pollJob(job.id, (j) => { msg.textContent = j.message || ''; bar.set(j.progress > 0.01 ? j.progress : null); }, { signal: ac.signal });
      addHistory({ kind: 'add-link', ok: true, projectId: project.id, name: project.name, message: 'Video fetched from link', ms: Date.now() - t0 });
      navigate('#/project/' + project.id + '/generate');
    } catch (e) {
      if (isAbort(e) || (e instanceof ApiError && e.code === 'cancelled')) { statusBox.replaceChildren(); toast('Cancelled.'); }
      else {
        addHistory({ kind: 'add-link', ok: false, name: p.host, message: e.message, ms: Date.now() - t0 });
        statusBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('bad', h('b', null, 'Could not fetch the video. '), e.message, h('div', { class: 'row' }, uploadInstead(), btn('Try again', { cls: 'sm', onclick: () => submitLink() })))));
      }
    } finally { setBusy(false); }
  }

  /* ---------- upload part ---------- */
  const fileInput = h('input', { type: 'file', accept: ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', onchange: () => { const f = fileInput.files && fileInput.files[0]; fileInput.value = ''; if (f) startUpload(f); } });
  const drop = h('button', { class: 'dropzone', type: 'button', onclick: () => fileInput.click() },
    h('span', { class: 'ic', html: icon('upload') }),
    h('span', { class: 'grow' }, h('b', null, 'Upload a video file'), h('div', { class: 'small muted' }, 'MP4, MOV, WebM, MKV and more' + (conn.caps ? ' · up to ' + Math.round(conn.caps.limits.maxSourceMB / 1024 * 10) / 10 + ' GB / ' + conn.caps.limits.maxDurationMin + ' min' : ''))));
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) startUpload(f); });
  const uploadPart = h('div', null, drop, fileInput);

  function renderPending() {
    const p = getPendingUpload();
    if (!p || busy) { pendingBox.replaceChildren(); return; }
    pendingBox.replaceChildren(h('div', { style: { marginBottom: '12px' } }, notice('', h('b', null, 'Unfinished upload: '), p.name + ' (' + fmtBytes(p.size) + '). Choose the same file again and it continues where it stopped.',
      h('div', { class: 'row' }, btn('Choose the file', { cls: 'sm primary', onclick: () => fileInput.click() }), btn('Discard', { cls: 'sm', onclick: async () => { await abandonUpload(); renderPending(); } })))));
  }

  async function startUpload(file) {
    if (busy) return;
    const lim = conn.caps && conn.caps.limits;
    if (conn.status !== 'ok') return toast('Connect to your ClipGen backend first (Settings).', { kind: 'bad' });
    if (lim && file.size > lim.maxSourceMB * 1048576) return toast(file.name + ' is ' + fmtBytes(file.size) + '; this server accepts up to ' + lim.maxSourceMB + ' MB.', { kind: 'bad' });
    setBusy(true); pendingBox.replaceChildren();
    ac = new AbortController();
    const bar = progressBar(0), info = h('div', { class: 'small muted num' }, 'Starting …'), title = h('b', null, 'Uploading ' + file.name);
    const cancelBtn = btn('Cancel', { cls: 'sm', onclick: () => { ac.abort(); } });
    taskBox.replaceChildren(h('div', { class: 'source-status' }, h('div', { class: 'grow' }, h('div', { class: 'row between nowrap' }, h('span', { class: 'ellipsis' }, title), cancelBtn), bar, h('div', { style: { marginTop: '8px' } }, info))));
    const t0 = Date.now();
    try {
      const { project, job } = await uploadFile(file, {
        signal: ac.signal, chunkBytes: lim && lim.uploadChunkBytes,
        onProgress: ({ loaded, total, speed, resumed }) => {
          bar.set(loaded / total);
          const eta = speed > 0 ? (total - loaded) / speed : 0;
          info.textContent = Math.round(loaded / total * 100) + '% · ' + fmtBytes(loaded) + ' of ' + fmtBytes(total) + (speed ? ' · ' + fmtBytes(speed) + '/s' : '') + (eta > 1 ? ' · ' + fmtLong(eta) + ' left' : '') + (resumed ? ' · resumed' : '');
        }
      });
      title.textContent = 'Reading your video'; bar.set(null); info.textContent = 'Checking the file, reading its length and size …';
      await pollJob(job.id, (j) => { info.textContent = j.message || ''; }, { signal: ac.signal });
      addHistory({ kind: 'upload', ok: true, projectId: project.id, name: project.name, message: 'Uploaded ' + fmtBytes(file.size), ms: Date.now() - t0 });
      navigate('#/project/' + project.id + '/generate');
    } catch (e) {
      if (isAbort(e)) { taskBox.replaceChildren(); toast('Upload paused. Choose the same file to continue.'); }
      else {
        addHistory({ kind: 'upload', ok: false, name: file.name, message: e.message, ms: Date.now() - t0 });
        taskBox.replaceChildren(h('div', { style: { marginTop: '12px' } }, notice('bad', h('b', null, 'The upload did not finish. '), e.message, h('div', { class: 'row' }, btn('Retry', { cls: 'sm primary', onclick: () => { taskBox.replaceChildren(); startUpload(file); } }), btn('Dismiss', { cls: 'sm', onclick: () => taskBox.replaceChildren() })))));
      }
    } finally { setBusy(false); renderPending(); }
  }

  function setBusy(b) { busy = b; input.disabled = b; addBtn.disabled = b; drop.disabled = b; }

  /* ---------- layout ---------- */
  if (mode !== 'upload') root.append(linkPart);
  if (mode === 'both') root.append(h('div', { class: 'or' }, 'or'));
  if (mode !== 'link') root.append(pendingBox, uploadPart);
  root.append(taskBox);
  if (mode === 'link') root.append(h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Works with direct links to video files (…/video.mp4) and Dropbox share links. Video-site pages (YouTube, TikTok …) are not video files — upload those instead.'));
  renderPending();

  return { el: root, destroy() { if (ac) ac.abort(); if (inspectAc) inspectAc.abort(); check.cancel(); }, focus() { input.focus(); } };
}
