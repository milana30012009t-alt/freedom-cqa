// Application factory: wires services and the HTTP server. Used by server/index.js and the tests.
import http from 'node:http';
import { Router } from './http/router.js';
import { applyCors, securityHeaders, sendError, sendJson } from './http/http-utils.js';
import { serveStatic } from './http/static.js';
import { DatasetService } from './data/dataset-service.js';
import { ChecklistService } from './checklist/checklist-service.js';
import { EvaluationService } from './evaluation/evaluation-service.js';
import { AppealsService } from './appeals/appeals-service.js';
import { AnalyticsService } from './analytics/analytics-service.js';
import { AudioService } from './audio/audio-service.js';
import { JobQueue } from './jobs/job-queue.js';
import { register as conversationsRoutes } from './routes/conversations.routes.js';
import { register as evaluationsRoutes } from './routes/evaluations.routes.js';
import { register as checklistsRoutes } from './routes/checklists.routes.js';
import { register as appealsRoutes } from './routes/appeals.routes.js';
import { register as systemRoutes } from './routes/system.routes.js';
import { logger } from './lib/logger.js';

export function createServices(cfg, { providerOverride = null, fetchImpl, audioFetchImpl, datasetFetchImpl } = {}) {
  const datasets = new DatasetService({ cfg, fetchImpl: datasetFetchImpl || fetchImpl });
  const checklists = new ChecklistService({ cfg });
  const evaluations = new EvaluationService({ cfg, datasets, checklists, providerOverride, fetchImpl });
  const appeals = new AppealsService({ cfg, evaluations });
  const analytics = new AnalyticsService({ datasets, evaluations, appeals, checklists });
  const audio = new AudioService({ cfg, datasets, fetchImpl: audioFetchImpl || fetchImpl });
  const jobs = new JobQueue();
  return { cfg, datasets, checklists, evaluations, appeals, analytics, audio, jobs };
}

export async function initServices(s) {
  await s.checklists.init();
  if (!s.datasets.listGroups().length && s.cfg.dataset.apiUrl && s.cfg.dataset.autoload) {
    try {
      const r = await s.datasets.fetchFromApi(s.cfg.dataset.groupId);
      logger.info(`Набор ${r.group_id} загружен из API: ${r.record_count} диалогов`);
    } catch (e) {
      logger.warn(`Автозагрузка набора из API не удалась: ${e.message}. Загрузите JSON-файл через раздел «Данные».`);
    }
  }
}

export function createApp(cfg, options = {}) {
  const services = createServices(cfg, options);
  const router = new Router();
  conversationsRoutes(router, services);
  evaluationsRoutes(router, services);
  checklistsRoutes(router, services);
  appealsRoutes(router, services);
  systemRoutes(router, services);
  const secHeaders = securityHeaders(cfg);

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(secHeaders)) res.setHeader(k, v);
    applyCors(req, res, cfg);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      sendJson(res, 400, { error: 'Некорректный URL' });
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (url.pathname.startsWith('/api/')) {
        const m = router.match(req.method, url.pathname);
        if (!m) {
          sendJson(res, 404, { error: 'Маршрут не найден' });
          return;
        }
        await m.handler(req, res, { params: m.params, query: url.searchParams });
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, cfg, url.pathname, {})) return;
      sendJson(res, 404, { error: 'Не найдено' });
    } catch (e) {
      sendError(res, e);
    }
  });
  return { server, services, init: () => initServices(services) };
}
