import { readFileSync } from 'node:fs';
import retired from './retired-content.cjs';
import { grantTickets } from './notices.js';
export const policy = JSON.parse(readFileSync(new URL('../config/retirement-costs.json', import.meta.url), 'utf8'));
export function compensation(save) {
  const levels = save?.pupg?.[1150] || save?.retiredKor?.armoredMewtwo?.pupg || {};
  let invested = 0;
  for (const [id, prices] of Object.entries(policy.prices)) {
    const n = Number(levels[id]);
    const level = Number.isFinite(n) ? Math.max(0, Math.min(prices.length, Math.floor(n))) : 0;
    invested += prices.slice(0, level).reduce((sum, n) => sum + n, 0);
  }
  return { invested, coins: invested * policy.multiplier, multiplier: policy.multiplier };
}
export async function retireAccount(pool, account, now = Date.now()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO notice_campaigns(id) VALUES($1) ON CONFLICT(id) DO NOTHING', [policy.campaign]);
    const saved = (await client.query('SELECT data,revision FROM saves WHERE account_id=$1 FOR UPDATE', [account.id])).rows[0];
    if (!saved) throw Error('Missing retirement save');
    const receipt = (await client.query('SELECT coins FROM member_grants WHERE account_id=$1 AND notice_id=$2', [account.id, policy.campaign])).rows[0];
    // The ledger also covers old-format backup restores where receipts are absent.
    const entry = saved.data.led?.['server:' + policy.campaign]?.c;
    const ledgerPaid = Number.isSafeInteger(entry?.[0]) && entry[0] >= 0 ? entry[0] : 0;
    const paid = receipt ? Number(receipt.coins) : ledgerPaid;
    const plan = compensation(saved.data);
    const coins = receipt || ledgerPaid ? 0 : plan.coins;
    let canonical = retired.normalize(saved.data), revision = saved.revision;
    if (coins) canonical = grantTickets(canonical, { id: policy.campaign }, now, { coins });
    if (JSON.stringify(canonical) !== JSON.stringify(saved.data)) {
      const result = await client.query('UPDATE saves SET data=$1,revision=revision+1,updated_at=now() WHERE account_id=$2 AND revision=$3 RETURNING revision', [JSON.stringify(canonical), account.id, revision]);
      if (!result.rows[0]) throw Error('Retirement revision changed');
      revision = result.rows[0].revision;
    }
    if (!receipt) await client.query('INSERT INTO member_grants(account_id,notice_id,ticket1,coins) VALUES($1,$2,0,$3)', [account.id, policy.campaign, paid || coins]);
    await client.query('COMMIT');
    return { granted: coins > 0, coins, invested: plan.invested, revision };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
export async function retireAllAccounts(pool) {
  const accounts = (await pool.query('SELECT id,name FROM accounts ORDER BY id')).rows;
  let recipients = 0, coins = 0;
  for (const account of accounts) { const result = await retireAccount(pool, account); recipients += +result.granted; coins += result.coins; }
  return { accounts: accounts.length, recipients, coins };
}
