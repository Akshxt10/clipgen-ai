/*
  ClipGen AI · Phase 2 · crypto helpers (pure, no DOM, no storage, no network).

  Used by the creator-authorization system:
    canonicalize(value)         deterministic JSON text, so signer and verifier hash exactly the same bytes
    Sha256 / sha256OfBlob       streaming SHA-256, so a multi-GB file is hashed in chunks and never loaded whole
    thumbprint(publicJwk)       the key's ID (SHA-256 of its canonical public parts)
    generateKeyPair()           ECDSA P-256 key pair (the browser's built-in WebCrypto, no library)
    signPayload / verifySignature   sign / verify a JSON payload

  Why ECDSA P-256: it is supported by WebCrypto in every current browser including iPhone Safari, needs no
  library, and signatures are small.
*/

const enc = new TextEncoder();
export const utf8 = (s) => enc.encode(s);

function subtleOrThrow() {
  const c = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
  if (!c || !c.subtle) throw new Error('This browser cannot do cryptographic signatures (a secure https page is required).');
  return c.subtle;
}

/* ---------------- base64url ---------------- */
export function b64uEncode(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('Invalid base64url');
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const bin = atob(str.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------------- canonical JSON ----------------
   Sorted keys, no whitespace, UTF-8. Only plain JSON values; anything else throws, so a payload can never be
   silently altered between signing and verifying. */
export function canonicalize(v) {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') { if (!isFinite(v)) throw new Error('canonicalize: non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    const parts = [];
    for (const k of keys) {
      if (v[k] === undefined) throw new Error('canonicalize: undefined value at "' + k + '"');
      parts.push(JSON.stringify(k) + ':' + canonicalize(v[k]));
    }
    return '{' + parts.join(',') + '}';
  }
  throw new Error('canonicalize: unsupported value type ' + t);
}

/* ---------------- streaming SHA-256 ---------------- */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export class Sha256 {
  constructor() {
    this.h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.total = 0;
    this.w = new Uint32Array(64);
    this.done = false;
  }
  _block(p, off) {
    const w = this.w, h = this.h;
    for (let i = 0; i < 16; i++, off += 4) w[i] = ((p[off] << 24) | (p[off + 1] << 16) | (p[off + 2] << 8) | p[off + 3]) >>> 0;
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  update(data) {
    if (this.done) throw new Error('Sha256: already finished');
    const u = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.total += u.length;
    let i = 0;
    if (this.bufLen) {
      const take = Math.min(64 - this.bufLen, u.length);
      this.buf.set(u.subarray(0, take), this.bufLen);
      this.bufLen += take; i = take;
      if (this.bufLen === 64) { this._block(this.buf, 0); this.bufLen = 0; }
    }
    for (; i + 64 <= u.length; i += 64) this._block(u, i);
    if (i < u.length) { this.buf.set(u.subarray(i), 0); this.bufLen = u.length - i; }
    return this;
  }
  /** returns the 32-byte digest */
  digest() {
    if (this.done) throw new Error('Sha256: already finished');
    this.done = true;
    const hi = Math.floor(this.total / 0x20000000);          // bits = total * 8, split in two 32-bit words
    const lo = (this.total % 0x20000000) * 8;
    const padLen = this.bufLen < 56 ? 56 - this.bufLen : 120 - this.bufLen;
    const pad = new Uint8Array(padLen + 8);
    pad[0] = 0x80;
    const dv = new DataView(pad.buffer);
    dv.setUint32(padLen, hi >>> 0); dv.setUint32(padLen + 4, lo >>> 0);
    this.done = false; this.update(pad); this.done = true;
    const out = new Uint8Array(32), odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, this.h[i]);
    return out;
  }
  hex() { return Array.from(this.digest()).map((b) => b.toString(16).padStart(2, '0')).join(''); }
}

export function sha256HexOfBytes(bytes) { return new Sha256().update(bytes).hex(); }

function readSlice(blob) {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('Could not read the file'));
    r.readAsArrayBuffer(blob);
  });
}
const abortError = () => { const e = new Error('Cancelled'); e.name = 'AbortError'; return e; };

/** SHA-256 of a File/Blob, read in 4 MB slices (memory use stays small even for a multi-GB file). */
export async function sha256OfBlob(blob, opts) {
  const o = opts || {};
  const chunk = o.chunkBytes || 4 * 1024 * 1024;
  const h = new Sha256();
  for (let off = 0; off < blob.size; off += chunk) {
    if (o.signal && o.signal.aborted) throw abortError();
    const end = Math.min(off + chunk, blob.size);
    h.update(new Uint8Array(await readSlice(blob.slice(off, end))));
    if (o.onProgress) o.onProgress(end / blob.size);
  }
  return h.hex();
}

/* ---------------- ECDSA P-256 ---------------- */
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

/** the key ID: SHA-256 over the canonical public parts of the key */
export function thumbprint(jwk) {
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof jwk.x !== 'string' || typeof jwk.y !== 'string') throw new Error('Not a P-256 public key');
  return sha256HexOfBytes(utf8(canonicalize({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })));
}
export const publicParts = (jwk) => ({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y });

export async function generateKeyPair() {
  const s = subtleOrThrow();
  const kp = await s.generateKey(ALG, true, ['sign', 'verify']);
  const priv = await s.exportKey('jwk', kp.privateKey);
  const pub = publicParts(await s.exportKey('jwk', kp.publicKey));
  return { publicJwk: pub, privateJwk: priv, keyId: thumbprint(pub) };
}

export async function signPayload(privateJwk, payload) {
  const s = subtleOrThrow();
  const key = await s.importKey('jwk', privateJwk, ALG, false, ['sign']);
  const sig = await s.sign(SIGN, key, utf8(canonicalize(payload)));
  return b64uEncode(new Uint8Array(sig));
}

export async function verifySignature(publicJwk, payload, signatureB64u) {
  const s = subtleOrThrow();
  let key, sig;
  try {
    key = await s.importKey('jwk', publicParts(publicJwk), ALG, false, ['verify']);
    sig = b64uDecode(signatureB64u);
  } catch (_) { return false; }
  if (sig.length !== 64) return false;
  try { return await s.verify(SIGN, key, sig, utf8(canonicalize(payload))); } catch (_) { return false; }
}
