import express from 'express';
import { query } from '../config/db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { limitStaff, limitServices, PLAN_LIMITS } from '../middleware/planLimits.js';
import {
  cancelAppointmentById,
  completeAppointmentById,
  createAppointmentManually,
  getAvailableSlots,
  getBusiness,
  getTodaysAppointments,
  getUpcomingAppointments,
  rescheduleAppointmentById,
} from '../services/appointment.service.js';
import { curateSlots } from '../utils/formatter.js';

const router = express.Router();
router.use(requireAuth);

// ─── Helper: slugify ──────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ─── POST /api/business/onboard ───────────────────────────────────────────────
// Step 1 of onboarding: create the business record and link to owner
router.post('/onboard', async (req, res) => {
  const { name, type, phone, timezone = 'Asia/Kolkata' } = req.body;

  if (!name || !type || !phone) {
    return res.status(400).json({ error: 'name, type, and phone are required' });
  }

  const validTypes = ['salon', 'doctor', 'dentist', 'tutor', 'other'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `type must be one of: ${validTypes.join(', ')}` });
  }

  try {
    const baseSlug = slugify(name);
    // Ensure slug uniqueness
    let slug = baseSlug;
    let attempt = 1;
    while (true) {
      const { rows } = await query('SELECT id FROM businesses WHERE slug = $1', [slug]);
      if (!rows.length) break;
      slug = `${baseSlug}-${++attempt}`;
    }

    const { rows: bizRows } = await query(
      `INSERT INTO businesses (name, type, phone, slug, timezone)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, type, phone, slug, timezone]
    );
    const business = bizRows[0];

    // Create subscription with 14‑day trial (treated as pro for limits)
    await query(
      `INSERT INTO subscriptions (business_id, plan, status, trial_ends_at)
       VALUES ($1, 'free', 'trialing', NOW() + INTERVAL '14 days')
       ON CONFLICT (business_id) DO NOTHING`,
      [business.id]
    );

    // Link owner to business and mark onboarded
    await query(
      `UPDATE business_owners SET business_id = $1, onboarded = TRUE WHERE id = $2`,
      [business.id, req.owner.ownerId]
    );

    // Issue a fresh token with the new businessId so subsequent API calls work
    const token = signToken({ ownerId: req.owner.ownerId, businessId: business.id, email: req.owner.email });

    res.status(201).json({ business, token });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'A business with this phone number already exists' });
    }
    console.error('[Business] Onboard error:', err);
    res.status(500).json({ error: 'Failed to create business' });
  }
});

// ─── GET /api/business ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT b.*, s.plan FROM businesses b
       LEFT JOIN subscriptions s ON b.id = s.business_id
       WHERE b.id = $1`,
      [req.owner.businessId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Business not found' });
    res.json({ business: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load business' });
  }
});

// ─── PUT /api/business ────────────────────────────────────────────────────────
router.put('/', async (req, res) => {
  const { name, phone, timezone } = req.body;
  try {
    const { rows } = await query(
      `UPDATE businesses SET
         name      = COALESCE($1, name),
         phone     = COALESCE($2, phone),
         timezone  = COALESCE($3, timezone)
       WHERE id = $4 RETURNING *`,
      [name, phone, timezone, req.owner.businessId]
    );
    res.json({ business: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update business' });
  }
});

// ─── GET /api/business/services ──────────────────────────────────────────────
router.get('/services', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM services WHERE business_id = $1 ORDER BY name`,
    [req.owner.businessId]
  );
  res.json({ services: rows });
});

// ─── POST /api/business/services ─────────────────────────────────────────────
router.post('/services', limitServices, async (req, res) => {
  const { name, duration_minutes = 30, price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!req.owner.businessId) return res.status(400).json({ error: 'No business linked to your account. Please complete onboarding step 1 first.' });
  try {
    const { rows } = await query(
      `INSERT INTO services (business_id, name, duration_minutes, price)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.owner.businessId, name, duration_minutes, price || null]
    );
    res.status(201).json({ service: rows[0] });
  } catch (err) {
    console.error('[Business] Add service error:', err.message);
    res.status(500).json({ error: 'Failed to save service' });
  }
});

