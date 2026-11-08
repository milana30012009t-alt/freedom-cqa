// Conversations: list with filters/sorting, card data, evaluation (single and batch).
import { readJson, sendJson, actorFrom, HttpError } from '../http/http-utils.js';
import { estimateBatch } from '../evaluation/cost.js';
import { APPEAL_OPEN_STATUSES } from '../../shared/constants.js';

export function conversationRow(s, conv) {
  const ev = s.evaluations.latestFor(conv.uid);
  const summary = s.evaluations.summary(ev);
  const appeals = s.appeals.list({ uid: conv.uid });
  const open = appeals.filter((a) => APPEAL_OPEN_STATUSES.includes(a.status));
  let status = 'not_evaluated';
  if (summary) {
    if (open.length) status = 'appeal';
    else if (summary.needs_human_review) status = 'needs_review';
    else if (summary.verified || summary.overrides || appeals.length) status = 'reviewed';
    else status = 'auto';
  }
  return {
    uid: conv.uid,
    conversation_id: conv.conversation_id,
    group: conv.group,
    language: conv.language,
    channel_type: conv.channel_type,
    message_count: conv.stats.message_count,
    duration_sec: conv.duration_sec,
    started_at: conv.started_at,
    has_audio: conv.has_audio,
    quality_level: conv.quality.level,
    preview: conv.preview.slice(0, 120),
    status,
    evaluation: summary,
    appeals_open: open.length,
    appeal_status: appeals[0]?.status || null,
  };
}

const SORTERS = {
  id: (r) => r.conversation_id,
  language: (r) => r.language,
  channel: (r) => r.channel_type,
  score: (r) => (r.evaluation?.total ?? -1),
  status: (r) => r.status,
  date: (r) => r.started_at ?? r.duration_sec ?? 0,
  duration: (r) => r.duration_sec ?? 0,
  messages: (r) => r.message_count,
  priority: (r) => ({ critical: 0, high: 1, medium: 2, low: 3 }[r.evaluation?.priority] ?? 4),
};

