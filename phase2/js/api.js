/* ClipGen AI · client for the backend API (fetch + XHR for upload progress). Nothing here is simulated. */
import { getSettings, getPendingUpload, setPendingUpload, clearPendingUpload } from './state.js';
import { sleep } from './util.js';

export class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.extra = extra || {}; }
}

let override = null;                       // set by conn.js once same-origin / default base has been resolved
export const setBaseOverride = (b) => { override = b; };
export const base = () => ((getSettings().apiBase || override || '').replace(/\/+$/, ''));
export const hasBase = () => !!base() || override === '';
const authHeaders = () => { const t = getSettings().token; return t ? { Authorization: 'Bearer ' + t } : {}; };

function netError(b) {
  return new ApiError(0, 'network', 'Could not reach the ClipGen backend' + (b ? ' at ' + b.replace(/^https?:\/\//, '') : '') + '. Free hosts go to sleep when idle — wait up to a minute and try again, or check the address in Settings.');
}

export async function request(method, path, { body, signal, noAuth, baseUrl } = {}) {
  const b = baseUrl !== undefined ? baseUrl : base();
  let res;
  try {
    res = await fetch(b + path, {
      method, signal, headers: Object.assign({}, noAuth ? {} : authHeaders(), body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store'
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw netError(b);
  }
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch (_) { /* not json */ }
  if (!res.ok) {
    const er = (data && data.error) || {};
    const extra = Object.assign({}, er); delete extra.code; delete extra.message;
    throw new ApiError(res.status, er.code || 'http-' + res.status, er.message || (res.status === 404 && !data ? 'The backend address does not look right (page not found).' : 'The server answered with an error (' + res.status + ').'), extra);
  }
  return data;
}

export const health = (baseUrl) => request('GET', '/api/health', { noAuth: true, baseUrl });
export const capabilities = () => request('GET', '/api/capabilities');
export const inspectLink = (url, signal) => request('POST', '/api/sources/inspect', { body: { url }, signal });
export const addByLink = (url) => request('POST', '/api/projects/url', { body: { url } });
export const listProjects = () => request('GET', '/api/projects');
export const getProject = (id) => request('GET', '/api/projects/' + id);
export const deleteProject = (id) => request('DELETE', '/api/projects/' + id);
export const analyze = (id, settings) => request('POST', '/api/projects/' + id + '/analyze', { body: { settings } });
export const patchClip = (id, cid, body) => request('PATCH', '/api/projects/' + id + '/clips/' + cid, { body });
export const regenerateClip = (id, cid) => request('POST', '/api/projects/' + id + '/clips/' + cid + '/regenerate', { body: {} });
export const renderClip = (id, cid, body) => request('POST', '/api/projects/' + id + '/clips/' + cid + '/render', { body: body || {} });
export const renderAll = (id, clipIds, options) => request('POST', '/api/projects/' + id + '/render-all', { body: { clipIds, options } });
export const zipLink = (id, clipIds) => request('POST', '/api/projects/' + id + '/zip-link', { body: { clipIds: clipIds || [] } });
export const words = (id, start, end) => request('GET', '/api/projects/' + id + '/words?start=' + start + '&end=' + end);
export const getJob = (id) => request('GET', '/api/jobs/' + id);
export const listJobs = () => request('GET', '/api/jobs');
export const cancelJob = (id) => request('POST', '/api/jobs/' + id + '/cancel', { body: {} });

/* absolute URL for a signed media path returned by the backend */
export const mediaUrl = (rel) => (rel ? (/^https?:/.test(rel) ? rel : base() + rel) : '');

/* follow a background job until it ends; transient network errors are retried */
export async function pollJob(jobId, onUpdate, { signal } = {}) {
  let fails = 0, delay = 600;
  for (;;) {
    if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    try {
      const { job } = await getJob(jobId);
      fails = 0;
      if (onUpdate) onUpdate(job);
      if (job.state === 'done') return job;
      if (job.state === 'error') throw new ApiError(422, job.error && job.error.code || 'failed', job.error && job.error.message || 'The job failed.');
      if (job.state === 'cancelled') throw new ApiError(0, 'cancelled', 'Cancelled.');
      delay = job.state === 'queued' ? 1200 : 700;
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e instanceof ApiError && e.code === 'network') { if (++fails > 20) throw e; delay = Math.min(4000, 800 * fails); }
      else if (e instanceof ApiError && e.code === 'job-not-found') throw new ApiError(404, 'job-lost', 'The server restarted and lost track of this job. Open the video again to see its state.');
      else throw e;
    }
    await sleep(delay, signal);
  }
}

/* ---------------- chunked, resumable upload ---------------- */
function putChunk(uploadId, offset, blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', base() + '/api/uploads/' + uploadId + '?offset=' + offset);
    const t = getSettings().token;
    if (t) xhr.setRequestHeader('Authorization', 'Bearer ' + t);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => {
      let data = null; try { data = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const er = (data && data.error) || {};
      const extra = Object.assign({}, er); delete extra.code; delete extra.message;
      reject(new ApiError(xhr.status, er.code || 'http-' + xhr.status, er.message || 'Upload failed (' + xhr.status + ').', extra));
    };
    xhr.onerror = () => reject(netError(base()));
    xhr.ontimeout = () => reject(netError(base()));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/*
  uploadFile(file, {onProgress({loaded,total,speed,resumed}), signal}) → {project, job}
  If an earlier upload of the same file (name + size + date) was interrupted, it continues where it stopped.
*/
export async function uploadFile(file, { onProgress, signal, chunkBytes } = {}) {
  const sig = { name: file.name, size: file.size, modified: file.lastModified };
  let uploadId = null, received = 0, chunk = chunkBytes || 8 * 1048576, resumed = false;
  const pend = getPendingUpload();
  if (pend && pend.name === sig.name && pend.size === sig.size && pend.modified === sig.modified) {
    try { const r = await request('GET', '/api/uploads/' + pend.uploadId, { signal }); uploadId = pend.uploadId; received = r.received; chunk = pend.chunkBytes || chunk; resumed = received > 0; }
    catch (e) { if (e && e.name === 'AbortError') throw e; if (!(e instanceof ApiError) || e.code === 'network') throw e; clearPendingUpload(); }
  }
  if (!uploadId) {
    const r = await request('POST', '/api/uploads', { body: { name: file.name, size: file.size }, signal });
    uploadId = r.uploadId; chunk = r.chunkBytes || chunk; received = 0;
    setPendingUpload(Object.assign({ uploadId, chunkBytes: chunk }, sig));
  }
  const t0 = Date.now(); const startBytes = received; let lastReport = 0;
  const report = (loaded) => {
    const now = Date.now();
    if (now - lastReport < 150 && loaded < file.size) return;
    lastReport = now;
    const secs = Math.max(0.5, (now - t0) / 1000);
    onProgress && onProgress({ loaded, total: file.size, speed: Math.max(0, (loaded - startBytes) / secs), resumed });
  };
  report(received);
  let attempts = 0;
  while (received < file.size) {
    const end = Math.min(file.size, received + chunk);
    try {
      const r = await putChunk(uploadId, received, file.slice(received, end), (l) => report(received + l), signal);
      received = r.received; attempts = 0; report(received);
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e instanceof ApiError && e.code === 'offset-mismatch' && typeof e.extra.received === 'number') { received = e.extra.received; continue; }
      const retryable = e instanceof ApiError && (e.code === 'network' || e.code === 'upload-interrupted' || e.status >= 500 || e.code === 'upload-busy');
      if (!retryable || ++attempts > 5) throw e;
      await sleep(Math.min(8000, 800 * 2 ** attempts), signal);
      try { const r = await request('GET', '/api/uploads/' + uploadId, { signal }); received = r.received; } catch (e2) { if (e2 && e2.name === 'AbortError') throw e2; }
    }
  }
  const done = await request('POST', '/api/uploads/' + uploadId + '/complete', { body: {}, signal });
  clearPendingUpload();
  return done;
}
export async function abandonUpload() {
  const p = getPendingUpload();
  clearPendingUpload();
  if (p) { try { await request('DELETE', '/api/uploads/' + p.uploadId); } catch (_) { /* ignore */ } }
}
