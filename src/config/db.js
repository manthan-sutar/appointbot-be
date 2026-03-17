import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

const SLOW_QUERY_MS = 100;

export async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production' && duration > SLOW_QUERY_MS) {
    console.warn(`[DB] Slow query (${duration}ms): ${text.slice(0, 120)}`);
  }
  return res;
}

export async function getClient() {
  return pool.connect();
}

export default pool;
