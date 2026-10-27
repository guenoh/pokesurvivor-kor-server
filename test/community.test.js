import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { periodStart } from '../src/community.js';
import { snapshot, restore } from '../tools/backup.mjs';
function adapter(db) {
  let queue = Promise.resolve();
  async function acquire() { const old = queue; let release; queue = new Promise(r => { release = r; }); await old; return release; }
  async function query(sql, params) { const result = params ? await db.query(sql, params) : (await db.exec(sql)).at(-1); return { ...result, rowCount: result.affectedRows ?? result.rows.length }; }
  return { async query(sql, params) { const release = await acquire(); try { return await query(sql, params); } finally { release(); } }, async connect() { const release = await acquire(); return { query, release }; } };
}
let db, pool, app, base, admin, schema, now = Date.now();
const origin = 'http://localhost:8080', sockets = [];
before(async () => {
  if (process.env.DATABASE_URL) {
    admin = new pg.Pool({connectionString:process.env.DATABASE_URL});
    schema = 'community_' + randomUUID().replaceAll('-', '');
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  } else { db = await PGlite.create(); pool = adapter(db); }
  await migrate(pool);
  app = createApp({ pool, origin, secureCookies: false, authLimit: 500, notices: { notices: [], support: {} }, clock: () => now, logger: { error() {} } });
  await new Promise(r => app.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { for (const ws of sockets) ws.terminate(); app.community.live.close(); app.closeAllConnections(); await new Promise(r => app.close(r)); if (db) await db.close(); else { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); } });
async function req(path, account, data, method = data === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + path, { method, headers: { Origin: origin, ...(account ? { Cookie: account.cookie } : {}), ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
}
async function user(name) {
  const r = await req('/api/auth/register', null, { name, password: '1234' }); assert.equal(r.status, 201);
  const u = { ...r.data.user, cookie: r.cookie };
  const save = await req('/api/save', u, { revision: 0, save: { partner: 25, owned: { 25: {} }, stats: {} } }, 'PUT'); assert.equal(save.status, 200);
  return u;
}
async function link(a, b) {
  assert.equal((await req('/api/community/friends/request', a, { name: b.name })).status, 200);
  assert.equal((await req('/api/community/friends/accept', b, { uid: a.id })).status, 200);
}
function waitMessage(ws, match, timeout = 3000) {
  const old = ws.messages?.findIndex(match);
  if (old >= 0) return Promise.resolve(ws.messages.splice(old, 1)[0]);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('WebSocket message timeout')); }, timeout);
    function receive(raw) { const msg = JSON.parse(raw); if (match(msg)) { clearTimeout(timer); ws.off('message', receive); const i = ws.messages.findIndex(m => m === msg); if (i >= 0) ws.messages.splice(i, 1); resolve(msg); } }
    ws.on('message', receive);
  });
}
async function socket(u, instance = randomUUID(), playing = false) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/live?instance=' + instance, { origin, headers: { Cookie: u.cookie } });
  ws.instance = instance; ws.messages = []; ws.on('message', raw => ws.messages.push(JSON.parse(raw))); sockets.push(ws);
  await once(ws, 'open'); await waitMessage(ws, m => m.type === 'snapshot');
  ws.send(JSON.stringify({ type: 'presence', playing, ready: !playing }));
  return ws;
}
test('friend requests are private, directional, immutable to outsiders and durable', async () => {
  const a = await user('친구시험A'), b = await user('친구시험B'), x = await user('친구시험X');
  assert.equal((await req('/api/community')).status, 401);
  assert.equal((await req('/api/community/friends/request', a, { name: a.name })).status, 400);
  assert.equal((await req('/api/community/friends/request', a, { name: b.name })).status, 200);
  assert.equal((await req('/api/community/friends/accept', a, { uid: b.id })).status, 404);
  assert.equal((await req('/api/community/friends/accept', x, { uid: a.id })).status, 404);
  assert.deepEqual((await req('/api/community', x)).data.friends, []);
  assert.equal((await req('/api/community', b)).data.friends[0].status, 'in');
  assert.equal((await req('/api/community/friends/accept', b, { uid: a.id })).status, 200);
  assert.equal((await req('/api/community/friends/request', a, { name: b.name })).status, 409);
  assert.equal((await req('/api/community', a)).data.friends[0].status, 'ok');
  const profile = await req('/api/community/profile/' + b.id, a); assert.equal(profile.status, 200); assert.ok(!JSON.stringify(profile.data).includes('password'));
  assert.equal((await req('/api/community/profile/' + b.id, x)).status, 404);
  await req('/api/community/friends/remove', a, { uid: b.id });
  assert.deepEqual((await req('/api/community', b)).data.friends, []);
});
test('solo records require a server-started run, reject spoofed time, deduplicate and rank scoped friends', async () => {
  const a = await user('기록시험A'), b = await user('기록시험B'), outsider = await user('기록시험C'); await link(a, b);
  const start = await req('/api/community/runs/start', a, {}); assert.equal(start.status, 200);
  assert.equal((await req('/api/community/runs/finish', b, { id: start.data.id, t: 30, lv: 2, kills: 5 })).status, 409);
  assert.equal((await req('/api/community/runs/finish', a, { id: start.data.id, t: 9999, lv: 2, kills: 5 })).status, 400);
  now += 40000;
  assert.equal((await req('/api/community/runs/finish', a, { id: start.data.id, t: 35, lv: 2, kills: 5, members: [{ uid: outsider.id }] })).status, 200);
  assert.equal((await req('/api/community/runs/finish', a, { id: start.data.id, t: 35, lv: 2, kills: 5 })).status, 409);
  const second = await req('/api/community/runs/start', a, {}); now += 60000;
  await req('/api/community/runs/finish', a, { id: second.data.id, t: 50, lv: 3, kills: 10 });
  const third = await req('/api/community/runs/start', outsider, {}); now += 90000;
  await req('/api/community/runs/finish', outsider, { id: third.data.id, t: 70, lv: 3, kills: 10 });
  const board = (await req('/api/community/records?mode=s&period=a', b)).data;
  assert.equal(board.rows[0].t, 70); assert.equal(board.rows.filter(r => r.uids.includes(a.id)).length, 1);
  const circle = (await req('/api/community/records?mode=s&period=a&friends=1', b)).data;
  assert.deepEqual(circle.rows.map(r => r.uids[0]), [a.id]);
  assert.deepEqual((await req('/api/community/records?mode=s&period=a&dex=150', b)).data.rows, []);
  assert.deepEqual((await req('/api/community/records?mode=s&period=a&friends=1', a)).data.me, { pos: 1, t: 50 });
});
test('four-player invite-only co-op validates host, capacity, ready status, frame sender and team records', async () => {
  const users = await Promise.all(['협동방장', '협동친구1', '협동친구2', '협동친구3', '협동친구4'].map(user));
  const [a,b,c,d,e] = users;
  for (const u of users.slice(1)) await link(a, u);
  const [wa,wb,wc,wd,we] = await Promise.all(users.map(u => socket(u)));
  const cmd = (u, action, data = {}) => req('/api/community/room/' + action, u, data);
  for (const u of [b,c,d,e]) assert.equal((await cmd(a, 'invite', { uid: u.id })).status, 200);
  for (const u of [b,c,d]) assert.equal((await cmd(u, 'join', { from: a.id })).status, 200);
  assert.equal((await cmd(e, 'join', { from: a.id })).status, 409);
  assert.equal((await cmd(b, 'start')).status, 403);
  wb.send(JSON.stringify({ type: 'presence', ready: false, playing: false })); await new Promise(r => setTimeout(r, 20));
  assert.equal((await cmd(a, 'start')).status, 409);
  wb.send(JSON.stringify({ type: 'presence', ready: true, playing: false })); await new Promise(r => setTimeout(r, 20));
  assert.equal((await cmd(a, 'start')).status, 200);
  const start = await waitMessage(wa, m => m.type === 'start'); assert.equal(start.cfg.members.length, 4); assert.ok(start.runId);
  assert.equal((await waitMessage(wb, m => m.type === 'start')).runId, null);
  assert.equal((await cmd(a, 'invite', { uid: e.id })).status, 409);
  wb.send(JSON.stringify({ type: 'frame', from: e.id, to: a.id, message: { k: 'f', p: [1,2], ev: [] } }));
  const frame = await waitMessage(wa, m => m.type === 'frame'); assert.equal(frame.from, b.id);
  const first = wb.messages.length;
  we.send(JSON.stringify({ type: 'frame', to: b.id, message: { k: 'f', t: 100, p: {}, e: [] } }));
  wc.send(JSON.stringify({ type: 'frame', to: b.id, message: { k: 'f', p: [999], ev: [] } }));
  wa.send(JSON.stringify({ type: 'frame', to: b.id, message: { k: 'start', seed: 7 } }));
  await new Promise(r => setTimeout(r, 40)); assert.equal(wb.messages.slice(first).filter(m => m.type === 'frame').length, 0);
  wa.send(JSON.stringify({ type: 'frame', to: b.id, message: { k: 'f', t: 10, p: {}, e: [], ev: [] } }));
  assert.equal((await waitMessage(wb, m => m.type === 'frame')).from, a.id);
  now += 65000;
  assert.equal((await req('/api/community/runs/finish', a, { id: start.runId, t: 60, lv: 5, kills: 50, members: [{ uid: e.id }] })).status, 200);
  const board = (await req('/api/community/records?mode=g&period=a', b)).data; assert.equal(board.rows[0].uids.length, 4); assert.ok(!board.rows[0].uids.includes(e.id)); assert.equal(board.me.pos, 1);
  const privateBoard = (await req('/api/community/records?mode=g&period=a&friends=1', b)).data; assert.equal(privateBoard.rows.length, 1);
  // A normal transient disconnect preserves membership and immediately restores server relay state.
  wb.close(); await once(wb, 'close'); const reconnected = await socket(b,wb.instance,true);
  const room = (await req('/api/community', b)).data.room; assert.equal(room.members.length, 4); assert.equal(room.members.find(m => m.uid === b.id).online, true);
  reconnected.send('null'); await once(reconnected, 'close'); // invalid JSON envelope cannot crash the process.
  assert.equal((await req('/api/health')).status, 200);
  assert.equal((await req('/api/auth/logout', a, undefined, 'POST')).status, 200);
  await waitMessage(wc, m => m.type === 'room' && m.closed); assert.equal((await req('/api/community', c)).data.room, null);
});
test('WebSocket rejects missing sessions and foreign origins without accepting a connection', async () => {
  const u = await user('연결시험');
  for (const headers of [{ origin }, { origin: 'https://evil.example', headers: { Cookie: u.cookie } }]) {
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/live', headers); ws.on('error', () => {});
    const [,response] = await once(ws, 'unexpected-response'); assert.ok([401,403].includes(response.statusCode)); ws.terminate();
  }
});
test('damage ranking adds a new metric while old survival records and best times stay intact', async () => {
  const a=await user('피해기록A'),b=await user('피해기록B');await link(a,b);
  const finish=async(u,t,dmg)=>{const start=await req('/api/community/runs/start',u,{});now+=t*1000;const result=await req('/api/community/runs/finish',u,{id:start.data.id,t,lv:226,kills:15931,...(dmg===undefined?{}:{dmg})});assert.equal(result.status,200);return result;};
  const old=await finish(a,2300);await finish(a,2200,100);await finish(a,2000,300);await finish(b,2100,200);
  const time=(await req('/api/community/records?period=a',a)).data;
  assert.equal(time.me.t,2300);assert.ok(time.rows.some(r=>r.id===old.data.id));
  const damage=(await req('/api/community/records?period=a&metric=damage',a)).data;
  const mine=damage.rows.find(r=>r.uids.includes(a.id)),other=damage.rows.find(r=>r.uids.includes(b.id));
  assert.equal(mine.d,300);assert.equal(mine.t,2000);assert.equal(other.d,200);assert.ok(mine.pos<other.pos);assert.equal(damage.me.d,300);
  const friends=(await req('/api/community/records?period=a&metric=damage&friends=1',a)).data;
  assert.equal(friends.rows.length,2);
  assert.equal((await req('/api/community/records?metric=not-a-metric',a)).status,400);
  const start=await req('/api/community/runs/start',a,{});now+=2000000;
  for(const dmg of [-1,1.5,10000000000001,'9'])assert.equal((await req('/api/community/runs/finish',a,{id:start.data.id,t:1900,lv:1,kills:0,dmg})).status,400);
  assert.equal((await req('/api/community/runs/finish',a,{id:start.data.id,t:1900,lv:1,kills:0,dmg:1})).status,200);
});

