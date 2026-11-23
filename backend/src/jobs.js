/*
  ClipGen AI backend · background jobs (download, analysis, rendering).
  A job is a function run with progress reporting and cancellation. At most `maxConcurrentJobs` run at once;
  the rest wait in a queue (free hosts have very little CPU/RAM).
*/
import { newId, ApiError } from './util.js';

export class JobManager {
  constructor(cfg) {
    this.cfg = cfg;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
  }
  create({ type, projectId, label, run }) {
    const job = {
      id: newId('j'), type, projectId, label: label || type, state: 'queued', stage: 'queued', progress: 0, message: 'Waiting for a free worker …',
      error: null, result: null, createdAt: Date.now(), startedAt: null, finishedAt: null, ac: new AbortController(), run
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this._pump();
    this._trim();
    return job;
  }
  _pump() {
    while (this.running < this.cfg.limits.maxConcurrentJobs && this.queue.length) {
      const job = this.queue.shift();
      if (job.state === 'cancelled') continue;
      this.running++;
      job.state = 'running'; job.startedAt = Date.now(); job.message = 'Starting …';
      const ctx = {
        signal: job.ac.signal,
        report: (stage, progress, message) => {
          if (job.state !== 'running') return;
          if (stage) job.stage = stage;
          if (typeof progress === 'number') job.progress = Math.max(0, Math.min(1, progress));
          if (message !== undefined) job.message = message;
        }
      };
      Promise.resolve().then(() => job.run(ctx)).then((result) => {
        if (job.state === 'running') { job.state = 'done'; job.progress = 1; job.stage = 'done'; job.message = 'Done'; job.result = result === undefined ? null : result; }
      }).catch((e) => {
        if (job.state === 'cancelled' || (e && e.name === 'AbortError')) { job.state = 'cancelled'; job.message = 'Cancelled'; }
        else { job.state = 'error'; job.error = { code: (e && e.code) || 'failed', message: (e && e.message) || String(e) }; job.message = job.error.message; }
      }).finally(() => { job.finishedAt = Date.now(); this.running--; this._pump(); });
    }
  }
  get(id) {
    const j = this.jobs.get(id);
    if (!j) throw new ApiError(404, 'job-not-found', 'That job is no longer known (the server may have restarted).');
    return j;
  }
  cancel(id) {
    const j = this.get(id);
    if (j.state === 'queued' || j.state === 'running') { j.state = 'cancelled'; j.message = 'Cancelled'; j.finishedAt = Date.now(); j.ac.abort(); }
    return j;
  }
  isBusyProject(projectId) {
    for (const j of this.jobs.values()) if (j.projectId === projectId && (j.state === 'queued' || j.state === 'running')) return true;
    return false;
  }
  activeFor(projectId, type) {
    for (const j of this.jobs.values()) if (j.projectId === projectId && (!type || j.type === type) && (j.state === 'queued' || j.state === 'running')) return j;
    return null;
  }
  snapshot(j) {
    return { id: j.id, type: j.type, projectId: j.projectId, label: j.label, state: j.state, stage: j.stage, progress: Math.round(j.progress * 1000) / 1000, message: j.message, error: j.error, result: j.state === 'done' ? j.result : null, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt };
  }
  _trim() {
    const done = [...this.jobs.values()].filter((j) => j.finishedAt).sort((a, b) => a.finishedAt - b.finishedAt);
    while (done.length > 200) this.jobs.delete(done.shift().id);
  }
}
