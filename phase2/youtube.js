/*
  ClipGen AI · Phase 2 · YouTube link helpers.   (pure functions — no DOM, no storage)

  WHAT THIS FILE DOES
    parseYouTubeUrl(text)   validate a pasted link and extract the 11-character video ID
    embedSrc(id, opts)      the official privacy-enhanced embed URL (youtube-nocookie.com)
    fetchOEmbed(url, opts)  public title / channel via YouTube's oEmbed endpoint (best effort)

  WHAT THIS FILE DELIBERATELY DOES NOT DO
    It never requests, downloads, records or extracts YouTube video or audio. Linking a video only lets the
    official YouTube player show it. Any processing happens on a file the user supplies themselves.
*/

const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const SUPPORTED = 'youtube.com/watch?v=…, youtu.be/…, youtube.com/live/… or youtube.com/shorts/…';

const fail = (code, message) => ({ ok: false, code, message });

/* "90", "90s", "1m30s", "1h2m3s" → seconds (or 0 when it is not understood) */
export function parseTimeParam(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().toLowerCase();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return clampStart(parseInt(s, 10));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (!m || (m[1] == null && m[2] == null && m[3] == null)) return 0;
  return clampStart((parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10));
}
const clampStart = (n) => (isFinite(n) && n > 0 && n < 86400 * 2 ? Math.floor(n) : 0);

/* Pull a link out of whatever was pasted (iOS "Share" often adds a title or extra words around the URL). */
function pickToken(input) {
  const text = String(input == null ? '' : input).trim();
  if (!text) return '';
  if (!/\s/.test(text)) return text;
  const tokens = text.split(/\s+/);
  for (let i = 0; i < tokens.length; i++) if (/youtube\.com|youtu\.be/i.test(tokens[i])) return tokens[i];
  return text;
}

export function parseYouTubeUrl(input) {
  const token = pickToken(input).replace(/^[<(\["']+|[>)\]"'.,;]+$/g, '');
  if (!token) return fail('empty', 'Paste a YouTube link first.');

  let raw = token;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');   // allow "youtu.be/ID" with no scheme
  let u;
  try { u = new URL(raw); } catch (_) { return fail('not-url', 'That does not look like a web link. Example: https://youtu.be/XXXXXXXXXXX'); }

  if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail('scheme', 'Only normal web links (https://…) are accepted.');
  if (u.username || u.password) return fail('credentials', 'That link contains a user name or password part, so it was rejected for safety.');

  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, '');
  const parts = u.pathname.split('/').filter(Boolean);
  let id = null, kind = null;

  if (host === 'youtu.be') {
    if (parts.length >= 1) { id = parts[0]; kind = 'short-link'; }
  } else if (host === 'youtube.com') {
    if (parts[0] === 'watch') {
      id = u.searchParams.get('v'); kind = 'watch';
      if (!id && u.searchParams.get('list')) return fail('playlist', 'That is a playlist link. Open one video from the playlist and paste that video’s link.');
    } else if (parts[0] === 'live' && parts[1]) { id = parts[1]; kind = 'live'; }
    else if (parts[0] === 'shorts' && parts[1]) { id = parts[1]; kind = 'shorts'; }
    else if (parts[0] === 'playlist') return fail('playlist', 'That is a playlist link. Open one video from the playlist and paste that video’s link.');
    else if (parts[0] === 'channel' || parts[0] === 'c' || parts[0] === 'user' || (parts[0] && parts[0][0] === '@')) return fail('channel', 'That is a channel link. Paste the link of one specific video or livestream.');
    else return fail('unsupported', 'Unsupported YouTube link. Use ' + SUPPORTED + '.');
  } else {
    return fail('host', 'That is not a YouTube link. Use ' + SUPPORTED + '.');
  }

  if (!id) return fail('no-id', 'No video ID was found in that link. Use ' + SUPPORTED + '.');
  if (!ID_RE.test(id)) return fail('bad-id', 'The video ID in that link is not valid (it must be 11 letters, numbers, - or _).');

  const startSec = parseTimeParam(u.searchParams.get('t') != null ? u.searchParams.get('t') : u.searchParams.get('start'));
  return {
    ok: true,
    videoId: id,
    kind,
    startSec,
    canonicalUrl: 'https://www.youtube.com/watch?v=' + id,
    watchUrl: 'https://www.youtube.com/watch?v=' + id + (startSec ? '&t=' + startSec + 's' : '')
  };
}

export const KIND_LABEL = { watch: 'Video', 'short-link': 'Video', live: 'Live / stream', shorts: 'Short' };

/* The official embedded player. Never add overlays, ad blocking or playback changes on top of it. */
export function embedSrc(videoId, opts) {
  if (!ID_RE.test(String(videoId))) throw new Error('Invalid YouTube video ID');
  const o = opts || {};
  let q = '?rel=0&playsinline=1';
  if (o.startSec && o.startSec > 0) q += '&start=' + Math.floor(o.startSec);
  return 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(videoId) + q;
}

/*
  Public metadata through oEmbed (title, channel). It needs no key and no account.
  It is best effort: it can fail (offline, blocked, private or removed video) and the app copes with that.
  oEmbed never provides the duration. Nothing returned here is saved by the app.
  Resolves { ok:true, title, authorName, authorUrl } or { ok:false, code, message }.
*/
const memo = new Map();
export async function fetchOEmbed(canonicalUrl, opts) {
  const o = opts || {};
  const f = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { ok: false, code: 'unsupported', message: 'This browser cannot load video details.' };
  if (memo.has(canonicalUrl) && !o.noCache) return memo.get(canonicalUrl);
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, o.timeoutMs || 8000);
  let result;
  try {
    const res = await f('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(canonicalUrl),
      { method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'strict-origin-when-cross-origin', signal: ctl ? ctl.signal : undefined });
    if (res.status === 401 || res.status === 403) result = { ok: false, code: 'private', message: 'YouTube says this video is private or its owner does not allow sharing details.' };
    else if (res.status === 404) result = { ok: false, code: 'not-found', message: 'YouTube could not find this video (it may be removed, private or not yet public).' };
    else if (!res.ok) result = { ok: false, code: 'http-' + res.status, message: 'YouTube answered with an error (HTTP ' + res.status + ').' };
    else {
      const j = await res.json();
      result = {
        ok: true,
        title: typeof j.title === 'string' ? j.title : '',
        authorName: typeof j.author_name === 'string' ? j.author_name : '',
        authorUrl: typeof j.author_url === 'string' && /^https:\/\/www\.youtube\.com\//.test(j.author_url) ? j.author_url : ''
      };
    }
  } catch (e) {
    result = (e && e.name === 'AbortError')
      ? { ok: false, code: 'timeout', message: 'YouTube did not answer in time.' }
      : { ok: false, code: 'network', message: 'Details could not be loaded (offline, or this browser blocked the request).' };
  } finally { clearTimeout(timer); }
  if (result.ok) memo.set(canonicalUrl, result);     // only successes are cached, and only in memory for this tab
  return result;
}
