/*
  ClipGen AI · Phase 2 · creator authorization — the trust engine (pure logic; network is injected).

  THE IDEA
    YouTube does not allow anyone to download its videos (see ARCHITECTURE.md), and a creator saying "yes" cannot
    change that. So ClipGen never gets video from YouTube. Instead, a creator who WANTS to be clipped:
      1. registers a signing key with ClipGen          →  registry/creators.json   (maintainer verifies the channel)
      2. publishes a signed manifest on their own host →  video ID → original file URL + SHA-256 + terms
    and ClipGen checks all of this before it will touch anything.

  "VERIFIED" IS ONLY SHOWN WHEN EVERY CHECK PASSES:
      registry loaded · creator listed · status "verified" (set by the ClipGen maintainer) · manifest fetched ·
      signature valid for the registered key · key ID matches · not expired · this video listed · clipping allowed ·
      (YouTube's author matches the registered channel — or, if YouTube could not be asked, labelled "unconfirmed")
    and later, for the file itself:  size and SHA-256 equal the signed values.
  Nothing here reads a description, a comment, a checkbox or any other public statement as permission.

  A registry entry whose status is "pending" or "revoked", or whose data is malformed, can never produce "verified".
*/
import { canonicalize, thumbprint, verifySignature } from './crypto-utils.js';

export const REGISTRY_FORMAT = 'clipgen-registry/1';
export const MANIFEST_FORMAT = 'clipgen-manifest/1';
export const SIG_ALG = 'ECDSA-P256-SHA256';
export const REGISTRY_URL = 'registry/creators.json';
export const MAX_SCAN = 10;                       // fallback scan never fetches more than this many manifests
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64U_43 = /^[A-Za-z0-9_-]{43}$/;
const VIDEO_TYPES = ['video/mp4', 'video/quicktime'];
export const DEFAULT_TERMS = { clipping: true, captions: true, verticalExport: true, attributionRequired: false, attributionText: '', expiresAt: null };

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const parseDate = (s) => { if (typeof s !== 'string') return NaN; const t = Date.parse(s); return t; };

export function isAllowedUrl(u, allowLocalHttp) {
  let x;
  try { x = new URL(u); } catch (_) { return false; }
  if (x.username || x.password) return false;
  if (x.protocol === 'https:') return true;
  return !!allowLocalHttp && x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1');
}

/* ---------------- identifying a channel from a YouTube author URL / handle ---------------- */
export function channelRef(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const s = input.trim();
  if (s[0] === '@') return 'h:' + s.toLowerCase();
  let u;
  try { u = new URL(/^[a-z]+:/i.test(s) ? s : 'https://' + s); } catch (_) { return null; }
  if (!/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)) return null;
  const p = u.pathname.split('/').filter(Boolean);
  if (!p.length) return null;
  let first = p[0];
  try { first = decodeURIComponent(first); } catch (_) { /* keep raw */ }
  if (first[0] === '@') return 'h:' + first.toLowerCase();
  if (p[0] === 'channel' && p[1] && /^UC[A-Za-z0-9_-]{22}$/.test(p[1])) return 'c:' + p[1];
  if ((p[0] === 'c' || p[0] === 'user') && p[1]) return 'l:' + p[1].toLowerCase();
  return null;
}
function entryRefs(entry) {
  const refs = new Set();
  const c = entry.channel || {};
  if (c.handle) refs.add(channelRef(c.handle[0] === '@' ? c.handle : '@' + c.handle));
  if (c.channelId) refs.add('c:' + c.channelId);
  if (c.url) refs.add(channelRef(c.url));
  refs.delete(null);
  return refs;
}

