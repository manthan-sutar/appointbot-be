import express from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcrypt';
import { query } from '../config/db.js';
import { signToken, requireAuth } from '../middleware/auth.js';
import { recordAuditEvent } from '../services/audit.service.js';
import {
  loginBodySchema,
  signupBodySchema,
  magicLoginBodySchema,
  formatZodError,
} from '../validation/schemas.js';
import { consumeMagicLoginToken } from '../services/magicLink.service.js';

const router = express.Router();
const SALT_ROUNDS = 12;

const magicLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many magic-link attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many signup attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
// Self-service signup is off unless ALLOW_PUBLIC_SIGNUP=true (e.g. local dev only).
router.post('/signup', signupLimiter, async (req, res) => {
  if (process.env.ALLOW_PUBLIC_SIGNUP !== 'true') {
    return res.status(403).json({
      error:
        'Self-service signup is disabled. Please request a demo from the website, or contact us if you were invited.',
    });
  }

  const parsed = signupBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const { email, password } = parsed.data;

  try {
    const existing = await query('SELECT id FROM business_owners WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await query(
      `INSERT INTO business_owners (email, password_hash) VALUES ($1, $2) RETURNING id, email, onboarded`,
      [email.toLowerCase(), passwordHash]
    );
    const owner = rows[0];

    const token = signToken({ ownerId: owner.id, businessId: null, email: owner.email });
    await recordAuditEvent({
      action: 'auth.signup',
      actorType: 'owner',
      actorId: owner.id,
      businessId: null,
      resourceType: 'business_owner',
      resourceId: String(owner.id),
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    res.status(201).json({ token, owner: { id: owner.id, email: owner.email, onboarded: owner.onboarded } });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const parsed = loginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const { email, password } = parsed.data;

  try {
    const { rows } = await query(
      `SELECT o.*, b.slug FROM business_owners o
       LEFT JOIN businesses b ON o.business_id = b.id
       WHERE o.email = $1`,
      [email.toLowerCase()]
    );
    const owner = rows[0];

    if (!owner) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, owner.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = signToken({ ownerId: owner.id, businessId: owner.business_id, email: owner.email });
    await recordAuditEvent({
      action: 'auth.login',
      actorType: 'owner',
      actorId: owner.id,
      businessId: owner.business_id || null,
      resourceType: 'business_owner',
      resourceId: String(owner.id),
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    res.json({
      token,
      owner: {
        id:         owner.id,
        email:      owner.email,
        businessId: owner.business_id,
        onboarded:  owner.onboarded,
        slug:       owner.slug,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─── POST /api/auth/magic-login (one-time demo link; no password) ─────────────
router.post('/magic-login', magicLoginLimiter, async (req, res) => {
  const parsed = magicLoginBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }

  try {
    const result = await consumeMagicLoginToken(parsed.data.token);
    if (result.error) {
      const msg = {
        invalid: 'This sign-in link is invalid.',
        used: 'This link was already used. Request a new demo confirmation email.',
        expired: 'This link has expired. Submit the demo form again for a new link.',
      };
      return res.status(401).json({
        error: msg[result.error] || 'Invalid or expired link',
        code: result.error,
      });
    }

    const { owner } = result;

    const token = signToken({
      ownerId: owner.id,
      businessId: owner.business_id,
      email: owner.email,
    });
    await recordAuditEvent({
      action: 'auth.magic_login',
      actorType: 'owner',
      actorId: owner.id,
      businessId: owner.business_id || null,
      resourceType: 'business_owner',
      resourceId: String(owner.id),
      ip: req.ip,
      userAgent: req.get('user-agent') || null,
    });
    return res.json({
      token,
      owner: {
        id: owner.id,
        email: owner.email,
        businessId: owner.business_id,
        onboarded: owner.onboarded,
        slug: owner.slug,
      },
    });
  } catch (err) {
    console.error('[Auth] magic-login error:', err);
    return res.status(500).json({ error: 'Could not sign you in. Try again later.' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT o.id, o.email, o.business_id, o.onboarded, b.slug, b.name AS business_name
       FROM business_owners o
       LEFT JOIN businesses b ON o.business_id = b.id
       WHERE o.id = $1`,
      [req.owner.ownerId]
    );
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'Owner not found' });
    res.json({
      owner: {
        id:           row.id,
        email:        row.email,
        businessId:   row.business_id,
        onboarded:    row.onboarded,
        slug:         row.slug,
        businessName: row.business_name,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

export default router;
