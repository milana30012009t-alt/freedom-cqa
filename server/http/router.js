// Tiny router: method + path pattern with :params.
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/\/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })}/?$`);
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }

  post(p, h) { return this.add('POST', p, h); }

  match(method, path) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        try { params[k] = decodeURIComponent(m[i + 1]); } catch { params[k] = m[i + 1]; }
      });
      return { handler: r.handler, params };
    }
    return null;
  }
}
