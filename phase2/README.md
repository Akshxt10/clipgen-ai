# ClipGen AI — Phase 2

Paste a link or upload a video → AI finds the best moments → pick, edit and download vertical clips with captions.

Web app: `https://akshxt10.github.io/clipgen-ai/phase2/` (static, hosted on GitHub Pages).
It needs the **ClipGen backend** (folder `../backend`, Docker) because cutting video can't run on GitHub Pages.
Setup: `../backend/DEPLOY.md`. Phase 0 and Phase 1 are separate and untouched.

## How it works for the user
1. **Settings → Backend**: paste your backend address (and access token if you set one) → Connect. Remembered on the device.
2. **Video input**: paste a direct video link (an `.mp4/.mov/.webm…` file URL, a Dropbox/Drive-style direct link), or **Upload** a file
   (chunked, resumable, with progress).
3. Choose clip settings: clip count, min/max length, platform (default YouTube Shorts), aspect, caption style, hook preference,
   language, intensity.
4. **AI analysis**: transcription with word timestamps, loudness and scene analysis, scoring → ranked clips (0–100 with reasons).
5. **Preview** the real video segment with captions, **edit** (trim, caption text/style, aspect, reframing), **regenerate** a clip,
   **render** it, **download** one MP4 or **Download all (ZIP)**.
6. Library and History keep your projects/renders list on the device; the server deletes videos after the retention time (12 h by default).

Sections: Dashboard · Video input · Upload · AI analysis · Clip generation · Clip editor · Clips library · Processing history · Settings · About.

## What it does not do (by design)
- It does **not** download from YouTube, TikTok, Instagram, Facebook, X, Vimeo, Twitch, etc. Those pages don't give a video file;
  the app says so and offers upload. No yt-dlp, scraping, unofficial APIs or DRM/login circumvention.
- Users are responsible for having the rights to the videos they process.

## Files
`index.html`, `styles.css`, `app.js` (router), `config.js` (default backend address), `js/` (api, conn, state, ui, preview,
components, views/*). Plain ES modules, no build step.
