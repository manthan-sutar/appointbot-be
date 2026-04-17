/**
 * Clears `magic_login_tokens` and `demo_requests` only (no tenant / owner deletion).
 * Use when you need to re-submit the public demo form with the same email.
 *
 * Usage: node scripts/cleanup-demo-requests.mjs
 */
import "dotenv/config";
import pool, { query } from "../src/config/db.js";

async function main() {
  const m = await query(`DELETE FROM magic_login_tokens`);
  const d = await query(`DELETE FROM demo_requests`);
  console.log(
    `[demo:clear] Removed ${m.rowCount} magic login token(s), ${d.rowCount} demo request(s).`,
  );
}

try {
  await main();
} catch (e) {
  console.error("[demo:clear] Failed:", e?.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
