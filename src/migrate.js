import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export async function migrate(pool) {
  // This initial migration is additive and repeatable. Future migrations must be numbered.
  const sql = await readFile(new URL('../migrations/001-init.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try { await migrate(pool); } finally { await pool.end(); }
}
