# Deploying the ClipGen AI backend (step by step, works from an iPhone)

GitHub Pages can only host the web app (the buttons and screens). Cutting video needs a real server with FFmpeg,
so the backend in this folder runs separately, in Docker. You need **one** of the two options below.
Both have a free tier; free tiers are slow (see "Honest notes").

## Option A — Hugging Face Space (free, recommended)

1. Create a free account at huggingface.co, then tap **New → Space**.
2. Name it `clipgen-ai`, choose **SDK: Docker → Blank**, visibility **Public** (free Spaces need this) or Private, create it.
3. Add **one file** to the Space: tap **Files → Add file → Create a new file**, name it `Dockerfile`, and paste the contents of
   `backend/Dockerfile` from this repository. The image downloads the code from `github.com/Akshxt10/clipgen-ai` (branch `main`)
   while building, so the backend must already be pushed there. (To build another branch or fork, change `ARG REPO` / `ARG REF`.)
4. Open **Settings → Variables and secrets** and add:
   | Name | Type | Value |
   |---|---|---|
   | `ACCESS_TOKEN` | **Secret** | a long random password you invent (strongly recommended; the app asks for it once) |
   | `ALLOWED_ORIGINS` | Variable | `https://akshxt10.github.io` |
   | `SIGNING_SECRET` | **Secret** | another long random string (keeps download links valid across restarts) |
5. The first build takes 10–20 minutes (it compiles whisper.cpp and downloads the speech model). Wait for **Running**.
6. Your backend address is `https://<your-username>-clipgen-ai.hf.space`. Open it: it also serves the app itself.
7. In the app open **Settings → Backend**, paste that address (and the access token) and tap **Connect**.

## Option B — Render (free web service)

1. render.com → **New → Web Service → Public Git repository** → `https://github.com/Akshxt10/clipgen-ai`.
2. Runtime **Docker**, Dockerfile path `backend/Dockerfile` (the build fetches the code from GitHub itself).
3. Add the same environment variables as above. Set `PORT` to `7860` (the Dockerfile default) or remove it.
4. Free Render instances sleep after inactivity; the first request wakes them (about a minute).

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 7860 in Docker | listening port |
| `ACCESS_TOKEN` | empty | if set, every API call needs `Authorization: Bearer …`. **Set it on any public server.** |
| `ALLOWED_ORIGINS` | `https://akshxt10.github.io` | comma list of origins allowed by CORS (`*` for any) |
| `SIGNING_SECRET` | random per start | HMAC key for download/preview links |
| `DATA_DIR` | `/data` | where videos and renders live (temporary; cleaned automatically) |
| `RETENTION_HOURS` | 12 | projects older than this are deleted |
| `MAX_SOURCE_MB` / `MAX_DURATION_MIN` | 1024 / 120 | per-video limits |
| `MAX_DISK_MB` / `MAX_PROJECTS` | 6144 / 30 | storage quotas |
| `MAX_CONCURRENT_JOBS` | 1 | parallel analyses/renders |
| `WHISPER_MODEL_PATH` | `/models/model.bin` | speech model. Build arg `WHISPER_MODEL=base` (try `small` or `tiny`) |
| `WHISPER_BIN` | `whisper-cli` | whisper.cpp binary |
| `FACE_DETECT` | `auto` | `off` disables OpenCV face tracking (motion tracking still works) |
| `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL` | empty | **optional**: any OpenAI-compatible chat endpoint, used to re-rank clips and write titles. Without it the built-in scoring is used. |
| `RENDER_PRESET` | `veryfast` | x264 speed preset |
| `FFMPEG_THREADS`, `WHISPER_THREADS` | 4 | CPU threads |

Secrets (`ACCESS_TOKEN`, `SIGNING_SECRET`, `LLM_API_KEY`) are only ever set on the server, never in the web app or repository.

## Connecting the app by default (optional)

Anyone opening the app has to paste the backend address once (it is remembered on that device). To pre-fill it, edit
`phase2/config.js`: `export const DEFAULT_API_BASE = 'https://<your-username>-clipgen-ai.hf.space';` and push.
Never put the access token there.

## Honest notes

- Free CPUs are slow: expect analysis of a 10-minute video to take several minutes, and each clip render tens of seconds.
- Free Hugging Face/Render disks are not permanent. That is fine: projects expire after `RETENTION_HOURS` anyway.
- The Docker image has not been built by the author in the sandbox (no Docker there). If the build fails, send the build log.
- Speech recognition quality depends on the model (`base` is fast and decent; `small` is better and slower).
