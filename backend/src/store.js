/*
  ClipGen AI backend · project storage on local disk (DATA_DIR), with retention.

  data/projects/<id>/
      meta.json        project record (source, media info, status)
      source.<ext>     the video (uploaded or fetched)
      audio.wav        16 kHz mono audio used for transcription + loudness analysis
      transcript.json  words with timestamps (when transcription ran)
      analysis.json    analysis result: settings, signals, candidate pool, selected clips
      thumbs/          thumbnails
      renders/         rendered clips
  data/uploads/<id>/   partial chunked uploads
  Everything older than RETENTION_HOURS (since last use) is deleted by sweep().
*/
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ID_RE, ApiError, newId, readJson, writeJsonAtomic, dirSize, notFound } from './util.js';

export class Store {
  constructor(cfg) {
    this.cfg = cfg;
    this.root = path.join(cfg.dataDir, 'projects');
    this.uploads = path.join(cfg.dataDir, 'uploads');
    this.cache = new Map();            // id -> project (write-through)
  }
  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    await fsp.mkdir(this.uploads, { recursive: true });
    /* anything that was mid-flight when the server stopped cannot continue: mark it so the UI can offer a retry */
    for (const id of await this.ids()) {
      const p = await this.get(id, { quiet: true });
      if (p && (p.status === 'ingesting' || p.status === 'analyzing' || p.status === 'probing')) {
        p.status = p.status === 'analyzing' ? 'ready' : 'error';
        p.error = p.status === 'ready' ? null : { code: 'interrupted', message: 'The server restarted while this video was being prepared. Please add it again.' };
        if (p.status === 'ready') p.notice = 'Analysis was interrupted by a server restart. Run it again.';
        await this.save(p);
      }
    }
  }
  dir(id) {
    if (!ID_RE.test(id)) throw notFound('Project');
    return path.join(this.root, id);
  }
  uploadDir(id) {
    if (!ID_RE.test(id)) throw notFound('Upload');
    return path.join(this.uploads, id);
  }
  async ids() {
    try { return (await fsp.readdir(this.root)).filter((n) => ID_RE.test(n)); } catch (_) { return []; }
  }
  async create(initial) {
    const ids = await this.ids();
    if (ids.length >= this.cfg.limits.maxProjects) await this.sweep({ force: true });
    if ((await this.ids()).length >= this.cfg.limits.maxProjects) throw new ApiError(507, 'storage-full', 'This server is holding the maximum number of videos (' + this.cfg.limits.maxProjects + '). Delete one first, or wait for old ones to expire.');
    const id = newId('p');
    const now = Date.now();
    const p = Object.assign({ id, createdAt: now, updatedAt: now, lastAccess: now, status: 'ingesting', error: null, media: null, source: {}, hasTranscript: false, hasAnalysis: false }, initial);
    await fsp.mkdir(path.join(this.dir(id), 'thumbs'), { recursive: true });
    await fsp.mkdir(path.join(this.dir(id), 'renders'), { recursive: true });
    await this.save(p);
    return p;
  }
  async get(id, { quiet } = {}) {
    if (this.cache.has(id)) return this.cache.get(id);
    const p = await readJson(path.join(this.dir(id), 'meta.json'), null);
    if (!p) { if (quiet) return null; throw notFound('Project'); }
    this.cache.set(id, p);
    return p;
  }
  async save(p) {
    p.updatedAt = Date.now();
    this.cache.set(p.id, p);
    await writeJsonAtomic(path.join(this.dir(p.id), 'meta.json'), p);
    return p;
  }
  async touch(id) { const p = await this.get(id); p.lastAccess = Date.now(); this.cache.set(id, p); return p; }
  async list() {
    const out = [];
    for (const id of await this.ids()) { const p = await this.get(id, { quiet: true }); if (p) out.push(p); }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
  async remove(id) {
    const d = this.dir(id);
    this.cache.delete(id);
    await fsp.rm(d, { recursive: true, force: true });
  }
  file(id, name) { return path.join(this.dir(id), name); }
  async sourcePath(id) {
    const p = await this.get(id);
    if (!p.source || !p.source.file) throw new ApiError(409, 'no-source', 'This project has no video file yet.');
    return path.join(this.dir(id), p.source.file);
  }
  async usedBytes() { return dirSize(this.cfg.dataDir); }
  async assertRoomFor(bytes) {
    const used = await this.usedBytes();
    if (used + bytes > this.cfg.limits.maxDiskBytes) throw new ApiError(507, 'storage-full', 'The server does not have enough free space for this video (' + Math.round(bytes / 1048576) + ' MB). Delete an older video or try a smaller file.');
  }
  /* delete projects that were not used for RETENTION_HOURS, and stale partial uploads */
  async sweep({ force } = {}) {
    const now = Date.now(), ttl = this.cfg.limits.ttlMs;
    let removed = 0;
    const list = await this.list();
    const busy = (p) => p.status === 'ingesting' || p.status === 'analyzing' || p.status === 'probing' || (this.isBusy && this.isBusy(p.id));
    for (const p of list) if (!busy(p) && now - (p.lastAccess || p.createdAt) > ttl) { await this.remove(p.id); removed++; }
    if (force) {   // make room: drop the least recently used idle project
      const left = (await this.list()).filter((p) => !busy(p)).sort((a, b) => a.lastAccess - b.lastAccess);
      if (left.length && (await this.ids()).length >= this.cfg.limits.maxProjects) { await this.remove(left[0].id); removed++; }
    }
    try {
      for (const n of await fsp.readdir(this.uploads)) {
        const d = path.join(this.uploads, n);
        const st = await fsp.stat(d);
        if (now - st.mtimeMs > Math.min(ttl, 6 * 3600 * 1000)) await fsp.rm(d, { recursive: true, force: true });
      }
    } catch (_) { /* ignore */ }
    return removed;
  }
}
