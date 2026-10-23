import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
let pool, app, base;
const origin = 'http://localhost:8080';
before(async () => {
  const Driver = process.env.DATABASE_URL ? pg : newDb().adapters.createPg();
  pool = new Driver.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  await migrate(pool);
  app = createApp({ pool, origin, secureCookies: false, authLimit: 100, logger: { error() {} } });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { app.closeAllConnections(); await new Promise(r => app.close(r)); await pool.end(); });
async function request(path, { method = 'GET', data, cookie, from = origin } = {}) {
  const headers = { Origin: from };
  if (cookie) headers.Cookie = cookie;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
}
test('account isolation, session, revision conflicts, logout and deletion', async () => {
  const suffix = Date.now().toString(36), name = '한글' + suffix, password = 'sufficient-password-2026';
  assert.equal((await request('/api/save')).status, 401);
  const a = await request('/api/auth/register', { method: 'POST', data: { name, password } });
  assert.equal(a.status, 201); assert.match(a.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  assert.equal((await request('/api/auth/register', { method: 'POST', data: { name, password } })).status, 409);
  const wrong = await request('/api/auth/login', { method: 'POST', data: { name, password: 'wrong-password-123' } });
  assert.equal(wrong.status, 401);
  const signed = await request('/api/auth/login', { method: 'POST', data: { name, password } });
  assert.equal(signed.status, 200);
  const save = { v: 3, coins: 42, owned: { 25: { from: 'starter', at: 123 } }, led: { device1: { coins: [100, 58] } } };
  const put = await request('/api/save', { method: 'PUT', cookie: a.cookie, data: { save, revision: 0 } });
  assert.deepEqual(put.data, { revision: 1 });
  assert.equal((await request('/api/save', { method: 'PUT', cookie: a.cookie, data: { save: { coins: 0 }, revision: 0 } })).status, 409);
  const loaded = await request('/api/session', { cookie: signed.cookie });
  assert.deepEqual(loaded.data.save, save);
  const b = await request('/api/auth/register', { method: 'POST', data: { name: 'other' + suffix, password } });
  assert.deepEqual((await request('/api/save', { cookie: b.cookie })).data.save, {});
  assert.equal((await request('/api/auth/logout', { method: 'POST', cookie: signed.cookie })).status, 200);
  assert.equal((await request('/api/save', { cookie: signed.cookie })).status, 401);
  assert.equal((await request('/api/account', { method: 'DELETE', cookie: a.cookie, data: { password: 'wrong-password-123' } })).status, 401);
  assert.equal((await request('/api/account', { method: 'DELETE', cookie: a.cookie, data: { password } })).status, 200);
  assert.equal((await request('/api/save', { cookie: a.cookie })).status, 401);
});
test('CSRF, credential validation, invalid payload and database health', async () => {
  assert.equal((await request('/api/health')).status, 200);
  assert.equal((await request('/api/auth/register', { method: 'POST', data: {}, from: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/auth/register', { method: 'POST', data: { name: 'abc', password: 'abc' } })).status, 400);
  const a = await request('/api/auth/register', { method: 'POST', data: { name: 'safe' + Date.now().toString(36), password: 'safe-password-123' } });
  const save = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal((await request('/api/save', { method: 'PUT', cookie: a.cookie, data: { save, revision: 0 } })).status, 400);
  assert.equal((await request('/api/save', { method: 'PUT', cookie: a.cookie, data: { save: [], revision: 0 } })).status, 400);
  assert.equal((await request('/api/save', { method: 'PUT', cookie: a.cookie, data: { save: {}, revision: -1 } })).status, 400);
});
