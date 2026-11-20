# ClipGen AI — architecture (Phase 2 design)

This document says what exists, what is only planned, and the rules every future stage must follow.
`pipeline.js` is the machine-readable twin of the tables below; the app's status panel is drawn from it.

## 1. Hard rules (legal and technical)

1. **The pipeline's only input is a file the user provides.** A YouTube link is a *reference* shown in YouTube's
   official embedded player. It is never a source of video or audio data.
2. ClipGen AI never downloads, records, scrapes or extracts YouTube content. No yt-dlp, no unofficial APIs, no
   "download" sites, no capturing the player. The embed is not modified, overlaid, or ad-blocked.
3. The user must confirm they own the video or have permission before choosing a file for a YouTube project
   (stored on the project with a timestamp and the exact wording).
4. YouTube metadata (title, channel) is display-only, fetched live, and **not saved**. Only the video ID,
   the link kind and the start time (all supplied by the user's own link) are stored.
5. ₹0: no paid API, no server, no account. Everything runs in the browser; files never leave the device.
6. A stage may show "Built" only after it is implemented **and** tested on a real iPhone.

## 2. Data flow

```
 YouTube link ──► official player (display only)            ┐
                                                             ├─ project (IndexedDB)
 your authorized file (MP4/MOV) ──► SOURCE                   ┘
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
| Authorized source file | built | file you choose | `blobs[projectId]`, `project.authorization` |
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

Stores in v1: `projects`, `clips` (index `projectId`), `blobs`, `analysis`.

```
project  { id, name, schema:2, createdAt, updatedAt,
           source: {kind:'upload'} | {kind:'youtube', videoId, linkKind, startSec, url, addedAt},
           authorization: null | {confirmed, at, statement, version},
           video: {name,size,type,lastModified,duration,width,height},   // the user's own file
           hasBlob, thumb, clipCount, analysisStatus, analysisSummary, analysisError }
clip     { id, projectId, start, end, label, source:'manual'|'loudness'|'auto', createdAt }
analysis { projectId, version, windowSec, rmsDb, peakDb, stats, moments, probe, engine, ... }
```

Planned (arrive through a normal **version 2 upgrade of this same database**, `onupgradeneeded` only adds stores):

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

1. Device-test Phase 2 (links, player, authorization, file, analysis).
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
