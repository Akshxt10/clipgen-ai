/* shared UI pieces: toasts, modal sheet, progress bar, empty state, downloads */
import { h } from './util.js';
import { icon } from './icons.js';

export function toast(message, { kind = '', action, ms = 5200 } = {}) {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = h('div', { class: 'toast ' + kind, role: 'status' }, h('div', { class: 'grow' }, message));
  if (action) t.append(h('button', { class: 'btn sm', onclick: () => { action.run(); t.remove(); } }, action.label));
  box.append(t);
  setTimeout(() => t.remove(), action ? Math.max(ms, 9000) : ms);
}

export function modal(content, { onClose } = {}) {
  const prevFocus = document.activeElement;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key); if (onClose) onClose(); if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch (_) { /* ignore */ } };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const wrap = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === wrap) close(); } }, h('div', { class: 'sheet' }, content));
  document.body.append(wrap);
  document.addEventListener('keydown', key);
  return close;
}

export function progressBar(value) {
  const i = h('i');
  const el = h('div', { class: 'bar' + (value == null ? ' indeterminate' : ''), role: 'progressbar' }, i);
  const set = (v) => { if (v == null) { el.classList.add('indeterminate'); } else { el.classList.remove('indeterminate'); i.style.width = Math.round(Math.max(0, Math.min(1, v)) * 100) + '%'; el.setAttribute('aria-valuenow', Math.round(v * 100)); } };
  if (value != null) set(value);
  el.set = set;
  return el;
}

export function empty({ art = 'clips', title, text, actions }) {
  return h('div', { class: 'empty' }, h('div', { class: 'art', html: icon(art) }), h('h3', null, title), text ? h('p', null, text) : null, actions ? h('div', { class: 'row', style: { justifyContent: 'center' } }, actions) : null);
}

export const notice = (kind, ...kids) => h('div', { class: 'notice ' + kind, role: kind === 'bad' ? 'alert' : 'status' }, ...kids);

export function btn(label, { cls = '', ic, onclick, href, disabled, title } = {}) {
  const el = h(href ? 'a' : 'button', { class: 'btn ' + cls, onclick, href, disabled, title, type: href ? undefined : 'button' }, ic ? h('span', { html: icon(ic), style: { display: 'inline-flex' } }) : null, label);
  return el;
}

/* start a file download from a (signed, Content-Disposition: attachment) URL */
export function triggerDownload(url) {
  const a = document.createElement('a');
  a.href = url; a.rel = 'noopener'; a.style.display = 'none';
  document.body.append(a); a.click();
  setTimeout(() => a.remove(), 1500);
}

export function setTitle(t) { document.title = (t ? t + ' · ' : '') + 'ClipGen AI'; }