export function register(router, s) {
  router.get('/api/conversations', (req, res, { query }) => {
    const group = query.get('group') || undefined;
    let rows = s.datasets.conversations(group).map((c) => conversationRow(s, c));
    const q = (query.get('q') || '').trim().toLowerCase();
    if (q) rows = rows.filter((r) => r.conversation_id.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q));
    const lang = query.get('language');
    if (lang) rows = rows.filter((r) => lang.split(',').includes(r.language));
    const channel = query.get('channel');
    if (channel) rows = rows.filter((r) => channel.split(',').includes(r.channel_type));
    const status = query.get('status');
    if (status) rows = rows.filter((r) => status.split(',').includes(r.status));
    if (query.get('critical') === '1') rows = rows.filter((r) => (r.evaluation?.critical_count || 0) + (r.evaluation?.risk_count || 0) > 0);
    if (query.get('gross') === '1') rows = rows.filter((r) => r.evaluation?.gross_error === true);
    const min = Number(query.get('min'));
    const max = Number(query.get('max'));
    if (query.get('min') !== null && Number.isFinite(min)) rows = rows.filter((r) => Number.isFinite(r.evaluation?.total) && r.evaluation.total >= min);
    if (query.get('max') !== null && Number.isFinite(max)) rows = rows.filter((r) => Number.isFinite(r.evaluation?.total) && r.evaluation.total <= max);
    const fail = query.get('fail');
    if (fail) {
      rows = rows.filter((r) => {
        const e = s.evaluations.latestFor(r.uid);
        const sc = e?.score_final.criteria.find((x) => x.criterion_id === fail);
        if (!sc || sc.status !== 'scored') return false;
        return sc.role === 'flag' ? sc.answer === 'yes' : sc.normalized < 0.999;
      });
    }
    const appeal = query.get('appeal');
    if (appeal === 'open') rows = rows.filter((r) => r.appeals_open > 0);
    if (appeal === 'any') rows = rows.filter((r) => r.appeal_status);
    const sortKey = SORTERS[query.get('sort')] ? query.get('sort') : null;
    const dir = query.get('dir') === 'desc' ? -1 : 1;
    if (sortKey) {
      const f = SORTERS[sortKey];
      rows.sort((a, b) => {
        const x = f(a);
        const y = f(b);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    sendJson(res, 200, { group: group || s.datasets.status().active_group, total: rows.length, items: rows });
  });

  router.get('/api/conversations/:uid', (req, res, { params }) => {
    const conv = s.datasets.get(params.uid);
    if (!conv) throw new HttpError(404, 'Диалог не найден');
    const evaluations = s.evaluations.listFor(conv.uid);
    const latest = evaluations[evaluations.length - 1] || null;
    sendJson(res, 200, {
      conversation: conv,
      row: conversationRow(s, conv),
      evaluation: latest,
      evaluations: evaluations.map((e) => s.evaluations.summary(e)).reverse(),
      appeals: s.appeals.list({ uid: conv.uid }),
      audio: conv.has_audio ? s.audio.status(conv.uid) : null,
    });
  });

  router.post('/api/conversations/:uid/evaluate', async (req, res, { params }) => {
    const body = await readJson(req);
    const actor = actorFrom(req);
    const prev = s.evaluations.latestFor(params.uid);
    const ev = await s.evaluations.evaluate(params.uid, {
      engine: ['ai', 'rules', 'auto'].includes(body.engine) ? body.engine : 'auto',
      checklistVersion: body.checklist_version || null,
      actor,
    });
    sendJson(res, 201, {
      evaluation: ev,
      previous_id: prev?.id || null,
      diff: prev ? s.evaluations.compare(prev.id, ev.id) : null,
    });
  });

  router.post('/api/evaluations/batch', async (req, res) => {
    const body = await readJson(req);
    const actor = actorFrom(req);
    const group = body.group || undefined;
    const all = s.datasets.conversations(group);
    let uids;
    const scope = body.scope || 'unevaluated';
    if (scope === 'selected') uids = (Array.isArray(body.uids) ? body.uids : []).filter((u) => s.datasets.get(u));
    else if (scope === 'all') uids = all.map((c) => c.uid);
    else if (scope === 'outdated') {
      const active = s.checklists.getActive()?.version;
      uids = all.filter((c) => {
        const e = s.evaluations.latestFor(c.uid);
        return !e || e.checklist_version !== active || e.transcript_hash !== c.transcript_hash;
      }).map((c) => c.uid);
    } else uids = all.filter((c) => !s.evaluations.latestFor(c.uid)).map((c) => c.uid);
    const engine = ['ai', 'rules', 'auto'].includes(body.engine) ? body.engine : 'auto';
    const usesAi = engine !== 'rules' && s.evaluations.engineInfo().ai_available;
    const job = s.jobs.start('evaluate', uids, async (uid) => {
      const ev = await s.evaluations.evaluate(uid, { engine, checklistVersion: body.checklist_version || null, actor });
      return { evaluation_id: ev.id, total: ev.score_final.total, engine: ev.engine.used };
    }, { concurrency: usesAi ? s.cfg.ai.concurrency : 1, label: `Оценка: ${uids.length} диалогов` });
    sendJson(res, 202, job);
  });

  router.get('/api/jobs/:id', (req, res, { params }) => {
    const job = s.jobs.get(params.id);
    if (!job) throw new HttpError(404, 'Задача не найдена');
    sendJson(res, 200, job);
  });

  router.get('/api/estimate', (req, res, { query }) => {
    const group = query.get('group') || undefined;
    const scope = query.get('scope') || 'all';
    const convs = s.datasets.conversations(group).filter((c) => scope === 'all' || !s.evaluations.latestFor(c.uid));
    const active = s.checklists.getActive();
    if (!active) throw new HttpError(404, 'Нет активного чек-листа');
    sendJson(res, 200, {
      model: s.evaluations.engineInfo().ai?.model || s.cfg.ai.anthropic.model,
      ...estimateBatch(convs, active.checklist, s.cfg.ai.pricing, { promptCaching: s.cfg.ai.anthropic.promptCaching }),
    });
  });
}
