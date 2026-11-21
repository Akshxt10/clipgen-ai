# ClipGen AI · Phase 2 — YouTube links + creator-approved source files

Open: `https://akshxt10.github.io/clipgen-ai/phase2/` · Creators: `…/phase2/creator.html`

Separate from `phase0/` and `phase1/` (both untouched). Plain HTML/CSS/JS, no build step, no paid services.
Uses its own browser database (`clipgen-ai-p2`, now version 2 — upgraded in place, nothing is deleted).

## What works
- Paste a YouTube link (watch?v= · youtu.be · live · shorts) → validated → shown in YouTube's official player
- Public title and channel (best effort, shown live, never saved)
- **Creator check:** the app looks the channel up in the creator registry and reads the creator's signed approval.
  If the creator is verified and approved the video, their original file is fetched from *their own host* and kept
  only if it matches the SHA-256 they signed — no checkbox, no manual upload. Shown as “Verified source”.
- If not verified, the app says exactly why and what is needed; you may still choose your own file and declare you
  own it or have permission (labelled “Self-declared · not verified”)
- Revoked / expired / invalid approvals block the project; unreachable hosts only produce a “could not re-check” note
- **Creator Studio:** key, registration request, signed manifest builder, checker
- Same Phase 1 engine for preview, loudness map, manual clips; direct upload unchanged

## What does NOT exist
Transcription · automatic highlight detection · automatic clips · captions · 9:16 export.
ClipGen AI never downloads or extracts anything from YouTube — see `CREATOR-AUTHORIZATION.md` for why a creator's
approval cannot change that and what is done instead. **No creator is registered yet** (`registry/creators.json` is
empty), so today every YouTube link takes the self-declared route.

## Tested vs not tested
Tested: unit tests (crypto, trust engine, URL parsing) and a headless-Chromium end-to-end suite with synthetic
creators, a cross-origin file host, tampered/expired/forged/revoked cases, DB migration and Creator Studio round trip.
Not tested: a real creator, a real file host (CORS behaviour), real YouTube, iPhone Safari.

## Files (all in this folder)
`index.html` · `styles.css` · `app.js` · `youtube.js` · `pipeline.js` · `db.js` · `audio.js` · `timeline.js` ·
`ffmpeg-engine.js` · `ffmpeg-worker.js` · `crypto-utils.js` · `authz.js` · `source-fetch.js` · `creator.html` ·
`creator.js` · `registry/creators.json` · `ARCHITECTURE.md` · `CREATOR-AUTHORIZATION.md`

`audio.js`, `timeline.js`, `ffmpeg-engine.js`, `ffmpeg-worker.js` are exact copies of the Phase 1 files.