// ─── PUT /api/business/services/:id ──────────────────────────────────────────
router.put('/services/:id', async (req, res) => {
  const { name, duration_minutes, price, active } = req.body;
  const { rows } = await query(
    `UPDATE services SET
       name             = COALESCE($1, name),
       duration_minutes = COALESCE($2, duration_minutes),
       price            = COALESCE($3, price),
       active           = COALESCE($4, active)
     WHERE id = $5 AND business_id = $6 RETURNING *`,
    [name, duration_minutes, price, active, req.params.id, req.owner.businessId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Service not found' });
  res.json({ service: rows[0] });
});

// ─── DELETE /api/business/services/:id ───────────────────────────────────────
router.delete('/services/:id', async (req, res) => {
  await query(
    `UPDATE services SET active = FALSE WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.owner.businessId]
  );
  res.json({ ok: true });
});

// ─── GET /api/business/staff ──────────────────────────────────────────────────
router.get('/staff', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM staff WHERE business_id = $1 ORDER BY name`,
    [req.owner.businessId]
  );
  res.json({ staff: rows });
});

// ─── POST /api/business/staff ─────────────────────────────────────────────────
// New staff get default availability Mon–Sat 9:00–18:00 so bookings work immediately.
router.post('/staff', limitStaff, async (req, res) => {
  const { name, role } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!req.owner.businessId) return res.status(400).json({ error: 'No business linked to your account.' });
  try {
    const { rows } = await query(
      `INSERT INTO staff (business_id, name, role) VALUES ($1, $2, $3) RETURNING *`,
      [req.owner.businessId, name, role || null]
    );
    const staff = rows[0];
    // Default availability: Mon (1)–Sat (6), 09:00–18:00
    for (let day = 1; day <= 6; day++) {
      await query(
        `INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
         VALUES ($1, $2, '09:00', '18:00')`,
        [staff.id, day]
      );
    }
    res.status(201).json({ staff });
  } catch (err) {
    console.error('[Business] Add staff error:', err.message);
    res.status(500).json({ error: 'Failed to save staff' });
  }
});

// ─── PUT /api/business/staff/:id ─────────────────────────────────────────────
router.put('/staff/:id', async (req, res) => {
  const { name, role, active } = req.body;
  const { rows } = await query(
    `UPDATE staff SET
       name   = COALESCE($1, name),
       role   = COALESCE($2, role),
       active = COALESCE($3, active)
     WHERE id = $4 AND business_id = $5 RETURNING *`,
    [name, role, active, req.params.id, req.owner.businessId]
  );
  if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
  res.json({ staff: rows[0] });
});

// ─── DELETE /api/business/staff/:id ──────────────────────────────────────────
router.delete('/staff/:id', async (req, res) => {
  await query(
    `UPDATE staff SET active = FALSE WHERE id = $1 AND business_id = $2`,
    [req.params.id, req.owner.businessId]
  );
  res.json({ ok: true });
});

// ─── GET /api/business/hours ──────────────────────────────────────────────────
router.get('/hours', async (req, res) => {
  const { rows } = await query(
    `SELECT a.* FROM availability a
     JOIN staff s ON a.staff_id = s.id
     WHERE s.business_id = $1
     ORDER BY s.name, a.day_of_week`,
    [req.owner.businessId]
  );
  res.json({ hours: rows });
});

// ─── POST /api/business/hours ─────────────────────────────────────────────────
// Replaces all availability for a staff member
router.post('/hours', async (req, res) => {
  const { staffId, hours } = req.body;
  // hours: [{ day_of_week, start_time, end_time }]
  if (!staffId || !Array.isArray(hours)) {
    return res.status(400).json({ error: 'staffId and hours[] are required' });
  }

  // Verify staff belongs to this business
  const { rows: staffRows } = await query(
    `SELECT id FROM staff WHERE id = $1 AND business_id = $2`,
    [staffId, req.owner.businessId]
  );
  if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });

  // Replace availability
  await query(`DELETE FROM availability WHERE staff_id = $1`, [staffId]);
  for (const h of hours) {
    await query(
      `INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)`,
      [staffId, h.day_of_week, h.start_time, h.end_time]
    );
  }
  res.json({ ok: true });
});

