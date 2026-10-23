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
    await client.query('COMMIT');
    // Session tokens are intentionally excluded. Restored users log in again.
    return { schema: 1, accounts, saves };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
export async function restore(pool, data) {
  if (data.schema !== 1 || !Array.isArray(data.accounts) || !Array.isArray(data.saves) || data.accounts.length !== data.saves.length) throw new Error('Invalid application backup');
  await migrate(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE accounts, saves, sessions IN ACCESS EXCLUSIVE MODE');
    for (const table of ['accounts', 'saves', 'sessions']) {
      if (Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count) !== 0) throw new Error('Restore requires an empty database; existing data will not be overwritten');
    }
    for (const a of data.accounts) await client.query('INSERT INTO accounts(id,name,name_key,password_hash,created_at) VALUES($1,$2,$3,$4,$5)', [a.id, a.name, a.name_key, a.password_hash, a.created_at]);
    for (const s of data.saves) await client.query('INSERT INTO saves(account_id,data,revision,updated_at) VALUES($1,$2,$3,$4)', [s.account_id, JSON.stringify(s.data), s.revision, s.updated_at]);
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
