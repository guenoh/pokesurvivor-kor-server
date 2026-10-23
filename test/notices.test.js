import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { initializeNotices, grantTickets } from '../src/notices.js';
let pool, app, base, clock = Date.now();
const origin = 'https://game.example';
const config = {
  notices: [
    { id: 'test-signup', version: 1, title: '가입 선물', paragraphs: ['환영합니다'], reward: { ticket10: 100, window: 'signup24h' } },
    { id: 'test-event', version: 1, title: '오픈 선물', paragraphs: ['오픈 인사'], reward: { ticket10: 100, window: 'event24h' } }
  ], support: { title: '후원', url: null }
};
before(async () => {
  const Driver = process.env.DATABASE_URL ? pg : newDb().adapters.createPg();
  pool = new Driver.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  await migrate(pool); await initializeNotices(pool, config);
  clock = Date.now() + 1000;
  app = createApp({ pool, origin, secureCookies: false, authLimit: 100, notices: config, clock: () => clock, logger: { error() {} } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); await pool.end(); });
async function request(path, { cookie, method = 'GET', data, from = origin } = {}) {
  const result = await fetch(base + path, { method, headers: { Origin: from, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: result.status, data: await result.json(), cookie: result.headers.get('set-cookie')?.split(';')[0] };
}
async function register(password = '1234') {
  const result = await request('/api/auth/register', { method: 'POST', data: { name: '선물' + randomBytes(4).toString('hex'), password } });
  assert.equal(result.status, 201); clock = Date.now() + 1000; return result;
}
const claim = (cookie, id, revision = 0, extra = {}) => request(`/api/notices/${id}/claim`, { method: 'POST', cookie, data: { revision, ...extra } });
test('password minimum is four characters and notices do not grant anonymous rewards', async () => {
  assert.equal((await request('/api/auth/register', { method: 'POST', data: { name: '짧은암호', password: '123' } })).status, 400);
  const user = await register();
  assert.equal((await request('/api/notices/test-signup/claim', { method: 'POST', cookie: user.cookie, from: 'https://evil.example', data: { revision: 0 } })).status, 403);
  const notices = await request('/api/notices');
  assert.equal(notices.status, 200); assert.equal(notices.data.notices[0].reward.needsLogin, true);
  assert.equal((await claim(null, 'test-signup')).status, 401);
  assert.equal((await request('/api/notices', { cookie: user.cookie })).data.notices[0].reward.eligible, true);
});
test('one account receives exactly 100 ten-draw tickets; retries and stale saves cannot duplicate or erase them', async () => {
  const user = await register();
  const saved = { coins: 42, tickets: { t1: 3, t10: 2 }, led: { base: { c: [42, 0], t1: [3, 0], t10: [2, 0] } }, owned: { 25: { from: 'starter' } } };
  assert.equal((await request('/api/save', { cookie: user.cookie, method: 'PUT', data: { save: saved, revision: 0 } })).status, 200);
  assert.equal((await claim(user.cookie, 'test-signup', 0)).status, 409);
  const result = await claim(user.cookie, 'test-signup', 1, { ticket10: 999999 });
  assert.equal(result.status, 200); assert.equal(result.data.granted, true);
  assert.equal(result.data.save.tickets.t10, 102); assert.equal(result.data.save.tickets.t1, 3); assert.equal(result.data.save.coins, 42);
  assert.deepEqual(result.data.save.led['server:test-signup'].t10, [100, 0]);
  assert.deepEqual(result.data.save.owned, saved.owned);
  const retry = await claim(user.cookie, 'test-signup', 1);
  assert.equal(retry.status, 200); assert.equal(retry.data.alreadyClaimed, true); assert.equal(retry.data.save.tickets.t10, 102);
  assert.equal((await request('/api/save', { cookie: user.cookie, method: 'PUT', data: { save: saved, revision: 1 } })).status, 409);
  assert.equal((await request('/api/notices', { cookie: user.cookie })).data.notices[0].reward.claimed, true);
  const other = await register(); assert.equal((await request('/api/save', { cookie: other.cookie })).data.save.tickets, undefined);
  assert.equal((await request('/api/notices', { cookie: other.cookie })).data.notices[0].reward.claimed, false);
  assert.equal((await request('/api/account', { cookie: user.cookie, method: 'DELETE', data: { password: '1234' } })).status, 200);
  assert.equal(Number((await pool.query('SELECT count(*) FROM notice_claims WHERE account_id=$1', [user.data.user.id])).rows[0].count), 0);
});
test('claim expiry uses server time; restarting does not reset the event window', async () => {
  const user = await register();
  await pool.query('UPDATE accounts SET created_at=$1 WHERE id=$2', [new Date(clock - 25 * 3600000), user.data.user.id]);
  assert.equal((await claim(user.cookie, 'test-signup')).status, 410);
  const started = new Date(clock - 25 * 3600000);
  await pool.query('UPDATE notice_campaigns SET started_at=$1 WHERE id=$2', [started, 'test-event']);
  await initializeNotices(pool, config);
  assert.equal(new Date((await pool.query('SELECT started_at FROM notice_campaigns WHERE id=$1', ['test-event'])).rows[0].started_at).getTime(), started.getTime());
  assert.equal((await claim(user.cookie, 'test-event')).status, 410);
  assert.equal((await claim(user.cookie, 'unknown')).status, 404);
});
test('PostgreSQL serializes simultaneous claims from two devices', { skip: !process.env.DATABASE_URL }, async () => {
  const user = await register();
  const results = await Promise.all([claim(user.cookie, 'test-signup'), claim(user.cookie, 'test-signup')]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  assert.equal(results.filter(r => r.data.granted).length, 1);
  assert.equal((await request('/api/save', { cookie: user.cookie })).data.save.tickets.t10, 100);
  assert.equal(Number((await pool.query('SELECT count(*) FROM notice_claims WHERE account_id=$1', [user.data.user.id])).rows[0].count), 1);
});
test('legacy save currency and inventory survive the first server reward ledger entry', () => {
  const original = { coins: 500, tickets: { t1: 4, t10: 2 }, bag: { mint: 3 }, tms: { 'iron-tail': 1 } };
  const granted = grantTickets(original, config.notices[0], Date.now());
  assert.equal(granted.tickets.t10, 102); assert.equal(original.tickets.t10, 2);
  assert.deepEqual(granted.led.base['b:mint'], [3, 0]); assert.deepEqual(granted.led.base['m:iron-tail'], [1, 0]);
});