// ─── GET /api/business/appointments ──────────────────────────────────────────
// Query params: view=today|upcoming|all, status, staffId, search, from, to, page, limit
router.get('/appointments', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const {
      view   = 'today',   // today | upcoming | all | range
      status,             // confirmed | cancelled | completed
      staffId,
      search,             // customer name or phone
      from,               // YYYY-MM-DD
      to,                 // YYYY-MM-DD
      page  = 1,
      limit = 25,
    } = req.query;

    const business = await getBusiness(bId);
    const tz = business?.timezone || 'Asia/Kolkata';

    // Params: $1 = businessId, $2 = business timezone (used for "today" and "range" filtering)
    const params = [bId, tz];
    const conditions = ['a.business_id = $1'];

    // View presets
    if (view === 'today') {
      conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) = CURRENT_DATE`);
    } else if (view === 'upcoming') {
      conditions.push(`a.scheduled_at >= NOW()`);
    } else if (view === 'range' && from) {
      params.push(from);
      conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) >= $${params.length}`);
      if (to) {
        params.push(to);
        conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) <= $${params.length}`);
      }
    }
    // view === 'all' → no date filter

    // Status filter
    if (status && ['confirmed', 'cancelled', 'completed'].includes(status)) {
      params.push(status);
      conditions.push(`a.status = $${params.length}`);
    }

    // Staff filter
    if (staffId) {
      params.push(parseInt(staffId, 10));
      conditions.push(`a.staff_id = $${params.length}`);
    }

    // Search: customer name or phone
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(a.customer_phone) LIKE $${params.length} OR LOWER(COALESCE(c.name,'')) LIKE $${params.length})`);
    }

    const where = conditions.join(' AND ');
    const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);

    // Total count
    const countRes = await query(
      `SELECT COUNT(*) AS n
       FROM appointments a
       LEFT JOIN customers c ON a.customer_phone = c.phone AND c.business_id = a.business_id
       WHERE ${where}`,
      params
    );
    const total = parseInt(countRes.rows[0].n, 10);

    // Paginated rows
    params.push(parseInt(limit, 10));
    params.push(offset);
    const { rows } = await query(
      `SELECT a.*,
              s.name  AS service_name,
              st.name AS staff_name,
              c.name  AS customer_name
       FROM appointments a
       LEFT JOIN services  s  ON a.service_id  = s.id
       LEFT JOIN staff     st ON a.staff_id    = st.id
       LEFT JOIN customers c  ON a.customer_phone = c.phone AND c.business_id = a.business_id
       WHERE ${where}
       ORDER BY a.scheduled_at ${view === 'upcoming' ? 'ASC' : 'DESC'}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      appointments: rows,
      total,
      page: parseInt(page, 10),
      pages: Math.ceil(total / parseInt(limit, 10)),
    });
  } catch (err) {
    console.error('[Appointments] Error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// ─── POST /api/business/appointments/manual ─────────────────────────────
// Manual admin booking (e.g. customer calls in).
// Body: { staffId, serviceId, customerPhone, customerName?, date: 'YYYY-MM-DD', time: 'HH:MM', notes? }
router.post('/appointments/manual', async (req, res) => {
  const {
    staffId,
    serviceId,
    customerPhone,
    customerName,
    date,
    time,
    notes,
  } = req.body || {};

  const apptStaffId = parseInt(staffId, 10);
  const apptServiceId = parseInt(serviceId, 10);

  if (!apptStaffId || Number.isNaN(apptStaffId)) return res.status(400).json({ error: 'Invalid staffId' });
  if (!apptServiceId || Number.isNaN(apptServiceId)) return res.status(400).json({ error: 'Invalid serviceId' });
  if (!customerPhone || !date || !time) {
    return res.status(400).json({ error: 'customerPhone, date, and time are required' });
  }

  try {
    const result = await createAppointmentManually({
      businessId: req.owner.businessId,
      staffId: apptStaffId,
      serviceId: apptServiceId,
      customerPhone,
      customerName: customerName || null,
      date,
      time,
      notes: notes || null,
    });

    if (result?.error) {
      return res.status(400).json({ error: result.error });
    }

    return res.status(201).json({ appointment: result });
  } catch (err) {
    if (err?.message === 'SLOT_TAKEN') {
      return res.status(409).json({ error: 'That slot is not available', slots: err.slots || [] });
    }
    return res.status(err?.statusCode || 500).json({ error: err?.message || 'Failed to create appointment' });
  }
});

// ─── GET /api/business/appointments/:id/slots ─────────────────────────────
// Used for admin reschedule slot suggestions.
router.get('/appointments/:id/slots', async (req, res) => {
  const apptId = parseInt(req.params.id, 10);
  const { date } = req.query; // YYYY-MM-DD

  if (Number.isNaN(apptId)) return res.status(400).json({ error: 'Invalid appointment id' });
  if (!date) return res.status(400).json({ error: 'date is required' });

  try {
    const { rows: apptRows } = await query(
      `SELECT staff_id, duration_minutes, status
       FROM appointments
       WHERE id = $1 AND business_id = $2`,
      [apptId, req.owner.businessId],
    );

    if (!apptRows.length) return res.status(404).json({ error: 'Appointment not found' });

    const appt = apptRows[0];
    if (appt.status !== 'confirmed') {
      return res.status(409).json({ error: `Cannot reschedule a ${appt.status} appointment` });
    }

    const business = await getBusiness(req.owner.businessId);
    const tz = business?.timezone || 'Asia/Kolkata';

    const durationMinutes = appt.duration_minutes || 30;
    const slots = await getAvailableSlots(req.owner.businessId, date, appt.staff_id, durationMinutes, tz);
    return res.json({ slots, curatedSlots: curateSlots(slots, 6), timezone: tz });
  } catch (err) {
    console.error('[Appointment Slots] Error:', err);
    res.status(500).json({ error: 'Failed to load available slots' });
  }
});

// ─── POST /api/business/appointments/:id/cancel ──────────────────────────
router.post('/appointments/:id/cancel', async (req, res) => {
  const apptId = parseInt(req.params.id, 10);
  if (Number.isNaN(apptId)) return res.status(400).json({ error: 'Invalid appointment id' });

  try {
    const appointment = await cancelAppointmentById(apptId, req.owner.businessId);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found or cannot be cancelled' });
    }
    return res.json({ appointment });
  } catch (err) {
    console.error('[Appointment Cancel] Error:', err);
    return res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// ─── POST /api/business/appointments/:id/complete ────────────────────────
router.post('/appointments/:id/complete', async (req, res) => {
  const apptId = parseInt(req.params.id, 10);
  if (Number.isNaN(apptId)) return res.status(400).json({ error: 'Invalid appointment id' });

  try {
    const appointment = await completeAppointmentById(apptId, req.owner.businessId);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found or cannot be completed' });
    }
    return res.json({ appointment });
  } catch (err) {
    console.error('[Appointment Complete] Error:', err);
    return res.status(500).json({ error: 'Failed to mark appointment completed' });
  }
});

// ─── POST /api/business/appointments/:id/reschedule ─────────────────────
// Body: { date: "YYYY-MM-DD", time: "HH:MM" }
router.post('/appointments/:id/reschedule', async (req, res) => {
  const apptId = parseInt(req.params.id, 10);
  const { date, time } = req.body || {};

  if (Number.isNaN(apptId)) return res.status(400).json({ error: 'Invalid appointment id' });
  if (!date || !time) return res.status(400).json({ error: 'date and time are required' });

  try {
    const appointment = await rescheduleAppointmentById(apptId, req.owner.businessId, date, time);
    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found or cannot be rescheduled' });
    }
    return res.json({ appointment });
  } catch (err) {
    if (err?.message === 'SLOT_TAKEN') {
      return res.status(409).json({ error: 'That slot is not available', slots: err.slots || [] });
    }
    console.error('[Appointment Reschedule] Error:', err);
    return res.status(500).json({ error: 'Failed to reschedule appointment' });
  }
});

// ─── GET /api/business/stats ──────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const [todayRes, monthRes, totalRes, subRes] = await Promise.all([
      query(`SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND DATE(scheduled_at AT TIME ZONE 'Asia/Kolkata') = CURRENT_DATE AND status = 'confirmed'`, [bId]),
      query(`SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND DATE_TRUNC('month', scheduled_at) = DATE_TRUNC('month', NOW()) AND status != 'cancelled'`, [bId]),
      query(`SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND status != 'cancelled'`, [bId]),
      query(`SELECT plan FROM subscriptions WHERE business_id = $1`, [bId]),
    ]);
    const plan = subRes.rows[0]?.plan || 'free';
    res.json({
      today:    parseInt(todayRes.rows[0].n, 10),
      thisMonth: parseInt(monthRes.rows[0].n, 10),
      total:    parseInt(totalRes.rows[0].n, 10),
      plan,
      limits:   PLAN_LIMITS[plan],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── GET /api/business/plan ───────────────────────────────────────────────────
router.get('/plan', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM subscriptions WHERE business_id = $1`,
    [req.owner.businessId]
  );
  const plan = rows[0]?.plan || 'free';
  res.json({ plan, limits: PLAN_LIMITS[plan], allPlans: PLAN_LIMITS });
});

