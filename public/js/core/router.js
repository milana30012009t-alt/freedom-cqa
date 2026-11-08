// Hash router: #/path/segments?query. Pages export render(root, ctx) and may return a cleanup fn.
const routes = [];
let cleanup = null;
let renderToken = 0;

export function route(pattern, loader) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([a-z_]+)/gi, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ re, keys, loader, pattern });
}

export function currentHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path, query: new URLSearchParams(qs) };
}

export function navigate(path) {
  if (location.hash !== `#${path}`) location.hash = path;
  else window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function setQuery(params, { replace = true } = {}) {
  const { path } = currentHash();
  const qs = new URLSearchParams(params).toString();
  const url = `#${path}${qs ? `?${qs}` : ''}`;
  if (replace) history.replaceState(null, '', url);
  else location.hash = url.slice(1);
}

export async function resolve(root, onRoute) {
  const { path, query } = currentHash();
  const token = ++renderToken;
  if (typeof cleanup === 'function') {
    try { cleanup(); } catch { /* ignore */ }
  }
  cleanup = null;
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    onRoute?.(r.pattern, params);
    const mod = await r.loader();
    if (token !== renderToken) return;
    const result = await mod.render(root, { params, query, isCurrent: () => token === renderToken });
    if (token === renderToken) cleanup = result;
    return;
  }
  onRoute?.('404', {});
  root.textContent = 'Страница не найдена';
}
