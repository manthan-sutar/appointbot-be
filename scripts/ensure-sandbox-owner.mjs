/**
 * Creates (or reuses) a dedicated demo sandbox owner + business, then writes DEMO_SANDBOX_OWNER_ID to .env.
 * Idempotent: if sandbox@booklyft.demo exists, only updates DEMO_SANDBOX_* lines.
 *
 * Usage: node scripts/ensure-sandbox-owner.mjs
 */
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import pool, { query } from "../src/config/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SANDBOX_EMAIL = "sandbox@booklyft.demo";
const SALT_ROUNDS = 12;

function randomE164Phone() {
  const n = String(1000000000 + Math.floor(Math.random() * 8999999999));
  return `+91${n}`;
}

async function uniqueSlug(base) {
  let slug = base;
  let n = 1;
  for (;;) {
    const r = await query(`SELECT 1 FROM businesses WHERE slug = $1`, [slug]);
    if (!r.rows.length) return slug;
    slug = `${base}-${++n}`;
  }
}

function randomPassword() {
  return `${crypto.randomBytes(18).toString("base64url")}aA1!`;
}

function upsertEnvLines(envPath, pairs) {
  const keys = Object.keys(pairs);
  const escaped = keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const prefixRe = new RegExp(`^\\s*(${escaped.join("|")})=`);
  const text = fs.readFileSync(envPath, "utf8");
  const lines = text.split(/\r?\n/);
  const out = lines.filter((line) => !prefixRe.test(line));
  for (const k of keys) {
    out.push(`${k}=${pairs[k]}`);
  }
  fs.writeFileSync(envPath, out.join("\n").replace(/\n*$/, "\n"));
}

async function main() {
  const envPath = path.join(__dirname, "..", ".env");

  const existing = await query(
    `SELECT id, email FROM business_owners WHERE lower(email) = lower($1)`,
    [SANDBOX_EMAIL],
  );

  let ownerId;
  let password = null;

  if (existing.rows.length) {
    ownerId = existing.rows[0].id;
    console.log(`[sandbox] Reusing existing owner ${SANDBOX_EMAIL} → id=${ownerId}`);
  } else {
    password = randomPassword();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const phone = randomE164Phone();
    const slug = await uniqueSlug("demo-sandbox");

    const { rows: bizRows } = await query(
      `INSERT INTO businesses (name, type, phone, slug, timezone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      ["Demo sandbox", "salon", phone, slug, "Asia/Kolkata"],
    );
    const businessId = bizRows[0].id;

    await query(
      `INSERT INTO subscriptions (business_id, plan, status, trial_ends_at)
       VALUES ($1, 'free', 'trialing', NOW() + INTERVAL '14 days')
       ON CONFLICT (business_id) DO NOTHING`,
      [businessId],
    );

    const { rows: ownRows } = await query(
      `INSERT INTO business_owners (email, password_hash, business_id, onboarded)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id`,
      [SANDBOX_EMAIL.toLowerCase(), passwordHash, businessId],
    );
    ownerId = ownRows[0].id;
    console.log(`[sandbox] Created owner ${SANDBOX_EMAIL} → id=${ownerId}`);
  }

  upsertEnvLines(envPath, {
    DEMO_SANDBOX_OWNER_ID: String(ownerId),
    DEMO_SANDBOX_LOGIN_EMAIL: SANDBOX_EMAIL,
    ...(password
      ? { DEMO_SANDBOX_LOGIN_PASSWORD: password }
      : {}),
  });

  console.log(`[sandbox] Updated ${envPath}`);
  console.log(`[sandbox] DEMO_SANDBOX_OWNER_ID=${ownerId}`);
  if (password) {
    console.log(
      `[sandbox] Password saved as DEMO_SANDBOX_LOGIN_PASSWORD in .env (manual login at /dashboard/login).`,
    );
  } else {
    console.log(
      `[sandbox] Password unchanged — use DEMO_SANDBOX_LOGIN_PASSWORD in .env if set, or reset via DB.`,
    );
  }
  console.log(
    `[sandbox] Run "npm run sandbox:profile" to add staff, services, and working hours for the demo UI.`,
  );
}

try {
  await main();
} catch (e) {
  console.error("[sandbox] Failed:", e?.message || e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