test('community backup restores friendships and records while excluding live sessions and unfinished runs', async () => {
  const data = await snapshot(pool); assert.equal(data.schema, 6); assert.ok(data.records.length > 0); assert.ok(data.friends.length > 0); assert.ok(!('runs' in data));
  const copyDb = await PGlite.create(), copy = adapter(copyDb);
  try {
    await restore(copy, data); assert.deepEqual(await snapshot(copy), data);
    assert.equal(Number((await copy.query('SELECT count(*) FROM sessions')).rows[0].count), 0);
    assert.equal(Number((await copy.query('SELECT count(*) FROM social_runs')).rows[0].count), 0);
    await assert.rejects(restore(copy, data), /empty database/);
  } finally { await copyDb.close(); }
});
test('Korean record periods start at KST midnight and ISO Monday', () => {
  const now = Date.parse('2026-10-23T16:00:00Z');
  assert.equal(periodStart('d', now).toISOString(), '2026-10-23T15:00:00.000Z');
  assert.equal(periodStart('w', now).toISOString(), '2026-10-18T15:00:00.000Z');
  assert.equal(periodStart('m', now).toISOString(), '2026-09-30T15:00:00.000Z');
});

test('deleting an account removes its friendships and completed record membership', async () => {
  const a = await user('탈퇴시험A'), b = await user('탈퇴시험B'); await link(a,b);
  const run = await req('/api/community/runs/start', a, {}); now += 5000;
  assert.equal((await req('/api/community/runs/finish', a, {id:run.data.id,t:2,lv:1,kills:0})).status,200);
  assert.equal((await req('/api/account', a, {password:'1234'}, 'DELETE')).status,200);
  assert.equal((await req('/api/community', b)).data.friends.length,0);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM record_members WHERE account_id=$1',[a.id])).rows[0].n),0);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM survival_records WHERE owner_id=$1',[a.id])).rows[0].n),0);
});


