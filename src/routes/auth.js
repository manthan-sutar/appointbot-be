import express from 'express';
import bcrypt from 'bcrypt';
import { query } from '../config/db.js';
import { signToken, requireAuth } from '../middleware/auth.js';

const router = express.Router();
const SALT_ROUNDS = 12;

// ─── POST /api/auth/signup ────────────────────────────────────────────────────
router.post('/signup', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

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
    res.status(201).json({ token, owner: { id: owner.id, email: owner.email, onboarded: owner.onboarded } });
  } catch (err) {
    console.error('[Auth] Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

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
