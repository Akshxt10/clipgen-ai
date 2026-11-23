# ClipGen AI — architecture (Phase 2)

```
 iPhone / browser ── GitHub Pages: phase2/ (static, ES modules) ──HTTPS, CORS, optional Bearer──► backend (Docker)
                                                                                   │
        direct video URL ─► SSRF-safe fetch ┐                                      ├─ FFmpeg / ffprobe
        chunked upload (resumable) ─────────┴─► project on disk ─► job queue ─────►├─ whisper.cpp (words + timestamps)
                                                                                   ├─ OpenCV Haar faces (optional)
                                                                                   └─ OpenAI-compatible LLM (optional)
```

## Frontend (`phase2/`)
- Hash router (`app.js`) lazy-loads views: dashboard, add (link/upload), project (settings → analysis progress → clips), editor, library, history, settings, about.
- `api.js` (fetch wrapper, auth header, error mapping), `conn.js` (connection state, capabilities), `state.js` (settings + history in localStorage),
  `preview.js` (plays the real source segment with a DOM caption overlay), `addbox.js` (link check, resumable XHR upload with pending-upload record).
- Job polling with retries; reloading mid-analysis resumes from the server's job state. No secrets in the frontend; backend address/token are user settings.
- Premium dark, mobile-first UI (bottom tab bar on phones, top nav on desktop).

## Backend (`backend/src/`)
| Module | Role |
|---|---|
| `server.js` | routes, CORS, bearer auth, rate limit, signed media with Range, upload, ZIP, optional static serving |
| `ssrf.js`, `sources.js` | URL validation, DNS pinning, redirect re-validation, platform classification, oEmbed preview, content checks |
| `store.js`, `jobs.js` | projects on disk, quotas, retention sweep; queue with progress, cancellation, restart recovery |
| `media.js` | ffprobe, 16 kHz audio, loudness windows, scene detection, thumbnails |
| `transcribe.js`, `lexicon.js` | whisper.cpp JSON → word timeline; keyword/hook/emotion cues |
| `analyze.js`, `llm.js` | candidate generation, scoring, selection (no overlap, no near-duplicates, sentence/pause-aligned), optional LLM re-rank |
| `captions.js` | ASS subtitles: pop, karaoke, classic, minimal, neon, impact |
| `reframe.js`, `tools/face_track.py` | smart crop path: faces → motion centroid → centre; smoothed; blur-fill and passthrough |
| `render.js`, `pipeline.js` | FFmpeg filter graph (libx264 + AAC, faststart), render cache keyed by option hash |
| `zip.js` | streaming ZIP writer |

## Analysis
Word timestamps are grouped into sentences; candidate runs are scored on energy, peaks, variation, speech rate, density, hook/question/emotion/
surprise/humour/information/story cues, scene changes, completeness and length fit → 0–100. The picker enforces length range, no overlap,
Jaccard de-duplication and gaps; boundaries snap to pauses so cuts don't land mid-sentence. Without a transcript it falls back to audio/visual
scoring and says so. Categories and "reasons" are heuristic cues, not human-level understanding.

## Security & limits
SSRF defences (public hosts only, pinned IPs, ≤5 re-validated redirects), no platform downloading, size/duration/disk/project/rate limits,
HMAC-signed expiring media URLs, optional bearer token, CORS allow-list, retention sweep, secrets only in server environment.

## Testing
`backend/test`: 19 unit + 23 API tests (real FFmpeg on synthetic videos) and a Playwright Chromium end-to-end run on a phone viewport with the app
and backend on different origins. Speech recognition is replaced by a test double in tests (no model in the dev sandbox).
