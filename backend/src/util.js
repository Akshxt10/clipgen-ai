/* small shared helpers (no dependencies) */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.extra = extra || null; }
}
export const bad = (code, msg, extra) => new ApiError(400, code, msg, extra);
export const notFound = (what) => new ApiError(404, 'not-found', (what || 'Item') + ' not found.');

export const newId = (prefix) => prefix + '_' + crypto.randomBytes(9).toString('base64url');
export const ID_RE = /^[a-z]{1,3}_[A-Za-z0-9_-]{8,24}$/;
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function writeJsonAtomic(file, obj) {
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj));
  await fsp.rename(tmp, file);
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch (e) { if (fallback !== undefined) return fallback; throw e; }
}
export async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else { try { total += (await fsp.stat(p)).size; } catch (_) { /* ignore */ } }
  }
  return total;
}
export const exists = (p) => fs.existsSync(p);

/* a safe download filename: letters, numbers, dash, underscore, dot, space */
export function safeName(name, fallback) {
  const base = String(name || '').replace(/[\\/]+/g, ' ').replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+/, '').trim().slice(0, 80);
  return base || fallback || 'file';
}
export function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

/* HMAC-signed, expiring media links so the access token never has to appear in a URL */
export function signUrlPart(secret, pathname, exp) {
  return crypto.createHmac('sha256', secret).update(pathname + '|' + exp).digest('base64url').slice(0, 32);
}
export function verifySig(secret, pathname, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const want = signUrlPart(secret, pathname, exp);
  const a = Buffer.from(want), b = Buffer.from(String(sig));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
