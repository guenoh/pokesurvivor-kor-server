import { readFileSync } from 'node:fs';

export const noticeConfig = JSON.parse(readFileSync(new URL('../config/notices.json', import.meta.url), 'utf8'));
for (const notice of noticeConfig.notices) {
  if (!/^[a-z0-9-]{1,60}$/.test(notice.id) || !Number.isSafeInteger(notice.version) || !Array.isArray(notice.paragraphs)) throw new Error('Invalid notice configuration');
  if (notice.reward && (!Number.isSafeInteger(notice.reward.ticket10) || notice.reward.ticket10 < 1 || notice.reward.ticket10 > 1000 || !['signup24h', 'event24h'].includes(notice.reward.window))) throw new Error('Invalid reward configuration');
  if (notice.reward?.coins !== undefined && (!Number.isSafeInteger(notice.reward.coins) || notice.reward.coins < 0 || notice.reward.coins > 100000000)) throw new Error('Invalid coin reward');
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error; }
const DAY = 86400_000;
export async function initializeNotices(pool, config = noticeConfig) {
  for (const notice of config.notices.filter(n => n.reward)) {
    await pool.query('INSERT INTO notice_campaigns(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [notice.id]);
  }
}
function timing(notice, account, campaign, now) {
  const starts = notice.reward.window === 'signup24h' ? new Date(account?.created_at).getTime() : new Date(campaign?.started_at).getTime();
  const expires = starts + DAY;
  return { eligible: !!account && now >= starts && now < expires, expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null };
}
export async function listNotices(pool, account, config = noticeConfig, now = Date.now()) {
  const campaigns = (await pool.query('SELECT id,started_at FROM notice_campaigns')).rows;
  const claims = account ? (await pool.query('SELECT notice_id,ticket10,coins,claimed_at FROM notice_claims WHERE account_id=$1', [account.id])).rows : [];
  return {
    serverNow: new Date(now).toISOString(),
    notices: config.notices.map(notice => {
      if (!notice.reward) return { ...notice };
      const receipt = claims.find(c => c.notice_id === notice.id);
      const remaining = remainingReward(notice, receipt);
      const claimed = !remaining.ticket10 && !remaining.coins;
      const window = timing(notice, account, campaigns.find(c => c.id === notice.id), now);
      return { ...notice, reward: { ...notice.reward, ...window, remaining, eligible: !claimed && window.eligible, claimed, partiallyClaimed: !!receipt && !claimed, needsLogin: !account, claimedAt: receipt?.claimed_at || null } };
    }),
    support: { ...config.support, url: config.support?.url && /^https:\/\//.test(config.support.url) ? config.support.url : null }
  };
}
const amount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function remainingReward(notice, receipt) {
  return { ticket10: Math.max(0, notice.reward.ticket10 - amount(Number(receipt?.ticket10))), coins: Math.max(0, (notice.reward.coins || 0) - amount(Number(receipt?.coins))) };
}
export function grantTickets(original, notice, now, awarded = remainingReward(notice)) {
  const save = structuredClone(original);
  save.tickets = { ...(save.tickets || {}), t1: amount(save.tickets?.t1), t10: amount(save.tickets?.t10) };
  if (!save.led || typeof save.led !== 'object' || Array.isArray(save.led)) {
    save.led = { base: { c: [amount(save.coins), 0], t1: [save.tickets.t1, 0], t10: [save.tickets.t10, 0] } };
    for (const [collection, prefix] of [['bag', 'b'], ['tms', 'm']]) for (const [key, count] of Object.entries(save[collection] || {})) {
      if (/^[a-z0-9-]{1,40}$/.test(key)) save.led.base[`${prefix}:${key}`] = [amount(count), 0];
    }
  }
  save.coins = amount(save.coins);
  if (save.tickets.t10 > Number.MAX_SAFE_INTEGER - awarded.ticket10 || save.coins > Number.MAX_SAFE_INTEGER - awarded.coins) fail(400, '선물 수량을 확인할 수 없습니다.');
  const entry = save.led[`server:${notice.id}`] ||= {};
  for (const [field, quantity] of [['t10', awarded.ticket10], ['c', awarded.coins]]) if (quantity) {
    entry[field] = [amount(entry[field]?.[0]) + quantity, amount(entry[field]?.[1])];
  }
  save.tickets.t10 += awarded.ticket10;
  save.coins += awarded.coins;
  save.updated = now;
  return save;
}
export async function claimNotice(pool, account, noticeId, revision, config = noticeConfig, now = Date.now()) {
  const notice = config.notices.find(n => n.id === noticeId);
  if (!notice?.reward) fail(404, '받을 수 있는 선물이 없습니다.');
  if (!Number.isSafeInteger(revision) || revision < 0) fail(400, '저장 내용을 먼저 동기화해 주세요.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize every claim with game saves, including two simultaneous devices.
    const save = (await client.query('SELECT data,revision FROM saves WHERE account_id=$1 FOR UPDATE', [account.id])).rows[0];
    if (!save) fail(404, '계정의 저장 데이터를 찾을 수 없습니다.');
    const receipt = (await client.query('SELECT ticket10,coins FROM notice_claims WHERE account_id=$1 AND notice_id=$2', [account.id, noticeId])).rows[0];
    const awarded = remainingReward(notice, receipt);
    if (!awarded.ticket10 && !awarded.coins) {
      await client.query('COMMIT');
      return { user: { id: account.id, name: account.name }, save: save.data, revision: save.revision, granted: false, alreadyClaimed: true, awarded };
    }
    if (Number(save.revision) !== revision) fail(409, '다른 기기에서 저장되었습니다. 현재 데이터를 백업한 뒤 서버 저장을 다시 불러와 주세요.');
    const campaign = (await client.query('SELECT id,started_at FROM notice_campaigns WHERE id=$1', [noticeId])).rows[0];
    if (!timing(notice, account, campaign, now).eligible) fail(410, '선물을 받을 수 있는 시간이 지났습니다.');
    const updated = grantTickets(save.data, notice, now, awarded);
    const result = await client.query('UPDATE saves SET data=$1,revision=revision+1,updated_at=now() WHERE account_id=$2 AND revision=$3 RETURNING revision', [JSON.stringify(updated), account.id, revision]);
    if (!result.rows[0]) fail(409, '저장 내용이 변경되었습니다. 다시 확인해 주세요.');
    if (receipt) await client.query('UPDATE notice_claims SET ticket10=ticket10+$3,coins=coins+$4 WHERE account_id=$1 AND notice_id=$2', [account.id, noticeId, awarded.ticket10, awarded.coins]);
    else await client.query('INSERT INTO notice_claims(account_id,notice_id,ticket10,coins) VALUES($1,$2,$3,$4)', [account.id, noticeId, awarded.ticket10, awarded.coins]);
    await client.query('COMMIT');
    return { user: { id: account.id, name: account.name }, save: updated, revision: result.rows[0].revision, granted: true, alreadyClaimed: false, awarded };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
