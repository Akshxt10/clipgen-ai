/*
  ClipGen AI · Phase 2 · local project storage (IndexedDB).

  Phase 2 uses its OWN database, "clipgen-ai-p2", so it can never clash with the Phase 1 database "clipgen-ai"
  (an IndexedDB version bump in one phase would otherwise lock the other phase out).
  Phase 1 projects stay in Phase 1; they are not shown here and are never touched.

  Database "clipgen-ai-p2", version 2, five object stores (heavy data is kept apart so lists stay fast):
    projects  { id, name, createdAt, updatedAt, schema:3,
                source:{kind:'upload'} | {kind:'youtube', videoId, linkKind, startSec, url, addedAt},   (a link, never media)
                authorization:null
                   | {method:'self-declared', confirmed, at, statement, version}      the user's own claim — NOT verified
                   | {method:'creator-grant', creatorId, displayName, keyId, verifiedAt, identity,
                      grant:{videoId, source:{url,sha256,size,type,name}, terms}, fileVerified}  signed by a verified creator
                video:{name,size,type,lastModified,duration,width,height},   (the user's own file; empty until chosen)
                hasBlob, thumb(Blob|null), clipCount, analysisStatus, analysisSummary, analysisError }
    clips     { id, projectId, start, end, label, source('manual'|'loudness'), createdAt }      index: projectId
    blobs     { projectId, blob(File/Blob), name, size, type, savedAt }                          the video itself (optional)
    analysis  { projectId, version, windowSec, rmsDb(Float32Array), peakDb(Float32Array), stats, moments, ... }
    authlog   { id, projectId, at, event, code, creatorId, keyId, detail }       index: projectId   (how a source was authorized)

  Upgrade 1 → 2 (runs once, inside IndexedDB's own upgrade transaction, so it is all-or-nothing):
    - adds the "authlog" store
    - tags every existing authorization (the old checkbox) as method:'self-declared' and sets schema:3
    - never deletes or rewrites projects, clips, saved videos or analysis

  If IndexedDB is unavailable or broken (some private modes), everything keeps working in memory for the
  current tab and the app shows a clear "not saving" warning (db.persistent === false).
  Only this file knows about IndexedDB, so later phases extend the schema in one place (see ARCHITECTURE.md:
  transcripts / scores arrive as new stores through a normal version-2 upgrade of THIS database).
*/

const DB_NAME = 'clipgen-ai-p2';
const DB_VERSION = 2;
const STORE_NAMES = ['projects', 'clips', 'blobs', 'analysis', 'authlog'];
const KEY_PATH = { projects: 'id', clips: 'id', blobs: 'projectId', analysis: 'projectId', authlog: 'id' };

/* Brings a project record of any older schema up to the current shape (used by the upgrade AND on every read). */
export function normalizeProject(p) {
  if (!p) return p;
  if (p.authorization && !p.authorization.method) p.authorization = Object.assign({ method: 'self-declared' }, p.authorization);
  if (p.schema !== undefined && p.schema < 3) p.schema = 3;
  return p;
}

const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
});
const txDone = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
});

/* ---------------- IndexedDB backend ---------------- */
class IdbBackend {
  constructor() { this.db = null; }

  open() {
    return new Promise((resolve, reject) => {
      let settled = false, blocked = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error(blocked ? 'Another ClipGen tab is open with an older version — close it and reload' : 'IndexedDB did not respond (timed out)')); }
      }, 8000);
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { clearTimeout(timer); settled = true; reject(e); return; }

      req.onblocked = () => { blocked = true; };
      req.onupgradeneeded = (ev) => {
        const d = req.result;
        if (!d.objectStoreNames.contains('projects')) {
          const s = d.createObjectStore('projects', { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
        if (!d.objectStoreNames.contains('clips')) {
          const s = d.createObjectStore('clips', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
        }
        if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'projectId' });
        if (!d.objectStoreNames.contains('analysis')) d.createObjectStore('analysis', { keyPath: 'projectId' });
        if (!d.objectStoreNames.contains('authlog')) {
          const s = d.createObjectStore('authlog', { keyPath: 'id' });
          s.createIndex('projectId', 'projectId');
        }
        if (ev.oldVersion >= 1 && ev.oldVersion < 2) {                 // migrate existing projects in place (same transaction)
          const cur = req.transaction.objectStore('projects').openCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return;
            c.update(normalizeProject(c.value));
            c.continue();
          };
        }
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (settled) { try { req.result.close(); } catch (_) { /* ignore */ } return; }
        settled = true;
        this.db = req.result;
        this.db.onversionchange = () => { try { this.db.close(); } catch (_) { /* ignore */ } this.db = null; };
        this.db.onclose = () => { this.db = null; };
        resolve();
      };
      req.onerror = () => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(req.error || new Error('Could not open IndexedDB'));
      };
    });
  }

  /** Runs fn(...stores) inside one transaction. fn may only issue IDB requests. Retries once if Safari dropped the connection. */
  async run(storeNames, mode, fn) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (!this.db) await this.open();
        const tx = this.db.transaction(storeNames, mode);
        const done = txDone(tx);
        done.catch(() => { /* surfaced through `await done` below */ });
        const out = await fn(...storeNames.map((n) => tx.objectStore(n)));
        await done;
        return out;
      } catch (e) {
        const lost = e && (e.name === 'InvalidStateError' || /connection to indexed database server lost|database connection is closing/i.test(e.message || ''));
        if (attempt === 0 && lost) { this.db = null; continue; }
        throw e;
      }
    }
  }

  get(store, key) { return this.run([store], 'readonly', (s) => reqP(s.get(key))); }
  put(store, value) { return this.run([store], 'readwrite', (s) => reqP(s.put(value))); }
  del(store, key) { return this.run([store], 'readwrite', (s) => reqP(s.delete(key))); }
  getAll(store) { return this.run([store], 'readonly', (s) => reqP(s.getAll())); }
  getAllByIndex(store, index, key) { return this.run([store], 'readonly', (s) => reqP(s.index(index).getAll(key))); }
  hasKey(store, key) { return this.run([store], 'readonly', (s) => reqP(s.count(key))).then((n) => n > 0); }
  /** items: [{ store, key }] deleted in ONE transaction */
  batchDelete(items) {
    const names = Array.from(new Set(items.map((i) => i.store)));
    if (!names.length) return Promise.resolve();
    return this.run(names, 'readwrite', (...stores) => {
      const byName = {};
      names.forEach((n, i) => { byName[n] = stores[i]; });
      items.forEach((i) => byName[i.store].delete(i.key));
    });
  }
  clearAll() { return this.run(STORE_NAMES, 'readwrite', (...stores) => { stores.forEach((s) => s.clear()); }); }
}

