// Dataset management: organisers' GET API by group_id, local JSON import, persistence,
// group switching (DEV → control set) and conversation lookup.
// Signed audio URLs stay on the server: they are never sent to the browser or logged.
import { join } from 'node:path';
import { promises as fs, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { parseDatasetPayload, DatasetError } from './dataset-validator.js';
import { buildConversation } from './transcript-model.js';
import { fetchWithRetry } from '../lib/http-client.js';
import { writeJsonAtomic, readJsonSync } from '../storage/json-store.js';
import { logger, describeUrl } from '../lib/logger.js';

const GROUP_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function sanitizeGroupId(g) {
  const s = String(g ?? '').trim();
  if (!GROUP_RE.test(s)) throw new DatasetError('group_id: латиница, цифры, «_» или «-», до 40 символов');
  return s;
}

export class DatasetService {
  constructor({ cfg, fetchImpl } = {}) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    this.dir = join(cfg.dataDir, 'datasets');
    mkdirSync(this.dir, { recursive: true });
    this.metaPath = join(this.dir, 'meta.json');
    this.meta = readJsonSync(this.metaPath, { active_group: null, groups: {} });
    this.groups = new Map(); // group -> {records, conversations: Map(uid->conv)}
    this.loadFromDisk();
  }

  loadFromDisk() {
    for (const f of readdirSync(this.dir)) {
      const m = /^(.+)\.raw\.json$/.exec(f);
      if (!m) continue;
      const group = m[1];
      try {
        const parsed = parseDatasetPayload(readFileSync(join(this.dir, f), 'utf8'));
        this.ingest(group, parsed, this.meta.groups[group] || {});
      } catch (e) {
        logger.warn(`Не удалось загрузить сохранённый набор ${group}: ${e.message}`);
      }
    }
    if (!this.meta.active_group || !this.groups.has(this.meta.active_group)) {
      this.meta.active_group = this.groups.has(this.cfg.dataset.groupId) ? this.cfg.dataset.groupId : [...this.groups.keys()][0] || null;
    }
  }

  ingest(group, parsed, prevMeta = {}) {
    const conversations = new Map();
    for (const r of parsed.records) {
      const conv = buildConversation(r, group);
      conversations.set(conv.uid, conv);
    }
    this.groups.set(group, { records: parsed.records, conversations });
    const byLanguage = {};
    const byChannel = {};
    for (const c of conversations.values()) {
      byLanguage[c.language] = (byLanguage[c.language] || 0) + 1;
      byChannel[c.channel_type] = (byChannel[c.channel_type] || 0) + 1;
    }
    this.meta.groups[group] = {
      ...prevMeta,
      group_id: group,
      record_count: conversations.size,
      declared_total: parsed.meta.total_records_declared,
      dataset_group_id: parsed.meta.dataset_group_id,
      by_language: byLanguage,
      by_channel: byChannel,
      validation: { errors: parsed.errors, warnings: parsed.warnings, duplicates: parsed.duplicates },
      repaired_messages: [...conversations.values()].reduce((s, c) => s + c.quality.repaired_messages, 0),
    };
  }

  async persist(group, rawText, source) {
    await writeJsonAtomicText(join(this.dir, `${group}.raw.json`), rawText);
    this.meta.groups[group].source = source;
    this.meta.groups[group].loaded_at = new Date().toISOString();
    await writeJsonAtomic(this.metaPath, this.meta);
  }

  status() {
    return {
      active_group: this.meta.active_group,
      api_configured: Boolean(this.cfg.dataset.apiUrl),
      api_url_display: describeUrl(this.cfg.dataset.apiUrl),
      default_group: this.cfg.dataset.groupId,
      groups: Object.values(this.meta.groups).filter((g) => this.groups.has(g.group_id)),
    };
  }

  /** Fetch a dataset from the organisers' API. */
  async fetchFromApi(groupId) {
    const group = sanitizeGroupId(groupId || this.cfg.dataset.groupId);
    if (!this.cfg.dataset.apiUrl) {
      throw new DatasetError('DATASET_API_URL не задан в .env — загрузите JSON-файл вручную или укажите адрес API');
    }
    let url;
    try {
      url = new URL(this.cfg.dataset.apiUrl);
    } catch {
      throw new DatasetError('DATASET_API_URL некорректен');
    }
    url.searchParams.set('group_id', group);
    logger.info(`Загрузка набора ${group} из ${describeUrl(url.toString())}`);
    const res = await fetchWithRetry(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: this.cfg.dataset.timeoutMs,
      retries: this.cfg.dataset.retries,
      label: `GET набора ${group}`,
      fetchImpl: this.fetchImpl,
    });
    // Always decode as UTF-8 (JSON spec); encoding damage inside strings is handled later.
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString('utf8');
    return this.importPayload(group, text, 'api');
  }

  /** Import a payload (API response text, uploaded file text or parsed object). */
  async importPayload(groupId, payload, source = 'file') {
    const group = sanitizeGroupId(groupId);
    const parsed = parseDatasetPayload(payload);
    if (parsed.meta.dataset_group_id && parsed.meta.dataset_group_id !== group) {
      parsed.warnings.push(`В ответе dataset_group_id = «${parsed.meta.dataset_group_id}», а запрошен «${group}»`);
    }
    const previous = this.groups.get(group);
    const previousIds = previous ? new Set(previous.conversations.keys()) : new Set();
    this.ingest(group, parsed, this.meta.groups[group] || {});
    const rawText = typeof payload === 'string' ? payload : JSON.stringify(payload);
    await this.persist(group, rawText, source);
    if (!this.meta.active_group) {
      this.meta.active_group = group;
      await writeJsonAtomic(this.metaPath, this.meta);
    }
    const current = this.groups.get(group);
    const added = [...current.conversations.keys()].filter((k) => !previousIds.has(k)).length;
    return {
      group_id: group,
      record_count: current.conversations.size,
      added,
      updated: current.conversations.size - added,
      errors: parsed.errors,
      warnings: parsed.warnings,
      duplicates: parsed.duplicates,
    };
  }

  async setActive(groupId) {
    const group = sanitizeGroupId(groupId);
    if (!this.groups.has(group)) throw new DatasetError(`Набор «${group}» ещё не загружен`);
    this.meta.active_group = group;
    await writeJsonAtomic(this.metaPath, this.meta);
    return this.status();
  }

  listGroups() {
    return [...this.groups.keys()];
  }

  conversations(group) {
    if (group === '*' || group === 'all') return [...this.groups.values()].flatMap((g) => [...g.conversations.values()]);
    const g = this.groups.get(group || this.meta.active_group);
    return g ? [...g.conversations.values()] : [];
  }

  get(uid) {
    const group = String(uid).split(':')[0];
    return this.groups.get(group)?.conversations.get(uid) || null;
  }

  /** Server-only: the original (possibly signed) audio URL. */
  audioUrl(uid) {
    const conv = this.get(uid);
    if (!conv) return null;
    const rec = this.groups.get(conv.group).records.find((r) => r.conversation_id === conv.conversation_id);
    return rec?.audio_url || null;
  }
}

async function writeJsonAtomicText(path, text) {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, path);
}

export function datasetFileExists(dataDir, group) {
  return existsSync(join(dataDir, 'datasets', `${group}.raw.json`));
}
