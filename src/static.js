import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const rootFiles = new Set(['index.html', 'version.json', 'release.json', 'sw.js', 'manifest.webmanifest', 'favicon.ico', 'LICENSE', 'LICENSE-NONCOMMERCIAL.md', 'CREDITS.md']);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };

// Only a packaged game directory is public. The server repository and backups never are.
export async function attachGame(app, directory) {
  const root = await realpath(directory);
  if (!(await stat(path.join(root, 'index.html'))).isFile()) throw new Error('Game package is missing');
  const api = app.listeners('request')[0];
  app.removeListener('request', api);
  app.on('request', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-cache');
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
    catch { res.writeHead(400); res.end(); return; }
    if (pathname === '/api' || pathname.startsWith('/api/')) { api(req, res); return; }
    // Render probes this path frequently. Do not wake Neon or consume DB quota here.
    if (pathname === '/healthz' && ['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : '{"ok":true}'); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    try {
      const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (relative.includes('\\') || relative.split('/').some(p => p.startsWith('.')) || (!rootFiles.has(relative) && !/^(assets|js|css|kor)\//.test(relative))) throw new Error('Not public');
      const file = await realpath(path.resolve(root, relative));
      if (!file.startsWith(root + path.sep)) throw new Error('Outside game');
      const info = await stat(file);
      if (!info.isFile()) throw new Error('Not a file');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': info.size });
      if (req.method === 'HEAD') res.end();
      else createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
