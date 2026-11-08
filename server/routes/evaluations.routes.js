// Evaluations: details, comparison, reviewer actions (override, finding review, verification).
import { readJson, sendJson, actorFrom, requireReviewer, HttpError } from '../http/http-utils.js';

export function register(router, s) {
  router.get('/api/evaluations/:id', (req, res, { params }) => {
    const e = s.evaluations.get(params.id);
    if (!e) throw new HttpError(404, 'Оценка не найдена');
    sendJson(res, 200, e);
  });

  router.get('/api/evaluations/:id/compare/:other', (req, res, { params }) => {
    sendJson(res, 200, s.evaluations.compare(params.id, params.other));
  });

  router.post('/api/evaluations/:id/override', async (req, res, { params }) => {
    const actor = actorFrom(req);
    requireReviewer(actor);
    const body = await readJson(req);
    const e = await s.evaluations.applyOverride(params.id, body.criterion_id, { status: body.status || 'scored', answer: body.answer, reason: body.reason }, actor);
    sendJson(res, 200, e);
  });

  router.post('/api/evaluations/:id/findings/:finding/review', async (req, res, { params }) => {
    const actor = actorFrom(req);
    requireReviewer(actor);
    const body = await readJson(req);
    sendJson(res, 200, await s.evaluations.reviewFinding(params.id, params.finding, body.decision, body.note, actor));
  });

  router.post('/api/evaluations/:id/verify', async (req, res, { params }) => {
    const actor = actorFrom(req);
    requireReviewer(actor);
    const body = await readJson(req);
    sendJson(res, 200, await s.evaluations.verify(params.id, body.note, actor));
  });
}
