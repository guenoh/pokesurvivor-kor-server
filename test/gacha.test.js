import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';import pg from 'pg';import {newDb} from 'pg-mem';
import {migrate} from '../src/migrate.js';import {draw,createEngine,growth,catalog,protectGrowth} from '../src/gacha.js';
let pool,admin,schema;
before(async()=>{if(process.env.DATABASE_URL){admin=new pg.Pool({connectionString:process.env.DATABASE_URL});schema='gacha_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});}else pool=new(newDb().adapters.createPg().Pool)();await migrate(pool);});
after(async()=>{await pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
const now=Date.parse('2026-10-30T03:00:00Z');
async function user(override={}){const u={id:randomUUID(),name:'성장시험'};await pool.query('INSERT INTO accounts(id,name,name_key,password_hash) VALUES($1,$2,$3,$4)',[u.id,u.name,u.id,'test']);const save={coins:123,tickets:{t1:200,t10:20},owned:Object.fromEntries(catalog.filter(m=>m.gen===1).map(m=>[m.dex,{at:1,from:'gacha'}])),stats:{pulls:4},pupg:{150:{atk:5}},bag:{mint:3},pnat:{150:['modest',1]},...override};await pool.query('INSERT INTO saves(account_id,data) VALUES($1,$2)',[u.id,JSON.stringify(save)]);return u;}
const data=(o={})=>({requestId:randomUUID(),n:10,gen:1,use:'t1',revision:0,...o});const saved=async u=>(await pool.query('SELECT data,revision FROM saves WHERE account_id=$1',[u.id])).rows[0];
test('server uses the preserved probabilities, guarantees, ticket costs and shiny rules',()=>{const e=createEngine({now});assert.equal(JSON.stringify(e.RATES),JSON.stringify(growth.RATES));assert.equal(e.PITY_5,70);assert.equal(e.SHINY_RATE,.01);assert.equal(e.pool(5,1).length,6);assert.equal(e.pool(4,1).length,31);});
test('draw, ticket spend, coin refund, growth and receipt commit together; a lost response replays once',async()=>{
 const u=await user(),d=data(),r=await draw(pool,u,d,now,{random:()=>.5});assert.equal(r.results.length,10);assert.equal(r.save.tickets.t1,190);assert.equal(Object.values(r.save.korGrowth.counts).reduce((a,b)=>a+b,0),10);assert.equal(r.save.coins,123+r.results.reduce((s,x)=>s+x.refund,0));assert.deepEqual(r.save.pupg,{150:{atk:5}});assert.deepEqual(r.save.bag,{mint:3});assert.deepEqual(r.save.led['server:gacha:'+d.requestId].t1,[0,10]);
 const before=await saved(u),again=await draw(pool,u,d,now+1);assert.equal(again.replayed,true);assert.deepEqual(again.results,JSON.parse(JSON.stringify(r.results)));assert.deepEqual(await saved(u),before);assert.equal((await pool.query('SELECT * FROM gacha_receipts WHERE account_id=$1',[u.id])).rows.length,1);
 await assert.rejects(draw(pool,u,{...d,n:100},now),{status:409});
});
test('100 draws spend exactly ten ten-draw tickets, preserve pity and guarantee every group',async()=>{
 const u=await user({pity:{1:69}}),d=data({n:100,use:'t10'}),r=await draw(pool,u,d,now,{random:()=>.5});assert.equal(r.save.tickets.t10,10);assert.equal(r.save.tickets.t1,200);assert.equal(r.results[0].rarity,5);for(let i=0;i<10;i++)assert.ok(r.results.slice(i*10,i*10+10).some(x=>x.rarity>=4));assert.equal(r.save.stats.pulls,104);assert.deepEqual(r.save.pnat,{150:['modest',1]});
});
test('first species acquisition does not grow it, but a new shiny of an owned species does',async()=>{
 const u=await user({owned:{},shiny:{}}),r=await draw(pool,u,data(),now,{random:()=>.5});assert.equal(r.results[0].growth.duplicate,false);assert.equal(r.results[0].growth.count,0);assert.equal(r.results[1].growth.duplicate,true);
 const owned=await user({shiny:{}}),sh=await draw(pool,owned,data(),now,{random:()=>0});assert.equal(sh.results[0].growth.duplicate,true);assert.equal(sh.results[0].shiny,true);assert.equal(sh.results[0].isNew,true);
});
test('stale revision, insufficient tickets and an expired event never debit or record a draw',async()=>{
 const u=await user({tickets:{t1:9,t10:0}}),before=await saved(u);await assert.rejects(draw(pool,u,data(),now),{status:400});await assert.rejects(draw(pool,u,data({revision:2}),now),{status:409});await assert.rejects(draw(pool,u,data({gen:10}),Date.parse('2026-11-02T23:00:00Z')),{status:410});assert.deepEqual(await saved(u),before);assert.equal((await pool.query('SELECT * FROM gacha_receipts WHERE account_id=$1',[u.id])).rows.length,0);
});
test('old or edited saves cannot erase growth, fake growth, or replay a server draw ledger',()=>{
 const current={korGrowth:{v:1,counts:{150:3}},coins:150,tickets:{t1:90,t10:2},led:{base:{c:[100,0],t1:[100,0],t10:[2,0]},'server:gacha:real':{c:[50,0],t1:[0,10],t10:[0,0]}}};
 const incoming={...structuredClone(current),korGrowth:{counts:{150:999}},pupg:{150:{hp:4}}};incoming.led['server:gacha:real'].t1=[10,0];incoming.led['server:gacha:fake']={t1:[500,0]};const out=protectGrowth(incoming,current);assert.deepEqual(out.korGrowth,current.korGrowth);assert.equal(out.tickets.t1,90);assert.equal(out.coins,150);assert.equal(out.led['server:gacha:fake'],undefined);assert.deepEqual(out.pupg,incoming.pupg);assert.equal(protectGrowth({korGrowth:{counts:{150:20}}},{}).korGrowth,undefined);assert.equal(protectGrowth({coins:999},current).tickets.t1,90);
});
test('PostgreSQL concurrent identical requests grant and debit only once',{skip:!process.env.DATABASE_URL},async()=>{const u=await user(),d=data();const out=await Promise.all([draw(pool,u,d,now),draw(pool,u,d,now)]);assert.deepEqual(out.map(r=>r.replayed).sort(),[false,true]);assert.equal((await saved(u)).data.tickets.t1,190);assert.equal(Object.values((await saved(u)).data.korGrowth.counts).reduce((a,b)=>a+b,0),10);});