/* ---------------- registry ---------------- */
/* Validates every entry on its own: one bad entry is rejected (and listed), the others still work. */
export async function validateRegistry(raw, opts) {
  const o = opts || {};
  const out = { ok: false, creators: [], rejected: [], updatedAt: null, message: '' };
  if (!isObj(raw) || raw.format !== REGISTRY_FORMAT || !Array.isArray(raw.creators)) {
    out.message = 'The creator registry file is not in the expected format.';
    return out;
  }
  out.ok = true;
  out.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  const seen = new Set();
  for (const e of raw.creators) {
    const id = isObj(e) && typeof e.id === 'string' ? e.id : '(no id)';
    const reject = (reason) => out.rejected.push({ id, reason });
    if (!isObj(e)) { reject('not an object'); continue; }
    if (!ID_RE.test(e.id)) { reject('bad id'); continue; }
    if (seen.has(e.id)) { reject('duplicate id'); continue; }
    if (typeof e.displayName !== 'string' || !e.displayName.trim() || e.displayName.length > 80) { reject('bad displayName'); continue; }
    if (!['verified', 'pending', 'revoked'].includes(e.status)) { reject('bad status'); continue; }
    if (!isObj(e.channel) || !entryRefs(e).size) { reject('no usable channel identifier'); continue; }
    if (e.channel.channelId !== undefined && !/^UC[A-Za-z0-9_-]{22}$/.test(e.channel.channelId)) { reject('bad channelId'); continue; }
    const k = e.publicKey;
    if (!isObj(k) || k.kty !== 'EC' || k.crv !== 'P-256' || !B64U_43.test(k.x || '') || !B64U_43.test(k.y || '') || 'd' in k) { reject('bad public key (or it contains a private part)'); continue; }
    let tp;
    try { tp = thumbprint(k); } catch (_) { reject('bad public key'); continue; }
    if (e.keyId !== tp) { reject('keyId does not match the public key'); continue; }
    if (!isAllowedUrl(e.manifestUrl, o.allowLocalHttp)) { reject('manifestUrl must be https'); continue; }
    if (e.status === 'verified') {
      const v = e.verification;
      if (!isObj(v) || typeof v.method !== 'string' || !v.method || isNaN(parseDate(v.verifiedAt))) { reject('verified entry without verification details'); continue; }
    }
    seen.add(e.id);
    out.creators.push(e);
  }
  return out;
}

/* ---------------- manifest ---------------- */
function checkVideoEntry(v, allowLocalHttp) {
  if (!isObj(v) || !VIDEO_ID_RE.test(v.videoId || '')) return 'bad videoId';
  const s = v.source;
  if (!isObj(s) || !isAllowedUrl(s.url, allowLocalHttp)) return 'source.url must be https';
  if (!HEX64.test(s.sha256 || '')) return 'source.sha256 must be 64 hex characters';
  if (!Number.isInteger(s.size) || s.size < 1 || s.size > 200e9) return 'source.size must be a whole number of bytes';
  if (!VIDEO_TYPES.includes(s.type)) return 'source.type must be video/mp4 or video/quicktime';
  if (typeof s.name !== 'string' || !/^[^\\/\0]{1,200}$/.test(s.name) || !/\.(mp4|mov|m4v)$/i.test(s.name)) return 'source.name must be an .mp4/.mov file name';
  if (v.terms !== undefined) {
    if (!isObj(v.terms)) return 'terms must be an object';
    for (const k of ['clipping', 'captions', 'verticalExport', 'attributionRequired']) if (v.terms[k] !== undefined && typeof v.terms[k] !== 'boolean') return 'terms.' + k + ' must be true/false';
    if (v.terms.attributionText !== undefined && (typeof v.terms.attributionText !== 'string' || v.terms.attributionText.length > 300)) return 'terms.attributionText too long';
    if (v.terms.expiresAt != null && isNaN(parseDate(v.terms.expiresAt))) return 'terms.expiresAt is not a date';
  }
  return null;
}

