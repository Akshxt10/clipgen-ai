/* backend connection state (address, token, capabilities) shared by all screens */
import { getSettings } from './state.js';
import { health, capabilities, setBaseOverride, base, hasBase, ApiError } from './api.js';
import { DEFAULT_API_BASE } from '../config.js';

export const conn = { status: 'checking', caps: null, error: null, base: '' };   // unset | checking | ok | down | auth
const listeners = new Set();
export const onConn = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(conn); } catch (_) { /* ignore */ } });

/* no address typed in Settings: use config.js, else the page's own origin when the backend serves this app */
export async function resolveBase() {
  if (getSettings().apiBase) { setBaseOverride(null); return; }
  if (DEFAULT_API_BASE) { setBaseOverride(DEFAULT_API_BASE); return; }
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    const j = r.ok ? await r.json() : null;
    setBaseOverride(j && j.name === 'clipgen-ai-backend' ? '' : null);
  } catch (_) { setBaseOverride(null); }
}

export async function connect() {
  await resolveBase();
  conn.base = base();
  if (!hasBase()) { conn.status = 'unset'; conn.caps = null; conn.error = null; emit(); return conn; }
  conn.status = 'checking'; emit();
  try {
    const hl = await health();
    if (!hl || hl.name !== 'clipgen-ai-backend') throw new ApiError(0, 'not-backend', 'That address answered, but it is not a ClipGen AI backend.');
    conn.caps = await capabilities();
    conn.status = 'ok'; conn.error = null;
  } catch (e) {
    conn.caps = null; conn.error = e;
    conn.status = e instanceof ApiError && e.status === 401 ? 'auth' : 'down';
  }
  emit();
  return conn;
}
export const init = connect;
export function whenSettled() {
  if (conn.status !== 'checking') return Promise.resolve(conn);
  return new Promise((res) => { const off = onConn((c) => { if (c.status !== 'checking') { off(); res(c); } }); });
}
export const ready = () => conn.status === 'ok';
