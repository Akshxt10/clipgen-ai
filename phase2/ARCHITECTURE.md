# ClipGen AI — architecture (Phase 2 design, v2: creator authorization)

This document says what exists, what is only planned, and the rules every future stage must follow.
`pipeline.js` is the machine-readable twin of the tables below; the app's status panel is drawn from it.

## 1. Hard rules (legal and technical)

1. **The pipeline's only input is a file** — either one the user provides, or the creator's own original file
   fetched from the creator's own host under a signed approval (section 8). A YouTube link is a *reference* shown
   in YouTube's official embedded player. It is never a source of video or audio data.
2. ClipGen AI never downloads, records, scrapes or extracts YouTube content. No yt-dlp, no unofficial APIs, no
   "download" sites, no capturing the player. The embed is not modified, overlaid, or ad-blocked.
3. A YouTube project's file is either **verified** (creator registered + verified by the maintainer, video approved
   in the creator's signed manifest, file equals the signed SHA-256 — no checkbox needed) or **self-declared** (the
   user confirms they own the video or have permission; stored with timestamp and wording and always labelled
   "not verified"). A description, a public statement or a checkbox alone never makes a source "verified".
4. YouTube metadata (title, channel) is display-only, fetched live, and **not saved**. Only the video ID,
   the link kind and the start time (all supplied by the user's own link) are stored.
5. ₹0: no paid API, no server, no account. Everything runs in the browser; files never leave the device.
6. A stage may show "Built" only after it is implemented **and** tested on a real iPhone.

## 2. Data flow

```
 YouTube link ──► official player (display only)            ┐
                                                             ├─ project (IndexedDB)
 creator-approved file (signed, hash-checked)  ─┐
 or your own self-declared file (MP4/MOV) ──────┴► SOURCE   ┘
                                      │
                       AUDIO  (FFmpeg.wasm → 8 kHz mono PCM)          built (experimental)
                                      │
              TRANSCRIPT (on-device speech-to-text, word times)       planned
                                      │
        SCORING (loudness + speech density + keywords → 0..1)         planned
                                      │
           CLIP PLAN (top windows → start/end/label, you approve)     planned
                                      │
        CAPTIONS (word-timed, drawn per clip)        EXPORT 9:16     planned
                                      └───────────────► MP4 (FFmpeg.wasm, one clip at a time)
```

| Stage | Status | Input | Output (stored) |
|---|---|---|---|
| YouTube link + player | built | pasted link | `project.source` |
| Title / channel | experimental | oEmbed (public) | nothing |
| Creator registry + signed manifests | experimental | `registry/creators.json` + creator's manifest | `project.authorization`, `authlog` |
| Fetch creator's original file | experimental | URL inside the signed grant | `blobs[projectId]` |
| Self-declared source file | built | file you choose | `blobs[projectId]`, `project.authorization` |
| Direct upload | built | file you choose | `projects`, `blobs` |
| Audio loudness map | experimental | source file | `analysis[projectId]` |
| Manual clips | built | player time | `clips[]` |
| Transcription | **planned** | audio | `transcripts[projectId]` |
| Highlight scoring | **planned** | analysis + transcript | `scores[projectId]` |
| Auto clip plan | **planned** | scores + transcript | `clips[]` (`source:"auto"`) |
| Captions | **planned** | transcript words in a clip | caption style + subtitle data |
| 9:16 export | **planned** | file + clip + captions | downloadable MP4 |

## 3. Storage (IndexedDB)

Phase 2 uses its own database, `clipgen-ai-p2` (Phase 1 keeps `clipgen-ai`). Two phases sharing one database
would lock each other out the first time either bumped its version, so they stay apart. Phase 1 projects are
not shown in Phase 2 and are never modified.

Stores: `projects`, `clips` (index `projectId`), `blobs`, `analysis`, and (since v2 of the database) `authlog` (index `projectId`).
Upgrade 1 → 2 runs inside IndexedDB's upgrade transaction: it adds `authlog`, tags every existing checkbox authorization `method:'self-declared'` and sets `schema:3`. Projects, clips, saved videos and analysis are never deleted or rewritten otherwise.

```
project  { id, name, schema:3, createdAt, updatedAt,
           source: {kind:'upload'} | {kind:'youtube', videoId, linkKind, startSec, url, addedAt},
           authorization: null
              | {method:'self-declared', confirmed, at, statement, version}          // user's claim, NOT verified
              | {method:'creator-grant', creatorId, displayName, keyId, verifiedAt, identity, grant, fileVerified, at},
           video: {name,size,type,lastModified,duration,width,height},   // the user's own file
           hasBlob, thumb, clipCount, analysisStatus, analysisSummary, analysisError }
clip     { id, projectId, start, end, label, source:'manual'|'loudness'|'auto', createdAt }
analysis { projectId, version, windowSec, rmsDb, peakDb, stats, moments, probe, engine, ... }
authlog  { id, projectId, at, event, code, creatorId, keyId, detail }   // check / file-verified / file-rejected / self-declared
```

Planned (arrive through a normal **version 3 upgrade of this same database**, `onupgradeneeded` only adds stores):

```
transcripts { projectId, model, language, segments:[{start,end,text,words:[{t0,t1,w}]}] }
scores      { projectId, version, windowSec, values:Float32Array, parts:{loud,speech,keywords} }
```

Every stored analysis carries a `version`; if an algorithm changes, old results are recomputed, not migrated.

## 4. Module contracts (for the planned stages)

Each stage is one ES module that imports nothing from the UI and talks to the rest through plain data.

```js
// transcribe.js (planned)   audio PCM  → segments
startTranscription(source, { onProgress, onLog })  → { promise, cancel }   // same shape as audio.js startAnalysis
// highlights.js (planned)   analysis + transcript → scores
scoreWindows({ analysis, transcript, settings })   → { values, parts }      // pure function, unit-testable
// planner.js (planned)      scores → clip candidates
planClips({ scores, transcript, minSec, maxSec, count }) → [{start,end,label,confidence}]  // pure
// captions.js (planned)     words in [start,end] → subtitle data
buildCaptions({ words, style })                    → subtitleData
// export.js (planned)       one clip → MP4
exportClip({ source, clip, captions, preset:'9:16-720p' }) → { promise, cancel } → Blob
```

`startAnalysis` in `audio.js` is the template: it returns `{promise, cancel}`, reports progress, terminates its
engine in a `finally`, and never keeps the whole file in memory (WORKERFS mount, chunked reads).

## 5. iPhone budget and risks

* One FFmpeg.wasm job at a time (single-thread core, ~32 MB download). Keep the screen on (Wake Lock).
* Transcription is the biggest unknown: a Whisper-class model means a large one-time download and minutes of
  CPU per hour of audio. **First task for that stage: a Phase-0-style benchmark page on a real iPhone**
  (download size, speed, memory) before any integration.
* Export of long clips can exceed memory: cut the clip with `-ss/-t` first, then filter, as Phase 0 did.
* Safari may evict site data: keep the "Protect my data" button and keep sources re-attachable.
* Highlight quality cannot be assumed: build a small set of hand-chosen "good clips" per test video and
  measure how often the scorer's top picks overlap them. Only then switch the feature on.

## 6. Build order (smallest risk first)

1. Device-test Phase 2 (links, player, creator authorization with a real creator and file host, file, analysis).
2. Transcription benchmark page (`phase3-bench/`), separate from the app.
3. `transcripts` store + transcript viewer with tap-to-seek (no scoring yet).
4. Scoring v1 (loudness + speech density) + a visible "why this moment" explanation.
5. Planner + review screen (approve / edit / reject each suggested clip).
6. Export 9:16 with static captions, then word-by-word animation.

## 7. Known limits of Phase 2

* Duration is **not** available from a link (oEmbed does not provide it; the YouTube Data API needs a key).
  The duration shown is that of your file. The app cannot check that the file matches the link.
* Title/channel depend on YouTube answering the browser; when it does not, the player and workflow still work.
* Videos with embedding disabled may show "unavailable" inside the player. The app cannot detect that.

## 8. Creator authorization (v2)

**Why not "approve → download from YouTube"?** YouTube's Terms forbid accessing or downloading videos except as the
service itself permits, the Data API has no endpoint that returns video media, and the API terms grant no right to
copy audiovisual content. A creator saying "yes" cannot grant what YouTube has not granted. So the only legitimate
automatic route is a file the **creator supplies from their own storage**. Details: `CREATOR-AUTHORIZATION.md`.

```
 paste link ─► parse ID ─► oEmbed (author)  ─┐
                                              ├─► authz.evaluateYouTubeSource()
 registry/creators.json (maintainer-verified) ┤       registry loaded? creator listed? status=verified?
 creator's signed manifest (creator's host) ──┘       author matches? manifest signature valid for registered key?
                                                      creator id / dates ok? this video listed + clipping allowed?
                       verified ─► source-fetch.fetchSourceFile(): download from the SIGNED url, hash while streaming,
                                   keep only if size + SHA-256 equal the signed values ─► same engine as an upload
                       otherwise ─► explain exactly what is missing; self-declared route (labelled "not verified")
```

| Module | Role |
|---|---|
| `crypto-utils.js` | canonical JSON, streaming SHA-256, ECDSA P-256 sign/verify, key thumbprint (WebCrypto, no library) |
| `authz.js` | registry validation, manifest verification, the verdict and its checklist (pure; network injected) |
| `source-fetch.js` | hash-while-downloading fetch of the creator's file, rejects any mismatch |
| `creator.html` / `creator.js` | Creator Studio: key, registration request, manifest builder + signer, checker |
| `registry/creators.json` | creator registry. **Ships empty**; only the maintainer adds verified entries |

Re-check: every time a YouTube project opens, the approval is evaluated again. A revoked creator, a bad signature,
an expired manifest or a video removed from the manifest **blocks** the project (video hidden, analysis disabled).
If the registry or host simply cannot be reached, the project keeps working and says it could not re-check.

Trust anchor: the ClipGen maintainer's registry (a file in this repository). Anyone can build a manifest; only a
registry entry set to `verified` by the maintainer makes ClipGen accept it.

Known limits: creator hosts must send CORS headers; channel matching is by handle unless the entry has a channel ID;
expiry/replay protection is only `expiresAt`; an iPhone cannot hold multi-GB files in memory (auto-fetch ≤ 200 MB,
refuse > 3 GB); nothing here has been tested with a real creator, host or on iPhone Safari.
