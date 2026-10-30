import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { initializeNotices, grantAllMembers, grantMemberNotice, listNotices } from '../src/notices.js';
import { snapshot, restore } from '../tools/backup.mjs';
const notice = { id: 'kia-test', version: 1, title: '승리 기원', paragraphs: ['함께 응원해요!'], reward: { ticket1: 333, coins: 50000, window: 'members', automatic: true } };
const config = { newAccountCoins: 500, notices: [notice], support: {} };
const origin = 'https://game.example';
let pool, admin, schema, app, base;
before(async () => {
  if (process.env.DATABASE_URL) {
    admin = new pg.Pool({ connectionString: process.env.DATABASE_URL }); schema = 'member_gifts_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  } else pool = new (newDb().adapters.createPg().Pool)();
  await migrate(pool); await initializeNotices(pool, config);
  app = createApp({ pool, origin, notices: config, secureCookies: false, authLimit: 100, logger: { error() {} } });
  await new Promise((resolve, reject) => { app.once('error', reject); app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => {
  app?.closeAllConnections(); if (app) await new Promise(resolve => app.close(resolve)); await pool?.end();
  if (admin) { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
async function member(save = {}) {
  const id = randomUUID(), name = '선물' + id.slice(0, 8);
  await pool.query('INSERT INTO accounts(id,name,name_key,password_hash) VALUES($1,$2,$2,$3)', [id, name, 'fixture-only']);
  await pool.query('INSERT INTO saves(account_id,data,revision) VALUES($1,$2,7)', [id, JSON.stringify(save)]);
  return { id, name };
}
async function stored(account) { return (await pool.query('SELECT data,revision FROM saves WHERE account_id=$1', [account.id])).rows[0]; }
async function req(path, { cookie, method = 'GET', data } = {}) {
  const r = await fetch(base + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
  return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
test('all existing members receive exactly 333 single tickets and 50000 coins; retries and restart do not repeat them', async () => {
  const original = { coins: 120, tickets: { t1: 7, t10: 2 }, owned: { 1150: { from: 'armored-event' } }, shiny: { 150: {} }, pupg: { 150: { hp: 4 } }, stats: { bestTime: 1823 }, bag: { mint: 3 }, tms: { confusion: 2 }, led: { base: { c: [500, 0], t1: [10, 0], t10: [2, 0], 'b:mint': [3, 0], 'm:confusion': [2, 0] }, spent: { c: [0, 380], t1: [0, 3] } } };
  const a = await member(original), b = await member();
  const first = await grantAllMembers(pool, config); assert.ok(first.grants >= 2);
  const result = await stored(a); assert.equal(result.data.coins, 50120); assert.equal(result.data.tickets.t1, 340); assert.equal(result.data.tickets.t10, 2);
  for (const key of ['owned', 'shiny', 'pupg', 'stats', 'bag', 'tms']) assert.deepEqual(result.data[key], original[key]);
  assert.deepEqual(result.data.led.base, original.led.base); assert.deepEqual(result.data.led.spent, original.led.spent);
  assert.deepEqual(result.data.led['server:kia-test'], { t1: [333, 0], c: [50000, 0] });
  assert.equal((await stored(b)).data.coins, 50500); assert.equal((await stored(b)).data.tickets.t1, 333);
  if (process.env.DATABASE_URL) await migrate(pool); // pg-mem cannot re-plan CREATE TABLE IF NOT EXISTS.
  await initializeNotices(pool, config);
  assert.equal((await grantAllMembers(pool, config)).grants, 0); assert.deepEqual(await stored(a), result);
});
test('a new registration receives the same gift automatically before the first game save, without a deadline', async () => {
  const result = await req('/api/auth/register', { method: 'POST', data: { name: '신규' + randomUUID().slice(0, 8), password: '1234' } });
  assert.equal(result.status, 201); assert.equal(result.data.save.coins, 50500); assert.equal(result.data.save.tickets.t1, 333);
  const revision = result.data.revision;
  const session = await req('/api/session', { cookie: result.cookie }); assert.equal(session.data.revision, revision);
  const notices = await req('/api/notices', { cookie: result.cookie });
  assert.equal(notices.data.notices[0].reward.claimed, true); assert.equal(notices.data.notices[0].reward.expiresAt, null);
  const retry = await req('/api/notices/kia-test/claim', { method: 'POST', cookie: result.cookie, data: { revision, ticket1: 999999, coins: 999999 } });
  assert.equal(retry.data.alreadyClaimed, true); assert.equal(retry.data.save.tickets.t1, 333); assert.equal(retry.data.save.coins, 50500);
  const future = await member(); await grantMemberNotice(pool, future, notice, config, Date.now() + 365 * 86400_000);
  assert.equal((await listNotices(pool, future, config, Date.now() + 365 * 86400_000)).notices[0].reward.claimed, true);
  assert.equal((await req('/api/notices/kia-test/claim', { method: 'POST', data: { revision: 0 } })).status, 401);
});
test('member credit advances revision so a stale game save cannot erase the new gift', async () => {
  const a = await member({ coins: 80, tickets: { t1: 4, t10: 9 } }); const before = await stored(a);
  await grantMemberNotice(pool, a, notice, config); const after = await stored(a);
  assert.equal(after.revision, before.revision + 1);
  const stale = await pool.query('UPDATE saves SET data=$1,revision=revision+1 WHERE account_id=$2 AND revision=$3 RETURNING revision', [JSON.stringify(before.data), a.id, before.revision]);
  assert.equal(stale.rows.length, 0); assert.equal((await stored(a)).data.tickets.t1, 337);
});
test('PostgreSQL serializes simultaneous member credits without double payment', { skip: !process.env.DATABASE_URL }, async () => {
  const a = await member({ coins: 25, tickets: { t1: 2, t10: 3 } });
  const results = await Promise.all([grantMemberNotice(pool, a, notice, config), grantMemberNotice(pool, a, notice, config)]);
  assert.equal(results.filter(r => r.granted).length, 1); assert.equal((await stored(a)).data.coins, 50025);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM member_grants WHERE account_id=$1', [a.id])).rows[0].n), 1);
});
test('a credited ledger from an old-format backup repairs the receipt without repeating a spent gift', async () => {
  const a = await member({ coins: 10, tickets: { t1: 3, t10: 2 }, led: { base: { c: [10, 0], t1: [3, 0], t10: [2, 0] }, 'server:kia-test': { c: [50000, 50000], t1: [333, 333] } } });
  const before = await stored(a); const result = await grantMemberNotice(pool, a, notice, config);
  assert.equal(result.alreadyClaimed, true); assert.deepEqual(await stored(a), before);
  assert.equal((await listNotices(pool, a, config)).notices[0].reward.claimed, true);
});
test('PostgreSQL backup restores gift receipts and schema-five backups do not duplicate the credited ledger', { skip: !process.env.DATABASE_URL }, async () => {
  await grantAllMembers(pool, config); const original = await snapshot(pool); assert.equal(original.schema, 7);
  assert.ok(original.memberGrants.length > 0);
  for (const format of [7, 6, 5]) {
    const targetSchema = 'gift_restore_' + randomUUID().replaceAll('-', ''); await admin.query(`CREATE SCHEMA ${targetSchema}`);
    const target = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${targetSchema}` });
    try {
      const data = structuredClone(original); data.schema = format;
      if (format < 7) delete data.gachaReceipts;
      if (format < 6) delete data.memberGrants;
      await restore(target, data); assert.equal((await grantAllMembers(target, config)).grants, 0);
      const restored = await snapshot(target); assert.deepEqual(restored.saves, original.saves); assert.equal(restored.memberGrants.length, original.memberGrants.length);
      if (format >= 6) assert.deepEqual(restored.memberGrants, original.memberGrants);
    } finally { await target.end(); await admin.query(`DROP SCHEMA ${targetSchema} CASCADE`); }
  }
});
