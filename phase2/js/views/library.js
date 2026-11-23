/* Generated clips library: every clip on the server across all videos */
import { h, fmtTime, timeLeft } from '../util.js';
import { icon } from '../icons.js';
import { conn, onConn } from '../conn.js';
import * as api from '../api.js';
import { empty, notice, btn, toast, modal, triggerDownload, setTitle } from '../ui.js';

export async function mount(root, ctx) {
  setTitle('Clips library');
  let dead = false;
  const off = onConn(() => { if (!dead) load(); });
  async function load() {
    if (conn.status !== 'ok') { root.replaceChildren(h('div', { class: 'page-head' }, h('h1', null, 'Clips library')), empty({ art: 'clips', title: 'Not connected', text: 'Connect your ClipGen backend to see your videos and clips.', actions: [btn('Open settings', { cls: 'primary', href: '#/settings' })] })); return; }
    root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Clips library'), h('p', null, 'Everything currently stored on your server. Files are deleted automatically' + (conn.caps ? ' ' + conn.caps.limits.retentionHours + ' hours after you last used a video' : '') + ' — download what you want to keep.'))), h('div', { class: 'skeleton', style: { height: '160px' } }));
    let projects;
    try { projects = (await api.listProjects()).projects; } catch (e) { if (!dead) root.replaceChildren(notice('bad', e.message)); return; }
    if (dead) return;
    const withClips = projects.filter((p) => p.hasAnalysis);
    const head = h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Clips library'), h('p', null, 'Everything currently stored on your server. Files are deleted automatically ' + conn.caps.limits.retentionHours + ' hours after you last used a video — download what you want to keep.')),
      h('span', { class: 'chip' }, conn.caps.limits.storageUsedMB + ' of ' + conn.caps.limits.storageMaxMB + ' MB used'));
    if (!projects.length) { root.replaceChildren(head, empty({ art: 'clips', title: 'No clips yet', text: 'Add a video and generate clips — they will appear here.', actions: [btn('Add a video', { cls: 'primary', href: '#/', ic: 'plus' })] })); return; }
    const body = h('div', { class: 'stack' });
    root.replaceChildren(head, body);
    for (const p of projects) {
      const sec = h('section', { class: 'card' });
      body.append(sec);
      sec.append(h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('h3', { class: 'ellipsis' }, p.name), h('div', { class: 'small muted' }, p.hasAnalysis ? p.clipCount + ' clips · ' + timeLeft(p.expiresAt) : p.status === 'error' ? 'Failed' : 'Not analysed yet · ' + timeLeft(p.expiresAt))), btn(p.hasAnalysis ? 'Open' : 'Continue', { cls: 'sm', href: '#/project/' + p.id })));
      if (!p.hasAnalysis) continue;
      const grid = h('div', { class: 'clip-grid', style: { marginTop: '14px' } }, h('div', { class: 'skeleton', style: { height: '120px' } }));
      sec.append(grid);
      api.getProject(p.id).then(({ analysis }) => {
        if (dead || !analysis) return;
        grid.replaceChildren(...analysis.clips.map((c) => {
          const rendered = c.renderUrl && c.renderCurrent;
          return h('article', { class: 'clip' },
            h('button', { class: 'pic', type: 'button', 'aria-label': 'Play clip ' + c.rank, onclick: () => play(p, c) }, c.thumbUrl ? h('img', { src: api.mediaUrl(c.thumbUrl), alt: '', loading: 'lazy' }) : null, h('div', { class: 'play' }, h('span', { html: icon('play') })), h('span', { class: 'badge-n' }, 'Clip ' + c.rank), h('span', { class: 'badge-d num' }, fmtTime(c.duration))),
            h('div', { class: 'body' }, h('div', { class: 'ttl' }, c.title), h('div', { class: 'chips' }, h('span', { class: 'chip accent' }, 'Score ' + Math.round(c.score)), rendered ? h('span', { class: 'chip ok' }, 'Rendered') : h('span', { class: 'chip' }, 'Not rendered')),
              h('div', { class: 'actions' }, rendered ? btn('Download', { cls: 'sm primary', ic: 'download', onclick: () => triggerDownload(api.mediaUrl(c.downloadUrl)) }) : btn('Render', { cls: 'sm primary', ic: 'film', href: '#/project/' + p.id + '/edit/' + c.id }), btn('Edit', { cls: 'sm', ic: 'edit', href: '#/project/' + p.id + '/edit/' + c.id }))));
        }));
      }).catch((e) => { if (!dead) grid.replaceChildren(notice('bad', e.message)); });
    }
  }
  function play(p, c) {
    const rendered = c.renderUrl && c.renderCurrent;
    const v = h('video', { controls: true, playsinline: '', autoplay: true, src: rendered ? api.mediaUrl(c.renderUrl) : api.mediaUrl(p.urls.source) + '#t=' + c.start + ',' + c.end });
    const close = modal(h('div', { class: 'stack' }, h('div', { class: 'row between nowrap' }, h('h3', { class: 'ellipsis' }, c.title), btn('', { cls: 'iconbtn ghost', ic: 'x', onclick: () => close() })), v, rendered ? null : h('div', { class: 'hint' }, 'Showing the original video at this moment (not rendered yet).')), { onClose: () => { v.pause(); v.removeAttribute('src'); v.load(); } });
  }
  load();
  return () => { dead = true; off(); };
}
