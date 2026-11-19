/*
  ClipGen AI · Phase 1 · timeline canvas.
  Shows the loudness map (when analysis exists), clip regions, IN/OUT marks, loudest-moment markers and the playhead.
  Tap or drag anywhere to seek. Arrow keys seek when the canvas is focused.
  Pure canvas, no dependencies. The static layer (bars + ruler) is cached; only the overlay is redrawn each frame.
*/

const MIN_DB = -60, MAX_DB = -6;
const NICE_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

function clock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + p(m) + ':' + p(s) : m + ':' + p(s);
}

export class Timeline {
  /** @param {HTMLCanvasElement} canvas  @param {{onSeek:(t:number)=>void}} opts */
  constructor(canvas, opts) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSeek = (opts && opts.onSeek) || (() => {});
    this.duration = 0;
    this.env = null;            // { rmsDb:Float32Array, windowSec:number }
    this.clips = [];
    this.selectedId = null;
    this.moments = [];
    this.t = 0;
    this.marks = { inT: null, outT: null };
    this.base = document.createElement('canvas');
    this.dirty = true;
    this.raf = 0;
    this.dpr = 1;
    this.w = 0; this.h = 0;
    this.alive = true;
    this.dragging = false;

    canvas.setAttribute('role', 'slider');
    canvas.setAttribute('tabindex', '0');
    canvas.setAttribute('aria-label', 'Video timeline. Tap or drag to seek; arrow keys move by one second.');
    canvas.style.touchAction = 'pan-y';   // vertical scroll still works, horizontal drags seek

