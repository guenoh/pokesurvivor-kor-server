import fs from 'node:fs';
import vm from 'node:vm';
import { randomInt } from 'node:crypto';
import growth from './duplicate-growth.cjs';
import { halloweenAt } from './event-calendar.js';
const catalog=JSON.parse(fs.readFileSync(new URL('../data/gacha-catalog.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('../data/upstream-gacha.js',import.meta.url),'utf8');
growth.configure(catalog);
const amount=n=>Number.isSafeInteger(n)&&n>=0?n:0;
const fail=(status,message)=>{const e=new Error(message);e.status=status;throw e;};
export function createEngine({now=Date.now(),random=()=>randomInt(0,2**32)/2**32}={}){
 const math=Object.create(Math);math.random=random;
 const G={DEX:catalog,SPRITE_META:Object.fromEntries(catalog.map(m=>[m.dex,true])),Sprites:{hasShiny:id=>!!catalog.find(m=>m.dex===id)?.sh},U:{pick:a=>a[Math.floor(random()*a.length)]},Halloween:{on:halloweenAt(now)}};
 vm.runInNewContext(source,{G,Math:math,Date:{now:()=>now}},{timeout:1000});return G.Gacha;
}
function initLedger(save){
 if(!save.led||typeof save.led!=='object'||Array.isArray(save.led)){
  save.led={base:{c:[amount(save.coins),0],t1:[amount(save.tickets?.t1),0],t10:[amount(save.tickets?.t10),0]}};
  for(const [collection,prefix]of [['bag','b'],['tms','m']])for(const [key,n]of Object.entries(save[collection]||{}))if(/^[a-z0-9-]{1,40}$/.test(key))save.led.base[prefix+':'+key]=[amount(n),0];
 }
}
export async function draw(pool,account,data,now=Date.now(),options={}){
 const {requestId,n,gen,use,revision}=data||{};
 if(!/^[a-f0-9-]{36}$/.test(requestId||'')||![10,100].includes(n)||!Number.isInteger(gen)||gen<1||gen>10||!['t1','t10'].includes(use)||!Number.isSafeInteger(revision)||revision<0)fail(400,'뽑기 요청을 확인할 수 없습니다.');
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const saved=(await client.query('SELECT data,revision FROM saves WHERE account_id=$1 FOR UPDATE',[account.id])).rows[0];
  if(!saved)fail(404,'저장 데이터를 찾을 수 없습니다.');
  const receipt=(await client.query('SELECT n,gen,ticket_kind,results,iris FROM gacha_receipts WHERE account_id=$1 AND request_id=$2',[account.id,requestId])).rows[0];
  if(receipt){
   if(receipt.n!==n||receipt.gen!==gen||receipt.ticket_kind!==use)fail(409,'이미 처리된 뽑기 요청과 내용이 다릅니다.');
   await client.query('COMMIT');return{user:{id:account.id,name:account.name},save:saved.data,revision:saved.revision,results:receipt.results,iris:receipt.iris,replayed:true};
  }
  if(saved.revision!==revision)fail(409,'저장 내용이 변경되었습니다. 동기화 후 다시 시도해 주세요.');
  const engine=createEngine({now,...options});
  if(!engine.isOpen(gen))fail(410,'할로윈 뽑기 기간이 종료되었습니다.');
  const save=structuredClone(saved.data);save.owned||={};save.shiny||={};save.stats||={};save.tickets||={t1:0,t10:0};save.coins=amount(save.coins);save.tickets.t1=amount(save.tickets.t1);save.tickets.t10=amount(save.tickets.t10);
  const cost=engine.costOf(save,n,use);if(!cost)fail(400,'뽑기권이 부족합니다.');
  initLedger(save);const owned={...save.owned};
  const results=engine.pull(save,n,gen,use);growth.record(save,results,owned);
  const iris=results.iris||0,refund=results.reduce((sum,r)=>sum+r.refund,0);
  save.led['server:gacha:'+requestId]={c:[refund,0],t1:[0,cost.t1],t10:[0,cost.t10]};save.updated=now;
  const next=(await client.query('UPDATE saves SET data=$1,revision=revision+1,updated_at=now() WHERE account_id=$2 AND revision=$3 RETURNING revision',[JSON.stringify(save),account.id,revision])).rows[0];
  if(!next)fail(409,'저장 내용이 변경되었습니다.');
  await client.query('INSERT INTO gacha_receipts(account_id,request_id,n,gen,ticket_kind,results,iris,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[account.id,requestId,n,gen,use,JSON.stringify(results),iris,new Date(now)]);
  await client.query('COMMIT');return{user:{id:account.id,name:account.name},save,revision:next.revision,results,iris,replayed:false};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
// Old or edited browser saves cannot replace the server's growth or draw ledger.
export function protectGrowth(incoming,current){
 const save=structuredClone(incoming);
 delete save.korGrowth;if(current.korGrowth)save.korGrowth=structuredClone(current.korGrowth);
 const existing=Object.entries(current.led||{}).filter(([id])=>id.startsWith('server:gacha:'));
 if(save.led&&typeof save.led==='object')for(const id of Object.keys(save.led))if(id.startsWith('server:gacha:'))delete save.led[id];
 if(existing.length){
  if(!save.led||typeof save.led!=='object'||Array.isArray(save.led))save.led=structuredClone(current.led);
  for(const [id,entry]of existing)save.led[id]=structuredClone(entry);
  for(const [key,set]of [['c',n=>save.coins=n],['t1',n=>(save.tickets||={}).t1=n],['t10',n=>(save.tickets||={}).t10=n]]){
   let balance=0;for(const entry of Object.values(save.led))balance+=amount(entry?.[key]?.[0])-amount(entry?.[key]?.[1]);set(Math.max(0,balance));
  }
 }
 return save;
}
export {growth,catalog};
