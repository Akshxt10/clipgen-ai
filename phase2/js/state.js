/* settings + processing history, persisted in this browser (localStorage, with an in-memory fallback) */
const SETTINGS_KEY = 'clipgen.p2.settings.v3';
const HISTORY_KEY = 'clipgen.p2.history.v1';
const PENDING_KEY = 'clipgen.p2.upload.v1';

const mem = {};
function read(key, fallback) {
  try { const v = localStorage.getItem(key); if (v) return JSON.parse(v); } catch (_) { /* private mode etc. */ }
  return mem[key] !== undefined ? mem[key] : fallback;
}
function write(key, value) {
  mem[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
}

export const DEFAULTS = {
  apiBase: '',
  token: '',
  gen: { platform: 'shorts', numClips: 5, minDuration: 20, maxDuration: 58, aspect: '9:16', captionStyle: 'pop', captions: true, hook: 'balanced', language: 'auto', intensity: 'balanced', reframe: 'smart', keywords: '' }
};

let settings = null;
export function getSettings() {
  if (!settings) {
    const s = read(SETTINGS_KEY, {});
    settings = { apiBase: s.apiBase || '', token: s.token || '', gen: Object.assign({}, DEFAULTS.gen, s.gen || {}) };
  }
  return settings;
}
export function saveSettings(patch) {
  const s = getSettings();
  if (patch.apiBase !== undefined) s.apiBase = patch.apiBase;
  if (patch.token !== undefined) s.token = patch.token;
  if (patch.gen) s.gen = Object.assign({}, s.gen, patch.gen);
  write(SETTINGS_KEY, s);
  return s;
}

/* ---- processing history ---- */
export function getHistory() { return read(HISTORY_KEY, []); }
export function addHistory(entry) {
  const list = getHistory();
  list.unshift(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), ts: Date.now() }, entry));
  write(HISTORY_KEY, list.slice(0, 200));
}
export function clearHistory() { write(HISTORY_KEY, []); }

/* ---- an upload that was interrupted (page closed, connection lost) can be resumed with the same file ---- */
export function getPendingUpload() { return read(PENDING_KEY, null); }
export function setPendingUpload(p) { write(PENDING_KEY, p); }
export function clearPendingUpload() { write(PENDING_KEY, null); try { localStorage.removeItem(PENDING_KEY); } catch (_) { /* ignore */ } }
