import express from "express";
import { query } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { recordAuditEvent } from "../services/audit.service.js";
import {
  demoRequestSchema,
  demoRequestUpdateSchema,
  formatZodError,
} from "../validation/schemas.js";
import { sendDemoRequestEmails } from "../services/email.service.js";

const router = express.Router();

/** Demo requests do not mint magic-login tokens (no auto sandbox access). Magic link code stays in
 *  `magicLink.service.js` + `POST /api/auth/magic-login` for other flows or future use. */

// ─── POST /api/demo/request (public) ───────────────────────────────────────────
router.post("/request", async (req, res) => {
  const parsed = demoRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const { business_name, email, phone, business_type, message } = parsed.data;

  try {
    const dup = await query(
      `SELECT id FROM demo_requests WHERE lower(btrim(email)) = $1 LIMIT 1`,
      [email],
    );
    if (dup.rows.length) {
      return res.status(409).json({
        error:
          "We already have a demo request from this email. We'll be in touch soon.",
      });
    }

    const { rows: inserted } = await query(
      `INSERT INTO demo_requests (business_name, email, phone, business_type, message)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [business_name, email, phone, business_type, message],
    );
    const demoRequestId = inserted[0]?.id;

    await recordAuditEvent({
      action: "demo.request",
      actorType: "anonymous",
      resourceType: "demo_request",
      resourceId: demoRequestId != null ? String(demoRequestId) : null,
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
      meta: { business_type, demo_request_id: demoRequestId },
    });

    void sendDemoRequestEmails({
      businessName: business_name,
      email,
      phone,
      businessType: business_type,
      message,
    }).catch((e) =>
      console.error("[Demo] sendDemoRequestEmails:", e?.message || e),
    );

    return res.status(201).json({
      success: true,
      message: "Demo request received",
    });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({
        error:
          "We already have a demo request from this email. We'll be in touch soon.",
      });
    }
    console.error("[Demo] POST /request error:", err);
    return res.status(500).json({ error: "Could not save your request. Try again later." });
  }
});

// ─── GET /api/demo/requests (authenticated owners) ─────────────────────────
router.get("/requests", requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT id, business_name, email, phone, business_type, message, status,
              assigned_to, internal_notes, next_followup_at, last_contacted_at,
              created_at, updated_at
       FROM demo_requests
       ORDER BY created_at DESC`,
    );
    return res.json({ requests: rows });
  } catch (err) {
    console.error("[Demo] GET /requests error:", err);
    return res.status(500).json({ error: "Could not load demo requests" });
  }
});

// ─── PUT /api/demo/requests/:id (manual demo pipeline updates) ───────────────
router.put("/requests/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid demo request id" });
  }

  const parsed = demoRequestUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }

  const payload = parsed.data;
  const setClauses = [];
  const vals = [];
  let i = 1;

  if (Object.prototype.hasOwnProperty.call(payload, "status")) {
    setClauses.push(`status = $${i++}`);
    vals.push(payload.status);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "assigned_to")) {
    setClauses.push(`assigned_to = $${i++}`);
    vals.push(payload.assigned_to || null);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "internal_notes")) {
    setClauses.push(`internal_notes = $${i++}`);
    vals.push(payload.internal_notes || null);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "next_followup_at")) {
    setClauses.push(`next_followup_at = $${i++}`);
    vals.push(payload.next_followup_at || null);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "last_contacted_at")) {
    setClauses.push(`last_contacted_at = $${i++}`);
    vals.push(payload.last_contacted_at || null);
  }

  if (!setClauses.length) {
    return res.status(400).json({ error: "No update fields provided" });
  }

  setClauses.push(`updated_at = NOW()`);
  vals.push(id);

  try {
    const { rows } = await query(
      `UPDATE demo_requests
       SET ${setClauses.join(", ")}
       WHERE id = $${i}
       RETURNING id, business_name, email, phone, business_type, message, status,
                 assigned_to, internal_notes, next_followup_at, last_contacted_at,
                 created_at, updated_at`,
      vals,
    );

    if (!rows.length) {
      return res.status(404).json({ error: "Demo request not found" });
    }

    return res.json({ request: rows[0] });
  } catch (err) {
    console.error("[Demo] PUT /requests/:id error:", err);
    return res.status(500).json({ error: "Could not update demo request" });
  }
});

export default router;
