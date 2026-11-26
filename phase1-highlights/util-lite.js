// Browser-safe copy of the two helpers analyze.js needs from backend/src/util.js (that file pulls in Node-only modules).
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const round = (n, d = 2) => { const f = 10 ** d; return Math.round(n * f) / f; };
