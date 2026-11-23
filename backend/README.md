# ClipGen AI backend

Zero-dependency Node ≥ 20 service that does the real work: fetches or receives a video, transcribes it (whisper.cpp),
analyses audio/scenes, ranks clip candidates, reframes and renders with FFmpeg, burns captions, and serves previews,
downloads and ZIPs. See `DEPLOY.md` to run it and `../phase2/ARCHITECTURE.md` for the design.

```
npm start                # node src/index.js   (needs ffmpeg + ffprobe on PATH)
npm test                 # unit + API tests (real FFmpeg, synthetic videos)
node test/e2e/e2e.mjs    # browser E2E (needs Playwright + Chromium)
```

## API (all JSON; `Authorization: Bearer <ACCESS_TOKEN>` when configured)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | public liveness |
| GET | `/api/capabilities` | version, ffmpeg, transcription, face tracking, LLM, limits |
| POST | `/api/sources/inspect` | `{url}` → classification, metadata, whether it can be fetched |
| POST | `/api/projects/url` | `{url}` → job that downloads a direct video file |
| POST/GET/PUT/DELETE | `/api/uploads[/:id]` , `POST /api/uploads/:id/complete` | chunked, resumable upload (`PUT ?offset=`) |
| GET/DELETE | `/api/projects[/:id]` | list / read / delete |
| POST | `/api/projects/:id/analyze` | settings → analysis job |
| GET | `/api/projects/:id/analysis`, `/words` | results, word-level transcript |
| PATCH | `/api/projects/:id/clips/:cid` | edit trim, captions, style, aspect |
| POST | `/api/projects/:id/clips/:cid/regenerate` / `/render` | next-best alternative / render one |
| POST | `/api/projects/:id/render-all`, `/zip-link` | render everything / signed ZIP URL |
| GET/POST | `/api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/cancel` | job status and cancellation |
| GET | `/media/:id/{source,poster,thumb/:cid,render/:file,zip/:ids}?exp&sig` | signed, Range-capable media |

## Security model

- Links must be public `http(s)` hosts. DNS is resolved server-side, every address must be public, the connection is pinned
  to the checked IP, redirects (≤ 5) are re-validated, ports limited. Private/loopback/link-local/metadata ranges are refused.
- Streaming-platform pages (YouTube, TikTok, Instagram …) are **not** downloaded; the API answers `422 unsupported-source`
  and the app offers upload. No DRM/login/paywall circumvention, no scraping, no unofficial APIs.
- Size, duration, disk, project and request-rate limits; retention sweep; per-clip render cache pruning.
- Optional bearer token (timing-safe compare), CORS allow-list, HMAC-signed media URLs with expiry.
