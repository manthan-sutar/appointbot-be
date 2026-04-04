import express from "express";
import { query } from "../config/db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

const ALLOWED_BUSINESS_TYPES = new Set([
  "salon",
  "doctor",
  "dentist",
  "tutor",
  "other",
]);

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// ─── POST /api/demo/request (public) ───────────────────────────────────────────
router.post("/request", async (req, res) => {
  const business_name = String(req.body.business_name || "").trim();
  const emailRaw = String(req.body.email || "").trim();
  const phone = String(req.body.phone || "").trim();
  const business_type = String(req.body.business_type || "").trim().toLowerCase();
  const message =
    req.body.message != null ? String(req.body.message).trim() || null : null;

  if (!business_name) {
    return res.status(400).json({ error: "Business name is required" });
  }
  if (!emailRaw) {
    return res.status(400).json({ error: "Email is required" });
  }
  const email = normalizeEmail(emailRaw);
  if (!EMAIL_RE.test(email) || email.length > 255) {
    return res.status(400).json({ error: "Please enter a valid email address" });
  }
  if (!phone) {
    return res.status(400).json({ error: "Phone number is required" });
  }
  if (phone.length > 30) {
    return res.status(400).json({ error: "Phone number is too long" });
  }
  if (!business_type || !ALLOWED_BUSINESS_TYPES.has(business_type)) {
    return res.status(400).json({ error: "Please select a valid business type" });
  }

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