test('same-window reconnection preserves a battle; a different window ends the old host room', async () => {
  const a = await user('중복창시험A'), b = await user('중복창시험B'); await link(a,b);
  const instance = randomUUID(), wa = await socket(a,instance), wb = await socket(b);
  await req('/api/community/room/invite',a,{uid:b.id}); await req('/api/community/room/join',b,{from:a.id});
  assert.equal((await req('/api/community/room/start',a,{})).status,200);
  const before = (await req('/api/community',a)).data.room;
  const replaced = once(wa,'close');
  const resumed = await socket(a,instance,true); await replaced;
  assert.equal((await req('/api/community',a)).data.room.id,before.id);
  resumed.close(); await once(resumed,'close');
  await socket(a,randomUUID(),false);
  await waitMessage(wb,m=>m.type==='room' && m.closed);
  assert.equal((await req('/api/community',a)).data.room,null);
});

test('additive migration and an old schema-four backup preserve every existing save and record',async()=>{
 const oldDb=await PGlite.create(),oldPool=adapter(oldDb);
 try{
  const {readFile}=await import('node:fs/promises');
  for(const file of ['001-init.sql','002-notices.sql','003-notice-coins.sql','004-community.sql'])await oldPool.query(await readFile(new URL('../migrations/'+file,import.meta.url),'utf8'));
  await oldPool.query("INSERT INTO accounts(id,name,name_key,password_hash) VALUES('legacy','기존트레이너','기존트레이너','hash')");
  const save={coins:143000,tickets:{t1:4,t10:92},owned:{150:{from:'gacha'},1150:{from:'armored-event'}},partner:1150,bag:{mint:3},pstart:{1150:'psycho-rush'},pity:{1:69},led:{'server:kor-opening-20261023':{c:[150000,0],t10:[100,0]}}};
  await oldPool.query("INSERT INTO saves(account_id,data,revision) VALUES('legacy',$1,42)",[JSON.stringify(save)]);
  await oldPool.query("INSERT INTO survival_records(id,run_id,owner_id,mode,team_key,seconds,level,kills) VALUES('old-record','old-run','legacy','s','legacy',1823,226,15931)");
  await oldPool.query("INSERT INTO record_members(record_id,account_id,dex,shiny,seat) VALUES('old-record','legacy',1150,false,0)");
  const before=await snapshot(oldPool);assert.equal(before.schema,4);
  await migrate(oldPool);const after=await snapshot(oldPool);assert.equal(after.schema,6);
  const restoredShape={...after,schema:4,records:after.records.map(({arceus_damage,...r})=>r)};
  // initializeNotices adds only campaign metadata; compare the data the update promises to preserve.
  for(const k of ['accounts','saves','records','members'])assert.deepEqual(restoredShape[k],before[k],k);
  await migrate(oldPool);assert.deepEqual(await snapshot(oldPool),after);
  const copyDb=await PGlite.create();try{const copy=adapter(copyDb);await restore(copy,before);const copied=await snapshot(copy);assert.deepEqual(copied.saves,before.saves);assert.equal(Number(copied.records[0].arceus_damage),0);assert.equal(copied.records[0].id,'old-record');}finally{await copyDb.close();}
 }finally{await oldDb.close();}
});