// ─── PUT /api/business/plan ───────────────────────────────────────────────────
router.put('/plan', async (req, res) => {
  const { plan } = req.body;
  if (!['free', 'pro', 'business'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan' });
  }
  await query(
    `INSERT INTO subscriptions (business_id, plan) VALUES ($1, $2)
     ON CONFLICT (business_id) DO UPDATE SET plan = $2, started_at = NOW()`,
    [req.owner.businessId, plan]
  );
  res.json({ plan, limits: PLAN_LIMITS[plan] });
});

// ─── GET /api/business/whatsapp ────────────────────────────────────────────────
router.get('/whatsapp', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         whatsapp_phone_number_id,
         whatsapp_display_phone,
         whatsapp_api_version,
         whatsapp_status,
         (whatsapp_access_token IS NOT NULL) AS has_access_token
       FROM businesses
       WHERE id = $1`,
      [req.owner.businessId]
    );

    const row = rows[0] || {};

    return res.json({
      whatsapp: {
        phoneNumberId: row.whatsapp_phone_number_id || null,
        displayPhone: row.whatsapp_display_phone || null,
        apiVersion: row.whatsapp_api_version || 'v21.0',
        status: row.whatsapp_status || 'unverified',
        hasAccessToken: !!row.has_access_token,
      },
    });
  } catch (err) {
    console.error('[Business] Load WhatsApp config error:', err.message);
    return res.status(500).json({ error: 'Failed to load WhatsApp settings' });
  }
});

// ─── PUT /api/business/whatsapp ────────────────────────────────────────────────
router.put('/whatsapp', async (req, res) => {
  const {
    displayPhone,
    phoneNumberId,
    accessToken,
    apiVersion,
    status,
  } = req.body;

  const fields = [];
  const values = [];
  let idx = 1;

  if (typeof displayPhone === 'string' && displayPhone.trim()) {
    const trimmed = displayPhone.trim();
    fields.push(`whatsapp_display_phone = $${idx}`);
    values.push(trimmed);
    idx += 1;

    // Keep routing simple: also normalise into the main business phone column
    const normalized = trimmed.replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();
    fields.push(`phone = $${idx}`);
    values.push(normalized);
    idx += 1;
  }

  if (typeof phoneNumberId === 'string' && phoneNumberId.trim()) {
    fields.push(`whatsapp_phone_number_id = $${idx}`);
    values.push(phoneNumberId.trim());
    idx += 1;
  }

  if (typeof accessToken === 'string' && accessToken.trim()) {
    fields.push(`whatsapp_access_token = $${idx}`);
    values.push(accessToken.trim());
    idx += 1;
  }

  if (typeof apiVersion === 'string' && apiVersion.trim()) {
    fields.push(`whatsapp_api_version = $${idx}`);
    values.push(apiVersion.trim());
    idx += 1;
  }

  if (typeof status === 'string' && status.trim()) {
    fields.push(`whatsapp_status = $${idx}`);
    values.push(status.trim());
    idx += 1;
  }

  if (!fields.length) {
    return res.status(400).json({ error: 'No WhatsApp fields to update' });
  }

  values.push(req.owner.businessId);

  try {
    const { rows } = await query(
      `UPDATE businesses
       SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING
         whatsapp_phone_number_id,
         whatsapp_display_phone,
         whatsapp_api_version,
         whatsapp_status,
         (whatsapp_access_token IS NOT NULL) AS has_access_token`,
      values
    );

    const row = rows[0] || {};

    return res.json({
      whatsapp: {
        phoneNumberId: row.whatsapp_phone_number_id || null,
        displayPhone: row.whatsapp_display_phone || null,
        apiVersion: row.whatsapp_api_version || 'v21.0',
        status: row.whatsapp_status || 'unverified',
        hasAccessToken: !!row.has_access_token,
      },
    });
  } catch (err) {
    console.error('[Business] Update WhatsApp config error:', err.message);
    return res.status(500).json({ error: 'Failed to save WhatsApp settings' });
  }
});

export default router;
