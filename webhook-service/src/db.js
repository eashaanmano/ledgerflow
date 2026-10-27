import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export async function migrate() {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    // Serialize migrations if several replicas start at once.
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query(sql);
  } finally {
    await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
    client.release();
  }
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
