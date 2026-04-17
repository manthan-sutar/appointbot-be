import crypto from "crypto";
import { query } from "../config/db.js";

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Public URL users open from email (prod). Prefer this over FRONTEND_URL when API host ≠ app host. */
export function getMagicLinkPublicOrigin() {
  const raw =
    process.env.MAGIC_LINK_PUBLIC_URL ||
    process.env.FRONTEND_URL ||
    "http://localhost:5173";
  return String(raw).trim().replace(/\/$/, "");
}

export function buildMagicLoginUrl(rawToken) {
  const base = getMagicLinkPublicOrigin();
  return `${base}/dashboard/magic-login?token=${encodeURIComponent(rawToken)}`;
}

/**
 * Create a one-time link for the configured demo sandbox owner.
 * @returns {Promise<string|null>} raw secret token, or null if demo owner not configured / missing row
 */
let warnedMissingDemoOwnerEnv;

export async function createMagicLoginTokenForDemoRequest(demoRequestId) {
  const ownerIdRaw = process.env.DEMO_SANDBOX_OWNER_ID;
  if (!ownerIdRaw || !String(ownerIdRaw).trim()) {
    if (!warnedMissingDemoOwnerEnv) {
      warnedMissingDemoOwnerEnv = true;
      console.warn(
        "[MagicLink] DEMO_SANDBOX_OWNER_ID is not set — demo emails will not include a magic link. Set it on this server (e.g. Render) to match your sandbox owner row.",
      );
    }
    return null;
  }
  const ownerId = Number.parseInt(String(ownerIdRaw).trim(), 10);
  if (!Number.isInteger(ownerId) || ownerId <= 0) return null;

  const { rows: exists } = await query(
    `SELECT 1 FROM business_owners WHERE id = $1`,
    [ownerId],
  );
  if (!exists.length) {
    console.warn(
      "[MagicLink] DEMO_SANDBOX_OWNER_ID does not match a business_owners row:",
      ownerId,
    );
    return null;
  }

  const raw = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(raw);
  const hours = Number(process.env.MAGIC_LINK_EXPIRES_HOURS || 168);
  const safeHours = Math.min(Math.max(hours, 1), 720);
  const expiresAt = new Date(Date.now() + safeHours * 3600 * 1000);

  await query(
    `INSERT INTO magic_login_tokens (token_hash, business_owner_id, demo_request_id, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [tokenHash, ownerId, demoRequestId, expiresAt.toISOString()],
  );

  return raw;
}

/**
 * Mark token used and return owner row for JWT (same shape as password login).
 * @returns {{ owner: object } | { error: 'invalid' | 'used' | 'expired' }}
 */
export async function consumeMagicLoginToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 20) {
    return { error: "invalid" };
  }
  const tokenHash = hashToken(rawToken.trim());

  const { rows: found } = await query(
    `SELECT business_owner_id, used_at, expires_at
     FROM magic_login_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  );

  if (!found.length) {
    return { error: "invalid" };
  }
  const row = found[0];
  if (row.used_at) {
    return { error: "used" };
  }
  if (new Date(row.expires_at) <= new Date()) {
    return { error: "expired" };
  }

  const upd = await query(
    `UPDATE magic_login_tokens m
     SET used_at = NOW()
     WHERE m.token_hash = $1
       AND m.used_at IS NULL
       AND m.expires_at > NOW()
     RETURNING m.business_owner_id`,
    [tokenHash],
  );

  if (!upd.rows.length) {
    return { error: "invalid" };
  }

  const ownerId = upd.rows[0].business_owner_id;

  const { rows } = await query(
    `SELECT o.*, b.slug FROM business_owners o
     LEFT JOIN businesses b ON o.business_id = b.id
     WHERE o.id = $1`,
    [ownerId],
  );

  const owner = rows[0];
  if (!owner) return { error: "invalid" };
  return { owner };
}