/* Verifies a manifest against ONE registry entry. Never trusts anything in the manifest before the signature passes. */
export async function verifyManifest(manifest, entry, opts) {
  const o = opts || {};
  const now = o.now != null ? o.now : Date.now();
  const bad = (code, message) => ({ ok: false, code, message });
  if (!isObj(manifest) || manifest.format !== MANIFEST_FORMAT || !isObj(manifest.payload) || !isObj(manifest.signature)) return bad('manifest-invalid', 'The creator’s manifest is not in the expected format.');
  const sig = manifest.signature;
  if (sig.alg !== SIG_ALG || typeof sig.value !== 'string') return bad('manifest-invalid', 'The manifest uses an unsupported signature type.');
  if (sig.keyId !== entry.keyId) return bad('signature-invalid', 'The manifest was signed with a different key than the one registered for this creator.');
  let valid = false;
  try { valid = await verifySignature(entry.publicKey, manifest.payload, sig.value); } catch (_) { valid = false; }
  if (!valid) return bad('signature-invalid', 'The manifest’s signature is not valid for the registered key, so it was ignored.');
  const p = manifest.payload;
  if (p.creatorId !== entry.id) return bad('manifest-invalid', 'The manifest names a different creator than the registry entry.');
  const issued = parseDate(p.issuedAt);
  if (isNaN(issued) || issued > now + CLOCK_SKEW_MS) return bad('manifest-invalid', 'The manifest has an invalid issue date.');
  if (p.expiresAt != null) {
    const exp = parseDate(p.expiresAt);
    if (isNaN(exp)) return bad('manifest-invalid', 'The manifest has an invalid expiry date.');
    if (exp <= now) return bad('manifest-expired', 'The creator’s manifest has expired, so the creator needs to publish a new one.');
  }
  if (!Array.isArray(p.videos) || p.videos.length > 5000) return bad('manifest-invalid', 'The manifest has no valid video list.');
  for (const v of p.videos) { const why = checkVideoEntry(v, o.allowLocalHttp); if (why) return bad('manifest-invalid', 'A video entry in the manifest is invalid (' + why + ').'); }
  return { ok: true, payload: p };
}

/* Finds one video's grant inside an already-verified payload. */
export function findGrant(payload, videoId, now) {
  const v = payload.videos.find((x) => x.videoId === videoId);
  if (!v) return { ok: false, code: 'video-not-in-manifest', message: 'This creator is registered, but has not approved this video for clipping.' };
  const terms = Object.assign({}, DEFAULT_TERMS, v.terms || {});
  if (terms.expiresAt != null && parseDate(terms.expiresAt) <= (now != null ? now : Date.now())) return { ok: false, code: 'grant-expired', message: 'The creator’s approval for this video has expired.' };
  if (terms.clipping !== true) return { ok: false, code: 'terms-forbid', message: 'The creator’s terms for this video do not allow clipping.' };
  return { ok: true, grant: { videoId: v.videoId, source: v.source, terms } };
}

/* ---------------- fetching JSON safely ---------------- */
export async function fetchJsonLimited(url, opts) {
  const o = opts || {};
  const f = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, message: 'This browser cannot load the file.' };
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, o.timeoutMs || 10000);
  try {
    const res = await f(url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: ctl ? ctl.signal : undefined });
    if (!res.ok) return { ok: false, message: 'The server answered with HTTP ' + res.status + '.' };
    const text = await res.text();
    if (text.length > (o.maxChars || 1000000)) return { ok: false, message: 'The file is unexpectedly large.' };
    try { return { ok: true, json: JSON.parse(text) }; } catch (_) { return { ok: false, message: 'The file is not valid JSON.' }; }
  } catch (e) {
    return { ok: false, message: (e && e.name === 'AbortError') ? 'The server did not answer in time.' : 'The file could not be loaded (offline, or the host does not allow this website to read it — CORS).' };
  } finally { clearTimeout(timer); }
}

/* ---------------- the verdict ---------------- */
const ASK_CREATOR = 'Ask the creator to register with ClipGen AI (they can do it in Creator Studio) and approve this video.';
const OWN_FILE = 'Or provide the original file yourself — only if it is your own video, or the creator gave you the file and permission to use it.';

function result(status, code, message, extra) {
  return Object.assign({ status, code, message, need: [], creator: null, grant: null, identity: null, checks: [] }, extra || {});
}
const chk = (id, label, ok) => ({ id, label, ok });

