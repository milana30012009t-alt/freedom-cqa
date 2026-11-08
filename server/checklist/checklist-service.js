// Checklist versions: immutable snapshots, one active version, import/export and diff.
// Every evaluation stores the full snapshot it used, so editing the checklist never rewrites
// past results.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { DocStore } from '../storage/json-store.js';
import { validateChecklist } from '../../shared/checklist-schema.js';
import { logger } from '../lib/logger.js';

export class ChecklistError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'ChecklistError';
    this.details = details;
  }
}

const COMPARE_FIELDS = ['name', 'description', 'guidance', 'section_id', 'weight', 'answer_type', 'scoring_role', 'na_allowed', 'na_condition', 'enabled', 'evaluation_mode'];

export class ChecklistService {
  constructor({ cfg }) {
    this.cfg = cfg;
    this.store = new DocStore(join(cfg.dataDir, 'store', 'checklists.json'), { active_version: null, versions: [] });
  }

  async init() {
    const data = this.store.get();
    if (data.versions.length) return;
    if (!existsSync(this.cfg.checklistSeedFile)) {
      logger.warn(`Файл начального чек-листа не найден: ${this.cfg.checklistSeedFile}`);
      return;
    }
    const def = JSON.parse(readFileSync(this.cfg.checklistSeedFile, 'utf8'));
    await this.create(def, {
      author: { role: 'system', name: 'Система' },
      change_note: def.official ? 'Начальная конфигурация: официальный чек-лист организаторов (PDF)' : 'Начальная конфигурация',
      activate: true,
      source: 'seed',
    });
  }

  list() {
    const { active_version: active, versions } = this.store.get();
    return versions.map((v) => ({
      version: v.version,
      status: v.version === active ? 'active' : 'archived',
      name: v.checklist.name,
      official: v.checklist.official,
      created_at: v.created_at,
      created_by: v.created_by,
      change_note: v.change_note,
      parent_version: v.parent_version,
      source: v.source,
      criteria_count: v.checklist.criteria.filter((c) => c.enabled).length,
      weights_sum: v.checklist.criteria.filter((c) => c.enabled && c.scoring_role === 'weighted').reduce((s, c) => s + c.weight, 0),
    })).sort((a, b) => b.version - a.version);
  }

  get(version) {
    const v = this.store.get().versions.find((x) => x.version === Number(version));
    if (!v) return null;
    return { ...v, status: v.version === this.store.get().active_version ? 'active' : 'archived' };
  }

  getActive() {
    const { active_version: active } = this.store.get();
    return active ? this.get(active) : null;
  }

  validate(def) {
    return validateChecklist(def);
  }

  async create(def, { author, change_note = '', activate = false, parent_version = null, source = 'ui' } = {}) {
    const result = validateChecklist(def);
    if (!result.ok) throw new ChecklistError('Чек-лист не прошёл проверку', { errors: result.errors, warnings: result.warnings });
    const data = this.store.get();
    const version = data.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const entry = {
      version,
      created_at: new Date().toISOString(),
      created_by: author || { role: 'unknown', name: '—' },
      change_note: String(change_note || '').slice(0, 500),
      parent_version: parent_version ? Number(parent_version) : null,
      source,
      checklist: result.checklist,
    };
    const next = { ...data, versions: [...data.versions, entry] };
    if (activate || !data.active_version) next.active_version = version;
    await this.store.save(next);
    return { ...this.get(version), warnings: result.warnings };
  }

  async activate(version) {
    const v = this.get(version);
    if (!v) throw new ChecklistError(`Версия ${version} не найдена`);
    const data = this.store.get();
    await this.store.save({ ...data, active_version: v.version });
    return this.get(v.version);
  }

  /** Portable JSON (no version metadata) — can be re-imported on another machine. */
  export(version) {
    const v = this.get(version);
    if (!v) return null;
    return v.checklist;
  }

  diff(fromVersion, toVersion) {
    const a = this.get(fromVersion);
    const b = this.get(toVersion);
    if (!a || !b) throw new ChecklistError('Версия не найдена');
    return diffChecklists(a.checklist, b.checklist);
  }
}

export function diffChecklists(a, b) {
  const byA = new Map(a.criteria.map((c) => [c.id, c]));
  const byB = new Map(b.criteria.map((c) => [c.id, c]));
  const added = b.criteria.filter((c) => !byA.has(c.id)).map((c) => ({ id: c.id, code: c.code, name: c.name }));
  const removed = a.criteria.filter((c) => !byB.has(c.id)).map((c) => ({ id: c.id, code: c.code, name: c.name }));
  const changed = [];
  for (const cb of b.criteria) {
    const ca = byA.get(cb.id);
    if (!ca) continue;
    const fields = [];
    for (const f of COMPARE_FIELDS) {
      if (JSON.stringify(ca[f]) !== JSON.stringify(cb[f])) fields.push({ field: f, before: ca[f], after: cb[f] });
    }
    for (const f of ['scale', 'options', 'binary', 'detector', 'flag_subtypes']) {
      if (JSON.stringify(ca[f] ?? null) !== JSON.stringify(cb[f] ?? null)) fields.push({ field: f, before: ca[f] ?? null, after: cb[f] ?? null });
    }
    if (fields.length) changed.push({ id: cb.id, code: cb.code, name: cb.name, fields });
  }
  const settings = [];
  for (const f of ['scoring', 'parameters', 'sections', 'instructions', 'risk_rules', 'name']) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) settings.push({ field: f, before: a[f], after: b[f] });
  }
  return { added, removed, changed, settings };
}
