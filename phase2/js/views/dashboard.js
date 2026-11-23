import { h } from '../util.js';
import { icon } from '../icons.js';
import { conn, onConn, connect } from '../conn.js';
import { listProjects, deleteProject } from '../api.js';
import { createAddBox } from '../addbox.js';
import { projectRow, connectCard, DEPLOY_URL } from '../components.js';
import { empty, toast, setTitle } from '../ui.js';

export async function mount(root, ctx) {
  setTitle('');
  let box = null, timer = 0, dead = false;
  const render = () => {
    if (box) { box.destroy(); box = null; }
    clearTimeout(timer);
    if (conn.status === 'ok') renderMain(); else renderConnect();
  };

  function renderConnect() {
    const titles = {
      unset: ['Connect your ClipGen backend', 'ClipGen AI runs the heavy work (FFmpeg, speech recognition, clip rendering) on a small server you control, because a phone browser cannot do it. Enter its address once.'],
      checking: ['Connecting …', 'Waking up the backend. Free servers can take up to a minute.'],
      down: ['Cannot reach the backend', conn.error ? conn.error.message : ''],
      auth: ['Access token needed', conn.error ? conn.error.message : '']
    };
    const [t, p] = titles[conn.status] || titles.unset;
    root.replaceChildren(
      h('section', { class: 'hero' }, h('h1', null, 'Turn long videos into ', h('span', { class: 'grad-text' }, 'short clips')), h('p', { class: 'lead' }, 'Paste a link or upload a video. ClipGen AI transcribes it, finds the best moments, reframes them and adds captions.')),
      h('div', { class: 'card', style: { marginTop: '22px' } },
        h('div', { class: 'card-title' }, h('h2', null, t)),
        p ? h('p', { class: 'muted', style: { marginBottom: '14px' } }, p) : null,
        conn.status === 'checking' ? h('div', { class: 'row' }, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Checking …')) : connectCard({ onDone: () => render() }),
        conn.status === 'unset' ? h('p', { class: 'hint', style: { marginTop: '14px' } }, 'No backend yet? ', h('a', { href: DEPLOY_URL, target: '_blank', rel: 'noopener', style: { color: 'var(--accent-2)' } }, 'Follow the free setup guide'), ' (about 15 minutes, no computer needed).') : null));
  }

  function renderMain() {
    box = createAddBox({ mode: 'both', navigate: ctx.navigate });
    const recent = h('div', { id: 'recent' });
    root.replaceChildren(
      h('section', { class: 'hero' },
        h('h1', null, 'Turn long videos into ', h('span', { class: 'grad-text' }, 'short clips')),
        h('p', { class: 'lead' }, 'Paste a link or upload a video. ClipGen AI transcribes it, finds the strongest moments, reframes them for vertical video and burns in captions.'),
        h('div', { class: 'linkbox' }, box.el)),
      h('div', { class: 'how' }, h('div', null, h('b', null, 'Paste'), ' a link or upload'), h('div', null, h('b', null, 'Analyse'), ' speech, sound, scenes'), h('div', null, h('b', null, 'Generate'), ' ranked clips'), h('div', null, h('b', null, 'Preview'), ' and fine-tune'), h('div', null, h('b', null, 'Download'), ' MP4 or ZIP')),
      h('div', { class: 'page-head', style: { marginTop: '28px' } }, h('h2', null, 'Recent videos'), h('a', { class: 'small', href: '#/library', style: { color: 'var(--accent-2)' } }, 'All clips →')),
      recent);
    loadRecent(recent);
  }

  async function loadRecent(el) {
    if (dead) return;
    try {
      const { projects } = await listProjects();
      if (dead) return;
      if (!projects.length) {
        el.replaceChildren(empty({ art: 'film', title: 'No videos yet', text: 'Paste a link above or upload a file to create your first clips. Videos stay on your server for a limited time and are deleted automatically.' }));
        return;
      }
      el.replaceChildren(...projects.slice(0, 6).map((p) => projectRow(p, { onDelete: async (pp) => {
        if (!confirm('Delete “' + pp.name + '” and its clips from the server?')) return;
        try { await deleteProject(pp.id); toast('Deleted.'); loadRecent(el); } catch (e) { toast(e.message, { kind: 'bad' }); }
      } })));
      if (projects.some((p) => ['ingesting', 'probing', 'analyzing'].includes(p.status))) timer = setTimeout(() => loadRecent(el), 3000);
    } catch (e) { if (!dead) el.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  }

  const off = onConn(() => { if (!dead) render(); });
  render();
  if (conn.status === 'unset' || conn.status === 'down') { /* user can edit and retry */ }
  return () => { dead = true; off(); clearTimeout(timer); if (box) box.destroy(); };
}
