// Outbound HTTP helper: timeout, bounded retries with backoff, transient-error detection.
import { logger, maskSecrets } from './logger.js';

export class UpstreamError extends Error {
  constructor(message, { status = 0, body = '', retryable = false, code = 'UPSTREAM_ERROR' } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

/**
 * fetch() with timeout and retries.
 * @param {string} url
 * @param {RequestInit & {timeoutMs?:number, retries?:number, backoffMs?:number, label?:string, fetchImpl?:Function}} opts
 * @returns {Promise<Response>} a response with ok status (non-OK statuses throw UpstreamError)
 */
export async function fetchWithRetry(url, opts = {}) {
  const { timeoutMs = 30000, retries = 2, backoffMs = 600, label = 'request', fetchImpl = globalThis.fetch, ...init } = opts;
  let attempt = 0;
  let lastError = null;
  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      const retryable = isRetryableStatus(res.status);
      lastError = new UpstreamError(`${label}: HTTP ${res.status}`, { status: res.status, body: body.slice(0, 2000), retryable });
      if (!retryable) throw lastError;
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 20000) : backoffMs * 2 ** attempt;
      logger.warn(`${label}: HTTP ${res.status}, повтор через ${wait} мс (попытка ${attempt + 1}/${retries + 1})`);
      await sleep(wait);
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof UpstreamError && !e.retryable) throw e;
      const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
      lastError = e instanceof UpstreamError ? e : new UpstreamError(
        aborted ? `${label}: превышено время ожидания (${Math.round(timeoutMs / 1000)} с)` : `${label}: сетевая ошибка (${maskSecrets(e?.cause?.code || e?.message || e)})`,
        { retryable: true, code: aborted ? 'TIMEOUT' : 'NETWORK' },
      );
      if (attempt >= retries) break;
      const wait = backoffMs * 2 ** attempt;
      logger.warn(`${lastError.message}; повтор через ${wait} мс`);
      await sleep(wait);
    }
    attempt += 1;
  }
  throw lastError || new UpstreamError(`${label}: неизвестная ошибка`);
}
