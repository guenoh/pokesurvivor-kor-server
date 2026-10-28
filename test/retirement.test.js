import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newDb } from 'pg-mem';
import { migrate } from '../src/migrate.js';
import { listNotices } from '../src/notices.js';
import { compensation, policy, retireAccount } from '../src/retirement.js';
let pool, admin, schema;
before(async () => {
  if (process.env.DATABASE_URL) {
    admin=new pg.Pool({connectionString:process.env.DATABASE_URL});schema='retire_'+randomUUID().replaceAll('-','');
    await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});
  } else pool=new (newDb().adapters.createPg().Pool)();
  await migrate(pool);
});
after(async()=>{await pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
async function member(data) {
  const id=randomUUID();await pool.query('INSERT INTO accounts(id,name,name_key,password_hash) VALUES($1,$1,$1,$2)',[id,'fixture']);
  await pool.query('INSERT INTO saves(account_id,data,revision) VALUES($1,$2,7)',[id,JSON.stringify(data)]);return{id};
}
const stored=async a=>(await pool.query('SELECT data,revision FROM saves WHERE account_id=$1',[a.id])).rows[0];
test('refund uses each purchased upgrade price once, at five times the original total',()=>{
  assert.deepEqual(compensation({pupg:{1150:{hp:2}}}),{invested:140,coins:700,multiplier:5});
  const all=Object.fromEntries(Object.entries(policy.prices).map(([id,p])=>[id,p.length]));
  assert.equal(compensation({pupg:{1150:all}}).invested,40800);assert.equal(compensation({pupg:{1150:all}}).coins,204000);
  assert.equal(compensation({pupg:{150:all}}).coins,0);assert.equal(compensation({pupg:{1150:{hp:-5,unknown:999}}}).coins,0);
});
test('event retirement credits the server ledger once and does not transfer upgrades to ordinary Mewtwo',async()=>{
  const save={coins:100,tickets:{t1:10,t10:2},partner:1150,owned:{150:{at:1},1150:{at:2}},pupg:{150:{hp:3},1150:{hp:2}},pstart:{1150:'psycho-rush'},stats:{bestTime:1823},led:{base:{c:[1000,900],t1:[10,0],t10:[2,0]}}};
  const a=await member(save),first=await retireAccount(pool,a);assert.equal(first.coins,700);
  const after=await stored(a);assert.equal(after.data.coins,800);assert.deepEqual(after.data.tickets,save.tickets);
  assert.deepEqual(after.data.pupg,{150:{hp:3}});assert.equal(after.data.owned[1150],undefined);assert.equal(after.data.partner,150);
  assert.deepEqual(after.data.retiredKor.armoredMewtwo.pupg,{hp:2});assert.deepEqual(after.data.stats,save.stats);
  assert.deepEqual(after.data.led.base,save.led.base);assert.deepEqual(after.data.led['server:'+policy.campaign].c,[700,0]);
  assert.equal((await retireAccount(pool,a)).coins,0);assert.deepEqual(await stored(a),after);
});
test('uninvested accounts receive a frozen zero receipt and cannot claim later through an old client save',async()=>{
  const a=await member({coins:99,owned:{25:{at:1}},partner:25});assert.equal((await retireAccount(pool,a)).coins,0);
  const before=await stored(a);await pool.query('UPDATE saves SET data=$1 WHERE account_id=$2',[JSON.stringify({...before.data,pupg:{1150:{hp:10}}}),a.id]);
  assert.equal((await retireAccount(pool,a)).coins,0);const after=await stored(a);assert.equal(after.data.coins,99);assert.equal(after.data.pupg[1150],undefined);
});
test('an old-format restored ledger repairs its receipt without refunding already-spent compensation',async()=>{
  const a=await member({coins:1,tickets:{t1:0,t10:0},pupg:{1150:{hp:2}},led:{['server:'+policy.campaign]:{c:[700,699]}}});
  assert.equal((await retireAccount(pool,a)).coins,0);const after=await stored(a);assert.equal(after.data.coins,1);
  assert.deepEqual(after.data.led['server:'+policy.campaign].c,[700,699]);
  const row=(await pool.query('SELECT coins FROM member_grants WHERE account_id=$1 AND notice_id=$2',[a.id,policy.campaign])).rows[0];assert.equal(Number(row.coins),700);
});
test('PostgreSQL serializes simultaneous retirement jobs so only one pays', {skip:!process.env.DATABASE_URL},async()=>{
  const a=await member({coins:10,pupg:{1150:{hp:2}}});
  const results=await Promise.all(Array.from({length:4},()=>retireAccount(pool,a)));assert.equal(results.filter(r=>r.granted).length,1);
  assert.equal((await stored(a)).data.coins,710);
});

test('retirement notice shows only the signed-in account receipt and cannot leak another member amount',async()=>{
  const a=await member({coins:10,pupg:{1150:{hp:2}}}),b=await member({coins:1});await retireAccount(pool,a);await retireAccount(pool,b);
  const noticeFor=async account=>(await listNotices(pool,account)).notices.find(n=>n.id===policy.campaign);
  assert.ok((await noticeFor(a)).paragraphs.at(-1).includes('700코인'));
  assert.ok((await noticeFor(b)).paragraphs.at(-1).includes('0코인'));
  assert.ok(!(await noticeFor(null)).paragraphs.some(p=>p.startsWith('내 계정의 종료 보상:')));
});
