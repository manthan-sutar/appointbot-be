import express from "express";
import { query } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";
import { recordAuditEvent } from "../services/audit.service.js";
import { demoRequestSchema, formatZodError } from "../validation/schemas.js";

const router = express.Router();

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

    await query(
      `INSERT INTO demo_requests (business_name, email, phone, business_type, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [business_name, email, phone, business_type, message],
    );

    await recordAuditEvent({
      action: "demo.request",
      actorType: "anonymous",
      resourceType: "demo_request",
      ip: req.ip,
      userAgent: req.get("user-agent") || null,
      meta: { business_type },
    });

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

export default router;
