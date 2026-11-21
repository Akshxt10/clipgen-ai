/*
  ClipGen AI · Phase 2 · fetch a creator-supplied source file (never from YouTube).

  The only URL this ever downloads is the one inside a creator's SIGNED grant, on the creator's own host
  (for example their own cloud storage). The host must allow this website to read it (CORS); if it does not, the
  browser blocks the request and we say so plainly.

  The file is hashed while it downloads and compared with the SHA-256 and size the creator signed. If anything
  differs, the data is thrown away and nothing is saved.
*/
import { Sha256, sha256OfBlob } from './crypto-utils.js';
import { isAllowedUrl } from './authz.js';

export const MAX_SOURCE_BYTES = 3 * 1024 * 1024 * 1024;     // 3 GB: beyond this an iPhone browser runs out of memory

export class SourceError extends Error {
  constructor(code, message) { super(message); this.name = 'SourceError'; this.code = code; }
}

/*
  fetchSourceFile(source, { onProgress, signal, fetchImpl, allowLocalHttp, maxBytes })
    source = { url, sha256, size, type, name }   (from a verified grant)
    onProgress({ received, total })
  Resolves a File whose bytes are proven to equal the signed grant.
*/
export async function fetchSourceFile(source, opts) {
  const o = opts || {};
  const max = o.maxBytes || MAX_SOURCE_BYTES;
  if (!isAllowedUrl(source.url, o.allowLocalHttp)) throw new SourceError('bad-url', 'The source link is not a secure (https) address.');
  if (source.size > max) throw new SourceError('too-big', 'This file is ' + Math.round(source.size / 1048576) + ' MB, which is more than a phone browser can safely handle here (limit ' + Math.round(max / 1048576) + ' MB).');
  const f = o.fetchImpl || fetch;
  let res;
  try {
    res = await f(source.url, { method: 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'follow', referrerPolicy: 'no-referrer', signal: o.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new SourceError('network', 'The file could not be downloaded from the creator’s host. Either you are offline, or the host does not allow this website to download it (CORS). The creator needs to enable cross-origin access on their storage.');
  }
  if (!res.ok) throw new SourceError('http-' + res.status, 'The creator’s host answered with HTTP ' + res.status + (res.status === 404 ? ' (file not found — the creator may have moved or removed it).' : '.'));
  const declared = res.headers && res.headers.get ? res.headers.get('content-length') : null;
  if (declared && Number(declared) !== source.size) throw new SourceError('size-mismatch', 'The file on the creator’s host has a different size (' + declared + ' bytes) than the creator’s signed approval (' + source.size + ' bytes). It was not downloaded.');

  const chunks = [];
  let received = 0;
  const hasher = new Sha256();
  const total = source.size;
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    for (;;) {
      if (o.signal && o.signal.aborted) { try { reader.cancel(); } catch (_) { /* ignore */ } const e = new Error('Cancelled'); e.name = 'AbortError'; throw e; }
      let step;
      try { step = await reader.read(); }
      catch (e) { if (e && e.name === 'AbortError') throw e; throw new SourceError('network', 'The download was interrupted.'); }
      if (step.done) break;
      received += step.value.length;
      if (received > total) { try { reader.cancel(); } catch (_) { /* ignore */ } throw new SourceError('size-mismatch', 'The download is larger than the creator’s signed size, so it was stopped and discarded.'); }
      hasher.update(step.value);
      chunks.push(step.value);
      if (o.onProgress) o.onProgress({ received, total });
    }
  } else {                                           // very old browsers: no streaming, hash after download
    const blob = await res.blob();
    received = blob.size;
    if (o.onProgress) o.onProgress({ received, total });
    chunks.push(blob);
    hasher.update(new Uint8Array(0));
    const hex = await sha256OfBlob(blob);
    return finish(chunks, received, hex, source);
  }
  return finish(chunks, received, hasher.hex(), source);
}

function finish(chunks, received, hex, source) {
  if (received !== source.size) throw new SourceError('size-mismatch', 'The download is ' + received + ' bytes but the creator signed ' + source.size + ' bytes. It was discarded.');
  if (hex !== source.sha256) throw new SourceError('hash-mismatch', 'The downloaded file does NOT match the creator’s signed SHA-256, so it was discarded. It is not the file the creator approved.');
  const blob = new Blob(chunks, { type: source.type });
  try { return new File([blob], source.name, { type: source.type, lastModified: Date.now() }); } catch (_) { blob.name = source.name; return blob; }
}
