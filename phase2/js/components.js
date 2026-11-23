import { h, fmtLong, timeLeft, fmtBytes } from './util.js';
import { icon } from './icons.js';
import { conn, connect } from './conn.js';
import { getSettings, saveSettings } from './state.js';
import { mediaUrl } from './api.js';
import { btn, notice, toast } from './ui.js';

export const DEPLOY_URL = 'https://github.com/Akshxt10/clipgen-ai/blob/main/backend/DEPLOY.md';

const STATUS = {
  ingesting: ['Fetching video …', 'accent'], probing: ['Reading video …', 'accent'], ready: ['Ready to analyse', ''], analyzing: ['Analysing …', 'accent'],
  analyzed: ['Analysed', 'ok'], error: ['Failed', 'bad']
};
export function projectRow(p, { onDelete } = {}) {
  const [label, cls] = STATUS[p.status] || [p.status, ''];
  const poster = p.urls && p.urls.poster ? mediaUrl(p.urls.poster) : '';
  const href = '#/project/' + p.id;
  return h('div', { class: 'proj' },
    h('a', { class: 'thumb', href, 'aria-label': 'Open ' + p.name }, poster ? h('img', { src: poster, alt: '', loading: 'lazy' }) : h('span', { html: icon('film'), style: { width: '28px', display: 'block' } })),
    h('a', { class: 'meta', href },
      h('div', { class: 'name ellipsis' }, p.name),
      h('div', { class: 'row small muted', style: { gap: '6px', marginTop: '4px' } },
        h('span', { class: 'chip ' + cls }, p.status === 'analyzed' ? (p.clipCount + ' clip' + (p.clipCount === 1 ? '' : 's')) : label),
        p.media ? h('span', { class: 'num' }, fmtLong(p.media.duration)) : null,
        p.source && p.source.bytes ? h('span', null, fmtBytes(p.source.bytes)) : null,
        h('span', null, timeLeft(p.expiresAt)))),
    onDelete ? h('button', { class: 'btn iconbtn ghost', type: 'button', 'aria-label': 'Delete ' + p.name, title: 'Delete from server', onclick: () => onDelete(p), html: icon('trash') }) : null);
}

/* backend address + token form (Dashboard when not connected, and Settings) */
export function connectCard({ onDone, compact } = {}) {
  const s = getSettings();
  const addr = h('input', { class: 'input', type: 'text', inputmode: 'url', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', placeholder: 'https://your-backend.example.com', value: s.apiBase, 'aria-label': 'Backend address' });
  const tok = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: 'Only if you set one on the server', value: s.token, 'aria-label': 'Access token' });
  const out = h('div');
  const go = btn('Test & save', { cls: 'primary', ic: 'check', onclick: async () => {
    let a = addr.value.trim().replace(/\/+$/, '');
    if (a && !/^https?:\/\//i.test(a)) a = 'https://' + a;
    saveSettings({ apiBase: a, token: tok.value.trim() });
    go.disabled = true; out.replaceChildren(h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'muted small' }, 'Connecting … a sleeping free server can take up to a minute.')));
    const c = await connect();
    go.disabled = false;
    if (c.status === 'ok') { out.replaceChildren(notice('ok', h('b', null, 'Connected. '), 'Backend ' + c.caps.version + ' · FFmpeg ' + (c.caps.ffmpeg.ok ? 'ready' : 'missing'))); toast('Backend connected.', { kind: 'ok' }); if (onDone) onDone(c); }
    else if (c.status === 'auth') out.replaceChildren(notice('bad', c.error.message));
    else if (c.status === 'unset') out.replaceChildren(notice('warn', 'Enter the address of your ClipGen backend.'));
    else out.replaceChildren(notice('bad', c.error ? c.error.message : 'Could not connect.'));
  } });
  return h('div', { class: 'stack' },
    h('div', null, h('label', { class: 'lbl' }, 'Backend address'), addr),
    h('div', null, h('label', { class: 'lbl' }, 'Access token (optional)'), tok, h('div', { class: 'hint' }, 'Stored only in this browser. It is sent to your backend, nowhere else.')),
    h('div', { class: 'row' }, go, compact ? null : h('a', { class: 'btn ghost', href: DEPLOY_URL, target: '_blank', rel: 'noopener' }, 'Setup guide')),
    out);
}

/* caption look defaults for a template (colours come from the server's template list) */
export function captionDefaults(style, caps, keywords) {
  const t = (caps && caps.captionStyles && caps.captionStyles[style]) || {};
  return { style, font: '', color: t.color || '#FFFFFF', highlight: t.highlight || '#FFD83D', outline: '#000000', position: 'auto', size: 100, keywords: keywords || [], upper: t.upper !== undefined ? !!t.upper : true };
}
export const splitKeywords = (s) => String(s || '').split(',').map((k) => k.trim()).filter(Boolean).slice(0, 40);
