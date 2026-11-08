// Static files for the SPA (public/) and the isomorphic modules (shared/ → /shared/).
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, extname, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(root, rel) {
  const p = normalize(join(root, rel));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

export function serveStatic(req, res, cfg, pathname, headers) {
  let root = cfg.publicDir;
  let rel = pathname;
  if (pathname.startsWith('/shared/')) {
    root = cfg.sharedDir;
    rel = pathname.slice('/shared/'.length);
  }
  if (rel === '/' || rel === '') rel = 'index.html';
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { return false; }
  const file = safeJoin(root, decoded);
  if (!file) return false;
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    ...headers,
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': type.startsWith('text/html') ? 'no-store' : 'no-cache',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}
