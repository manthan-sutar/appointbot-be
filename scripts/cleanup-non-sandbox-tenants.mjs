/**
 * Deletes every business except the sandbox tenant, then every business_owner except
 * DEMO_SANDBOX_OWNER_ID. Uses ON DELETE CASCADE from businesses for dependent rows.
 *
 * Also clears sales/demo intake: `magic_login_tokens` and `demo_requests` so the public
 * demo form accepts the same email again.
 *
 * Requires: DEMO_SANDBOX_OWNER_ID in .env (see npm run sandbox:ensure).
 *
 * Usage: node scripts/cleanup-non-sandbox-tenants.mjs
 */
import "dotenv/config";
import pool, { query } from "../src/config/db.js";

const ownerId = Number.parseInt(String(process.env.DEMO_SANDBOX_OWNER_ID || "").trim(), 10);
if (!Number.isInteger(ownerId) || ownerId <= 0) {
  console.error("Set DEMO_SANDBOX_OWNER_ID in .env first (npm run sandbox:ensure).");
  process.exit(1);
}

async function main() {
  const { rows } = await query(
    `SELECT id, email, business_id FROM business_owners WHERE id = $1`,
    [ownerId],
  );
  if (!rows.length) {
    console.error(`No business_owners row with id=${ownerId}.`);
    process.exit(1);
  }
  const keepBusinessId = rows[0].business_id;
  if (keepBusinessId == null) {
    console.error(
      "Sandbox owner has no business_id — complete onboarding or run sandbox:ensure first.",
    );
    process.exit(1);
  }

  const delMagic = await query(`DELETE FROM magic_login_tokens`);
  const delDemo = await query(`DELETE FROM demo_requests`);

  const delBiz = await query(
    `DELETE FROM businesses WHERE id <> $1`,
    [keepBusinessId],
  );
  const delOwners = await query(
    `DELETE FROM business_owners WHERE id <> $1`,
    [ownerId],
  );

  console.log(
    `[cleanup] Removed ${delMagic.rowCount} magic login token(s), ${delDemo.rowCount} demo request row(s).`,
  );
  console.log(
    `[cleanup] Removed ${delBiz.rowCount} other businesses (cascaded dependent rows).`,
  );
  console.log(`[cleanup] Removed ${delOwners.rowCount} other business owners.`);
  console.log(`[cleanup] Kept business id=${keepBusinessId}, owner id=${ownerId}.`);
}

try {
  await main();
} catch (e) {
  console.error("[cleanup] Failed:", e?.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