/*
  evaluateYouTubeSource({ videoId, authorUrl, registry, fetchManifest, now, allowLocalHttp, hintCreatorId })
    authorUrl        the channel URL YouTube's oEmbed returned for this video, or null if YouTube could not be asked
    registry         result of validateRegistry()  (or null when the registry could not be loaded)
    fetchManifest    async (entry) → { ok:true, json } | { ok:false, message }
    hintCreatorId    re-check mode: the creator a stored authorization came from
  Returns { status:'verified'|'unverified'|'pending'|'revoked', code, message, need[], creator, grant, identity, checks[] }.
*/
export async function evaluateYouTubeSource(args) {
  const { videoId, authorUrl, registry, fetchManifest } = args;
  const now = args.now != null ? args.now : Date.now();
  const opts = { now, allowLocalHttp: args.allowLocalHttp };
  const checks = [];

  if (!registry || !registry.ok) {
    checks.push(chk('registry', 'Creator registry loaded', false));
    return result('unverified', 'registry-unavailable', 'The creator registry could not be loaded, so nothing can be verified right now.', { checks, need: ['Check your internet connection and try again.', OWN_FILE] });
  }
  checks.push(chk('registry', 'Creator registry loaded', true));

  const ref = authorUrl ? channelRef(authorUrl) : null;
  let candidates = ref ? registry.creators.filter((e) => entryRefs(e).has(ref)) : [];
  let viaAuthor = candidates.length > 0;
  if (!candidates.length && args.hintCreatorId) { candidates = registry.creators.filter((e) => e.id === args.hintCreatorId); viaAuthor = false; }

  /* A: YouTube told us who made it, but that channel is not registered */
  if (ref && !candidates.length) {
    checks.push(chk('creator', 'Creator is registered with ClipGen AI', false));
    return result('unverified', 'creator-not-registered', 'The creator of this video has not registered with ClipGen AI, so ClipGen cannot process it automatically.', { checks, need: [ASK_CREATOR, OWN_FILE] });
  }

  /* B: YouTube could not be asked → look for a verified creator whose signed manifest lists this very video */
  let identity = viaAuthor ? 'youtube-author-match' : 'unconfirmed';
  if (!candidates.length) {
    const verified = registry.creators.filter((e) => e.status === 'verified').slice(0, MAX_SCAN);
    checks.push(chk('author', 'YouTube confirms who made this video', null));
    for (const e of verified) {
      const m = await fetchManifest(e);
      if (!m.ok) continue;
      const vm = await verifyManifest(m.json, e, opts);
      if (!vm.ok) continue;
      const g = findGrant(vm.payload, videoId, now);
      if (g.ok) return finishVerified(e, g.grant, 'unconfirmed', checks);
    }
    return result('unverified', 'creator-unknown', 'ClipGen could not tell who made this video (YouTube did not answer) and no verified creator has approved it.', { checks, need: [ASK_CREATOR, OWN_FILE] });
  }

  /* C: candidate creator(s) found */
  let lastFail = null;
  for (const e of candidates) {
    const c = [...checks.filter((x) => x.id === 'registry'), chk('creator', 'Creator is registered with ClipGen AI', true)];
    const creatorInfo = { id: e.id, displayName: e.displayName, status: e.status, verifiedAt: e.verification ? e.verification.verifiedAt : null };
    if (e.status === 'revoked') {
      c.push(chk('verified', 'Creator verified by the ClipGen maintainer', false));
      lastFail = result('revoked', 'creator-revoked', e.displayName + ' has withdrawn approval, so this video cannot be processed.', { creator: creatorInfo, checks: c, need: ['Nothing can be done here: the creator has revoked their approval.'] });
      continue;
    }
    if (e.status === 'pending') {
      c.push(chk('verified', 'Creator verified by the ClipGen maintainer', false));
      lastFail = result('pending', 'creator-pending', e.displayName + ' has registered, but ClipGen has not verified that they control the channel yet. Nothing is processed automatically until they are verified.', { creator: creatorInfo, checks: c, need: ['Wait until the creator is verified.', OWN_FILE] });
      continue;
    }
    c.push(chk('verified', 'Creator verified by the ClipGen maintainer', true));
    if (viaAuthor) c.push(chk('author', 'YouTube’s author for this video matches the registered channel', true));
    const m = await fetchManifest(e);
    if (!m.ok) { c.push(chk('manifest', 'Creator’s signed manifest loaded', false)); lastFail = result('unverified', 'manifest-unavailable', 'The creator is verified, but their manifest could not be loaded: ' + m.message, { creator: creatorInfo, checks: c, need: ['Try again later. The creator’s file host may be down or may not allow cross-origin reads.', OWN_FILE] }); continue; }
    c.push(chk('manifest', 'Creator’s signed manifest loaded', true));
    const vm = await verifyManifest(m.json, e, opts);
    if (!vm.ok) { c.push(chk('signature', 'Manifest signature is valid for the registered key', false)); lastFail = result('unverified', vm.code, vm.message, { creator: creatorInfo, checks: c, need: ['Ask the creator to publish a corrected manifest in Creator Studio.', OWN_FILE] }); continue; }
    c.push(chk('signature', 'Manifest signature is valid for the registered key', true));
    const g = findGrant(vm.payload, videoId, now);
    if (!g.ok) { c.push(chk('grant', 'This video is approved for clipping', false)); lastFail = result('unverified', g.code, g.message, { creator: creatorInfo, checks: c, need: ['Ask the creator to add this video to their manifest in Creator Studio.', OWN_FILE] }); continue; }
    return finishVerified(e, g.grant, identity, c);
  }
  return lastFail;
}

