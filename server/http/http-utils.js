// HTTP helpers: JSON responses, safe body parsing with limits, error mapping, actor (role) header.
import { ROLES } from '../../shared/constants.js';
import { maskSecrets, logger } from '../lib/logger.js';

export class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function securityHeaders(cfg) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${cfg.frameAncestors}`,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}

export function applyCors(req, res, cfg) {
  const origin = req.headers.origin;
  if (origin && cfg.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-cqa-role, x-cqa-user');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const STATUS_BY_NAME = { DatasetError: 400, ChecklistError: 400, AiOutputError: 502, UpstreamError: 502 };

export function sendError(res, err) {
  const status = err.status || STATUS_BY_NAME[err.name] || 500;
  const details = err.details || (err.errors ? { errors: err.errors } : undefined);
  if (status >= 500) logger.error(`${err.name || 'Error'}: ${err.message}`);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, status, { error: maskSecrets(err.message || 'Внутренняя ошибка'), code: err.code || err.name || 'ERROR', ...(details ? { details } : {}) });
}

export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, `Слишком большой запрос (лимит ${Math.round(limit / 1048576)} МБ)`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 1024 * 1024) {
  const text = await readBody(req, limit);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Тело запроса — некорректный JSON');
  }
}

/** Demo-only role switch (no authentication by requirement): the UI sends the chosen role. */
export function actorFrom(req) {
  const role = ROLES[req.headers['x-cqa-role']] ? req.headers['x-cqa-role'] : 'specialist';
  let name = '';
  try {
    name = decodeURIComponent(String(req.headers['x-cqa-user'] || '')).trim().slice(0, 60);
  } catch {
    name = '';
  }
  return { role, name: name || ROLES[role] };
}

export function requireReviewer(actor) {
  if (actor.role !== 'reviewer') throw new HttpError(403, 'Действие доступно только проверяющему — переключите роль в шапке приложения');
}
