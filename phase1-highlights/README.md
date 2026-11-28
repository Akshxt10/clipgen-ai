# ClipGen AI · Phase 1 · step 1 — automatic highlight detection (`phase1-highlights/`)

Open: `https://akshxt10.github.io/clipgen-ai/phase1-highlights/`

Builds on the confirmed speech-caption checkpoint (`phase0-speech/`, passed on iPhone 15 with Whisper base.en).
`phase0/`, `phase1/` and `phase0-speech/` are **not modified**. This page imports the video engine and the recognizer
straight from `../phase0-speech/`, so the passed pipeline is reused, not rebuilt.

## What it does (all on the device, ₹0, nothing uploaded)
1. Opens your video (mounted, not copied) and extracts 16 kHz mono audio (same call as the caption test).
2. Measures loudness every 0.25 s.
3. Recognizes speech with word timestamps (same Whisper files as the caption test).
4. Scores and picks clips with `analyze.js` — the backend's already-tested scoring/selection code, unchanged
   (a test fails if the copy ever drifts from `backend/src/analyze.js`). Signals: loudness/peaks/variation, speech rate,
   hook / question / emotion / surprise / humour / information / story cues, sentence + pause completeness, length fit.
5. Shows ranked clips with a score, labels, plain-language reasons, transcript, time in your video, a loudness map and a
   Preview button (plays that part of your original video).
6. Automatic checks: clips in range, no overlaps, cuts fall between words, clip text equals the words inside it.

## Quality pass (after the first real-iPhone test of IMG_4714.mov)
Real-device feedback: some clips ended mid-sentence ("…the ad-"), one transcript was garbled, and a clip claimed scene cuts although
no scene detection had run. Fixes in `analyze.js` (shared with `backend/src/analyze.js`, kept identical by a test):
- **Whole sentences.** Units cut only by the length rule are now marked as forced mid-sentence splits. A clip that ends on one, or on a
  dangling word / dash / comma ("the", "and", "ad-"), or starts right after one, has its score scaled down and shows a ⚠ warning.
  Clips that end on a full stop are preferred.
- **Transcript reliability, indirectly.** Whisper cannot tell us which of its words are wrong, and the recognizer used here does not return
  per-word confidence, so this is NOT error detection. Used instead: words timed over near-silent audio, implausible word lengths, and
  runaway repetition. A clip scoring low on these is scaled down and shows "Transcript may be unreliable". If a recognizer ever supplies a
  per-word confidence `p`, it is used. An ordinary mis-hearing (e.g. "soil" for "so") is not detectable and will still get through.
- **Truthful reasons.** Scene-cut reasons and scene weight exist only when cuts were detected. This page does not run scene detection, so it
  never shows one. When cuts exist, the reason states the real count inside the clip.
- **Hard limits.** Clips always stay inside the video, within your shortest/longest length (padding can no longer push past the maximum),
  and never overlap (the "More clips" setting used to allow 10% overlap; it no longer does).

## Fewer clips than requested (after the second iPhone run)
Run on IMG_4714.mov (45 s narration) returned 1 clip for "3 clips": only one moment scored above the cutoff, and the page did not say so.
Now: the results say "N of M requested clips scored above the cutoff", and next-best moments from a more permissive pass are listed after them,
labelled **weaker** (never overlapping the strong ones). If none exist it says why and what to try.
Correction: the "…ad -" ending seen in the first test report was the REPORT cutting each clip's text at 140 characters, not necessarily a real
clip boundary. The report now carries the full clip text. (The mid-sentence protections from the quality pass are still real and tested.)

## Memory safety and crash recovery (after a real-iPhone run stopped during “Recognize your speech”)
The cause on that phone is NOT confirmed (the sandbox cannot see iPhone memory). Two likely contributors were removed, and recovery was added:
- The video engine stays loaded while Whisper loads → it is now released right after the audio is extracted.
- All the audio went to Whisper in one call → it is now recognized in parts of ~20 s (never more than 27 s), cut at the quietest moment
  near each target so a word is not sliced. Each part's start offset is applied to its word times, so the timeline is exact
  (a test proves chunked output equals a single pass). The speech engine is rebuilt every 4 parts to give its memory back.
- Every finished part is saved (localStorage, 24 h, tied to the exact file + settings + model). After a crash, choose the same video again
  and tap Find highlights: saved parts are reused and only the rest is recognized. Another video, other settings or another model never reuse them.
