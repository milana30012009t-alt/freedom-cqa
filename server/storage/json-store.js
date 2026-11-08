// File-based storage: one JSON document per collection item, atomic writes (temp file + rename),
// serialized per file. Simple, inspectable and good enough for a prototype; the service layer
// only depends on this small interface, so it can be swapped for a database later.
import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();

function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(task, task);
  queues.set(key, next.catch(() => {}));
  return next;
}

export async function writeJsonAtomic(path, data) {
  return enqueue(path, async () => {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, path);
  });
}

export function readJsonSync(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

/** A keyed collection stored as one file per item in a directory, cached in memory. */
export class DirCollection {
  constructor(dir) {
    this.dir = dir;
    this.items = new Map();
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const item = readJsonSync(join(dir, f));
      if (item && item.id) this.items.set(item.id, item);
    }
  }

  get(id) {
    return this.items.get(id) || null;
  }

  all() {
    return [...this.items.values()];
  }

  async put(item) {
    if (!item || !item.id) throw new Error('item.id is required');
    this.items.set(item.id, item);
    await writeJsonAtomic(join(this.dir, `${safeName(item.id)}.json`), item);
    return item;
  }

  async clear() {
    this.items.clear();
    await fs.rm(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
}

/** A single JSON document (e.g. checklist versions, appeals list). */
export class DocStore {
  constructor(path, fallback) {
    this.path = path;
    this.data = readJsonSync(path, null) ?? structuredClone(fallback);
  }

  get() {
    return this.data;
  }

  async save(data = this.data) {
    this.data = data;
    await writeJsonAtomic(this.path, data);
    return data;
  }
}

export function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
}
