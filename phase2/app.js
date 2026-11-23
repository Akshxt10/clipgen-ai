/* ClipGen AI · Phase 2 — app shell: navigation, status, router */
import { h, $ } from './js/util.js';
import { icon } from './js/icons.js';
import { conn, onConn, resolveBase, connect, whenSettled } from './js/conn.js';

const NAV = [
  ['#/', 'Dashboard', 'home', /^\/(project\/.*)?$/], ['#/link', 'Video input', 'link', /^\/link$/], ['#/upload', 'Upload', 'upload', /^\/upload$/],
  ['#/library', 'Clips', 'clips', /^\/library$/], ['#/history', 'History', 'history', /^\/history$/], ['#/settings', 'Settings', 'settings', /^\/settings$/], ['#/about', 'About', 'info', /^\/about$/]
];
const TABS = [['#/', 'Home', 'home', /^\/(project\/.*)?$/], ['#/link', 'Add', 'plus', /^\/(link|upload)$/], ['#/library', 'Clips', 'clips', /^\/library$/], ['#/history', 'History', 'history', /^\/history$/], ['#/settings', 'Settings', 'settings', /^\/(settings|about)$/]];

const lazy = (path, pick) => () => import(path).then((m) => (pick ? pick(m) : m.mount));
const ROUTES = [
  [/^\/?$/, lazy('./js/views/dashboard.js')],
  [/^\/link$/, lazy('./js/views/add.js', (m) => m.addView('link'))],
  [/^\/upload$/, lazy('./js/views/add.js', (m) => m.addView('upload'))],
  [/^\/library$/, lazy('./js/views/library.js')],
  [/^\/history$/, lazy('./js/views/history.js')],
  [/^\/settings$/, lazy('./js/views/settings.js')],
  [/^\/about$/, lazy('./js/views/about.js')],
  [/^\/project\/([^/]+)\/edit\/([^/]+)$/, lazy('./js/views/editor.js')],
  [/^\/project\/([^/]+)(?:\/(generate|analysis|clips))?$/, lazy('./js/views/project.js')]
];

const view = $('#view');
let cleanup = null, token = 0;

function paintNav(path) {
  const link = (list, cls) => list.map(([href, label, ic, re]) => h('a', { href, class: re.test(path) ? 'on' : '', 'aria-current': re.test(path) ? 'page' : undefined }, cls === 'tab' ? h('span', { html: icon(ic), style: { display: 'contents' } }) : null, label));
  $('#topnav').replaceChildren(...link(NAV));
  $('#tabbar').replaceChildren(...link(TABS, 'tab'));
}
function paintStatus() {
  const dot = $('#statusPill .dot'), txt = $('#statusText');
  const map = { ok: ['ok', 'Backend connected'], checking: ['warn', 'Connecting …'], down: ['bad', 'Backend offline'], auth: ['bad', 'Token needed'], unset: ['', 'Connect backend'] };
  const [cls, label] = map[conn.status] || map.unset;
  dot.className = 'dot ' + cls; txt.textContent = label;
}

async function route() {
  const my = ++token;
  const path = (location.hash.replace(/^#/, '') || '/').replace(/\/+$/, '') || '/';
  paintNav(path);
  if (cleanup) { try { cleanup(); } catch (_) { /* ignore */ } cleanup = null; }
  const hit = ROUTES.map(([re, load]) => [re.exec(path), load]).find(([m]) => m);
  if (!hit) { view.replaceChildren(h('div', { class: 'empty' }, h('h3', null, 'Page not found'), h('p', null, 'That page does not exist.'), h('a', { class: 'btn primary', href: '#/' }, 'Go to dashboard'))); return; }
  const [m, load] = hit;
  if (conn.status === 'checking' && /^\/(project|library)/.test(path)) {
    view.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Connecting to your ClipGen backend … a sleeping free server can take up to a minute.'))));
    await whenSettled();
    if (my !== token) return;
  }
  let mount;
  try { mount = await load(); } catch (e) { view.replaceChildren(h('div', { class: 'notice bad' }, 'Could not load this page: ' + e.message)); return; }
  if (my !== token) return;
  const ctx = { params: m.slice(1), navigate: (hash) => { location.hash = hash; }, remount: () => route() };
  view.scrollTop = 0; window.scrollTo(0, 0);
  try { const c = await mount(view, ctx); if (my !== token) { if (c) c(); return; } cleanup = c || null; }
  catch (e) { console.error(e); view.replaceChildren(h('div', { class: 'notice bad' }, 'Something went wrong showing this page: ' + e.message)); }
}

onConn(paintStatus);
window.addEventListener('hashchange', route);
(async () => {
  paintStatus();
  await resolveBase();
  route();
  connect();
})();
