import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { newDb } from 'pg-mem';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { initializeNotices, grantAllMembers, grantMemberNotice } from '../src/notices.js';
const notice={id:'surprise-login-test',version:1,title:'깜짝 선물',paragraphs:['24시간 접속 선물'],reward:{ticket1:500,automatic:true,window:'login24h'}};
const config={newAccountCoins:500,notices:[notice],support:{}};
const origin='https://game.example',start=Date.now(),DAY=86400000;
let pool,admin,schema,app,base,clock=start-1000;
before(async()=>{
 if(process.env.DATABASE_URL){admin=new pg.Pool({connectionString:process.env.DATABASE_URL});schema='login_gift_'+randomUUID().replaceAll('-','');await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`});}
 else pool=new (newDb().adapters.createPg().Pool)();
 await migrate(pool);await initializeNotices(pool,config);await pool.query('UPDATE notice_campaigns SET started_at=$1 WHERE id=$2',[new Date(start),notice.id]);
 app=createApp({pool,origin,notices:config,secureCookies:false,authLimit:200,clock:()=>clock,logger:{error(){}}});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${app.address().port}`;
});
after(async()=>{app.community.live.close();app.closeAllConnections();await new Promise(r=>app.close(r));await pool.end();if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}});
async function req(path,u,data,method=data===undefined?'GET':'POST'){
 const r=await fetch(base+path,{method,headers:{Origin:origin,...(u?{Cookie:u.cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},body:data===undefined?undefined:JSON.stringify(data)});
 return{status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function user(){const r=await req('/api/auth/register',null,{name:'접속'+randomUUID().slice(0,8),password:'1234'});assert.equal(r.status,201);return{id:r.data.user.id,name:r.data.user.name,cookie:r.cookie};}
const saved=async u=>(await pool.query('SELECT data,revision FROM saves WHERE account_id=$1',[u.id])).rows[0];
const receipt=async u=>(await pool.query('SELECT ticket1 FROM member_grants WHERE account_id=$1 AND notice_id=$2',[u.id,notice.id])).rows;
test('startup does not credit offline accounts; an existing signed-in account gets exactly 500 on authenticated contact',async()=>{
 clock=start-1;const idle=await user(),online=await user();const original={coins:77,tickets:{t1:7,t10:2},owned:{25:{}},partner:25,pupg:{25:{hp:2}},led:{base:{c:[77,0],t1:[7,0],t10:[2,0]}}};
 assert.equal((await req('/api/save',online,{save:original,revision:0},'PUT')).status,200);
 assert.equal((await grantAllMembers(pool,config,start+1)).grants,0);assert.equal((await receipt(idle)).length,0);
 clock=start;const n=await req('/api/notices',online);assert.equal(n.status,200);assert.equal(n.data.notices[0].reward.claimed,true);assert.equal(n.data.notices[0].reward.expiresAt,new Date(start+DAY).toISOString());
 const after=await saved(online);assert.equal(after.data.tickets.t1,507);assert.equal(after.data.tickets.t10,2);assert.equal(after.data.coins,77);assert.deepEqual(after.data.pupg,original.pupg);assert.deepEqual(after.data.led['server:'+notice.id].t1,[500,0]);
 await req('/api/notices',online);await req('/api/session',online);assert.deepEqual(await saved(online),after);assert.equal((await receipt(online)).length,1);
 assert.equal((await req('/api/save',online,{save:original,revision:1},'PUT')).status,409);assert.equal((await receipt(idle)).length,0);
});
test('new and existing accounts qualify strictly before the shared 24-hour cutoff; anonymous visits do not qualify',async()=>{
 clock=start-1;const late=await user();clock=start+DAY-1;const last=await user();assert.equal((await saved(last)).data.tickets.t1,500);
 clock=start+DAY;const ended=await user();assert.equal((await receipt(ended)).length,0);assert.equal((await saved(ended)).data.tickets,undefined);
 const endedNotice=(await req('/api/notices',late)).data.notices[0];assert.equal(endedNotice.reward.eligible,false);assert.equal(endedNotice.autoOpen,false);assert.equal(endedNotice.priority,20);assert.equal((await receipt(late)).length,0);
 assert.equal((await req('/api/notices')).data.notices[0].reward.needsLogin,true);assert.equal((await req('/api/notices/'+notice.id+'/claim',late,{})).status,410);
});
test('restart preserves the cutoff and an older spent ledger repairs its receipt after expiry without paying again',async()=>{
 clock=start-1;const u=await user();const old={coins:99,tickets:{t1:1,t10:0},led:{['server:'+notice.id]:{t1:[500,499]}}};
 await pool.query('UPDATE saves SET data=$1 WHERE account_id=$2',[JSON.stringify(old),u.id]);const before=await saved(u);
 clock=start+DAY+1;await initializeNotices(pool,config);assert.equal(+(await pool.query('SELECT started_at FROM notice_campaigns WHERE id=$1',[notice.id])).rows[0].started_at,start);
 const result=await grantMemberNotice(pool,u,notice,config,clock);assert.equal(result.granted,false);assert.equal(result.alreadyClaimed,true);assert.deepEqual(await saved(u),before);assert.equal(Number((await receipt(u))[0].ticket1),500);
});
test('an already-authenticated WebSocket reconnection qualifies without a new login or claim button',async()=>{
 clock=start-1;const u=await user();clock=start+1000;
 const ws=new WebSocket(base.replace('http','ws')+'/api/live?instance='+randomUUID(),{origin,headers:{Cookie:u.cookie}});ws.on('error',()=>{});
 try{await once(ws,'open');assert.equal((await saved(u)).data.tickets.t1,500);assert.equal((await receipt(u)).length,1);}finally{ws.terminate();}
});
test('PostgreSQL serializes simultaneous authenticated attendance without duplicating the gift',{skip:!process.env.DATABASE_URL},async()=>{
 clock=start-1;const u=await user();clock=start+1000;const results=await Promise.all([req('/api/notices',u),req('/api/session',u)]);assert.deepEqual(results.map(r=>r.status),[200,200]);assert.equal((await saved(u)).data.tickets.t1,500);assert.equal((await receipt(u)).length,1);
});
