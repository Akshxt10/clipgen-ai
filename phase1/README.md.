
# ClipGen AI · Phase 1 — foundation

Open: `https://akshxt10.github.io/clipgen-ai/phase1/`

Separate from `phase0/` (which is untouched). Plain HTML/CSS/JS, no build step, no paid services.

## What works
- Import MP4 / MOV; preview; file name, duration, size, resolution
- Projects saved in the browser (IndexedDB): project info, clips, analysis, optional copy of the video
- Manual clip list (Set IN / Set OUT, rename, adjust, play, delete)
- Audio loudness map (experimental): loudness every 0.5 s + the loudest moments

## What does NOT exist yet
- Automatic highlight detection (the app says so; nothing pretends otherwise)
- Captions, studio editing, 9:16 export

## Files (all in this folder)
`index.html` · `styles.css` · `app.js` · `db.js` · `audio.js` · `timeline.js` · `ffmpeg-engine.js` · `ffmpeg-worker.js`

Audio analysis loads the same single-thread FFmpeg.wasm core as Phase 0 from a free CDN (~32 MB, once).
