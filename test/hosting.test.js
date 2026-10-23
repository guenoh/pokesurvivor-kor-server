import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.js';
import { attachGame } from '../src/static.js';

test('game hosting keeps source, keys and paths private; health probes do not query DB', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pskor-static-'));
  const game = path.join(directory, 'public');
  await fs.mkdir(path.join(game, 'assets'), { recursive: true });
  await fs.writeFile(path.join(game, 'index.html'), '<title>한국어 게임</title>');
  await fs.writeFile(path.join(game, 'assets', 'font.woff2'), 'font');
  await fs.writeFile(path.join(directory, 'private.pem'), 'PRIVATE');
  await fs.symlink(path.join(directory, 'private.pem'), path.join(game, 'assets', 'escape.pem'));
  let queries = 0;
  const app = createApp({ pool: { async query() { queries++; return { rows: [] }; } }, origin: 'https://game.example' });
  await attachGame(app, game);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}`;
  try {
    const index = await fetch(url + '/');
    assert.equal(index.status, 200); assert.match(await index.text(), /한국어/);
    const font = await fetch(url + '/assets/font.woff2', { method: 'HEAD' });
    assert.equal(font.headers.get('content-type'), 'font/woff2'); assert.equal(await font.text(), '');
    for (const route of ['/healthz', '/healthz']) assert.equal((await fetch(url + route)).status, 200);
    assert.equal(queries, 0);
    assert.equal((await fetch(url + '/api/health')).status, 200); assert.equal(queries, 1);
    assert.equal((await fetch(url + '/api/session')).status, 401);
    for (const route of ['/src/server.js', '/.env', '/private.pem', '/assets/escape.pem', '/assets/%2e%2e%2f%2e%2e%2fprivate.pem', '/assets/%5c..%5cprivate.pem']) assert.equal((await fetch(url + route)).status, 404, route);
    assert.equal((await fetch(url + '/%ZZ')).status, 400);
    assert.equal((await fetch(url + '/', { method: 'POST' })).status, 405);
  } finally {
    app.closeAllConnections(); await new Promise(resolve => app.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
