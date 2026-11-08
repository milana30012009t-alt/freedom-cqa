// API client. All requests carry the demo role (no authentication by requirement).
import { store } from './store.js';

const BASE = (window.CQA_CONFIG && window.CQA_CONFIG.apiBase) || '';

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request(method, path, body) {
  const headers = {
    'x-cqa-role': store.state.role,
    'x-cqa-user': encodeURIComponent(store.state.userName || ''),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('Сервер недоступен. Проверьте, что приложение запущено (npm start).', 0);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new ApiError(data?.error || `Ошибка ${res.status}`, res.status, data?.details);
  return data;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b = {}) => request('POST', p, b),
  url: (p) => `${BASE}${p}`,
  enc: (s) => encodeURIComponent(s),
};
