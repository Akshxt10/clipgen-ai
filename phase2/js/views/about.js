import { h } from '../util.js';
import { conn } from '../conn.js';
import { setTitle } from '../ui.js';
import { DEPLOY_URL } from '../components.js';

export async function mount(root) {
  setTitle('About');
  const li = (...k) => h('li', null, ...k);
  root.replaceChildren(
    h('div', { class: 'page-head' }, h('div', null, h('h1', null, 'About ClipGen AI'), h('p', null, 'Turns long videos into short, captioned, vertical-ready clips.'))),
    h('div', { class: 'stack' },
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'How it works'),
        h('ol', { class: 'muted', style: { paddingLeft: '20px', margin: 0, display: 'grid', gap: '8px' } },
          li(h('b', { style: { color: 'var(--text)' } }, 'Add a video. '), 'Paste a direct link to a video file or upload one. The real file is stored on your own ClipGen server.'),
          li(h('b', { style: { color: 'var(--text)' } }, 'Analyse. '), 'FFmpeg extracts the audio; whisper.cpp transcribes it with word timestamps; loudness and scene changes are measured.'),
          li(h('b', { style: { color: 'var(--text)' } }, 'Generate. '), 'Candidate moments are scored (hooks, questions, emotion, surprise, humour, information, storytelling, energy) and the best distinct ones are cut at sentence boundaries.'),
          li(h('b', { style: { color: 'var(--text)' } }, 'Refine. '), 'Trim, edit captions, change style and format, regenerate a clip.'),
          li(h('b', { style: { color: 'var(--text)' } }, 'Render & download. '), 'FFmpeg cuts the real video, reframes it, burns captions and exports an MP4 (or a ZIP of several).'))),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'What to expect'),
        h('ul', { class: 'muted', style: { paddingLeft: '20px', margin: 0, display: 'grid', gap: '8px' } },
          li('Links must point to the video file itself. Pages of video sites (YouTube, TikTok, Instagram …) are not video files and are not fetched; upload the file instead.'),
          li('“Engagement score” is an estimate from measurable signals in your video. It is not a guarantee of how a clip will perform.'),
          li('Moment categories (hook, funny, emotional …) come from wording and audio cues, so they can be wrong. Always preview.'),
          li('Transcription accuracy depends on audio quality, language and the speech model installed on your server.'),
          li('Smart framing follows faces when OpenCV is available, otherwise motion. It can misjudge crowded or fast scenes; switch to Center or Blur fill.'),
          li('Files are deleted from the server automatically after a retention period.'))),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Your videos and your responsibility'),
        h('p', { class: 'muted' }, 'Your video is sent to the ClipGen backend you configured — nowhere else (unless you enabled the optional AI review on your server, which sends only short transcript excerpts to the LLM service you chose). You are responsible for having the rights to the videos you process and publish. ClipGen AI respects technical protections: it does not bypass sign-ins, DRM or platform restrictions.')),
      h('div', { class: 'card' }, h('h2', { style: { marginBottom: '10px' } }, 'Technical'),
        h('dl', { class: 'kv' }, h('dt', null, 'App'), h('dd', null, 'Phase 2 · v' + (conn.caps ? conn.caps.version : '1.0.0')), h('dt', null, 'Frontend'), h('dd', null, 'static pages, no build step'), h('dt', null, 'Backend'), h('dd', null, 'Node.js · FFmpeg · whisper.cpp · OpenCV')),
        h('p', { style: { marginTop: '12px' } }, h('a', { href: DEPLOY_URL, target: '_blank', rel: 'noopener', style: { color: 'var(--accent-2)' } }, 'Backend setup guide →'))),
      h('p', { class: 'small muted' }, 'Phase 0 (FFmpeg test) and Phase 1 (local analysis) remain available at ', h('a', { href: '../phase0/', style: { color: 'var(--accent-2)' } }, 'phase0'), ' and ', h('a', { href: '../phase1/', style: { color: 'var(--accent-2)' } }, 'phase1'), '.')));
  return () => {};
}
