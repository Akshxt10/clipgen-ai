import { h } from '../util.js';
import { conn, onConn } from '../conn.js';
import { getSettings, saveSettings, clearHistory, DEFAULTS } from '../state.js';
import { connectCard } from '../components.js';
import { toast, setTitle, btn, notice } from '../ui.js';

const LANGS = [['auto', 'Detect automatically'], ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['pt', 'Portuguese'], ['it', 'Italian'], ['ru', 'Russian'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['ar', 'Arabic']];

export async function mount(root) {
  setTitle('Settings');
  let dead = false;
  const off = onConn(() => { if (!dead) paint(); });
  function paint() {
    const g = getSettings().gen;
    const caps = conn.caps;
    const upd = (patch) => { saveSettings({ gen: patch }); toast('Saved.', { ms: 1200 }); };
    const sel = (label, items, key, num) => h('div', null, h('label', { class: 'lbl' }, label), h('select', { class: 'input', onchange: (e) => upd({ [key]: num ? Number(e.target.value) : e.target.value }) }, items.map(([v, l]) => h('option', { value: v, selected: String(g[key]) === String(v) }, l))));
    const kv = (k, v) => [h('dt', null, k), h('dd', null, v)];
    const status = conn.status === 'ok'
      ? h('dl', { class: 'kv' }, ...kv('Status', h('span', { class: 'chip ok' }, 'Connected')), ...kv('Server version', caps.version), ...kv('FFmpeg', caps.ffmpeg.ok ? caps.ffmpeg.version : 'missing'),
        ...kv('Speech recognition', caps.transcription.available ? 'whisper.cpp · ' + caps.transcription.model + (caps.transcription.multilingual ? '' : ' (English only)') : h('span', { class: 'chip warn' }, 'not installed')),
        ...kv('Face tracking', caps.faceTracking ? 'OpenCV available' : 'not available (motion tracking is used)'), ...kv('Optional AI review', caps.llmReview.available ? caps.llmReview.model : 'off'),
        ...kv('Largest video', caps.limits.maxSourceMB + ' MB · ' + caps.limits.maxDurationMin + ' min'), ...kv('Kept for', caps.limits.retentionHours + ' h after last use'), ...kv('Storage', caps.limits.storageUsedMB + ' / ' + caps.limits.storageMaxMB + ' MB'))
      : notice(conn.status === 'checking' ? '' : conn.status === 'unset' ? 'warn' : 'bad', conn.status === 'unset' ? 'No backend connected yet.' : conn.status === 'checking' ? 'Checking …' : (conn.error ? conn.error.message : 'Not connected.'));
    root.replaceChildren(
      h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'Settings'), h('p', null, 'Saved in this browser and applied automatically.'))),
      h('div', { class: 'stack' },
        h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'Backend')), status, h('div', { style: { marginTop: '16px' } }, connectCard({ compact: false, onDone: () => paint() }))),
        h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'Clip generation defaults')),
          h('div', { class: 'fields two' },
            sel('Target platform', Object.entries((caps && caps.platforms) || { shorts: { label: 'YouTube Shorts' } }).map(([k, v]) => [k, v.label]), 'platform'),
            sel('Number of clips', Array.from({ length: 12 }, (_, i) => [i + 1, String(i + 1)]), 'numClips', true),
            sel('Aspect ratio', [['9:16', '9:16'], ['16:9', '16:9'], ['1:1', '1:1']], 'aspect'),
            sel('Framing', [['smart', 'Smart'], ['center', 'Center'], ['blur', 'Blur fill']], 'reframe'),
            sel('Caption style', Object.entries((caps && caps.captionStyles) || { pop: { label: 'Pop' } }).map(([k, v]) => [k, v.label]), 'captionStyle'),
            sel('Spoken language', LANGS, 'language'),
            sel('Hook preference', [['balanced', 'Balanced'], ['strong', 'Strong opening lines'], ['question', 'Questions & answers'], ['off', 'Ignore hooks']], 'hook'),
            sel('AI selection intensity', [['conservative', 'Conservative'], ['balanced', 'Balanced'], ['aggressive', 'Aggressive']], 'intensity'))),
        h('div', { class: 'card' }, h('div', { class: 'card-title' }, h('h2', null, 'This browser')),
          h('div', { class: 'row' },
            btn('Clear processing history', { cls: 'sm', onclick: () => { clearHistory(); toast('History cleared.'); } }),
            btn('Reset defaults', { cls: 'sm', onclick: () => { saveSettings({ gen: DEFAULTS.gen }); toast('Defaults restored.'); paint(); } }),
            btn('Forget backend & token', { cls: 'sm danger', onclick: async () => { if (!confirm('Forget the backend address and access token on this device?')) return; saveSettings({ apiBase: '', token: '' }); const { connect } = await import('../conn.js'); await connect(); toast('Forgotten.'); paint(); } })),
          oldDataBlock())));
  }
  function oldDataBlock() {
    const box = h('div', { style: { marginTop: '14px' } });
    const show = () => {
      box.replaceChildren(notice('', h('b', null, 'Data from the earlier Phase 2 version '), 'is still stored in this browser. The new app does not use it.', h('div', { class: 'row' }, btn('Remove it', { cls: 'sm danger', onclick: () => {
        const req = indexedDB.deleteDatabase('clipgen-ai-p2');
        req.onsuccess = () => { box.replaceChildren(); toast('Old data removed.', { kind: 'ok' }); };
        req.onerror = () => toast('Could not remove it.', { kind: 'bad' });
        req.onblocked = () => toast('Close other ClipGen tabs and try again.');
      } }))));
    };
    if (indexedDB && indexedDB.databases) indexedDB.databases().then((dbs) => { if (!dead && dbs.some((d) => d.name === 'clipgen-ai-p2')) show(); }).catch(() => {});
    return box;
  }
  paint();
  return () => { dead = true; off(); };
}
