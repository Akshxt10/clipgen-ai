/* Processing history (kept in this browser) + what is running on the server right now */
import { h, fmtLong, timeAgo } from '../util.js';
import { icon } from '../icons.js';
import { conn } from '../conn.js';
import * as api from '../api.js';
import { getHistory, clearHistory } from '../state.js';
import { empty, btn, setTitle } from '../ui.js';

const KIND = { 'add-link': ['link', 'Video from link'], upload: ['upload', 'Upload'], analyze: ['sparkle', 'AI analysis'], render: ['film', 'Clip render'], zip: ['zip', 'ZIP download'] };

export async function mount(root) {
  setTitle('Processing history');
  let dead = false, timer = 0;
  const running = h('div');
  const list = h('div', { class: 'list' });
  function paint() {
    const items = getHistory();
    list.replaceChildren(...(items.length ? items.map((e) => {
      const [ic, label] = KIND[e.kind] || ['info', e.kind];
      return h('div', { class: 'hist ' + (e.ok ? 'ok' : 'bad') },
        h('div', { class: 'ic', html: icon(e.ok ? ic : 'alert') }),
        h('div', { class: 'grow' }, h('div', { class: 'row between nowrap' }, h('b', { class: 'ellipsis' }, label + (e.name ? ' · ' + e.name : '')), h('span', { class: 'small faint', style: { whiteSpace: 'nowrap' } }, timeAgo(e.ts))),
          h('div', { class: 'small muted' }, (e.ok ? '' : 'Failed: ') + (e.message || '') + (e.ms ? ' · took ' + fmtLong(e.ms / 1000) : '')),
          e.projectId && e.ok ? h('a', { class: 'small', href: '#/project/' + e.projectId, style: { color: 'var(--accent-2)' } }, 'Open video') : null));
    }) : [empty({ art: 'history', title: 'Nothing here yet', text: 'Every upload, analysis, render and download is listed here, so you can see what happened and why something failed.' })]));
  }
  async function loadRunning() {
    if (dead) return;
    if (conn.status !== 'ok') { running.replaceChildren(); return; }
    try {
      const { jobs } = await api.listJobs();
      const act = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
      running.replaceChildren(...(act.length ? [h('div', { class: 'card', style: { marginBottom: '16px' } }, h('h3', { style: { marginBottom: '10px' } }, 'Running on the server'), ...act.map((j) => h('div', { class: 'hist run', style: { marginTop: '8px' } }, h('div', { class: 'ic' }, h('span', { class: 'spinner' })), h('div', { class: 'grow' }, h('b', null, j.label), h('div', { class: 'small muted' }, Math.round(j.progress * 100) + '% · ' + (j.message || j.state)), h('a', { class: 'small', href: '#/project/' + j.projectId, style: { color: 'var(--accent-2)' } }, 'Open')))))] : []));
      timer = setTimeout(loadRunning, act.length ? 2000 : 8000);
    } catch (_) { timer = setTimeout(loadRunning, 8000); }
  }
  root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Processing history'), h('p', null, 'Stored only in this browser.')), btn('Clear history', { cls: 'sm', ic: 'trash', onclick: () => { clearHistory(); paint(); } })), running, list);
  paint(); loadRunning();
  return () => { dead = true; clearTimeout(timer); };
}
