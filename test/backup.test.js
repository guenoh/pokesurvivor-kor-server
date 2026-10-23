import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import pg from 'pg';
import { seal, unseal, snapshot, restore } from '../tools/backup.mjs';
import { migrate } from '../src/migrate.js';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
test('encrypted backups round trip and reject tampering and incorrect keys', () => {
  const data = { schema: 1, accounts: [{ name: '복구시험', password_hash: 'secret-hash' }], saves: [{ data: { coins: 42 } }] };
  const envelope = seal(data, pair.publicKey);
  assert.ok(!envelope.includes('secret-hash'));
  assert.deepEqual(unseal(envelope, pair.privateKey), data);
  const changed = JSON.parse(envelope);
  const bytes = Buffer.from(changed.ciphertext, 'base64'); bytes[0] ^= 1;
  changed.ciphertext = bytes.toString('base64');
  assert.throws(() => unseal(JSON.stringify(changed), pair.privateKey));
  const header = JSON.parse(envelope); header.header = header.header.replace('pskor-backup', 'invalid');
  assert.throws(() => unseal(JSON.stringify(header), pair.privateKey));
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => unseal(envelope, other.privateKey));
});
test('PostgreSQL snapshot and encrypted restore preserve accounts, saves and revisions without overwriting', { skip: !process.env.DATABASE_URL }, async () => {
  const connectionString = process.env.DATABASE_URL;
  const admin = new pg.Pool({ connectionString });
  const id = randomUUID().replaceAll('-', '');
  const sourceSchema = `backup_source_${id}`, targetSchema = `backup_target_${id}`;
  await admin.query(`CREATE SCHEMA ${sourceSchema}`); await admin.query(`CREATE SCHEMA ${targetSchema}`);
  const source = new pg.Pool({ connectionString, options: `-c search_path=${sourceSchema}` });
  const target = new pg.Pool({ connectionString, options: `-c search_path=${targetSchema}` });
  try {
    await migrate(source);
    await source.query("INSERT INTO accounts(id,name,name_key,password_hash) VALUES('test-id','복구시험','복구시험','password-hash')");
    await source.query("INSERT INTO saves(account_id,data,revision) VALUES('test-id',$1,7)", [JSON.stringify({ coins: 25, owned: { 25: { from: 'starter' } } })]);
    await source.query("INSERT INTO sessions(token_hash,account_id,expires_at) VALUES('test-token','test-id',now()+interval '1 day')");
    const original = await snapshot(source);
    await restore(target, unseal(seal(original, pair.publicKey), pair.privateKey));
    assert.deepEqual(await snapshot(target), original);
    assert.equal(Number((await target.query('SELECT count(*) FROM sessions')).rows[0].count), 0);
    await assert.rejects(restore(target, original), /empty database/);
    assert.deepEqual(await snapshot(target), original);
  } finally {
    await source.end(); await target.end();
    await admin.query(`DROP SCHEMA ${sourceSchema} CASCADE`); await admin.query(`DROP SCHEMA ${targetSchema} CASCADE`); await admin.end();
  }
});
