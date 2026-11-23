import { h } from '../util.js';
import { conn, onConn } from '../conn.js';
import { createAddBox } from '../addbox.js';
import { connectCard } from '../components.js';
import { setTitle } from '../ui.js';

/* "Video input" (link) and "Upload" screens */
export function addView(mode) {
  return async function mount(root, ctx) {
    setTitle(mode === 'link' ? 'Video input' : 'Upload');
    let box = null, dead = false;
    const render = () => {
      if (box) box.destroy();
      if (conn.status !== 'ok') {
        root.replaceChildren(h('div', { class: 'page-head' }, h('div', null, h('h1', null, mode === 'link' ? 'Video input' : 'Upload'))), h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Connect your backend first'), h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Adding videos needs your ClipGen backend.'), connectCard({ onDone: render })));
        return;
      }
      box = createAddBox({ mode, navigate: ctx.navigate });
      root.replaceChildren(
        h('div', { class: 'page-head' }, h('div', null, h('h1', null, mode === 'link' ? 'Paste your video link' : 'Upload a video'),
          h('p', null, mode === 'link' ? 'A direct link to a video file. ClipGen AI checks it, fetches the real file and analyses it.' : 'Pick a video from your device. Large files are sent in pieces and resume if your connection drops.'))),
        h('div', { class: 'linkbox', style: { marginTop: 0 } }, box.el),
        h('p', { class: 'small muted', style: { marginTop: '14px' } }, mode === 'link' ? ['Have the file instead? ', h('a', { href: '#/upload', style: { color: 'var(--accent-2)' } }, 'Upload it')] : ['Have a direct link instead? ', h('a', { href: '#/link', style: { color: 'var(--accent-2)' } }, 'Paste it')]));
    };
    const off = onConn(() => { if (!dead) render(); });
    render();
    return () => { dead = true; off(); if (box) box.destroy(); };
  };
}
