/*
  ClipGen AI backend · safe outbound fetching of user-supplied URLs.

  A server that downloads whatever URL it is given can be tricked into reading its own network (SSRF). Defences:
    - only http/https, no credentials in the URL, only common web ports
    - the hostname is resolved HERE and every resolved address must be public; the connection is then pinned to
      that address (so DNS can't answer differently a moment later = no DNS rebinding)
    - redirects are followed manually, at most 5, and every hop is validated again
    - no cookies, no custom auth headers are ever sent; response size and time are capped by the caller
*/
import dns from 'node:dns/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { ApiError } from './util.js';

const PORTS_OK = new Set(['', '80', '443', '8080', '8443']);

function v4ToInt(ip) { return ip.split('.').reduce((a, b) => (a * 256) + Number(b), 0); }
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([a, bits]) => ({ base: v4ToInt(a), bits }));

function v6ToBig(ip) {
  let s = ip.split('%')[0].toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, v4.index) + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const parts = s.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length > 1 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length > 1 ? 8 - head.length - tail.length : 0;
  const all = head.concat(Array(Math.max(0, fill)).fill('0'), tail);
  if (all.length !== 8) throw new Error('bad ipv6');
  return all.reduce((a, h) => (a << 16n) | BigInt(parseInt(h || '0', 16)), 0n);
}

export function isPrivateIp(ip) {
  const fam = net.isIP(ip);
  if (fam === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some((b) => (n >>> (32 - b.bits)) === (b.base >>> (32 - b.bits)) || (b.bits === 0));
  }
  if (fam === 6) {
    let big;
    try { big = v6ToBig(ip); } catch (_) { return true; }
    if (big === 0n || big === 1n) return true;                                       // :: and ::1
    if ((big >> 32n) === 0xffffn) return isPrivateIp(Array.from({ length: 4 }, (_, i) => Number((big >> BigInt(24 - 8 * i)) & 0xffn)).join('.'));   // ::ffff:a.b.c.d
    if ((big >> 121n) === 0x7en) return true;                                        // fc00::/7
    if ((big >> 118n) === 0x3fan) return true;                                       // fe80::/10
    if ((big >> 120n) === 0xffn) return true;                                        // ff00::/8 multicast
    if ((big >> 96n) === 0x64ff9bn) return true;                                     // NAT64 64:ff9b::/96
    if ((big >> 112n) === 0x2001n && ((big >> 96n) & 0xffffn) === 0x0db8n) return true;   // documentation
    return false;
  }
  return true;
}

export function parsePublicUrl(str, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(String(str || '').trim()); } catch (_) { throw new ApiError(400, 'invalid-url', 'That does not look like a web address. Paste a full link starting with https://'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ApiError(400, 'invalid-url', 'Only http:// and https:// links are supported.');
  if (u.username || u.password) throw new ApiError(400, 'invalid-url', 'Links that contain a user name or password are not supported.');
  if (!allowPrivate && !PORTS_OK.has(u.port)) throw new ApiError(400, 'invalid-url', 'That link uses an unusual network port, which is not allowed.');
  if (!allowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (/^[\d.]+$|:/.test(host) && isPrivateIp(host))) throw new ApiError(400, 'invalid-url', 'Links to private or local addresses are not allowed.');
  }
  if (u.href.length > 2048) throw new ApiError(400, 'invalid-url', 'That link is too long.');
  return u;
}

export async function resolveSafe(hostname, { allowPrivate = false } = {}) {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }];
  else {
    try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (_) { throw new ApiError(400, 'unreachable', 'The address “' + hostname + '” could not be found. Check the link for typos.'); }
  }
  if (!addrs.length) throw new ApiError(400, 'unreachable', 'The address “' + hostname + '” could not be found.');
  if (!allowPrivate) {
    for (const a of addrs) if (isPrivateIp(a.address)) throw new ApiError(400, 'blocked-address', 'That link points to a private or internal network address, which is not allowed.');
  }
  return addrs[0];
}

/*
  httpGet(url, opts) → { res, url }   res = Node IncomingMessage (caller must consume or destroy it)
  opts: { method, headers, timeoutMs, maxRedirects, allowPrivate, signal }
*/
export async function httpGet(urlStr, opts = {}) {
  const o = Object.assign({ method: 'GET', headers: {}, timeoutMs: 20000, maxRedirects: 5, allowPrivate: false }, opts);
  let url = parsePublicUrl(urlStr, o);
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    const pinned = await resolveSafe(url.hostname, o);
    const res = await new Promise((resolve, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: url.pathname + url.search, method: o.method,
        headers: Object.assign({ 'user-agent': 'ClipGenAI-Fetcher/1.0 (+https://akshxt10.github.io/clipgen-ai/)', accept: 'video/*,application/octet-stream;q=0.9,*/*;q=0.5', 'accept-encoding': 'identity' }, o.headers),
        lookup: (_h, _opts, cb) => (_opts && _opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
        servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
        timeout: o.timeoutMs
      }, resolve);
      req.on('timeout', () => req.destroy(new ApiError(504, 'timeout', 'The other server took too long to answer.')));
      req.on('error', (e) => reject(e instanceof ApiError ? e : new ApiError(502, 'unreachable', 'Could not connect to the other server (' + (e.code || e.message) + ').')));
      if (o.signal) {
        if (o.signal.aborted) { req.destroy(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); }
        else o.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('Cancelled'), { name: 'AbortError' })), { once: true });
      }
      req.end();
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (hop === o.maxRedirects) throw new ApiError(502, 'too-many-redirects', 'The link redirects too many times.');
      url = parsePublicUrl(new URL(res.headers.location, url).href, o);
      continue;
    }
    return { res, url };
  }
  throw new ApiError(502, 'too-many-redirects', 'The link redirects too many times.');
}
