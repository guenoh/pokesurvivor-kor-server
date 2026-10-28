import { randomUUID } from 'node:crypto';
import { createLive } from './live.js';
import retired from './retired-content.cjs';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const pair = (a, b) => [a, b].sort();
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
export function periodStart(period, now = Date.now()) {
  const d = new Date(now + 9 * 3600000);
  d.setUTCHours(0, 0, 0, 0);
  if (period === 'w') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  if (period === 'm') d.setUTCDate(1);
  if (period === 'y') { d.setUTCMonth(0); d.setUTCDate(1); }
  return period === 'a' ? new Date(0) : new Date(+d - 9 * 3600000);
}
export function createCommunity({ pool, origin, session, clock = Date.now, logger }) {
  let queue = Promise.resolve();
  // Control operations are serialised across sockets and HTTP requests. Combat frames never wait on SQL.
  function serial(fn) { const result = queue.then(fn); queue = result.catch(() => {}); return result; }
  async function friends(uid) {
    const { rows } = await pool.query(`SELECT f.*,x.id AS uid,x.name FROM social_friends f JOIN accounts x ON x.id=CASE WHEN f.a=$1 THEN f.b ELSE f.a END WHERE f.a=$1 OR f.b=$1 ORDER BY f.created_at`, [uid]);
    return rows.map(f => ({ uid: f.uid, name: f.name, status: f.state === 'accepted' ? 'ok' : f.requested_by === uid ? 'out' : 'in', online: live.online(f.uid), play: live.playing(f.uid) }));
  }
  async function accepted(a, b) {
    if (!a || !b || a === b) return false;
    return !!(await pool.query("SELECT a FROM social_friends WHERE a=$1 AND b=$2 AND state='accepted'", pair(a, b))).rows[0];
  }
  async function member(account) {
    const s = retired.normalize((await pool.query('SELECT data FROM saves WHERE account_id=$1', [account.id])).rows[0]?.data || {});
    if (!integer(s.partner, 1, 2000) || !s.owned?.[s.partner]) fail(409, '먼저 함께할 포켓몬을 선택하고 저장해 주세요.');
    return { uid: account.id, name: account.name, dex: s.partner, shiny: !!s.partnerShiny && !!s.shiny?.[s.partner] };
  }
  async function begin(account, mode, roster) {
    const id = randomUUID();
    await pool.query('DELETE FROM social_runs WHERE owner_id=$1 OR started_at<$2', [account.id, new Date(clock() - 24 * 3600000)]);
    await pool.query('INSERT INTO social_runs(id,owner_id,mode,roster,started_at) VALUES($1,$2,$3,$4,$5)', [id, account.id, mode, JSON.stringify(roster), new Date(clock())]);
    return id;
  }
  const live = createLive({ origin, session, serial, friends, accepted, member, begin, clock, logger });
  async function board(account, url) {
    const mode = url.searchParams.get('mode') || 's', period = url.searchParams.get('period') || 'w';
    const metric = url.searchParams.get('metric') || 'time';
    const score = metric === 'damage' ? 'arceus_damage' : 'seconds';
    const dex = url.searchParams.get('dex') ? Number(url.searchParams.get('dex')) : null;
    if (!['time','damage'].includes(metric) || !['s', 'g'].includes(mode) || !['d', 'w', 'm', 'y', 'a'].includes(period) || (dex !== null && !integer(dex, 1, 2000))) fail(400, '기록 검색 조건을 확인해 주세요.');
    const circle = url.searchParams.get('friends') === '1' ? [account.id, ...(await friends(account.id)).filter(f => f.status === 'ok').map(f => f.uid)] : null;
    const args = [mode, periodStart(period, clock()), retired.recordDexes(dex), circle];
    const { rows } = await pool.query(`WITH best AS (
      SELECT r.*, row_number() OVER(PARTITION BY r.team_key ORDER BY r.${score} DESC,r.recorded_at,r.id) AS best_n
      FROM survival_records r WHERE r.mode=$1 AND r.recorded_at >= $2
      ${metric === 'damage' ? 'AND r.arceus_damage > 0' : ''}
      AND ($3::integer[] IS NULL OR EXISTS(SELECT 1 FROM record_members m WHERE m.record_id=r.id AND m.dex=ANY($3)))
      AND ($4::text[] IS NULL OR EXISTS(SELECT 1 FROM record_members m WHERE m.record_id=r.id AND m.account_id=ANY($4::text[])))
    ), ranked AS (
      SELECT *, row_number() OVER(ORDER BY ${score} DESC,recorded_at,id) AS position FROM best WHERE best_n=1
    ) SELECT r.id,r.seconds AS t,r.level AS lv,r.kills,r.arceus_damage,r.position,
      (SELECT jsonb_agg(jsonb_build_object('uid',a.id,'name',a.name,'dex',m.dex,'shiny',m.shiny) ORDER BY m.seat) FROM record_members m JOIN accounts a ON a.id=m.account_id WHERE m.record_id=r.id) AS members
      FROM ranked r WHERE r.position<=50 OR EXISTS(SELECT 1 FROM record_members m WHERE m.record_id=r.id AND m.account_id=$5) ORDER BY r.position`, [...args, account.id]);
    const format = r => ({ id: r.id, t: r.t, lv: r.lv, kills: r.kills, d: Number(r.arceus_damage), uids: r.members.map(m => m.uid), names: r.members.map(m => m.name), dex: r.members.map(m => retired.displayDex(m.dex)), shiny: r.members.map(m => m.shiny), pos: Number(r.position) });
    const all = rows.map(format), mine = all.find(r => r.uids.includes(account.id));
    return { rows: all.filter(r => r.pos <= 50), me: mine ? { pos: mine.pos, t: mine.t, ...(metric === 'damage' ? {d:mine.d} : {}) } : null };
  }
  async function handle(req, account, url, data) {
    const path = url.pathname.slice('/api/community'.length), method = req.method;
    if (method === 'GET' && path === '') return live.snapshot(account);
    if (method === 'GET' && path === '/records') return board(account, url);
    if (method === 'GET' && path.startsWith('/profile/')) {
      const uid = decodeURIComponent(path.slice(9));
      if (uid !== account.id && !await accepted(uid, account.id) && !(await pool.query('SELECT record_id FROM record_members WHERE account_id=$1 LIMIT 1', [uid])).rows.length) fail(404, '프로필을 볼 수 없습니다.');
      const a = (await pool.query('SELECT name FROM accounts WHERE id=$1', [uid])).rows[0];
      if (!a) fail(404, '탈퇴한 트레이너입니다.');
      // Explicit public projection: never return inventories, purchase ledgers, passwords or saves.
      const best = (await pool.query("SELECT max(CASE WHEN r.mode='s' THEN r.seconds ELSE 0 END) AS solo,max(CASE WHEN r.mode='g' THEN r.seconds ELSE 0 END) AS team,max(r.level) AS level,sum(r.kills) AS kills FROM survival_records r JOIN record_members m ON m.record_id=r.id WHERE m.account_id=$1", [uid])).rows[0];
      return { name: a.name, favs: [], medals: [], title: '', best: { solo: best.solo || 0, group: best.team || 0, level: best.level || 0, kills: Number(best.kills) || 0, bosses: 0, legends: 0, medals: 0 } };
    }
    return serial(async () => {
      if (path === '/friends/request' && method === 'POST') {
        const name = typeof data?.name === 'string' ? data.name.trim().normalize('NFKC') : '';
        if (!/^[\p{L}\p{N}_]{3,16}$/u.test(name)) fail(400, '친구의 계정 이름을 정확히 입력해 주세요.');
        const other = (await pool.query('SELECT id,name FROM accounts WHERE name_key=$1', [name.toLocaleLowerCase('en-US')])).rows[0];
        if (!other) fail(404, '해당 이름의 트레이너가 없습니다.');
        if (other.id === account.id) fail(400, '자신에게 친구 요청을 보낼 수 없습니다.');
        const ids = pair(account.id, other.id);
        const existing = (await pool.query('SELECT state,requested_by FROM social_friends WHERE a=$1 AND b=$2', ids)).rows[0];
        if (existing) fail(409, existing.state === 'accepted' ? '이미 친구인 트레이너입니다.' : existing.requested_by === account.id ? '이미 친구 요청을 보냈습니다.' : '받은 친구 요청에서 수락해 주세요.');
        const n = (await pool.query('SELECT count(*) AS n FROM social_friends WHERE a=$1 OR b=$1', [account.id])).rows[0].n;
        const pending = (await pool.query('SELECT count(*) AS n FROM social_friends WHERE a=$1 OR b=$1', [other.id])).rows[0].n;
        if (Number(n) >= 100 || Number(pending) >= 100) fail(409, '친구와 대기 중인 요청은 최대 100명까지입니다.');
        await pool.query("INSERT INTO social_friends(a,b,requested_by,state) VALUES($1,$2,$3,'pending')", [...ids, account.id]);
        await live.refresh([account.id, other.id]);
        return { ok: true, msg: `${other.name}님에게 친구 요청을 보냈습니다.` };
      }
      if (['/friends/accept', '/friends/remove'].includes(path) && method === 'POST') {
        if (typeof data?.uid !== 'string' || data.uid.length > 64) fail(400, '트레이너를 확인해 주세요.');
        const ids = pair(account.id, data.uid);
        if (path.endsWith('accept')) {
          const result = await pool.query("UPDATE social_friends SET state='accepted' WHERE a=$1 AND b=$2 AND requested_by=$3 AND state='pending' RETURNING a", [...ids, data.uid]);
          if (!result.rows.length) fail(404, '받은 친구 요청이 없습니다.');
        } else {
          await pool.query('DELETE FROM social_friends WHERE a=$1 AND b=$2', ids);
          live.revoke(account.id, data.uid);
        }
        await live.refresh([account.id, data.uid]);
        return { ok: true, msg: path.endsWith('accept') ? '친구가 되었습니다!' : '친구 목록에서 삭제했습니다.' };
      }
      if (method === 'POST' && path.startsWith('/room/')) return live.command(account, path.slice(6), data || {});
      if (method === 'POST' && path === '/runs/start') return { id: await begin(account, 's', [await member(account)]) };
      if (method === 'POST' && path === '/runs/finish') {
        const damage = data?.dmg ?? 0;
        if (!integer(damage, 0, 10000000000000) || (damage > 0 && data?.t < 1800)) fail(400, '아르세우스 피해량을 확인해 주세요.');
        if (typeof data?.id !== 'string' || !integer(data.t, 1, 21600) || !integer(data.lv, 1, 1000) || !integer(data.kills, 0, 10000000)) fail(400, '생존 기록을 확인해 주세요.');
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const run = (await client.query('SELECT * FROM social_runs WHERE id=$1 AND owner_id=$2 FOR UPDATE', [data.id, account.id])).rows[0];
          if (!run || run.finished) fail(409, '이미 등록했거나 만료된 도전입니다.');
          if (clock() - +new Date(run.started_at) > 24 * 3600000 || data.t > (clock() - +new Date(run.started_at)) / 1000 * 1.25 + 5) fail(400, '실제 플레이 시간과 기록이 맞지 않습니다.');
          const id = randomUUID(), team = run.roster;
          await client.query('INSERT INTO survival_records(id,run_id,owner_id,mode,team_key,seconds,level,kills,recorded_at,arceus_damage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [id, run.id, account.id, run.mode, team.map(m => m.uid).sort().join(':'), data.t, data.lv, data.kills, new Date(clock()), damage]);
          for (let i = 0; i < team.length; i++) await client.query('INSERT INTO record_members(record_id,account_id,dex,shiny,seat) VALUES($1,$2,$3,$4,$5)', [id, team[i].uid, team[i].dex, team[i].shiny, i]);
          await client.query('UPDATE social_runs SET finished=true WHERE id=$1', [run.id]);
          await client.query('COMMIT');
          return { id, periods: ['d', 'w', 'm', 'a'] };
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      }
      fail(404, '찾을 수 없습니다.');
    });
  }
  return { handle, live };
}
