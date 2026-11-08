// In-memory background jobs (batch evaluation) with bounded concurrency and progress.
import { randomBytes } from 'node:crypto';

export class JobQueue {
  constructor() {
    this.jobs = new Map();
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, 20);
  }

  /**
   * @param {string} type
   * @param {Array<string>} items
   * @param {(item:string)=>Promise<object>} worker
   * @param {{concurrency?:number, label?:string}} opts
   */
  start(type, items, worker, { concurrency = 1, label = '' } = {}) {
    const job = {
      id: `JOB-${Date.now().toString(36).toUpperCase()}-${randomBytes(2).toString('hex')}`,
      type,
      label,
      status: 'running',
      total: items.length,
      done: 0,
      failed: 0,
      started_at: new Date().toISOString(),
      finished_at: null,
      results: [],
    };
    this.jobs.set(job.id, job);
    const queue = [...items];
    const run = async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          const r = await worker(item);
          job.results.push({ item, ok: true, ...r });
        } catch (e) {
          job.failed += 1;
          job.results.push({ item, ok: false, error: e.message });
        }
        job.done += 1;
      }
    };
    Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, run))
      .then(() => { job.status = job.failed && job.failed === job.total ? 'failed' : 'done'; })
      .catch(() => { job.status = 'failed'; })
      .finally(() => { job.finished_at = new Date().toISOString(); });
    return job;
  }
}
