// Appeals: submit (specialist), take / decide (reviewer), close; detail view for the reviewer.
import { readJson, sendJson, actorFrom, HttpError } from '../http/http-utils.js';

export function register(router, s) {
  router.get('/api/appeals', (req, res, { query }) => {
    const items = s.appeals.list({ status: query.get('status') || undefined, uid: query.get('uid') || undefined });
    sendJson(res, 200, { counts: s.appeals.counts(), items });
  });

  router.get('/api/appeals/:id', (req, res, { params }) => {
    const a = s.appeals.get(params.id);
    if (!a) throw new HttpError(404, 'Апелляция не найдена');
    const e = s.evaluations.get(a.evaluation_id);
    const conv = s.datasets.get(a.conversation_uid);
    const criterion = e?.checklist.criteria.find((c) => c.id === a.criterion_id) || null;
    const ids = new Set((a.original.evidence || []).map((x) => x.message_id));
    const range = a.original.checked_range;
    const fragment = conv ? conv.messages.filter((m) => {
      if (ids.has(m.id)) return true;
      if (range) {
        const from = Number(range.from.slice(1));
        const to = Number(range.to.slice(1));
        return m.index >= from && m.index <= to;
      }
      return false;
    }) : [];
    sendJson(res, 200, {
      appeal: a,
      criterion,
      evaluation: e ? s.evaluations.summary(e) : null,
      score: e ? { original: e.score_original, final: e.score_final } : null,
      checklist: e ? { scoring: e.checklist.scoring, criteria: e.checklist.criteria, sections: e.checklist.sections } : null,
      results: e ? e.results : [],
      overrides: e ? e.overrides : {},
      fragment,
      conversation: conv ? { uid: conv.uid, conversation_id: conv.conversation_id, language: conv.language, channel_type: conv.channel_type } : null,
    });
  });

  router.post('/api/appeals', async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 201, await s.appeals.create(body, actorFrom(req)));
  });

  router.post('/api/appeals/:id/take', async (req, res, { params }) => {
    sendJson(res, 200, await s.appeals.take(params.id, actorFrom(req)));
  });

  router.post('/api/appeals/:id/decide', async (req, res, { params }) => {
    const body = await readJson(req);
    sendJson(res, 200, await s.appeals.decide(params.id, body, actorFrom(req)));
  });

  router.post('/api/appeals/:id/close', async (req, res, { params }) => {
    const body = await readJson(req);
    sendJson(res, 200, await s.appeals.close(params.id, body.note, actorFrom(req)));
  });
}