/* ---------------- in-memory fallback ---------------- */
class MemoryBackend {
  constructor() { this.m = {}; STORE_NAMES.forEach((n) => { this.m[n] = new Map(); }); }
  async get(store, key) { return this.m[store].get(key); }
  async put(store, value) { this.m[store].set(value[KEY_PATH[store]], value); }
  async del(store, key) { this.m[store].delete(key); }
  async getAll(store) { return Array.from(this.m[store].values()); }
  async getAllByIndex(store, index, key) { return Array.from(this.m[store].values()).filter((v) => v[index] === key); }
  async hasKey(store, key) { return this.m[store].has(key); }
  async batchDelete(items) { items.forEach((i) => this.m[i.store].delete(i.key)); }
  async clearAll() { STORE_NAMES.forEach((n) => this.m[n].clear()); }
}

/* ---------------- public API ---------------- */
export const db = {
  backend: null,
  persistent: false,
  reason: '',

  info() { return { persistent: this.persistent, reason: this.reason }; },

  async init() {
    if (this.backend) return this.info();
    try {
      if (typeof indexedDB === 'undefined' || !indexedDB) throw new Error('IndexedDB is not available in this browser');
      const b = new IdbBackend();
      await b.open();
      // write + delete a probe record: catches private-mode / quota quirks before the user imports anything
      await b.put('analysis', { projectId: '__probe__', t: Date.now() });
      await b.del('analysis', '__probe__');
      this.backend = b;
      this.persistent = true;
    } catch (e) {
      this.backend = new MemoryBackend();
      this.persistent = false;
      this.reason = (e && e.message) || String(e);
    }
    return this.info();
  },

  /* projects */
  async listProjects() {
    const all = await this.backend.getAll('projects');
    return all.map(normalizeProject).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },
  async getProject(id) { return normalizeProject(await this.backend.get('projects', id)); },
  async saveProject(p) { p.updatedAt = Date.now(); await this.backend.put('projects', p); return p; },
  async deleteProject(id) {
    const clips = await this.backend.getAllByIndex('clips', 'projectId', id);
    const items = clips.map((c) => ({ store: 'clips', key: c.id }));
    const logs = await this.backend.getAllByIndex('authlog', 'projectId', id);
    logs.forEach((l) => items.push({ store: 'authlog', key: l.id }));
    items.push({ store: 'projects', key: id }, { store: 'blobs', key: id }, { store: 'analysis', key: id });
    await this.backend.batchDelete(items);
  },

  /* clips */
  async listClips(projectId) {
    const all = await this.backend.getAllByIndex('clips', 'projectId', projectId);
    return all.sort((a, b) => a.start - b.start || a.createdAt - b.createdAt);
  },
  saveClip(c) { return this.backend.put('clips', c); },
  deleteClip(id) { return this.backend.del('clips', id); },

  /* the video file itself (optional copy) */
  async saveBlob(projectId, blob) {
    await this.backend.put('blobs', { projectId, blob, name: blob.name || '', size: blob.size, type: blob.type || '', savedAt: Date.now() });
  },
  async getBlob(projectId) { const r = await this.backend.get('blobs', projectId); return r ? r.blob : null; },
  hasBlob(projectId) { return this.backend.hasKey('blobs', projectId); },
  deleteBlob(projectId) { return this.backend.del('blobs', projectId); },

  /* audio analysis results */
  saveAnalysis(projectId, record) { return this.backend.put('analysis', Object.assign({}, record, { projectId })); },
  getAnalysis(projectId) { return this.backend.get('analysis', projectId); },
  deleteAnalysis(projectId) { return this.backend.del('analysis', projectId); },

  /* authorization history: how each source was approved (newest first) */
  logAuth(projectId, entry) {
    const rec = Object.assign({ detail: '' }, entry, { id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), projectId, at: Date.now() });
    return this.backend.put('authlog', rec);
  },
  async listAuthLog(projectId) {
    const all = await this.backend.getAllByIndex('authlog', 'projectId', projectId);
    return all.sort((a, b) => b.at - a.at);
  },

  /* storage info */
  async storageEstimate() {
    const out = { usage: null, quota: null, persisted: null };
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (_) { /* ignore */ }
    try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (_) { /* ignore */ }
    return out;
  },
  async requestPersist() {
    try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (_) { /* ignore */ }
    return false;
  },
  clearAll() { return this.backend.clearAll(); }
};
