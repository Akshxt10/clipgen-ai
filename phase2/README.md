# ClipGen AI · Phase 2 — YouTube links + authorized source file

Open: `https://akshxt10.github.io/clipgen-ai/phase2/`

Separate from `phase0/` and `phase1/` (both untouched). Plain HTML/CSS/JS, no build step, no paid services.
Uses its own browser database (`clipgen-ai-p2`), so Phase 1 projects are not affected either way.

## What works
- Paste a YouTube link (watch?v= · youtu.be · live · shorts) → validated → shown in YouTube's official player
- Public title and channel (best effort, shown live, never saved)
- For clipping: confirm you own the video or have permission, then choose the MP4/MOV yourself
- That file uses the same engine as Phase 1: preview, loudness map, manual clips, local projects
- Direct video upload is unchanged

## What does NOT exist yet (planned)
Transcription · automatic highlight detection · automatic clips · captions · 9:16 export.
A YouTube link on its own cannot produce clips: ClipGen AI never downloads or extracts anything from YouTube.

## Files (all in this folder)
`index.html` · `styles.css` · `app.js` · `youtube.js` · `pipeline.js` · `db.js` · `audio.js` · `timeline.js` ·
`ffmpeg-engine.js` · `ffmpeg-worker.js` · `ARCHITECTURE.md`

`audio.js`, `timeline.js`, `ffmpeg-engine.js`, `ffmpeg-worker.js` are exact copies of the Phase 1 files.
See `ARCHITECTURE.md` for the design of the planned stages.
