// Appeals and manual review. History is append-only and there is no delete operation:
// the original evaluation, the appeal, the decision and the final result all stay visible.
import { join } from 'node:path';
import { DocStore } from '../storage/json-store.js';
import { APPEAL_OPEN_STATUSES } from '../../shared/constants.js';
import { answerLabel } from '../../shared/checklist-schema.js';

export class AppealError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'AppealError';
    this.status = status;
  }
}

export class AppealsService {
  constructor({ cfg, evaluations }) {
    this.evaluations = evaluations;
    this.store = new DocStore(join(cfg.dataDir, 'store', 'appeals.json'), { seq: 0, items: [] });
  }

  list({ status, uid, evaluationId } = {}) {
    let items = [...this.store.get().items];
    if (status) {
      const set = new Set(String(status).split(','));
      items = items.filter((a) => set.has(a.status));
    }
    if (uid) items = items.filter((a) => a.conversation_uid === uid);
    if (evaluationId) items = items.filter((a) => a.evaluation_id === evaluationId);
    return items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id) {
    return this.store.get().items.find((a) => a.id === id) || null;
  }

  counts() {
    const out = { new: 0, pending: 0, confirmed: 0, changed: 0, closed: 0, open: 0, total: 0 };
    for (const a of this.store.get().items) {
      out[a.status] = (out[a.status] || 0) + 1;
      out.total += 1;
      if (APPEAL_OPEN_STATUSES.includes(a.status)) out.open += 1;
    }
    return out;
  }

  async save(mutator) {
    const data = structuredClone(this.store.get());
    const result = mutator(data);
    await this.store.save(data);
    return result;
  }

  effectiveResult(e, criterionId) {
    const r = e.results.find((x) => x.criterion_id === criterionId);
    const o = e.overrides?.[criterionId];
    const sc = e.score_final.criteria.find((x) => x.criterion_id === criterionId);
    const c = e.checklist.criteria.find((x) => x.id === criterionId);
    return {
      status: o ? o.status : r?.status,
      answer: o ? o.answer : r?.answer ?? null,
      answer_label: o ? o.answer_label : r?.answer_label || (r?.status === 'na' ? 'N/A' : answerLabel(c, r?.answer)),
      explanation: r?.explanation || '',
      evidence: r?.evidence || [],
      checked_range: r?.checked_range || null,
      confidence: r?.confidence ?? null,
      points: sc ? Number(sc.points.toFixed(2)) : null,
      max_points: sc ? Number(sc.max_points.toFixed(2)) : null,
      overridden: Boolean(o),
      engine: e.engine.used,
    };
  }

  async create({ evaluation_id: evaluationId, criterion_id: criterionId, comment }, actor) {
    const e = this.evaluations.get(evaluationId);
    if (!e) throw new AppealError('Оценка не найдена', 404);
    const c = e.checklist.criteria.find((x) => x.id === criterionId && x.enabled);
    if (!c) throw new AppealError('Критерий не найден в оценке', 404);
    const text = String(comment || '').trim();
    if (text.length < 5) throw new AppealError('Опишите, с чем вы не согласны (минимум 5 символов)');
    if (text.length > 4000) throw new AppealError('Комментарий слишком длинный');
    const open = this.list({ evaluationId }).find((a) => a.criterion_id === criterionId && APPEAL_OPEN_STATUSES.includes(a.status));
    if (open) throw new AppealError(`По этому критерию уже есть открытая апелляция ${open.id}`, 409);
    const now = new Date().toISOString();
    return this.save((data) => {
      data.seq += 1;
      const appeal = {
        id: `AP-${String(data.seq).padStart(4, '0')}`,
        conversation_uid: e.conversation_uid,
        conversation_id: e.conversation_id,
        group: e.group,
        evaluation_id: e.id,
        checklist_version: e.checklist_version,
        criterion_id: c.id,
        criterion_code: c.code,
        criterion_name: c.name,
        status: 'new',
        created_at: now,
        created_by: actor,
        comment: text,
        original: { ...this.effectiveResult(e, c.id), total: e.score_final.total },
        decision: null,
        history: [{ at: now, actor, action: 'created', status_from: null, status_to: 'new', note: text }],
      };
      data.items.push(appeal);
      return appeal;
    });
  }

  requireReviewer(actor) {
    if (actor?.role !== 'reviewer') throw new AppealError('Действие доступно только проверяющему — переключите роль в шапке', 403);
  }

  async take(id, actor) {
    this.requireReviewer(actor);
    const now = new Date().toISOString();
    return this.save((data) => {
      const a = data.items.find((x) => x.id === id);
      if (!a) throw new AppealError('Апелляция не найдена', 404);
      if (a.status !== 'new') throw new AppealError('Взять в работу можно только новую апелляцию', 409);
      a.status = 'pending';
      a.assigned_to = actor;
      a.history.push({ at: now, actor, action: 'taken', status_from: 'new', status_to: 'pending', note: '' });
      return a;
    });
  }

  async decide(id, { decision, status = 'scored', answer, reason }, actor) {
    this.requireReviewer(actor);
    const a = this.get(id);
    if (!a) throw new AppealError('Апелляция не найдена', 404);
    if (!APPEAL_OPEN_STATUSES.includes(a.status)) throw new AppealError('Решение уже принято', 409);
    const why = String(reason || '').trim();
    if (!why) throw new AppealError('Укажите причину решения');
    if (!['confirm', 'change'].includes(decision)) throw new AppealError('Решение: confirm или change');
    const e = this.evaluations.get(a.evaluation_id);
    if (!e) throw new AppealError('Исходная оценка не найдена', 404);
    const totalBefore = e.score_final.total;
    let updated = e;
    if (decision === 'change') {
      try {
        updated = await this.evaluations.applyOverride(e.id, a.criterion_id, { status, answer, reason: why, appealId: a.id }, actor);
      } catch (err) {
        throw new AppealError(err.message, err.status || 400);
      }
    }
    const now = new Date().toISOString();
    return this.save((data) => {
      const x = data.items.find((y) => y.id === id);
      const from = x.status;
      if (from === 'new') x.history.push({ at: now, actor, action: 'taken', status_from: 'new', status_to: 'pending', note: 'Автоматически при принятии решения' });
      x.status = decision === 'confirm' ? 'confirmed' : 'changed';
      x.decision = {
        type: decision,
        status: decision === 'change' ? status : x.original.status,
        answer: decision === 'change' ? updated.overrides[x.criterion_id].answer : x.original.answer,
        answer_label: decision === 'change' ? updated.overrides[x.criterion_id].answer_label : x.original.answer_label,
        reason: why,
        decided_at: now,
        decided_by: actor,
        total_before: totalBefore,
        total_after: updated.score_final.total,
      };
      x.history.push({ at: now, actor, action: decision === 'confirm' ? 'confirmed' : 'changed', status_from: 'pending', status_to: x.status, note: why });
      return x;
    });
  }

  async close(id, note, actor) {
    const now = new Date().toISOString();
    return this.save((data) => {
      const a = data.items.find((x) => x.id === id);
      if (!a) throw new AppealError('Апелляция не найдена', 404);
      if (a.status === 'closed') throw new AppealError('Апелляция уже закрыта', 409);
      if (a.status === 'pending') throw new AppealError('Апелляция на рассмотрении — дождитесь решения', 409);
      const from = a.status;
      a.status = 'closed';
      a.closed_at = now;
      a.history.push({ at: now, actor, action: from === 'new' ? 'withdrawn' : 'closed', status_from: from, status_to: 'closed', note: String(note || '').trim() });
      return a;
    });
  }
}
