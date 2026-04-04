import { query } from "../config/db.js";

/**
 * Append-only audit trail (login, signup, future admin/data actions).
 * Failures are logged but do not throw to callers — never block primary flows.
 */
export async function recordAuditEvent({
  action,
  actorType = "system",
  actorId = null,
  businessId = null,
  resourceType = null,
  resourceId = null,
  ip = null,
  userAgent = null,
  meta = null,
}) {
  try {
    await query(
      `INSERT INTO audit_logs (
         action, actor_type, actor_id, business_id,
         resource_type, resource_id, ip_address, user_agent, meta
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        action,
        actorType,
        actorId,
        businessId,
        resourceType,
        resourceId,
        ip || null,
        userAgent || null,
        meta ? JSON.stringify(meta) : null,
      ],
    );
  } catch (err) {
    console.error("[Audit] recordAuditEvent failed:", err.message);
  }
}

/**
 * Audit rows for this account: events where the owner is the actor, or tied to their business.
 */
export async function listAuditLogsForOwner({ businessId, ownerId, limit, offset }) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const off = Math.max(0, Number(offset) || 0);

  const [listRes, countRes] = await Promise.all([
    query(
      `SELECT id, created_at, action, actor_type, actor_id, business_id,
              resource_type, resource_id, ip_address, user_agent, meta
       FROM audit_logs
       WHERE actor_id = $1
          OR (business_id IS NOT NULL AND business_id = $2)
       ORDER BY created_at DESC
       LIMIT $3 OFFSET $4`,
      [ownerId, businessId, lim, off],
    ),
    query(
      `SELECT COUNT(*)::int AS n
       FROM audit_logs
       WHERE actor_id = $1
          OR (business_id IS NOT NULL AND business_id = $2)`,
      [ownerId, businessId],
    ),
  ]);

  return {
    logs: listRes.rows,
    total: countRes.rows[0]?.n ?? 0,
    limit: lim,
    offset: off,
  };
}