    this._down = (e) => {
      if (!this.duration) return;
      this.dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._seekFromEvent(e);
    };
    this._move = (e) => { if (this.dragging) this._seekFromEvent(e); };
    this._up = (e) => { this.dragging = false; try { canvas.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } };
    this._key = (e) => {
      if (!this.duration) return;
      let d = 0;
      if (e.key === 'ArrowLeft') d = -1; else if (e.key === 'ArrowRight') d = 1;
      else return;
      if (e.shiftKey) d *= 10;
      e.preventDefault();
      this.onSeek(Math.min(this.duration, Math.max(0, this.t + d)));
    };
    canvas.addEventListener('pointerdown', this._down);
    canvas.addEventListener('pointermove', this._move);
    canvas.addEventListener('pointerup', this._up);
    canvas.addEventListener('pointercancel', this._up);
    canvas.addEventListener('keydown', this._key);

    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(canvas);
    } else {
      this._onWin = () => this.resize();
      window.addEventListener('resize', this._onWin);
    }
    this.resize();
  }

  destroy() {
    this.alive = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.ro) this.ro.disconnect();
    if (this._onWin) window.removeEventListener('resize', this._onWin);
    const c = this.c;
    c.removeEventListener('pointerdown', this._down);
    c.removeEventListener('pointermove', this._move);
    c.removeEventListener('pointerup', this._up);
    c.removeEventListener('pointercancel', this._up);
    c.removeEventListener('keydown', this._key);
  }

  /* ---- data setters ---- */
  setDuration(d) { d = Number(d) || 0; if (d !== this.duration) { this.duration = d; this.dirty = true; this.schedule(); } }
  setEnvelope(env) { this.env = env || null; this.dirty = true; this.schedule(); }
  setClips(clips, selectedId) { this.clips = clips || []; this.selectedId = selectedId || null; this.schedule(); }
  setMoments(m) { this.moments = m || []; this.schedule(); }
  setMarks(inT, outT) { this.marks = { inT: inT == null ? null : inT, outT: outT == null ? null : outT }; this.schedule(); }
  setPlayhead(t) {
    t = Number(t) || 0;
    if (t === this.t) return;
    this.t = t;
    this.c.setAttribute('aria-valuenow', String(Math.round(t)));
    this.schedule();
  }

  /* ---- geometry ---- */
  resize() {
    if (!this.alive) return;
    const r = this.c.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.c.width = w; this.c.height = h;
    this.base.width = w; this.base.height = h;
    this.c.setAttribute('aria-valuemax', String(Math.round(this.duration)));
    this.dirty = true;
    this.schedule();
  }
  _x(t) { return this.duration ? (t / this.duration) * this.w : 0; }
  _seekFromEvent(e) {
    const r = this.c.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
    this.onSeek(f * this.duration);
  }

  schedule() {
    if (this.raf || !this.alive) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  /* ---- drawing ---- */
  _buildBase() {
    const b = this.base.getContext('2d');
    const { w, h, dpr } = this;
    b.clearRect(0, 0, w, h);
    const rulerH = Math.round(18 * dpr);
    const plotH = h - rulerH;
    const mid = plotH / 2;

    // plot background
    b.fillStyle = 'rgba(255,255,255,0.025)';
    b.fillRect(0, 0, w, plotH);

    if (this.env && this.env.rmsDb && this.env.rmsDb.length && this.duration) {
      const rms = this.env.rmsDb, ws = this.env.windowSec;
      const barW = Math.max(1, Math.round(2 * dpr)), gap = Math.max(1, Math.round(1 * dpr));
      const cols = Math.max(1, Math.floor(w / (barW + gap)));
      const grad = b.createLinearGradient(0, 0, 0, plotH);
      grad.addColorStop(0, '#8b7bff');
      grad.addColorStop(0.5, '#4fb6f5');
      grad.addColorStop(1, '#8b7bff');
      b.fillStyle = grad;
      const winsTotal = rms.length;
      for (let i = 0; i < cols; i++) {
        const t0 = (i / cols) * this.duration, t1 = ((i + 1) / cols) * this.duration;
        let a = Math.floor(t0 / ws), z = Math.ceil(t1 / ws);
        a = Math.min(winsTotal - 1, Math.max(0, a));
        z = Math.min(winsTotal, Math.max(a + 1, z));
        let mx = -90;
        for (let k = a; k < z; k++) if (rms[k] > mx) mx = rms[k];
        const norm = Math.min(1, Math.max(0, (mx - MIN_DB) / (MAX_DB - MIN_DB)));
        const hh = Math.max(Math.round(2 * dpr), norm * (plotH - 6 * dpr));
        b.fillRect(i * (barW + gap), mid - hh / 2, barW, hh);
      }
    } else {
      // no analysis yet: calm dotted baseline
      b.fillStyle = 'rgba(255,255,255,0.18)';
      const d = Math.round(3 * dpr);
      for (let x = 0; x < w; x += d * 3) b.fillRect(x, mid - dpr / 2, d, Math.max(1, dpr));
      b.fillStyle = 'rgba(190,200,225,0.55)';
      b.font = Math.round(12 * dpr) + 'px -apple-system, system-ui, sans-serif';
      b.textAlign = 'center';
      b.fillText(this.duration ? 'Loudness map appears after you analyze the audio' : 'Loading video …', w / 2, mid - 10 * dpr);
    }

    // ruler
    if (this.duration) {
      const minPx = 64 * dpr;
      let step = NICE_STEPS[NICE_STEPS.length - 1];
      for (const s of NICE_STEPS) { if ((s / this.duration) * w >= minPx) { step = s; break; } }
      b.fillStyle = 'rgba(190,200,225,0.55)';
      b.strokeStyle = 'rgba(255,255,255,0.14)';
      b.lineWidth = Math.max(1, dpr);
      b.font = Math.round(10.5 * dpr) + 'px -apple-system, system-ui, sans-serif';
      b.textBaseline = 'middle';
      for (let t = 0; t <= this.duration + 0.001; t += step) {
        const x = Math.round(this._x(t)) + 0.5;
        b.beginPath(); b.moveTo(x, plotH); b.lineTo(x, plotH + 4 * dpr); b.stroke();
        b.textAlign = x < 20 * dpr ? 'left' : (x > w - 20 * dpr ? 'right' : 'center');
        b.fillText(clock(t), x, plotH + rulerH / 2 + 2 * dpr);
      }
    }
    this.dirty = false;
  }

  draw() {
    if (!this.alive || !this.w) return;
    if (this.dirty) this._buildBase();
    const ctx = this.ctx, { w, h, dpr } = this;
    const rulerH = Math.round(18 * dpr), plotH = h - rulerH;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.base, 0, 0);
    if (!this.duration) return;

    // clip regions
    for (const c of this.clips) {
      const x0 = this._x(c.start), x1 = Math.max(x0 + 2 * dpr, this._x(c.end));
      const sel = c.id === this.selectedId;
      ctx.fillStyle = sel ? 'rgba(47,212,240,0.28)' : 'rgba(139,123,255,0.20)';
      ctx.fillRect(x0, 0, x1 - x0, plotH);
      ctx.fillStyle = sel ? '#2fd4f0' : 'rgba(139,123,255,0.9)';
      ctx.fillRect(x0, 0, Math.max(2, 2 * dpr), plotH);
      ctx.fillRect(x1 - Math.max(2, 2 * dpr), 0, Math.max(2, 2 * dpr), plotH);
      ctx.fillRect(x0, 0, x1 - x0, Math.max(2, 2 * dpr));
    }

    // loudest-moment markers (amber triangles on the top edge)
    ctx.fillStyle = '#ffc857';
    for (const m of this.moments) {
      const x = this._x(m.timeSec), s = 5 * dpr;
      ctx.beginPath(); ctx.moveTo(x - s, 0); ctx.lineTo(x + s, 0); ctx.lineTo(x, s * 1.4); ctx.closePath(); ctx.fill();
    }

    // IN / OUT marks
    const { inT, outT } = this.marks;
    if (inT != null && outT != null && outT > inT) {
      ctx.fillStyle = 'rgba(61,220,151,0.14)';
      ctx.fillRect(this._x(inT), 0, this._x(outT) - this._x(inT), plotH);
    }
    const flag = (t, label) => {
      const x = this._x(t);
      ctx.strokeStyle = '#3ddc97'; ctx.lineWidth = Math.max(2, 2 * dpr);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke();
      ctx.font = '700 ' + Math.round(10 * dpr) + 'px -apple-system, system-ui, sans-serif';
      const tw = ctx.measureText(label).width + 8 * dpr, fh = 14 * dpr;
      const fx = label === 'OUT' ? Math.max(0, x - tw) : Math.min(w - tw, x);
      ctx.fillStyle = '#3ddc97';
      ctx.fillRect(fx, plotH - fh, tw, fh);
      ctx.fillStyle = '#06130d'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, fx + 4 * dpr, plotH - fh / 2 + dpr * 0.5);
    };
    if (inT != null) flag(inT, 'IN');
    if (outT != null) flag(outT, 'OUT');

    // playhead
    const px = this._x(this.t);
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(px - dpr, 0, Math.max(2, 2 * dpr), h - rulerH + 4 * dpr);
    ctx.beginPath(); ctx.arc(px, 4 * dpr, 4 * dpr, 0, Math.PI * 2); ctx.fill();
  }
}
