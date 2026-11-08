// System status, datasets (API / file import / group switch), analytics and audio.
import { readJson, sendJson, actorFrom, HttpError, sendError } from '../http/http-utils.js';

export const APP_VERSION = '1.0.0';

export function register(router, s) {
  router.get('/api/health', (req, res) => sendJson(res, 200, { ok: true, version: APP_VERSION }));

  router.get('/api/system', (req, res) => {
    const active = s.checklists.getActive();
    sendJson(res, 200, {
      version: APP_VERSION,
      engine: s.evaluations.engineInfo(),
      dataset: s.datasets.status(),
      checklist: active ? { version: active.version, name: active.checklist.name, official: active.checklist.official } : null,
      actor: actorFrom(req),
      now: new Date().toISOString(),
    });
  });

  router.get('/api/datasets', (req, res) => sendJson(res, 200, s.datasets.status()));

  router.post('/api/datasets/fetch', async (req, res) => {
    const body = await readJson(req);
    const result = await s.datasets.fetchFromApi(body.group_id);
    if (body.activate) await s.datasets.setActive(result.group_id);
    sendJson(res, 200, { result, status: s.datasets.status() });
  });

  router.post('/api/datasets/import', async (req, res) => {
    const body = await readJson(req, s.cfg.maxUploadBytes);
    if (!body.group_id) throw new HttpError(400, 'Укажите group_id набора');
    if (body.content === undefined || body.content === null || body.content === '') throw new HttpError(400, 'Файл пустой');
    const result = await s.datasets.importPayload(body.group_id, body.content, 'file');
    if (body.activate) await s.datasets.setActive(result.group_id);
    sendJson(res, 200, { result, status: s.datasets.status() });
  });

  router.post('/api/datasets/active', async (req, res) => {
    const body = await readJson(req);
    sendJson(res, 200, await s.datasets.setActive(body.group_id));
  });

  router.get('/api/analytics/summary', (req, res, { query }) => {
    sendJson(res, 200, s.analytics.summary(query.get('group') || undefined));
  });

  router.get('/api/audio/:uid/status', (req, res, { params }) => {
    if (!s.datasets.get(params.uid)) throw new HttpError(404, 'Диалог не найден');
    sendJson(res, 200, s.audio.status(params.uid));
  });

  router.get('/api/audio/:uid', async (req, res, { params }) => {
    if (!s.datasets.get(params.uid)) throw new HttpError(404, 'Диалог не найден');
    try {
      await s.audio.serve(req, res, params.uid);
    } catch (e) {
      sendError(res, e);
    }
  });
}