function finishVerified(entry, grant, identity, checks) {
  const c = checks.slice();
  if (!c.some((x) => x.id === 'verified')) c.push(chk('creator', 'Creator is registered with ClipGen AI', true), chk('verified', 'Creator verified by the ClipGen maintainer', true), chk('manifest', 'Creator’s signed manifest loaded', true), chk('signature', 'Manifest signature is valid for the registered key', true));
  const i = c.findIndex((x) => x.id === 'author');
  if (identity === 'unconfirmed') { const row = chk('author', 'YouTube could not confirm who made this video (shown as unconfirmed)', null); if (i >= 0) c[i] = row; else c.push(row); }
  c.push(chk('grant', 'This video is approved for clipping, and the approval has not expired', true));
  const msg = identity === 'unconfirmed'
    ? 'Approved by a verified creator’s signed manifest. YouTube could not confirm the video’s author, so the match is by video ID only.'
    : 'Approved by the verified creator. The source file will be checked against the creator’s signed SHA-256 before it is used.';
  return result('verified', 'ok', msg, {
    creator: { id: entry.id, displayName: entry.displayName, status: 'verified', verifiedAt: entry.verification.verifiedAt, keyId: entry.keyId },
    grant, identity, checks: c
  });
}

/* A file the user already has (sent by the creator in any way) counts as verified only if it equals the signed grant. */
export function fileMatchesGrant(file, sha256Hex, grant) {
  return !!grant && file && file.size === grant.source.size && sha256Hex === grant.source.sha256;
}

/* Text the user can send to a creator who has not registered. */
export function creatorInviteText(appUrl, authorName, videoUrl) {
  return 'Hi' + (authorName ? ' ' + authorName : '') + '! I would like to make short clips from your video ' + videoUrl + ' using ClipGen AI, a free tool that works on files you provide. ' +
    'It only processes videos from creators who register and approve it. You can register and approve this video at ' + appUrl + ' (Creator Studio). ' +
    'You stay in control: you host the original file, you can set attribution terms, and you can revoke approval at any time.';
}

/* Which re-check outcomes must block an already-authorized project (vs. "could not re-check right now"). */
export const BLOCKING_CODES = new Set(['creator-revoked', 'creator-pending', 'creator-not-registered', 'signature-invalid', 'manifest-invalid', 'manifest-expired', 'video-not-in-manifest', 'grant-expired', 'terms-forbid']);
export const canonical = canonicalize;
