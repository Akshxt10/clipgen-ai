# ClipGen AI · Phase 0 speech-caption test (`phase0-speech/`)

Why this exists: Phase 0 only proved that captions can be *drawn* into an export. Its caption text was a hardcoded test line.
Speech recognition never existed in Phase 0 or Phase 1. This page adds it, still ₹0 and browser-only.

## Pipeline (all on the phone, nothing uploaded)
1. Open the video with FFmpeg.wasm (mounted, not copied into memory).
2. Extract the audio: 16 kHz, mono, 32-bit float PCM.
3. Recognize speech with **Whisper** (open-source, quantized) via transformers.js / ONNX Runtime Web in a Web Worker, asking for **word-level timestamps**.
   Library from jsDelivr, model from Hugging Face, cached by the browser after the first run. No API key, no server.
4. `captions.js` cleans the words, groups them into short lines and writes an ASS subtitle script with a word-by-word highlight.
5. Export 9:16 · 720×1280 H.264/AAC with the captions burned in by libass.
6. Verify: output size/length, a pixel check that the caption is visible at a word time but not at a silent time,
   whether the word times sit on audible sound, optional word-error-rate against what you typed, and your own yes/mostly/no.

The page never writes caption text itself. No recognized words → it stops with "NOT VERIFIED" and exports nothing.

## Tests (`node --test phase0-speech/tests/*.test.mjs`)
- `captions.test.mjs` – pure logic.
- `burn.test.mjs` – native ffmpeg (libass) + tesseract OCR: fixture words appear at the right times, not in a gap.
- `page.test.mjs` – the real page in headless Chromium with **stand-ins**: native ffmpeg for the engine and fixture chunks for the recognizer.
  Also: nothing recognized, blocked CDN, and a video without audio all fail honestly.

These do **not** prove Whisper recognizes real speech: the sandbox cannot download the model.
That is verified only by running the page on a real device and reading the "Words the phone recognized" list.

## Known limits
- Caption font (Poppins Bold subset) is Latin only. Hindi etc. would show empty boxes; the page warns.
- Whisper tiny/base word times are approximate. If the model gives no word times, the page falls back to phrase times and says so.
- Single-thread WASM (GitHub Pages cannot send COOP/COEP) → slow; speed and memory on iPhone are measured by the report.
- Library versions/model names are loaded from public CDNs and were not run in the sandbox.
