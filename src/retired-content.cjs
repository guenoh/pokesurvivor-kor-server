/* Read/write compatibility for removed content only. Registers no game content.
 * Keep this file byte-identical to the independent server's retired-content.cjs.
 */
(() => {
  const OLD = '1150', BASE = '150', MOVE = 'psycho-rush';
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const copy = v => JSON.parse(JSON.stringify(v));
  const displayDex = dex => +dex === +OLD ? +BASE : dex;
  const recordDexes = dex => dex == null ? null : +dex === +BASE ? [+BASE, +OLD] : [+dex];
  function normalize(input) {
    if (!object(input)) return input;
    const s = copy(input), archive = {};
    const indexed = ['owned','shiny','pupg','dfav','pused','pstart','pstart2','ptm','pnat','pabil','pskin','pbind','pban','legends'];
    for (const key of indexed) if (object(s[key]) && Object.hasOwn(s[key], OLD)) {
      archive[key] = copy(s[key][OLD]);
      delete s[key][OLD];
    }
    for (const key of ['partner','starter']) if (+s[key] === +OLD) {
      archive[key] = s[key];
      s[key] = s.owned?.[s.starter] && +s.starter !== +OLD ? +s.starter
        : s.owned?.[BASE] ? +BASE : +(Object.keys(s.owned || {}).find(d => Number.isSafeInteger(+d) && +d !== +OLD) || 0) || null;
    }
    if (Array.isArray(s.profile?.favs)) s.profile.favs = [...new Set(s.profile.favs.filter(d => +d !== +OLD))];
    for (const key of ['pstart','pstart2']) for (const [dex, id] of Object.entries(s[key] || {})) if (id === MOVE) {
      ((archive.moveOverrides ||= {})[key] ||= {})[dex] = id;
      delete s[key][dex];
    }
    for (const key of ['ptm','pban']) for (const [dex, ids] of Object.entries(s[key] || {})) if (Array.isArray(ids)) s[key][dex] = ids.filter(id => id !== MOVE);
    for (const [dex, ids] of Object.entries(s.pbind || {})) if (Array.isArray(ids)) s.pbind[dex] = ids.map(id => id === MOVE ? null : id);
    for (const key of ['tms','evoMoves']) if (object(s[key]) && Object.hasOwn(s[key], MOVE)) { archive[key] = s[key][MOVE]; delete s[key][MOVE]; }
    for (const [writer, entry] of Object.entries(s.led || {})) if (object(entry) && Object.hasOwn(entry, 'm:' + MOVE)) {
      (archive.moveLedger ||= {})[writer] = entry['m:' + MOVE]; delete entry['m:' + MOVE];
    }
    if (Object.keys(archive).length) {
      if (!object(s.retiredKor)) s.retiredKor = {};
      // The snapshot is recovery information, never re-registered as a Pokémon or move.
      s.retiredKor.armoredMewtwo ||= archive;
    }
    return s;
  }
  const api = { normalize, displayDex, recordDexes };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else G.RetiredContent = api;
})();
