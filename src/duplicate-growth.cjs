/* Korean duplicate growth policy. Pure, shared with the independent server. */
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else G.DuplicateGrowth = api;
})(function () {
  const STAGES = [
    { id:'hp', title:'체력', effect:'최대 체력 +8', key:'hp', bonus:8, icon:'heart' },
    { id:'atk', title:'공격', effect:'물리·특수 피해 +4%', key:'atkMul', bonus:0.04, icon:'fist' },
    { id:'magnet', title:'획득 범위', effect:'획득 범위 +12%', key:'magnetMul', bonus:0.12, icon:'magnet' },
    { id:'def', title:'방어', effect:'받는 피해 감소 +2%', key:'dmgReduce', bonus:0.02, icon:'shield' },
    { id:'regen', title:'재생', effect:'초당 체력 회복 +0.2', key:'regen', bonus:0.2, icon:'sprout' }
  ];
  // Expected banner pulls per milestone, adjusted for each species' actual pool.
  const TARGETS = [160,400,750,1200,1800];
  const RATES = [[1,45],[2,30],[3,17],[4,6.5],[5,1.5]];
  const LIMIT = 1000000;
  const amount = n => Number.isSafeInteger(n) && n >= 0 ? Math.min(LIMIT,n) : 0;
  let dex = new Map(), pools = new Map();
  // Exact long-run rarity distribution with the existing ten-pull and 70-pull guarantees.
  function effectiveRates() {
    let state=Array(140).fill(0), counts; state[0]=1;
    for(let batch=0;batch<3000;batch++) {
      const before=state; counts=Array(5).fill(0);
      for(let pos=0;pos<10;pos++) {
        const next=Array(140).fill(0);
        for(let p=0;p<70;p++) for(let seen=0;seen<2;seen++) {
          const mass=state[p*2+seen]; if(!mass) continue;
          const choices=p===69?[[5,1]]:pos===9&&!seen?[[4,6.5/8],[5,1.5/8]]:RATES.map(([r,w])=>[r,w/100]);
          for(const [r,q] of choices) { counts[r-1]+=mass*q; next[(r===5?0:p+1)*2+(pos===9?0:Number(seen||r>=4))]+=mass*q; }
        }
        state=next;
      }
      if(batch>100&&state.every((x,i)=>Math.abs(x-before[i])<1e-14)) break;
    }
    return counts.map(n=>n/10);
  }
  const effective = effectiveRates();
  function configure(catalog, meta) {
    dex=new Map(); pools=new Map();
    for(const mon of catalog) {
      if(meta && !meta[mon.dex]) continue;
      dex.set(Number(mon.dex),mon);
      const key=mon.gen+':'+mon.rarity; pools.set(key,(pools.get(key)||0)+1);
    }
  }
  function thresholds(id) {
    const mon=dex.get(Number(id)); if(!mon) return [];
    const chance=effective[mon.rarity-1]/pools.get(mon.gen+':'+mon.rarity);
    let previous=0;
    return TARGETS.map(goal => previous=Math.max(previous+1,Math.ceil(goal*chance)));
  }
  function count(save,id) { return amount(save?.korGrowth?.counts?.[id]); }
  function rank(save,id) { const n=count(save,id); return thresholds(id).filter(t=>n>=t).length; }
  function perks(base,save,id) {
    const result={...base};
    for(const stage of STAGES.slice(0,rank(save,id))) result[stage.key]=(result[stage.key]??(stage.key.endsWith('Mul')?1:0))+stage.bonus;
    return result;
  }
  function record(save,results,previouslyOwned) {
    const owned=new Set(Object.keys(previouslyOwned||{}));
    const counts={...(save.korGrowth?.counts||{})}; save.korGrowth={v:1,counts};
    for(const r of results) {
      const before=rank(save,r.dex), duplicate=owned.has(String(r.dex));
      if(duplicate&&dex.has(Number(r.dex))) counts[r.dex]=Math.min(LIMIT,count(save,r.dex)+1);
      owned.add(String(r.dex));
      r.growth={duplicate,count:count(save,r.dex),rank:rank(save,r.dex),unlocked:STAGES.slice(before,rank(save,r.dex)).map(s=>s.id)};
    }
    return results;
  }
  return {STAGES,TARGETS,RATES,LIMIT,amount,effective,configure,thresholds,count,rank,perks,record};
});
