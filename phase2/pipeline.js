/*
  ClipGen AI · Phase 2 · pipeline map — the single honest source of "what exists" vs "what is planned".

  The UI reads this list to draw the status panel, so a feature can only show "Built" here after it is
  implemented AND tested. Nothing in the planned stages is wired to any button.

  Statuses
    built         implemented and tested
    experimental  implemented, tested only in a limited way, output is a measurement not a decision
    planned       NOT implemented. Design notes only.

  Every stage talks to the next one through plain data saved in IndexedDB (see ARCHITECTURE.md), so each
  stage can be built, tested and switched on independently:

    SOURCE ─► AUDIO ─► TRANSCRIPT ─► SCORING ─► CLIP PLAN ─► CAPTIONS ─► 9:16 EXPORT
    (file)    (PCM)    (words+times)  (0..1 per   (start,end,  (ASS/drawtext  (ffmpeg.wasm,
                                       window)     label)       overlay)       one clip at a time)

  The rule that keeps this legal and simple: the pipeline's only input is a FILE the user provides.
  A YouTube link is a reference shown in the official player; it is never a source of media data.
*/

export const STATUS_LABEL = { built: 'Built', experimental: 'Experimental', planned: 'Planned' };
export const STATUS_PILL = { built: 'pill-ok', experimental: 'pill-accent', planned: '' };

export const STAGES = [
  {
    id: 'youtube-link', group: 'Source', status: 'built',
    title: 'YouTube link & official player',
    detail: 'Validates youtube.com / youtu.be / live / shorts links and shows the video in YouTube’s own embedded player.',
    reads: 'a pasted link', writes: 'project.source = { kind:"youtube", videoId }'
  },
  {
    id: 'youtube-meta', group: 'Source', status: 'experimental',
    title: 'Video title & channel',
    detail: 'Public title and channel via YouTube oEmbed. Best effort: it can be unavailable, and it is never saved. Duration is not available this way.',
    reads: 'oEmbed (public)', writes: 'nothing (display only)'
  },
  {
    id: 'source-file', group: 'Source', status: 'built',
    title: 'Authorized source file',
    detail: 'You confirm you own the video or have permission, then choose the MP4/MOV yourself. ClipGen AI never downloads from YouTube.',
    reads: 'a file you choose', writes: 'blobs[projectId], project.authorization'
  },
  {
    id: 'upload', group: 'Source', status: 'built',
    title: 'Direct video upload',
    detail: 'MP4/MOV import, preview, file info and local projects (unchanged from Phase 1).',
    reads: 'a file you choose', writes: 'projects, blobs'
  },
  {
    id: 'audio', group: 'Analysis', status: 'experimental',
    title: 'Audio loudness map',
    detail: 'Loudness every 0.5 s plus the loudest moments. A measurement only — it does not decide what is interesting.',
    reads: 'source file (FFmpeg.wasm → 8 kHz mono PCM)', writes: 'analysis[projectId]'
  },
  {
    id: 'manual-clips', group: 'Clips', status: 'built',
    title: 'Manual clip list',
    detail: 'Add clips yourself with IN / OUT, then adjust, rename, play and delete.',
    reads: 'player time', writes: 'clips[]'
  },
  {
    id: 'transcribe', group: 'Analysis', status: 'planned',
    title: 'Transcription',
    detail: 'On-device speech-to-text with an open-source Whisper-class model. Word timestamps feed scoring and captions.',
    reads: 'audio extracted from the source file', writes: 'transcripts[projectId] = [{ start, end, text, words[] }]',
    risk: 'Model download size and speed on iPhone are unproven; must be benchmarked on a real device first.'
  },
  {
    id: 'highlights', group: 'Analysis', status: 'planned',
    title: 'Automatic highlight detection',
    detail: 'Score every few seconds from loudness spikes, speech density and keywords, then rank. It will only be switched on after it is checked against clips chosen by hand.',
    reads: 'analysis + transcripts', writes: 'scores[projectId] = Float32Array(0..1)',
    risk: 'Quality is unknown until measured. Nothing in the app finds highlights today.'
  },
  {
    id: 'clip-plan', group: 'Clips', status: 'planned',
    title: 'Automatic clip generation',
    detail: 'Turn the best-scoring windows into several candidate clips (length limits, no overlaps, snap to sentence ends). You approve or edit each one.',
    reads: 'scores + transcripts', writes: 'clips[] with source:"auto"'
  },
  {
    id: 'captions', group: 'Output', status: 'planned',
    title: 'Animated, synchronized captions',
    detail: 'Word-timed captions drawn onto each clip. The rendering method will follow what Phase 0 proved on iPhone.',
    reads: 'transcript words inside a clip', writes: 'caption style + generated subtitle data'
  },
  {
    id: 'export', group: 'Output', status: 'planned',
    title: '9:16 MP4 export',
    detail: 'Crop to 1080×1920 (or 720p) and encode one clip at a time with FFmpeg.wasm. Phase 0 proved a 10 s 720p export on iPhone.',
    reads: 'source file + clip + captions', writes: 'a downloadable MP4',
    risk: 'Long clips and large sources may exceed iPhone memory; plan is to cut the clip before filtering.'
  }
];

export const stagesById = (id) => STAGES.find((s) => s.id === id) || null;