- The page writes breadcrumbs as it runs. After a crash the next load says which step and speech part it stopped in, whether the page was in
  the background / phone locked, how many parts were saved and what to do, restores your settings, and offers the smaller model.
  Closing or reloading the page is told apart from a silent kill. The screen-lock request is renewed when Safari comes back to the front.
- Limits: if the phone is short of memory, the smaller model may still be needed; I cannot promise this fixes your phone until you re-test.
  Resume needs the same file re-selected (Safari cannot keep a file across reloads).

## Honest limits
- Scores are **heuristics**, not human judgement. The automatic checks prove the clips are well-formed, not that they are good.
  Whether they are good highlights is your call (the page asks).
- English cue lists (hooks, emotions …). Other languages fall back mostly to loudness/rate.
- No scene-cut signal yet.
- If nothing qualifies, the page relaxes the settings step by step and tells you; if it still finds nothing it says so.
- If no usable transcript, it uses loudness only and labels the result.
- Window is capped at 600 s per run; recognition speed on a phone is measured by the report, not assumed.
- Chunk-border words: a word cut by a part border can lose its tail; cuts are placed in pauses to make this rare.

## Tests (`node --test phase1-highlights/tests/*.test.mjs`)
- `logic.test.mjs`: drift guard, loudness maths, ranking on a labelled synthetic signal + fixture transcript, determinism, audio-only mode, silence → zero clips, clip checks.
- `page.test.mjs`: the real page in headless Chromium with stand-ins (native ffmpeg for the engine, fixture words for the recognizer).
  Also: offset start, nothing recognized, short clip, silent video, blocked CDN, no audio track.
Real Whisper recognition and the quality of picks on real content are **not** testable in the sandbox.

## Step 2 — export the chosen clips as 9:16 MP4s (`export.js`, new)
Each clip card has an **Export this clip** tick box (strong clips ticked, weaker ones not), then **Export selected clips**.
For every ticked clip, on the phone, nothing uploaded:
1. **Cut** from the original video at the clip's exact start/end (analysis start + clip start; the length is floored, so it never runs past the requested end or past the analysed part).
2. **9:16, 720×1280** with the same centre-crop + scale filter as the passed speech-caption export.
3. **Captions** from the words Whisper already recognized (no second recognition). Words are shifted so the clip starts at 0 s; a word belongs to a clip when its middle lies inside it;
   times are clamped to the clip, so no caption can appear before its speech or outlive the clip. Same ASS/libass karaoke captions and bundled Poppins font as the passed export.
   No words inside a clip → exported without captions and the card says so (nothing is invented).
4. **H.264/AAC MP4**: the encoder arguments are identical to the passed export (a test compares them token by token against `phase0-speech/app.js`).
5. **Checked before it is offered**: the file's size/codecs/length are read back (must be 720×1280 H.264/AAC, never longer than requested), one frame is decoded from the output, and
   a caption-visibility check compares an exported frame with the same source frame (it says "inconclusive" for fast-moving pictures instead of guessing). A clip that fails the check shows an error and **no** download.
6. **Download MP4** (a normal download link with a real file name; iPhone Safari puts it in Files → Downloads) and, only if the browser supports sharing files, **Share / Save …** which opens the share sheet
   (normally with “Save Video” for Photos and “Save to Files”). **Direct saving to Photos is not implemented**, and neither the download nor the share sheet has been confirmed on a real iPhone yet.

Memory: one clip at a time; a **fresh video engine per clip, terminated afterwards** (WebAssembly memory only grows, so this is how it is handed back); the source is mounted in place, never copied
(if mounting fails the export refuses rather than copying a big video); Whisper is not loaded; the analysis audio is freed before export; each finished clip is kept only as a file (Blob), not as extra buffers.
Cancel keeps finished clips and drops the running one. A failed clip does not stop the others; **Export** again retries only what is missing. If the engine cannot start at all, the rest are not tried.
If Safari kills the tab during export, the next load says which clip it was. Limit: after a finished analysis the saved speech parts are cleared, so after a crash the video must be analysed again (about a minute) before exporting.

Tests: `tests/export.test.mjs` (maths, the Phase 0 filter/encoder drift guard, queue logic, and NATIVE ffmpeg/libass + OCR proving exact start/end by picture and audio, 720×1280 H.264/AAC, caption times on the clip clock, no captions outside)
and `tests/export.page.test.mjs` (the real page in Chromium: select, export, real MP4 files, download link bytes, sequential engines, cancel, failure + retry, no-words clip, share stub, crash message).
Stand-ins: native ffmpeg instead of FFmpeg.wasm, fixture words instead of Whisper. They do not prove behaviour on an iPhone.
