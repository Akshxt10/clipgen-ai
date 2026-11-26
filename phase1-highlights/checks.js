/*
  ClipGen AI · Phase 1 · step 1 (highlights) · automatic invariants for the clips the analyzer returned (pure).
  These prove the clips are well-formed and cut cleanly. They do NOT prove the clips are good highlights —
  that is subjective and is judged by the user.
*/
const EPS = 1e-6;
export function checkClips(clips, words, duration) {
  const problems = [];
  const ws = Array.isArray(words) ? words : [];
  let inRange = true, cleanCuts = true, noOverlap = true, textMatches = true;
  for (const c of clips) {
    if (!(c.start >= 0 && c.end <= duration + 0.01 && c.end > c.start)) { inRange = false; problems.push(c.id + ': outside the analysed range'); }
    if (ws.some((w) => (w.s < c.start - EPS && w.e > c.start + EPS) || (w.s < c.end - EPS && w.e > c.end + EPS))) { cleanCuts = false; problems.push(c.id + ': cut starts or ends inside a spoken word'); }
    if (ws.length && c.transcript) {
      const inside = ws.filter((w) => w.s >= c.start - 0.01 && w.e <= c.end + 0.01).map((w) => w.w).join(' ').replace(/\s+/g, ' ').trim();
      if (inside !== c.transcript.replace(/\s+/g, ' ').trim()) { textMatches = false; problems.push(c.id + ': transcript does not match the words inside the clip'); }
    }
  }
  for (let i = 0; i < clips.length; i++) for (let j = i + 1; j < clips.length; j++) {
    if (Math.min(clips[i].end, clips[j].end) > Math.max(clips[i].start, clips[j].start) + EPS) { noOverlap = false; problems.push(clips[i].id + ' and ' + clips[j].id + ' overlap'); }
  }
  return { ok: problems.length === 0, inRange, cleanCuts, noOverlap, textMatches, problems };
}
