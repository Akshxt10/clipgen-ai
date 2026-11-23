/*
  ClipGen AI backend · what kind of link is this?

  ClipGen AI can fetch a video only when the link IS the video file (a direct, public media URL), or a share link
  that resolves to one (Dropbox). Web pages of video platforms (YouTube, TikTok, Instagram …) are not video files:
  they expose no permitted public way to retrieve the media bytes, and ClipGen AI does not try to get around that.
  For those we say so, show the public preview data the platform's own oEmbed endpoint offers (title/thumbnail),
  and point to the upload route.
*/
import { httpGet, parsePublicUrl } from './ssrf.js';
import { ApiError } from './util.js';

const PLATFORMS = [
  { id: 'youtube', name: 'YouTube', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'], oembed: (u) => 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(u) },
  { id: 'vimeo', name: 'Vimeo', hosts: ['vimeo.com'], oembed: (u) => 'https://vimeo.com/api/oembed.json?url=' + encodeURIComponent(u) },
  { id: 'tiktok', name: 'TikTok', hosts: ['tiktok.com'], oembed: (u) => 'https://www.tiktok.com/oembed?url=' + encodeURIComponent(u) },
  { id: 'instagram', name: 'Instagram', hosts: ['instagram.com'] },
  { id: 'facebook', name: 'Facebook', hosts: ['facebook.com', 'fb.watch', 'fb.com'] },
  { id: 'x', name: 'X (Twitter)', hosts: ['twitter.com', 'x.com', 't.co'] },
  { id: 'twitch', name: 'Twitch', hosts: ['twitch.tv'] },
  { id: 'dailymotion', name: 'Dailymotion', hosts: ['dailymotion.com', 'dai.ly'] },
  { id: 'reddit', name: 'Reddit', hosts: ['reddit.com', 'redd.it'] },
  { id: 'kick', name: 'Kick', hosts: ['kick.com'] },
  { id: 'rumble', name: 'Rumble', hosts: ['rumble.com'] },
  { id: 'bilibili', name: 'Bilibili', hosts: ['bilibili.com', 'b23.tv'] },
  { id: 'linkedin', name: 'LinkedIn', hosts: ['linkedin.com'] },
  { id: 'snapchat', name: 'Snapchat', hosts: ['snapchat.com'] }
];
const hostMatches = (host, h) => host === h || host.endsWith('.' + h);

export function detectPlatform(urlObj) {
  const host = urlObj.hostname.toLowerCase().replace(/^www\./, '');
  return PLATFORMS.find((p) => p.hosts.some((h) => hostMatches(host, h))) || null;
}

export const PLATFORM_MESSAGE = (name) =>
  name + ' links open a web page, not a video file. No permitted public interface hands out the video itself, so ClipGen AI cannot fetch it from this link and does not try to work around that. ' +
  'Upload the video file instead (for example the original you exported or recorded), or paste a direct link to a video file you host yourself.';

/* turn share links into direct links where the provider documents it */
export function normalizeUrl(u) {
  const host = u.hostname.toLowerCase();
  if (hostMatches(host, 'dropbox.com')) {
    const n = new URL(u.href);
    n.searchParams.delete('dl'); n.searchParams.set('dl', '1');
    return { url: n, note: 'Dropbox share link converted to a direct download link.' };
  }
  return { url: u, note: null };
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ts|mts|m2ts|mpg|mpeg|flv|wmv|3gp|ogv)(?:$|[?#])/i;

/* classify only (no network) */
export function classify(str, opts) {
  const u = parsePublicUrl(str, opts);
  const platform = detectPlatform(u);
  if (platform) return { kind: 'platform', platform: platform.id, platformName: platform.name, supported: false, message: PLATFORM_MESSAGE(platform.name), url: u.href, oembed: platform.oembed ? platform.oembed(u.href) : null };
  const n = normalizeUrl(u);
  return { kind: 'direct', supported: true, url: n.url.href, note: n.note, looksLikeVideo: VIDEO_EXT.test(n.url.pathname) };
}

async function readLimited(res, max) {
  const chunks = []; let n = 0;
  for await (const c of res) { n += c.length; if (n > max) { res.destroy(); break; } chunks.push(c); }
  return Buffer.concat(chunks).toString('utf8');
}

/* public preview data (title, thumbnail) from a platform's own documented oEmbed endpoint */
async function fetchOembed(endpoint, opts) {
  try {
    const { res } = await httpGet(endpoint, { timeoutMs: 6000, headers: { accept: 'application/json' }, allowPrivate: opts && opts.allowPrivate });
    if (res.statusCode !== 200) { res.resume(); return null; }
    const j = JSON.parse(await readLimited(res, 200000));
    return { title: j.title || null, author: j.author_name || null, thumbnail: j.thumbnail_url || null };
  } catch (_) { return null; }
}

export function filenameFrom(url, contentDisposition) {
  const cd = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(contentDisposition || '');
  let name = cd ? cd[1] : decodeURIComponent((url.pathname.split('/').pop() || '')).trim();
  try { name = decodeURIComponent(name); } catch (_) { /* keep */ }
  return name || 'video';
}

/*
  inspect(url): classification + live "source status" for direct links (HEAD-like request, nothing is stored)
  → { kind, supported, status, message, name?, bytes?, type?, preview? }
*/
export async function inspect(str, opts = {}) {
  const c = classify(str, opts);
  if (c.kind === 'platform') {
    const preview = c.oembed ? await fetchOembed(c.oembed, opts) : null;
    return { kind: 'platform', platform: c.platform, platformName: c.platformName, supported: false, status: 'unsupported', message: c.message, preview };
  }
  try {
    const { res, url } = await httpGet(c.url, { method: 'GET', headers: { range: 'bytes=0-0' }, timeoutMs: 10000, allowPrivate: opts.allowPrivate });
    res.resume();
    const code = res.statusCode;
    if (code === 401 || code === 403) return { kind: 'direct', supported: false, status: 'forbidden', message: 'The other server refuses to hand out this file (HTTP ' + code + '). The link may need a login, may have expired, or may block downloads. ClipGen AI does not bypass sign-ins or protections — upload the file instead.' };
    if (code === 404 || code === 410) return { kind: 'direct', supported: false, status: 'not-found', message: 'Nothing was found at this link (HTTP ' + code + ').' };
    if (code >= 400) return { kind: 'direct', supported: false, status: 'error', message: 'The other server answered with HTTP ' + code + '.' };
    const type = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    let bytes = null;
    const cr = /\/(\d+)$/.exec(String(res.headers['content-range'] || ''));
    if (cr) bytes = Number(cr[1]); else if (res.headers['content-length'] && code === 200) bytes = Number(res.headers['content-length']);
    if (/^text\/html|application\/xhtml|application\/json/.test(type)) return { kind: 'direct', supported: false, status: 'not-media', type, message: 'This link opens a web page, not a video file. Paste a link that ends in the video file itself (like …/clip.mp4), or upload the file.' };
    if (type.startsWith('image/') || type.startsWith('text/')) return { kind: 'direct', supported: false, status: 'not-media', type, message: 'This link is not a video (it is “' + type + '”).' };
    return { kind: 'direct', supported: true, status: 'reachable', type: type || null, bytes, name: filenameFrom(url, res.headers['content-disposition']), finalUrl: url.href, note: c.note, rangeSupported: code === 206 };
  } catch (e) {
    if (e instanceof ApiError) return { kind: 'direct', supported: false, status: e.code, message: e.message };
    return { kind: 'direct', supported: false, status: 'error', message: 'Could not check this link: ' + (e.message || e) };
  }
}
