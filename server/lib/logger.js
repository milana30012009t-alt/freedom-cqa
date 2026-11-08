// Logger that never prints secrets: signed URL parameters and API keys are masked.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
let current = LEVELS.info;

export function setLogLevel(level) {
  current = LEVELS[level] ?? LEVELS.info;
}

const SECRET_PATTERNS = [
  [/([?&](?:sig|signature|sv|sp|token|key|code|api[-_]?key|access_token)=)[^&\s"']+/gi, '$1***'],
  [/(sk-ant-[a-z0-9-]{4})[a-z0-9_-]+/gi, '$1***'],
  [/(sk-[a-z0-9]{4})[a-z0-9_-]{8,}/gi, '$1***'],
  [/(x-api-key["':\s]+)[^"',\s]+/gi, '$1***'],
  [/(authorization["':\s]+bearer\s+)[^"',\s]+/gi, '$1***'],
];

export function maskSecrets(value) {
  let s = typeof value === 'string' ? value : value instanceof Error ? `${value.message}` : JSON.stringify(value);
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}

/** Show only scheme + host + first path segment of a URL (for UI/logs). */
export function describeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    const first = u.pathname.split('/').filter(Boolean)[0] || '';
    return `${u.protocol}//${u.host}/${first}${first ? '/…' : ''}${u.search ? ' (параметры скрыты)' : ''}`;
  } catch {
    return '(некорректный URL)';
  }
}

function log(level, msg, extra) {
  if (LEVELS[level] < current) return;
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${maskSecrets(msg)}${extra !== undefined ? ` ${maskSecrets(extra)}` : ''}`;
  if (level === 'error' || level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (m, e) => log('debug', m, e),
  info: (m, e) => log('info', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};
