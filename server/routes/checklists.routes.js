// Checklist management: versions, validation, save-as-new-version, activation, import/export, diff.
import { readJson, sendJson, actorFrom, HttpError } from '../http/http-utils.js';
import { listDetectors } from '../../shared/detector-catalog.js';
import { ANSWER_TYPE_LABELS, NA_POLICIES, ROUNDING_MODES, CRITICAL_POLICIES, EVALUATION_MODES } from '../../shared/checklist-schema.js';
import { supportedRiskRules } from '../evaluation/rules/risk.js';

export function register(router, s) {
  router.get('/api/checklists', (req, res) => {
    sendJson(res, 200, { active_version: s.checklists.getActive()?.version || null, versions: s.checklists.list() });
  });

  router.get('/api/checklists/meta', (req, res) => {
    sendJson(res, 200, {
      detectors: listDetectors(),
      answer_types: ANSWER_TYPE_LABELS,
      na_policies: NA_POLICIES,
      rounding_modes: ROUNDING_MODES,
      critical_policies: CRITICAL_POLICIES,
      evaluation_modes: EVALUATION_MODES,
      offline_risk_rules: supportedRiskRules(),
    });
  });

  router.get('/api/checklists/active', (req, res) => {
    const v = s.checklists.getActive();
    if (!v) throw new HttpError(404, 'Нет активного чек-листа');
    sendJson(res, 200, v);
  });

  router.get('/api/checklists/diff', (req, res, { query }) => {
    sendJson(res, 200, s.checklists.diff(Number(query.get('from')), Number(query.get('to'))));
  });

  router.get('/api/checklists/:version', (req, res, { params }) => {
    const v = s.checklists.get(Number(params.version));
    if (!v) throw new HttpError(404, 'Версия не найдена');
    sendJson(res, 200, v);
  });

  router.get('/api/checklists/:version/export', (req, res, { params }) => {
    const def = s.checklists.export(Number(params.version));
    if (!def) throw new HttpError(404, 'Версия не найдена');
    sendJson(res, 200, def, { 'Content-Disposition': `attachment; filename="checklist-v${Number(params.version)}.json"` });
  });

  router.post('/api/checklists/validate', async (req, res) => {
    const body = await readJson(req, 2 * 1024 * 1024);
    const r = s.checklists.validate(body.checklist);
    sendJson(res, 200, { ok: r.ok, errors: r.errors, warnings: r.warnings });
  });

  router.post('/api/checklists', async (req, res) => {
    const body = await readJson(req, 2 * 1024 * 1024);
    const actor = actorFrom(req);
    const v = await s.checklists.create(body.checklist, {
      author: actor,
      change_note: body.change_note,
      activate: Boolean(body.activate),
      parent_version: body.parent_version,
      source: 'ui',
    });
    sendJson(res, 201, v);
  });

  router.post('/api/checklists/import', async (req, res) => {
    const body = await readJson(req, 2 * 1024 * 1024);
    let def = body.checklist;
    if (typeof def === 'string') {
      try { def = JSON.parse(def); } catch { throw new HttpError(400, 'Файл чек-листа — некорректный JSON'); }
    }
    const v = await s.checklists.create(def, {
      author: actorFrom(req),
      change_note: body.change_note || 'Импорт из JSON',
      activate: Boolean(body.activate),
      source: 'import',
    });
    sendJson(res, 201, v);
  });

  router.post('/api/checklists/:version/activate', async (req, res, { params }) => {
    sendJson(res, 200, await s.checklists.activate(Number(params.version)));
  });
}
