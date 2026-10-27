import fs from 'node:fs/promises';
import { generateKeyPairSync, randomBytes, createCipheriv, createDecipheriv, publicEncrypt, privateDecrypt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { migrate } from '../src/migrate.js';

// Standard envelope encryption: RSA-OAEP/SHA-256 wraps a random AES-256-GCM key.
export function seal(data, publicKey) {
  const key = randomBytes(32), iv = randomBytes(12);
  const wrappedKey = publicEncrypt({ key: publicKey, oaepHash: 'sha256' }, key).toString('base64');
  const header = JSON.stringify({ format: 'pskor-backup', version: 1, createdAt: new Date().toISOString(), iv: iv.toString('base64'), wrappedKey });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return JSON.stringify({ header, ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') }) + '\n';
}
export function unseal(envelope, privateKey) {
  const { header, ciphertext, tag } = JSON.parse(envelope), metadata = JSON.parse(header);
  if (metadata.format !== 'pskor-backup' || metadata.version !== 1) throw new Error('Unsupported backup');
  const key = privateDecrypt({ key: privateKey, oaepHash: 'sha256' }, Buffer.from(metadata.wrappedKey, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(metadata.iv, 'base64'));
  decipher.setAAD(Buffer.from(header));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}
export async function snapshot(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const accounts = (await client.query('SELECT id,name,name_key,password_hash,created_at FROM accounts ORDER BY id')).rows;
    const saves = (await client.query('SELECT account_id,data,revision,updated_at FROM saves ORDER BY account_id')).rows;
    const hasClaims = (await client.query("SELECT to_regclass('notice_claims') AS claims")).rows[0].claims;
    const hasCoins = hasClaims && (await client.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='notice_claims' AND column_name='coins') AS present")).rows[0].present;
    const campaigns = hasClaims ? (await client.query('SELECT id,started_at FROM notice_campaigns ORDER BY id')).rows : [];
    const claims = hasClaims ? (await client.query(`SELECT account_id,notice_id,ticket10,claimed_at${hasCoins ? ',coins' : ''} FROM notice_claims ORDER BY account_id,notice_id`)).rows : [];
    const hasMemberGrants = (await client.query("SELECT to_regclass('member_grants') AS present")).rows[0].present;
    const memberGrants = hasMemberGrants ? (await client.query('SELECT account_id,notice_id,ticket1,coins,granted_at FROM member_grants ORDER BY account_id,notice_id')).rows : [];
    const hasCommunity = (await client.query("SELECT to_regclass('social_friends') AS present")).rows[0].present;
    const community = hasCommunity ? { friends: (await client.query('SELECT * FROM social_friends ORDER BY a,b')).rows, records: (await client.query('SELECT * FROM survival_records ORDER BY id')).rows, members: (await client.query('SELECT * FROM record_members ORDER BY record_id,seat')).rows } : null;
    const hasDamage = hasCommunity && (await client.query("SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='survival_records' AND column_name='arceus_damage') AS present")).rows[0].present;
    // pg returns bigint as text; the bounded metric fits exactly in JSON numbers and PGlite.
    if (hasDamage) community.records = community.records.map(r => ({ ...r, arceus_damage: Number(r.arceus_damage) }));
    await client.query('COMMIT');
    if (community) return { schema: hasMemberGrants ? 6 : hasDamage ? 5 : 4, accounts, saves, campaigns, claims, ...community, ...(hasMemberGrants ? { memberGrants } : {}) };
    // Session tokens are intentionally excluded. Restored users log in again.
    return hasClaims ? { schema: hasCoins ? 3 : 2, accounts, saves, campaigns, claims } : { schema: 1, accounts, saves };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
export async function restore(pool, data) {
  if (![1, 2, 3, 4, 5, 6].includes(data.schema) || !Array.isArray(data.accounts) || !Array.isArray(data.saves) || data.accounts.length !== data.saves.length || (data.schema >= 2 && (!Array.isArray(data.campaigns) || !Array.isArray(data.claims)))) throw new Error('Invalid application backup');
  if (data.schema >= 4 && !['friends','records','members'].every(k => Array.isArray(data[k]))) throw new Error('Invalid community backup');
  if (data.schema >= 6 && !Array.isArray(data.memberGrants)) throw new Error('Invalid member-gift backup');
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE accounts, saves, sessions, notice_campaigns, notice_claims, member_grants, social_friends, social_runs, survival_records, record_members IN ACCESS EXCLUSIVE MODE');
    for (const table of ['accounts', 'saves', 'sessions', 'notice_claims', 'member_grants', 'social_friends', 'social_runs', 'survival_records', 'record_members']) {
      if (Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count) !== 0) throw new Error('Restore requires an empty database; existing data will not be overwritten');
    }
    for (const a of data.accounts) await client.query('INSERT INTO accounts(id,name,name_key,password_hash,created_at) VALUES($1,$2,$3,$4,$5)', [a.id, a.name, a.name_key, a.password_hash, a.created_at]);
    for (const s of data.saves) await client.query('INSERT INTO saves(account_id,data,revision,updated_at) VALUES($1,$2,$3,$4)', [s.account_id, JSON.stringify(s.data), s.revision, s.updated_at]);
    if (data.schema >= 2) {
      for (const c of data.campaigns) await client.query('INSERT INTO notice_campaigns(id,started_at) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at', [c.id, c.started_at]);
      for (const c of data.claims) await client.query('INSERT INTO notice_claims(account_id,notice_id,ticket10,claimed_at,coins) VALUES($1,$2,$3,$4,$5)', [c.account_id, c.notice_id, c.ticket10, c.claimed_at, data.schema >= 3 ? c.coins : 0]);
    }
    if (data.schema >= 6) for (const receipt of data.memberGrants) await client.query('INSERT INTO member_grants(account_id,notice_id,ticket1,coins,granted_at) VALUES($1,$2,$3,$4,$5)', [receipt.account_id, receipt.notice_id, receipt.ticket1, receipt.coins, receipt.granted_at]);
    if (data.schema >= 4) {
      for (const f of data.friends) await client.query('INSERT INTO social_friends(a,b,requested_by,state,created_at) VALUES($1,$2,$3,$4,$5)', [f.a,f.b,f.requested_by,f.state,f.created_at]);
      for (const r of data.records) await client.query('INSERT INTO survival_records(id,run_id,owner_id,mode,team_key,seconds,level,kills,recorded_at,arceus_damage) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [r.id,r.run_id,r.owner_id,r.mode,r.team_key,r.seconds,r.level,r.kills,r.recorded_at,data.schema >= 5 ? r.arceus_damage : 0]);
      for (const m of data.members) await client.query('INSERT INTO record_members(record_id,account_id,dex,shiny,seat) VALUES($1,$2,$3,$4,$5)', [m.record_id,m.account_id,m.dex,m.shiny,m.seat]);
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function main() {
  const [operation, filename] = process.argv.slice(2);
  if (operation === 'keygen' && filename) {
    // Refuse to replace an existing recovery key.
    const pair = generateKeyPairSync('rsa', { modulusLength: 4096, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    await fs.writeFile(filename, pair.privateKey, { mode: 0o600, flag: 'wx' });
    await fs.writeFile(filename + '.pub', pair.publicKey, { mode: 0o600, flag: 'wx' });
    console.log('Recovery keys created. Keep the private key offline; only the public key belongs in GitHub.'); return;
  }
  if (!filename || !['create', 'restore'].includes(operation)) throw new Error('Usage: node tools/backup.mjs keygen|create|restore FILE');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 20000 });
  try {
    if (operation === 'create') {
      if (!process.env.BACKUP_PUBLIC_KEY) throw new Error('BACKUP_PUBLIC_KEY is required');
      const data = await snapshot(pool);
      await fs.writeFile(filename, seal(data, process.env.BACKUP_PUBLIC_KEY), { mode: 0o600, flag: 'wx' });
      console.log(`Encrypted backup created: ${data.accounts.length} accounts, ${data.saves.length} saves.`);
    } else {
      if (!process.env.BACKUP_PRIVATE_KEY_FILE) throw new Error('BACKUP_PRIVATE_KEY_FILE is required');
      const key = await fs.readFile(process.env.BACKUP_PRIVATE_KEY_FILE, 'utf8');
      const data = unseal(await fs.readFile(filename, 'utf8'), key);
      await restore(pool, data);
      console.log(`Restored ${data.accounts.length} accounts and ${data.saves.length} saves. Users must log in again.`);
    }
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  // Never print pg error objects or connection strings into CI logs.
  console.error('Backup operation failed. Check credentials, recovery key, file permissions, and an empty restore target.');
  process.exitCode = 1;
});
