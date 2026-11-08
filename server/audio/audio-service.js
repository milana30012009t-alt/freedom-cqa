// Audio proxy: the browser never sees the signed recording URL. The server downloads the
// recording once (handles Power Automate "$content" JSON envelopes), caches it locally
// (git-ignored) and serves it with HTTP Range support so the player can seek to evidence.
import { join } from 'node:path';
import { promises as fs, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { fetchWithRetry, UpstreamError } from '../lib/http-client.js';
import { readJsonSync, writeJsonAtomic, safeName } from '../storage/json-store.js';
import { logger } from '../lib/logger.js';

export class AudioError extends Error {
  constructor(message, status = 502, code = 'AUDIO_ERROR') {
    super(message);
    this.name = 'AudioError';
    this.status = status;
    this.code = code;
  }
}

function sniff(buf) {
  if (buf.length < 12) return null;
  const s4 = buf.subarray(0, 4).toString('latin1');
  if (s4 === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (s4.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (s4 === 'OggS') return 'audio/ogg';
  if (s4 === 'fLaC') return 'audio/flac';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'audio/mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  return null;
}

const EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/mp4': 'm4a', 'audio/webm': 'webm', 'video/mp4': 'mp4' };

export class AudioService {
  constructor({ cfg, datasets, fetchImpl }) {
    this.cfg = cfg;
    this.datasets = datasets;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.dir = join(cfg.dataDir, 'cache', 'audio');
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, 'index.json');
    this.index = readJsonSync(this.indexPath, {});
    this.inflight = new Map();
    this.errors = new Map();
  }

  status(uid) {
    const url = this.datasets.audioUrl(uid);
    const entry = this.index[uid];
    const cached = Boolean(entry && existsSync(join(this.dir, entry.file)));
    return {
      available: Boolean(url) || cached,
      cached,
      content_type: entry?.content_type || null,
      size: entry?.size || null,
      last_error: this.errors.get(uid) || null,
    };
  }

  async download(uid, url) {
    let res;
    try {
      res = await fetchWithRetry(url, {
        method: 'GET', headers: { Accept: 'audio/*,application/octet-stream,application/json;q=0.5' },
        timeoutMs: this.cfg.audio.timeoutMs, retries: 1, label: `Запись ${uid}`, fetchImpl: this.fetchImpl,
      });
    } catch (e) {
      if (e instanceof UpstreamError) {
        if (e.status === 401 || e.status === 403 || e.status === 404 || e.status === 410) {
          throw new AudioError(`Источник записи ответил HTTP ${e.status} — ссылка могла истечь или стать недоступной`, 502, 'UPSTREAM_DENIED');
        }
        if (e.code === 'TIMEOUT') throw new AudioError('Источник записи не ответил вовремя', 504, 'TIMEOUT');
        throw new AudioError(`Запись недоступна: ${e.message}`, 502, e.code);
      }
      throw e;
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > this.cfg.audio.maxBytes) throw new AudioError('Файл записи слишком большой', 413, 'TOO_LARGE');
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > this.cfg.audio.maxBytes) throw new AudioError('Файл записи слишком большой', 413, 'TOO_LARGE');
    let type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();

    if (type.includes('json') || (!sniff(buf) && buf.subarray(0, 1).toString() === '{')) {
      let body;
      try { body = JSON.parse(buf.toString('utf8')); } catch { throw new AudioError('Источник вернул некорректный JSON вместо записи', 502, 'BAD_PAYLOAD'); }
      const content = body?.$content ?? body?.content ?? body?.body?.$content;
      if (typeof content === 'string') {
        buf = Buffer.from(content, 'base64');
        type = String(body['$content-type'] || body.contentType || '').toLowerCase();
      } else {
        const link = body?.url || body?.audio_url || body?.downloadUrl;
        if (typeof link === 'string' && /^https?:\/\//.test(link)) return this.download(uid, link);
        throw new AudioError('Источник вернул JSON без аудиоданных', 502, 'BAD_PAYLOAD');
      }
    }
    const sniffed = sniff(buf);
    if (!type.startsWith('audio/') && !type.startsWith('video/')) {
      if (!sniffed) throw new AudioError(`Источник вернул не аудио (${type || 'тип не указан'})`, 502, 'NOT_AUDIO');
      type = sniffed;
    }
    if (!buf.length) throw new AudioError('Источник вернул пустой файл', 502, 'EMPTY');
    const file = `${safeName(uid)}.${EXT[type] || 'bin'}`;
    await fs.writeFile(join(this.dir, file), buf);
    this.index[uid] = { file, content_type: type, size: buf.length, fetched_at: new Date().toISOString() };
    await writeJsonAtomic(this.indexPath, this.index);
    return this.index[uid];
  }

  async ensure(uid) {
    const entry = this.index[uid];
    if (entry && existsSync(join(this.dir, entry.file))) return entry;
    const url = this.datasets.audioUrl(uid);
    if (!url) throw new AudioError('Для этого диалога нет записи', 404, 'NO_AUDIO');
    if (this.inflight.has(uid)) return this.inflight.get(uid);
    const p = this.download(uid, url)
      .then((r) => { this.errors.delete(uid); return r; })
      .catch((e) => { this.errors.set(uid, { message: e.message, code: e.code, at: new Date().toISOString() }); logger.warn(`Аудио ${uid}: ${e.message}`); throw e; })
      .finally(() => this.inflight.delete(uid));
    this.inflight.set(uid, p);
    return p;
  }

  /** Stream the cached file with Range support. */
  async serve(req, res, uid) {
    const entry = await this.ensure(uid);
    const path = join(this.dir, entry.file);
    const { size } = statSync(path);
    const headers = {
      'Content-Type': entry.content_type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      let end = range[1] === '' ? size - 1 : range[2] === '' ? size - 1 : Number(range[2]);
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Length': size });
    createReadStream(path).pipe(res);
  }
}
