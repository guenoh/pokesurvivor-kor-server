import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { initializeNotices } from './notices.js';
export async function migrate(pool) {
  for (const file of ['001-init.sql', '002-notices.sql', '003-notice-coins.sql', '004-community.sql', '005-arceus-records.sql', '006-member-gifts.sql', '007-run-start-retries.sql', '008-gacha-receipts.sql']) {
    await pool.query(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  await initializeNotices(pool);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { await migrate(pool); } finally { await pool.end(); }
}
