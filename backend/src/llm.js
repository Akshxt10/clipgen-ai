/*
  ClipGen AI backend · optional LLM review of the best candidates.

  Works with any OpenAI-compatible "chat completions" endpoint, including free tiers (Groq, Google Gemini's
  OpenAI-compatible endpoint, OpenRouter free models) or a local Ollama. Configure with environment variables on the
  server: LLM_API_URL (full chat-completions URL), LLM_API_KEY, LLM_MODEL. The key stays on the server.
  Without it, ClipGen AI uses its signal-based scoring only (and says so in the results).
*/
import { clamp, round } from './util.js';

export const llmAvailable = (cfg) => !!(cfg.llm && cfg.llm.url && cfg.llm.model);

function extractJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in the model reply');
  return JSON.parse(t.slice(a, b + 1));
}

export async function reviewWithLlm(cfg, clips, settings, { signal, fetchImpl } = {}) {
  const f = fetchImpl || fetch;
  const items = clips.slice(0, 30).map((c) => ({ id: c.id, start: c.start, end: c.end, text: String(c.transcript || '').slice(0, 900) }));
  const prompt =
    'You rate candidate segments of one video for short-form clips (' + settings.platform + '). For EACH segment give: ' +
    '"score" 0-100 = how likely a viewer is to keep watching (strong hook, emotion, humour, surprise, useful information, complete thought), ' +
    '"label" one of Hook|Funny|Emotional|Surprising|Informative|Story|Highlight, "title" max 8 words, "reason" max 18 words. ' +
    'Only judge the text given. Reply with JSON only: {"ratings":[{"id":"…","score":0,"label":"…","title":"…","reason":"…"}]}\n\nSegments:\n' + JSON.stringify(items);
  const headers = { 'content-type': 'application/json' };
  if (cfg.llm.key) headers.authorization = 'Bearer ' + cfg.llm.key;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.llm.timeoutMs);
  if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await f(cfg.llm.url, { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify({ model: cfg.llm.model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] }) });
    if (!res.ok) throw new Error('LLM endpoint answered HTTP ' + res.status);
    const j = await res.json();
    const content = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    const parsed = extractJson(content);
    const out = new Map();
    for (const r of parsed.ratings || []) {
      if (!r || typeof r.id !== 'string' || typeof r.score !== 'number') continue;
      out.set(r.id, { score: clamp(r.score, 0, 100), label: typeof r.label === 'string' ? r.label.slice(0, 20) : null, title: typeof r.title === 'string' ? r.title.slice(0, 80) : null, reason: typeof r.reason === 'string' ? r.reason.slice(0, 160) : null });
    }
    return out;
  } finally { clearTimeout(timer); }
}

/* blend: final = 50% signals + 50% LLM; clips re-ranked */
export function applyLlm(analysis, ratings) {
  if (!ratings || !ratings.size) return 0;
  let applied = 0;
  for (const c of [...analysis.clips, ...analysis.pool]) {
    const r = ratings.get(c.id);
    if (!r) continue;
    c.signalScore = c.score;
    c.llmScore = r.score;
    c.score = round(0.5 * c.score + 0.5 * r.score, 1);
    if (r.label && !c.categories.includes(r.label)) c.categories = [r.label, ...c.categories].slice(0, 3);
    if (r.title && r.title.length > 3) c.title = r.title;
    if (r.reason) c.reasons = ['AI review: ' + r.reason, ...c.reasons].slice(0, 4);
    applied++;
  }
  analysis.clips.sort((a, b) => b.score - a.score);
  analysis.clips.forEach((c, i) => { c.rank = i + 1; c.id = 'c' + (i + 1); });
  return applied;
}
