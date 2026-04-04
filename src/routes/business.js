import express from 'express';
import { getPublicBackendUrlForWidget } from '../utils/publicBackendUrl.js';
import { query } from '../config/db.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import {
  limitStaff,
  limitServices,
  PLAN_LIMITS,
  effectivePlanFromSubscriptionRow,
  getStaffLimitInfo,
  getServicesLimitInfo,
} from '../middleware/planLimits.js';
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
import {
  createCampaign,
  getCampaignFailures,
  listCampaigns,
  retryFailedRecipients,
  sendCampaignNow,
} from '../services/campaign.service.js';
import { listCampaignOptOutPreferences, setCampaignOptOut } from '../services/messaging-preference.service.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from '../services/campaign-template.service.js';
import { curateSlots } from '../utils/formatter.js';
import { generateApiKey } from '../utils/apiKey.js';
import { listAuditLogsForOwner } from '../services/audit.service.js';

const router = express.Router();
router.use(requireAuth);

// ─── Helper: slugify ──────────────────────────────────────────────────────────
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\s+/g, '')
    .trim();
}

/** Booking counts for a business using its IANA timezone (not server-local dates). */
async function fetchStatsForBusiness(bId, tz) {
  const [todayRes, monthRes, totalRes, subRes] = await Promise.all([
    query(
      `SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND DATE(scheduled_at AT TIME ZONE $2) = DATE(NOW() AT TIME ZONE $2) AND status != 'cancelled'`,
      [bId, tz],
    ),
    query(
      `SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND to_char(scheduled_at AT TIME ZONE $2, 'YYYY-MM') = to_char(NOW() AT TIME ZONE $2, 'YYYY-MM') AND status != 'cancelled'`,
      [bId, tz],
    ),
    query(`SELECT COUNT(*) AS n FROM appointments WHERE business_id = $1 AND status != 'cancelled'`, [bId]),
    query(`SELECT plan FROM subscriptions WHERE business_id = $1`, [bId]),
  ]);
  const plan = subRes.rows[0]?.plan || 'free';
  return {
    today: parseInt(todayRes.rows[0].n, 10),
    thisMonth: parseInt(monthRes.rows[0].n, 10),
    total: parseInt(totalRes.rows[0].n, 10),
    plan,
    limits: PLAN_LIMITS[plan],
  };
}

/** Dashboard insights from booking + event history. */
async function fetchDashboardInsights(bId, tz, leadWindowDays = 30) {
  const safeLeadWindowDays = [7, 30, 90].includes(Number(leadWindowDays)) ? Number(leadWindowDays) : 30;
  const [kpiRes, bookingsPerDayRes, noShowTrendRes, riskCustomersRes, leadMetricsRes, leadSourceRes, funnelTimelineRes, campaignPerfRes, utmPerfRes, campaignSummaryRes] = await Promise.all([
    query(
      `WITH base AS (
         SELECT
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '30 days'
               AND a.status IN ('confirmed', 'completed', 'cancelled', 'no_show')
           ) AS total_30d,
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '30 days'
               AND a.status = 'completed'
           ) AS completed_30d,
           COALESCE(SUM(CASE
             WHEN a.scheduled_at >= NOW() - INTERVAL '30 days' AND a.status = 'completed'
             THEN COALESCE(s.price, 0)
             ELSE 0
           END), 0) AS revenue_30d
         FROM appointments a
         LEFT JOIN services s ON a.service_id = s.id
         WHERE a.business_id = $1
       ),
       repeaters AS (
         SELECT COUNT(*) AS repeat_customers_90d
         FROM (
           SELECT a.customer_phone
           FROM appointments a
           WHERE a.business_id = $1
             AND a.scheduled_at >= NOW() - INTERVAL '90 days'
             AND a.status = 'completed'
           GROUP BY a.customer_phone
           HAVING COUNT(*) >= 2
         ) t
       ),
       customer_base AS (
         SELECT COUNT(DISTINCT a.customer_phone) AS customers_90d
         FROM appointments a
         WHERE a.business_id = $1
           AND a.scheduled_at >= NOW() - INTERVAL '90 days'
           AND a.status = 'completed'
       ),
       no_show AS (
         SELECT COUNT(*) AS auto_cancel_30d
         FROM appointment_events e
         WHERE e.business_id = $1
           AND e.event_type = 'appointment_auto_cancelled'
           AND e.created_at >= NOW() - INTERVAL '30 days'
       )
       SELECT
         b.total_30d,
         b.completed_30d,
         b.revenue_30d,
         n.auto_cancel_30d,
         r.repeat_customers_90d,
         c.customers_90d
       FROM base b, no_show n, repeaters r, customer_base c`,
      [bId],
    ),
    query(
      `SELECT
         DATE(a.scheduled_at AT TIME ZONE $2) AS day,
         COUNT(*)::int AS bookings
       FROM appointments a
       WHERE a.business_id = $1
         AND a.scheduled_at >= NOW() - INTERVAL '7 days'
         AND a.status != 'cancelled'
       GROUP BY DATE(a.scheduled_at AT TIME ZONE $2)
       ORDER BY day ASC`,
      [bId, tz],
    ),
    query(
      `SELECT
         DATE(e.created_at AT TIME ZONE $2) AS day,
         COUNT(*)::int AS auto_cancellations
       FROM appointment_events e
       WHERE e.business_id = $1
         AND e.event_type = 'appointment_auto_cancelled'
         AND e.created_at >= NOW() - INTERVAL '14 days'
       GROUP BY DATE(e.created_at AT TIME ZONE $2)
       ORDER BY day ASC`,
      [bId, tz],
    ),
    query(
      `WITH customer_stats AS (
         SELECT
           a.customer_phone,
           COALESCE(MAX(c.name), '') AS customer_name,
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
               AND a.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
           ) AS total_120d,
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
               AND (
                 a.status = 'no_show'
                 OR (a.status = 'cancelled' AND a.cancel_reason = 'auto_cancel_unconfirmed')
               )
           ) AS no_show_120d
         FROM appointments a
         LEFT JOIN customers c
           ON c.phone = a.customer_phone
          AND c.business_id = a.business_id
         WHERE a.business_id = $1
         GROUP BY a.customer_phone
       )
       SELECT
         customer_phone,
         customer_name,
         total_120d,
         no_show_120d,
         CASE
           WHEN total_120d = 0 THEN 0
           ELSE ROUND((no_show_120d::numeric / total_120d::numeric) * 100, 2)
         END AS no_show_rate_pct
       FROM customer_stats
       WHERE total_120d >= 2
       ORDER BY no_show_120d DESC, no_show_rate_pct DESC, total_120d DESC
       LIMIT 5`,
      [bId],
    ),
    query(
      `WITH lead_base AS (
         SELECT
           COUNT(*) FILTER (WHERE l.first_seen_at >= NOW() - make_interval(days => $2::int))::int AS leads_30d,
           COUNT(*) FILTER (
             WHERE l.first_seen_at >= NOW() - make_interval(days => $2::int)
               AND l.status = 'converted'
           )::int AS converted_30d
         FROM leads l
         WHERE l.business_id = $1
       ),
       dropped AS (
         SELECT
           COUNT(*)::int AS dropped_30d
         FROM lead_events e
         WHERE e.business_id = $1
           AND e.event_type = 'lead_dropped_auto'
           AND e.created_at >= NOW() - make_interval(days => $2::int)
       )
       SELECT
         lb.leads_30d,
         lb.converted_30d,
         d.dropped_30d
       FROM lead_base lb, dropped d`,
      [bId, safeLeadWindowDays],
    ),
    query(
      `SELECT
         CASE
           WHEN COALESCE(NULLIF(l.source, ''), 'unknown') IN ('chat_page', 'web_chat_page') THEN 'web_chat_page'
           WHEN COALESCE(NULLIF(l.source, ''), 'unknown') IN ('website_chat_widget', 'web_chat_widget') THEN 'web_chat_widget'
           ELSE COALESCE(NULLIF(l.source, ''), 'unknown')
         END AS source,
         COUNT(*)::int AS leads
       FROM leads l
       WHERE l.business_id = $1
        AND l.first_seen_at >= NOW() - make_interval(days => $2::int)
       GROUP BY 1
       ORDER BY leads DESC`,
      [bId, safeLeadWindowDays],
    ),
    query(
      `WITH days AS (
         SELECT generate_series(
           DATE((NOW() - INTERVAL '13 days') AT TIME ZONE $2),
           DATE(NOW() AT TIME ZONE $2),
           INTERVAL '1 day'
         )::date AS day
       ),
       created AS (
         SELECT DATE(l.first_seen_at AT TIME ZONE $2) AS day, COUNT(*)::int AS n
         FROM leads l
         WHERE l.business_id = $1
           AND l.first_seen_at >= NOW() - INTERVAL '14 days'
         GROUP BY DATE(l.first_seen_at AT TIME ZONE $2)
       ),
       converted AS (
         SELECT DATE(l.converted_at AT TIME ZONE $2) AS day, COUNT(*)::int AS n
         FROM leads l
         WHERE l.business_id = $1
           AND l.converted_at IS NOT NULL
           AND l.converted_at >= NOW() - INTERVAL '14 days'
         GROUP BY DATE(l.converted_at AT TIME ZONE $2)
       ),
       dropped AS (
         SELECT DATE(e.created_at AT TIME ZONE $2) AS day, COUNT(*)::int AS n
         FROM lead_events e
         WHERE e.business_id = $1
           AND e.event_type = 'lead_dropped_auto'
           AND e.created_at >= NOW() - INTERVAL '14 days'
         GROUP BY DATE(e.created_at AT TIME ZONE $2)
       )
       SELECT
         d.day,
         COALESCE(c.n, 0) AS leads_created,
         COALESCE(cv.n, 0) AS leads_converted,
         COALESCE(dr.n, 0) AS leads_dropped
       FROM days d
       LEFT JOIN created c ON c.day = d.day
       LEFT JOIN converted cv ON cv.day = d.day
       LEFT JOIN dropped dr ON dr.day = d.day
       ORDER BY d.day ASC`,
      [bId, tz],
    ),
    query(
      `WITH lead_attr AS (
         SELECT DISTINCT ON (e.lead_id)
           e.lead_id,
           COALESCE(NULLIF(e.event_data->>'campaign', ''), 'unknown') AS campaign
         FROM lead_events e
         WHERE e.business_id = $1
           AND e.event_type = 'lead_message_received'
         ORDER BY e.lead_id, e.created_at DESC
       ),
       lead_base AS (
         SELECT
           l.id,
           COALESCE(la.campaign, 'unknown') AS campaign,
           l.first_seen_at,
           l.converted_at
         FROM leads l
         LEFT JOIN lead_attr la ON la.lead_id = l.id
         WHERE l.business_id = $1
       ),
       dropped AS (
         SELECT
           COALESCE(la.campaign, 'unknown') AS campaign,
           COUNT(*)::int AS dropped
         FROM lead_events e
         LEFT JOIN lead_attr la ON la.lead_id = e.lead_id
         WHERE e.business_id = $1
           AND e.event_type = 'lead_dropped_auto'
           AND e.created_at >= NOW() - make_interval(days => $2::int)
         GROUP BY COALESCE(la.campaign, 'unknown')
       )
       SELECT
         lb.campaign,
         COUNT(*) FILTER (WHERE lb.first_seen_at >= NOW() - make_interval(days => $2::int))::int AS leads,
         COUNT(*) FILTER (WHERE lb.converted_at >= NOW() - make_interval(days => $2::int))::int AS converted,
         COALESCE(d.dropped, 0)::int AS dropped
       FROM lead_base lb
       LEFT JOIN dropped d ON d.campaign = lb.campaign
       GROUP BY lb.campaign, d.dropped
       HAVING COUNT(*) FILTER (WHERE lb.first_seen_at >= NOW() - make_interval(days => $2::int)) > 0
       ORDER BY leads DESC, converted DESC`,
      [bId, safeLeadWindowDays],
    ),
    query(
      `WITH lead_attr AS (
         SELECT DISTINCT ON (e.lead_id)
           e.lead_id,
           COALESCE(NULLIF(e.event_data->>'utmSource', ''), 'unknown') AS utm_source
         FROM lead_events e
         WHERE e.business_id = $1
           AND e.event_type = 'lead_message_received'
         ORDER BY e.lead_id, e.created_at DESC
       ),
       lead_base AS (
         SELECT
           l.id,
           COALESCE(la.utm_source, 'unknown') AS utm_source,
           l.first_seen_at,
           l.converted_at
         FROM leads l
         LEFT JOIN lead_attr la ON la.lead_id = l.id
         WHERE l.business_id = $1
       ),
       dropped AS (
         SELECT
           COALESCE(la.utm_source, 'unknown') AS utm_source,
           COUNT(*)::int AS dropped
         FROM lead_events e
         LEFT JOIN lead_attr la ON la.lead_id = e.lead_id
         WHERE e.business_id = $1
           AND e.event_type = 'lead_dropped_auto'
           AND e.created_at >= NOW() - make_interval(days => $2::int)
         GROUP BY COALESCE(la.utm_source, 'unknown')
       )
       SELECT
         lb.utm_source,
         COUNT(*) FILTER (WHERE lb.first_seen_at >= NOW() - make_interval(days => $2::int))::int AS leads,
         COUNT(*) FILTER (WHERE lb.converted_at >= NOW() - make_interval(days => $2::int))::int AS converted,
         COALESCE(d.dropped, 0)::int AS dropped
       FROM lead_base lb
       LEFT JOIN dropped d ON d.utm_source = lb.utm_source
       GROUP BY lb.utm_source, d.dropped
       HAVING COUNT(*) FILTER (WHERE lb.first_seen_at >= NOW() - make_interval(days => $2::int)) > 0
       ORDER BY leads DESC, converted DESC`,
      [bId, safeLeadWindowDays],
    ),
    query(
      `SELECT
         COUNT(*)::int AS campaigns_30d,
         COALESCE(SUM(total_recipients), 0)::int AS recipients_30d,
         COALESCE(SUM(sent_count), 0)::int AS sent_30d,
         COALESCE(SUM(failed_count), 0)::int AS failed_30d
       FROM campaigns
       WHERE business_id = $1
         AND created_at >= NOW() - INTERVAL '30 days'`,
      [bId],
    ),
  ]);

  const row = kpiRes.rows[0] || {};
  const total30 = Number(row.total_30d || 0);
  const autoCancel30 = Number(row.auto_cancel_30d || 0);
  const customers90 = Number(row.customers_90d || 0);
  const repeaters90 = Number(row.repeat_customers_90d || 0);
  const leadRow = leadMetricsRes.rows[0] || {};
  const campaignSummaryRow = campaignSummaryRes.rows[0] || {};
  const leads = Number(leadRow.leads_30d || 0);
  const convertedLeads = Number(leadRow.converted_30d || 0);
  const droppedLeads = Number(leadRow.dropped_30d || 0);
  const leadConversionRate = leads > 0 ? Number(((convertedLeads / leads) * 100).toFixed(2)) : 0;
  const campaignSent = Number(campaignSummaryRow.sent_30d || 0);
  const campaignFailed = Number(campaignSummaryRow.failed_30d || 0);
  const campaignDeliveryRate = campaignSent + campaignFailed > 0
    ? Number(((campaignSent / (campaignSent + campaignFailed)) * 100).toFixed(2))
    : 0;
  const campaignPerformance = campaignPerfRes.rows.map((r) => {
    const leads = Number(r.leads || 0);
    const converted = Number(r.converted || 0);
    return {
      campaign: r.campaign,
      leads,
      converted,
      dropped: Number(r.dropped || 0),
      conversionRate: leads > 0 ? Number(((converted / leads) * 100).toFixed(2)) : 0,
    };
  });
  const utmPerformance = utmPerfRes.rows.map((r) => {
    const leads = Number(r.leads || 0);
    const converted = Number(r.converted || 0);
    return {
      utmSource: r.utm_source,
      leads,
      converted,
      dropped: Number(r.dropped || 0),
      conversionRate: leads > 0 ? Number(((converted / leads) * 100).toFixed(2)) : 0,
    };
  });

  return {
    revenue30d: Number(row.revenue_30d || 0),
    noShowRate30d: total30 > 0 ? Number(((autoCancel30 / total30) * 100).toFixed(2)) : 0,
    repeatCustomerRate90d: customers90 > 0 ? Number(((repeaters90 / customers90) * 100).toFixed(2)) : 0,
    bookingsPerDay7d: bookingsPerDayRes.rows.map((r) => ({
      day: r.day,
      bookings: Number(r.bookings || 0),
    })),
    noShowTrend14d: noShowTrendRes.rows.map((r) => ({
      day: r.day,
      autoCancellations: Number(r.auto_cancellations || 0),
    })),
    topRiskCustomers: riskCustomersRes.rows.map((r) => ({
      phone: r.customer_phone,
      name: r.customer_name || null,
      totalAppointments120d: Number(r.total_120d || 0),
      noShows120d: Number(r.no_show_120d || 0),
      noShowRatePct: Number(r.no_show_rate_pct || 0),
    })),
    // Neutral names (preferred; scoped by requested lead window in funnel endpoint).
    leads,
    convertedLeads,
    droppedLeads,
    leadConversionRate,
    // Backward-compatible aliases
    leads30d: leads,
    convertedLeads30d: convertedLeads,
    droppedLeads30d: droppedLeads,
    leadConversionRate30d: leadConversionRate,
    leadsBySource30d: leadSourceRes.rows.map((r) => ({
      source: r.source,
      leads: Number(r.leads || 0),
    })),
    leadFunnelTimeline14d: funnelTimelineRes.rows.map((r) => ({
      day: r.day,
      leadsCreated: Number(r.leads_created || 0),
      leadsConverted: Number(r.leads_converted || 0),
      leadsDropped: Number(r.leads_dropped || 0),
    })),
    // Neutral names (preferred)
    campaignPerformance,
    utmPerformance,
    campaignSummary30d: {
      campaigns: Number(campaignSummaryRow.campaigns_30d || 0),
      recipients: Number(campaignSummaryRow.recipients_30d || 0),
      sent: campaignSent,
      failed: campaignFailed,
      deliveryRate: campaignDeliveryRate,
    },
    // Backward-compatible aliases
    leadCampaignPerformance30d: campaignPerformance,
    leadUtmPerformance30d: utmPerformance,
  };
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
    if (req.owner.businessId == null) {
      return res.status(400).json({
        error: 'No business linked to this account. Complete onboarding first.',
        business: null,
      });
    }
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

// ─── GET /api/business/audit-logs ─────────────────────────────────────────────
// Security / account activity: logins, signups, and other events for this owner or business.
router.get('/audit-logs', async (req, res) => {
  try {
    const ownerId = req.owner.ownerId;
    const businessId = req.owner.businessId ?? null;
    const limit = parseInt(req.query.limit, 10);
    const offset = parseInt(req.query.offset, 10);

    const result = await listAuditLogsForOwner({
      businessId,
      ownerId,
      limit: Number.isFinite(limit) ? limit : 100,
      offset: Number.isFinite(offset) ? offset : 0,
    });

    res.json({
      logs: result.logs,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    });
  } catch (err) {
    console.error('[Business] audit-logs error:', err);
    res.status(500).json({ error: 'Failed to load audit logs' });
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

async function insertServiceRow(businessId, name, durationMinutes, price) {
  const dur = Number.isFinite(durationMinutes) && durationMinutes >= 5 && durationMinutes <= 480
    ? Math.round(durationMinutes)
    : 30;
  const { rows } = await query(
    `INSERT INTO services (business_id, name, duration_minutes, price)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [businessId, name, dur, price == null ? null : price]
  );
  return rows[0];
}

function parseServiceDuration(val) {
  if (val == null || val === '') return 30;
  const n = parseInt(String(val).replace(/[^\d]/g, ''), 10);
  if (!Number.isFinite(n) || n < 5) return 30;
  return Math.min(480, n);
}

function parseServicePrice(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** [{ line, name, duration_minutes, price }] */
function parseServiceCsvRows(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  const firstCells = parseCsvLine(lines[0]).map((c) => c.toLowerCase());
  const NAME_HEADERS = new Set(['name', 'service', 'service name', 'title', 'offering']);
  const DURATION_HEADERS = new Set(['duration', 'duration_minutes', 'minutes', 'mins', 'length']);
  const PRICE_HEADERS = new Set(['price', 'cost', 'amount', 'fee']);
  const firstIsHeader = firstCells.some(
    (c) => NAME_HEADERS.has(c) || DURATION_HEADERS.has(c) || PRICE_HEADERS.has(c),
  );
  let nameIdx = 0;
  let durIdx = -1;
  let priceIdx = -1;
  let start = 0;
  if (firstIsHeader) {
    nameIdx = firstCells.findIndex((c) => NAME_HEADERS.has(c));
    if (nameIdx < 0) nameIdx = 0;
    durIdx = firstCells.findIndex((c) => DURATION_HEADERS.has(c));
    priceIdx = firstCells.findIndex((c) => PRICE_HEADERS.has(c));
    start = 1;
  } else {
    const cells0 = parseCsvLine(lines[0]);
    if (cells0.length >= 3) {
      nameIdx = 0;
      durIdx = 1;
      priceIdx = 2;
    } else if (cells0.length === 2) {
      nameIdx = 0;
      const rawSecond = cells0[1].trim();
      const n = parseInt(rawSecond.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n) && n >= 5 && n <= 480) {
        durIdx = 1;
      } else {
        priceIdx = 1;
      }
    } else {
      nameIdx = 0;
    }
  }
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[nameIdx] || '').trim();
    let durationMinutes = 30;
    let price = null;
    if (durIdx >= 0) durationMinutes = parseServiceDuration(cells[durIdx]);
    if (priceIdx >= 0) price = parseServicePrice(cells[priceIdx]);
    out.push({ line: i + 1, name, duration_minutes: durationMinutes, price });
  }
  return out;
}

// ─── POST /api/business/services ─────────────────────────────────────────────
router.post('/services', limitServices, async (req, res) => {
  const { name, duration_minutes = 30, price } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!req.owner.businessId) return res.status(400).json({ error: 'No business linked to your account. Please complete onboarding step 1 first.' });
  try {
    const dur = parseServiceDuration(duration_minutes);
    const p = price === undefined || price === '' ? null : parseServicePrice(price);
    const service = await insertServiceRow(req.owner.businessId, name, dur, p);
    res.status(201).json({ service });
  } catch (err) {
    console.error('[Business] Add service error:', err.message);
    res.status(500).json({ error: 'Failed to save service' });
  }
});

// ─── POST /api/business/services/import ───────────────────────────────────────
// Body: { csv: string } — columns: name, duration (optional), price (optional). Header optional.
router.post('/services/import', async (req, res) => {
  const { csv } = req.body;
  if (csv == null || typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required (string)' });
  }
  const businessId = req.owner.businessId;
  if (!businessId) {
    return res.status(400).json({ error: 'No business linked to your account. Please complete onboarding step 1 first.' });
  }

  const parsed = parseServiceCsvRows(csv);
  if (!parsed.length) {
    return res.status(400).json({ error: 'No rows found in CSV.' });
  }

  let { limit, count } = await getServicesLimitInfo(businessId);
  const created = [];
  const errors = [];
  let skippedEmpty = 0;

  for (const row of parsed) {
    if (!row.name) {
      skippedEmpty++;
      continue;
    }
    if (count >= limit) {
      errors.push({ line: row.line, message: `Plan limit reached (${limit} services).` });
      break;
    }
    try {
      const service = await insertServiceRow(
        businessId,
        row.name,
        row.duration_minutes,
        row.price,
      );
      created.push(service);
      count++;
    } catch (err) {
      console.error('[Business] service import row error:', err.message);
      errors.push({ line: row.line, message: `Failed to save: ${err.message || 'unknown error'}` });
    }
  }

  res.status(201).json({
    imported: created.length,
    skippedEmpty,
    errors,
    services: created,
  });
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

// ─── Staff CSV helpers ─────────────────────────────────────────────────────────
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** Returns [{ line, name, role }] — line is 1-based for error messages. */
function parseStaffCsvRows(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length);
  const firstCells = parseCsvLine(lines[0]).map((c) => c.toLowerCase());
  const NAME_HEADERS = new Set(['name', 'staff', 'staff name', 'full name', 'employee']);
  const ROLE_HEADERS = new Set(['role', 'title', 'job', 'position']);
  const firstIsHeader = firstCells.some((c) => NAME_HEADERS.has(c) || ROLE_HEADERS.has(c));
  let nameIdx = 0;
  let roleIdx = -1;
  let start = 0;
  if (firstIsHeader) {
    nameIdx = firstCells.findIndex((c) => NAME_HEADERS.has(c));
    if (nameIdx < 0) nameIdx = 0;
    roleIdx = firstCells.findIndex((c) => ROLE_HEADERS.has(c));
    start = 1;
  } else if (firstCells.length >= 2) {
    roleIdx = 1;
  }
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const name = (cells[nameIdx] || '').trim();
    const role = roleIdx >= 0 ? (cells[roleIdx] || '').trim() : '';
    out.push({ line: i + 1, name, role: role || null });
  }
  return out;
}

async function insertStaffWithDefaults(businessId, name, role) {
  const { rows } = await query(
    `INSERT INTO staff (business_id, name, role) VALUES ($1, $2, $3) RETURNING *`,
    [businessId, name, role || null]
  );
  const staff = rows[0];
  for (let day = 1; day <= 6; day++) {
    await query(
      `INSERT INTO availability (staff_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, '09:00', '18:00')`,
      [staff.id, day]
    );
  }
  return staff;
}

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
    const staff = await insertStaffWithDefaults(req.owner.businessId, name, role || null);
    res.status(201).json({ staff });
  } catch (err) {
    console.error('[Business] Add staff error:', err.message);
    res.status(500).json({ error: 'Failed to save staff' });
  }
});

// ─── POST /api/business/staff/import ───────────────────────────────────────────
// Body: { csv: string } — columns: name (required), role (optional). Header row optional.
router.post('/staff/import', async (req, res) => {
  const { csv } = req.body;
  if (csv == null || typeof csv !== 'string') {
    return res.status(400).json({ error: 'csv is required (string)' });
  }
  const businessId = req.owner.businessId;
  if (!businessId) return res.status(400).json({ error: 'No business linked to your account.' });

  const parsed = parseStaffCsvRows(csv);
  if (!parsed.length) {
    return res.status(400).json({ error: 'No rows found in CSV.' });
  }

  let { limit, count } = await getStaffLimitInfo(businessId);
  const created = [];
  const errors = [];
  let skippedEmpty = 0;

  for (const row of parsed) {
    if (!row.name) {
      skippedEmpty++;
      continue;
    }
    if (count >= limit) {
      errors.push({ line: row.line, message: `Plan limit reached (${limit} staff).` });
      break;
    }
    try {
      const staff = await insertStaffWithDefaults(businessId, row.name, row.role);
      created.push(staff);
      count++;
    } catch (err) {
      console.error('[Business] staff import row error:', err.message);
      errors.push({ line: row.line, message: `Failed to save: ${err.message || 'unknown error'}` });
    }
  }

  res.status(201).json({
    imported: created.length,
    skippedEmpty,
    errors,
    staff: created,
  });
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
    if (!bId) {
      console.error('[Appointments] No businessId in request');
      return res.status(401).json({ error: 'Business ID not found. Please log in again.' });
    }

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
    if (!business) {
      console.error('[Appointments] Business not found for ID:', bId);
      return res.status(404).json({ error: 'Business not found' });
    }
    const tz = business?.timezone || 'Asia/Kolkata';

    // Build params so placeholders stay $1..$N with no gaps — PostgreSQL rejects skipped indices
    // (e.g. upcoming/all must not reserve $2 for tz if the query never references it).
    const params = [bId];
    const conditions = ['a.business_id = $1'];

    // View presets ("today" = calendar day in business timezone)
    if (view === 'today') {
      params.push(tz);
      conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) = DATE(NOW() AT TIME ZONE $2)`);
    } else if (view === 'upcoming') {
      conditions.push(`a.scheduled_at >= NOW()`);
    } else if (view === 'range' && from) {
      params.push(tz);
      params.push(from);
      conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) >= $3`);
      if (to) {
        params.push(to);
        conditions.push(`DATE(a.scheduled_at AT TIME ZONE $2) <= $${params.length}`);
      }
    }
    // view === 'all' → no date filter

    // Status filter
    if (status && ['confirmed', 'cancelled', 'completed', 'no_show'].includes(status)) {
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
              c.name  AS customer_name,
              cr.risk_tier AS customer_risk_tier,
              cr.no_show_count_120d AS customer_no_show_count_120d
       FROM appointments a
       LEFT JOIN services  s  ON a.service_id  = s.id
       LEFT JOIN staff     st ON a.staff_id    = st.id
       LEFT JOIN customers c  ON a.customer_phone = c.phone AND c.business_id = a.business_id
       LEFT JOIN (
         SELECT
           a2.customer_phone,
           COUNT(*) FILTER (
             WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
               AND (
                 a2.status = 'no_show'
                 OR (a2.status = 'cancelled' AND a2.cancel_reason = 'auto_cancel_unconfirmed')
               )
           ) AS no_show_count_120d,
           COUNT(*) FILTER (
             WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
               AND a2.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
           ) AS total_count_120d,
           CASE
             WHEN COUNT(*) FILTER (
               WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
                 AND a2.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
             ) >= 3
             AND (
               COUNT(*) FILTER (
                 WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
                   AND (
                     a2.status = 'no_show'
                     OR (a2.status = 'cancelled' AND a2.cancel_reason = 'auto_cancel_unconfirmed')
                   )
               ) >= 2
               OR (
                 COUNT(*) FILTER (
                   WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
                     AND (
                       a2.status = 'no_show'
                       OR (a2.status = 'cancelled' AND a2.cancel_reason = 'auto_cancel_unconfirmed')
                     )
                 )::numeric
                 / NULLIF(
                   COUNT(*) FILTER (
                     WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
                       AND a2.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
                   ),
                   0
                 )
               ) >= 0.4
             )
               THEN 'high'
             WHEN COUNT(*) FILTER (
               WHERE a2.scheduled_at >= NOW() - INTERVAL '120 days'
                 AND (
                   a2.status = 'no_show'
                   OR (a2.status = 'cancelled' AND a2.cancel_reason = 'auto_cancel_unconfirmed')
                 )
             ) >= 1
               THEN 'medium'
             ELSE 'low'
           END AS risk_tier
         FROM appointments a2
         WHERE a2.business_id = $1
         GROUP BY a2.customer_phone
       ) cr ON cr.customer_phone = a.customer_phone
       WHERE ${where}
       ORDER BY a.scheduled_at ${view === 'upcoming' ? 'ASC' : 'DESC'}
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      appointments: rows,
      total,
      page: parseInt(page, 10),
      pages: Math.max(Math.ceil(total / parseInt(limit, 10)), 1),
    });
  } catch (err) {
    console.error('[Appointments] Error:', err);
    console.error('[Appointments] Query params:', req.query);
    console.error('[Appointments] Business ID:', req.owner?.businessId);
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

// ─── GET /api/business/customers/:phone/profile ───────────────────────────────
router.get('/customers/:phone/profile', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Invalid customer phone' });

  try {
    const bId = req.owner.businessId;
    const { rows } = await query(
      `WITH summary AS (
         SELECT
           a.customer_phone,
           COALESCE(MAX(c.name), MAX(a.customer_name), '') AS customer_name,
           COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed_visits,
           COUNT(*)::int AS total_bookings,
           MAX(a.scheduled_at) FILTER (WHERE a.status = 'completed') AS last_visit_at,
           COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS total_spend
         FROM appointments a
         LEFT JOIN customers c ON c.phone = a.customer_phone AND c.business_id = a.business_id
         LEFT JOIN services s ON s.id = a.service_id
         WHERE a.business_id = $1
           AND a.customer_phone = $2
         GROUP BY a.customer_phone
       ),
       risk AS (
         SELECT
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
               AND (
                 a.status = 'no_show'
                 OR (a.status = 'cancelled' AND a.cancel_reason = 'auto_cancel_unconfirmed')
               )
           )::int AS no_shows_120d,
           COUNT(*) FILTER (
             WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
               AND a.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
           )::int AS total_120d
         FROM appointments a
         WHERE a.business_id = $1
           AND a.customer_phone = $2
       )
       SELECT
         s.customer_phone,
         s.customer_name,
         s.total_bookings,
         s.completed_visits,
         s.last_visit_at,
         s.total_spend,
         r.no_shows_120d,
         r.total_120d,
         CASE
           WHEN r.total_120d >= 3 AND (r.no_shows_120d >= 2 OR (r.no_shows_120d::numeric / NULLIF(r.total_120d, 0)) >= 0.4) THEN 'high'
           WHEN r.no_shows_120d >= 1 THEN 'medium'
           ELSE 'low'
         END AS risk_tier
       FROM summary s, risk r`,
      [bId, phone],
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    return res.json({ customer: rows[0] });
  } catch (err) {
    console.error('[CRM] Profile error:', err);
    return res.status(500).json({ error: 'Failed to load customer profile' });
  }
});

// ─── GET /api/business/customers/:phone/history ───────────────────────────────
router.get('/customers/:phone/history', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  if (!phone) return res.status(400).json({ error: 'Invalid customer phone' });

  try {
    const bId = req.owner.businessId;
    const [historyRes, notesRes] = await Promise.all([
      query(
        `SELECT
           a.id,
           a.scheduled_at,
           a.status,
           a.confirmation_status,
           a.cancel_reason,
           a.notes,
           s.name AS service_name,
           st.name AS staff_name
         FROM appointments a
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN staff st ON st.id = a.staff_id
         WHERE a.business_id = $1
           AND a.customer_phone = $2
         ORDER BY a.scheduled_at DESC
         LIMIT 20`,
        [bId, phone],
      ),
      query(
        `SELECT id, note, created_at
         FROM customer_notes
         WHERE business_id = $1
           AND customer_phone = $2
         ORDER BY created_at DESC
         LIMIT 20`,
        [bId, phone],
      ),
    ]);

    return res.json({
      appointments: historyRes.rows,
      notes: notesRes.rows,
    });
  } catch (err) {
    console.error('[CRM] History error:', err);
    return res.status(500).json({ error: 'Failed to load customer history' });
  }
});

// ─── POST /api/business/customers/:phone/notes ────────────────────────────────
router.post('/customers/:phone/notes', async (req, res) => {
  const phone = normalizePhone(req.params.phone);
  const note = String(req.body?.note || '').trim();
  if (!phone) return res.status(400).json({ error: 'Invalid customer phone' });
  if (!note) return res.status(400).json({ error: 'Note is required' });
  if (note.length > 1000) return res.status(400).json({ error: 'Note is too long (max 1000 chars)' });

  try {
    const { rows } = await query(
      `INSERT INTO customer_notes (business_id, customer_phone, note, created_by_owner_id)
       VALUES ($1, $2, $3, $4)
       RETURNING id, note, created_at`,
      [req.owner.businessId, phone, note, req.owner.ownerId || null],
    );
    return res.status(201).json({ note: rows[0] });
  } catch (err) {
    console.error('[CRM] Add note error:', err);
    return res.status(500).json({ error: 'Failed to save note' });
  }
});

// ─── GET /api/business/customers ───────────────────────────────────────────────
// Query params: search, sort=risk|last_visit|spend|name, page, limit
router.get('/customers', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const {
      search = '',
      sort = 'risk',
      page = 1,
      limit = 25,
    } = req.query;

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
    const offset = (safePage - 1) * safeLimit;

    const params = [bId];
    const conditions = [];
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      conditions.push(`(LOWER(a.customer_phone) LIKE $${params.length} OR LOWER(COALESCE(c.name, a.customer_name, '')) LIKE $${params.length})`);
    }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const orderBy = {
      risk: `risk_rank DESC, no_shows_120d DESC, last_visit_at DESC NULLS LAST`,
      last_visit: `last_visit_at DESC NULLS LAST`,
      spend: `total_spend DESC`,
      name: `customer_name ASC`,
    }[sort] || `risk_rank DESC, no_shows_120d DESC, last_visit_at DESC NULLS LAST`;

    const baseSql = `
      WITH per_customer AS (
        SELECT
          a.customer_phone,
          COALESCE(MAX(c.name), MAX(a.customer_name), '') AS customer_name,
          COUNT(*)::int AS total_bookings,
          COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed_visits,
          MAX(a.scheduled_at) FILTER (WHERE a.status = 'completed') AS last_visit_at,
          COALESCE(SUM(CASE WHEN a.status = 'completed' THEN COALESCE(s.price, 0) ELSE 0 END), 0) AS total_spend,
          COUNT(*) FILTER (
            WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
              AND (
                a.status = 'no_show'
                OR (a.status = 'cancelled' AND a.cancel_reason = 'auto_cancel_unconfirmed')
              )
          )::int AS no_shows_120d,
          COUNT(*) FILTER (
            WHERE a.scheduled_at >= NOW() - INTERVAL '120 days'
              AND a.status IN ('completed', 'confirmed', 'cancelled', 'no_show')
          )::int AS total_120d
        FROM appointments a
        LEFT JOIN customers c ON c.phone = a.customer_phone AND c.business_id = a.business_id
        LEFT JOIN services s ON s.id = a.service_id
        WHERE a.business_id = $1
        GROUP BY a.customer_phone
      ),
      ranked AS (
        SELECT
          *,
          CASE
            WHEN total_120d >= 3 AND (no_shows_120d >= 2 OR (no_shows_120d::numeric / NULLIF(total_120d, 0)) >= 0.4) THEN 'high'
            WHEN no_shows_120d >= 1 THEN 'medium'
            ELSE 'low'
          END AS risk_tier,
          CASE
            WHEN total_120d >= 3 AND (no_shows_120d >= 2 OR (no_shows_120d::numeric / NULLIF(total_120d, 0)) >= 0.4) THEN 3
            WHEN no_shows_120d >= 1 THEN 2
            ELSE 1
          END AS risk_rank
        FROM per_customer
      )
    `;

    const countRes = await query(
      `${baseSql}
       SELECT COUNT(*)::int AS n
       FROM ranked r
       WHERE 1=1 ${where}`,
      params,
    );

    params.push(safeLimit);
    params.push(offset);

    const { rows } = await query(
      `${baseSql}
       SELECT
         r.customer_phone,
         r.customer_name,
         r.total_bookings,
         r.completed_visits,
         r.last_visit_at,
         r.total_spend,
         r.no_shows_120d,
         r.total_120d,
         r.risk_tier
       FROM ranked r
       WHERE 1=1 ${where}
       ORDER BY ${orderBy}
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    const total = Number(countRes.rows[0]?.n || 0);
    return res.json({
      customers: rows,
      total,
      page: safePage,
      pages: Math.max(Math.ceil(total / safeLimit), 1),
    });
  } catch (err) {
    console.error('[CRM] Customers list error:', err);
    return res.status(500).json({ error: 'Failed to load customers' });
  }
});

// ─── GET /api/business/dashboard ─────────────────────────────────────────────
router.get('/dashboard', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const { rows: bizRows } = await query(
      `SELECT b.*, s.plan FROM businesses b
       LEFT JOIN subscriptions s ON b.id = s.business_id
       WHERE b.id = $1`,
      [bId],
    );
    if (!bizRows.length) return res.status(404).json({ error: 'Business not found' });
    const business = bizRows[0];
    const tz = business.timezone || 'Asia/Kolkata';

    const [stats, insights, todayList, upcomingList] = await Promise.all([
      fetchStatsForBusiness(bId, tz),
      fetchDashboardInsights(bId, tz),
      query(
        `SELECT a.*,
                s.name  AS service_name,
                st.name AS staff_name,
                c.name  AS customer_name
         FROM appointments a
         LEFT JOIN services  s  ON a.service_id  = s.id
         LEFT JOIN staff     st ON a.staff_id    = st.id
         LEFT JOIN customers c  ON a.customer_phone = c.phone AND c.business_id = a.business_id
         WHERE a.business_id = $1 AND DATE(a.scheduled_at AT TIME ZONE $2) = DATE(NOW() AT TIME ZONE $2)
         ORDER BY a.scheduled_at ASC
         LIMIT 50`,
        [bId, tz],
      ),
      query(
        `SELECT a.*,
                s.name  AS service_name,
                st.name AS staff_name,
                c.name  AS customer_name
         FROM appointments a
         LEFT JOIN services  s  ON a.service_id  = s.id
         LEFT JOIN staff     st ON a.staff_id    = st.id
         LEFT JOIN customers c  ON a.customer_phone = c.phone AND c.business_id = a.business_id
         WHERE a.business_id = $1 AND a.scheduled_at >= NOW()
         ORDER BY a.scheduled_at ASC
         LIMIT 20`,
        [bId],
      ),
    ]);

    res.json({
      business,
      stats,
      insights,
      todayAppointments: todayList.rows,
      upcomingAppointments: upcomingList.rows,
    });
  } catch (err) {
    console.error('[Business] Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ─── GET /api/business/stats ──────────────────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const business = await getBusiness(bId);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    const tz = business.timezone || 'Asia/Kolkata';
    const stats = await fetchStatsForBusiness(bId, tz);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ─── GET /api/business/funnel ─────────────────────────────────────────────────
router.get('/funnel', async (req, res) => {
  try {
    const bId = req.owner.businessId;
    const requestedDays = Number(req.query.days || 30);
    const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
    const business = await getBusiness(bId);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    const insights = await fetchDashboardInsights(bId, business.timezone || 'Asia/Kolkata', days);
    return res.json({
      windowDays: days,
      leads: insights.leads,
      convertedLeads: insights.convertedLeads,
      droppedLeads: insights.droppedLeads,
      leadConversionRate: insights.leadConversionRate,
      // Backward-compatible aliases
      leads30d: insights.leads30d,
      convertedLeads30d: insights.convertedLeads30d,
      droppedLeads30d: insights.droppedLeads30d,
      leadConversionRate30d: insights.leadConversionRate30d,
      leadsBySource30d: insights.leadsBySource30d,
      timeline14d: insights.leadFunnelTimeline14d,
      campaignPerformance: insights.campaignPerformance,
      utmPerformance: insights.utmPerformance,
      // Backward-compatible aliases
      campaignPerformance30d: insights.leadCampaignPerformance30d,
      utmPerformance30d: insights.leadUtmPerformance30d,
    });
  } catch (err) {
    console.error('[Funnel] Error:', err);
    return res.status(500).json({ error: 'Failed to load funnel data' });
  }
});

// ─── GET /api/business/plan ───────────────────────────────────────────────────
router.get('/plan', async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM subscriptions WHERE business_id = $1`,
    [req.owner.businessId]
  );
  const plan = effectivePlanFromSubscriptionRow(rows[0]);
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

// ─── GET /api/business/widget-api-key ─────────────────────────────────────────
// Returns the widget API key for embedding chat on external websites
router.get('/widget-api-key', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT widget_api_key FROM businesses WHERE id = $1`,
      [req.owner.businessId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Business not found' });

    const apiKey = rows[0].widget_api_key;
    const backendUrl = getPublicBackendUrlForWidget(req);

    return res.json({
      apiKey,
      widgetUrl: apiKey ? `${backendUrl}/widget.js?api_key=${apiKey}` : null,
      embedCode: apiKey ? `<script async src="${backendUrl}/widget.js?api_key=${apiKey}"></script>` : null,
    });
  } catch (err) {
    console.error('[Business] Load widget API key error:', err.message);
    return res.status(500).json({ error: 'Failed to load widget API key' });
  }
});

// ─── POST /api/business/widget-api-key/regenerate ─────────────────────────────
// Generates a new widget API key (or creates one if none exists)
router.post('/widget-api-key/regenerate', async (req, res) => {
  try {
    const newApiKey = generateApiKey();

    const { rows } = await query(
      `UPDATE businesses
       SET widget_api_key = $1
       WHERE id = $2
       RETURNING widget_api_key`,
      [newApiKey, req.owner.businessId]
    );

    if (!rows.length) return res.status(404).json({ error: 'Business not found' });

    const backendUrl = getPublicBackendUrlForWidget(req);

    return res.json({
      apiKey: newApiKey,
      widgetUrl: `${backendUrl}/widget.js?api_key=${newApiKey}`,
      embedCode: `<script async src="${backendUrl}/widget.js?api_key=${newApiKey}"></script>`,
    });
  } catch (err) {
    console.error('[Business] Regenerate widget API key error:', err.message);
    return res.status(500).json({ error: 'Failed to regenerate widget API key' });
  }
});

// ─── GET /api/business/no-show-settings ───────────────────────────────────────
router.get('/no-show-settings', async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT
         reminder_24h_enabled,
         reminder_2h_enabled,
         auto_cancel_unconfirmed_enabled,
         confirmation_cutoff_minutes
       FROM businesses
       WHERE id = $1`,
      [req.owner.businessId],
    );
    if (!rows.length) return res.status(404).json({ error: 'Business not found' });
    return res.json({ noShowSettings: rows[0] });
  } catch (err) {
    console.error('[Business] Load no-show settings error:', err.message);
    return res.status(500).json({ error: 'Failed to load no-show settings' });
  }
});

// ─── PUT /api/business/no-show-settings ───────────────────────────────────────
router.put('/no-show-settings', async (req, res) => {
  const {
    reminder24hEnabled,
    reminder2hEnabled,
    autoCancelUnconfirmedEnabled,
    confirmationCutoffMinutes,
  } = req.body || {};

  if (
    confirmationCutoffMinutes != null
    && (!Number.isInteger(confirmationCutoffMinutes)
      || confirmationCutoffMinutes < 15
      || confirmationCutoffMinutes > 360)
  ) {
    return res.status(400).json({ error: 'confirmationCutoffMinutes must be an integer between 15 and 360' });
  }

  try {
    const { rows } = await query(
      `UPDATE businesses
       SET reminder_24h_enabled = COALESCE($1, reminder_24h_enabled),
           reminder_2h_enabled = COALESCE($2, reminder_2h_enabled),
           auto_cancel_unconfirmed_enabled = COALESCE($3, auto_cancel_unconfirmed_enabled),
           confirmation_cutoff_minutes = COALESCE($4, confirmation_cutoff_minutes)
       WHERE id = $5
       RETURNING
         reminder_24h_enabled,
         reminder_2h_enabled,
         auto_cancel_unconfirmed_enabled,
         confirmation_cutoff_minutes`,
      [
        typeof reminder24hEnabled === 'boolean' ? reminder24hEnabled : null,
        typeof reminder2hEnabled === 'boolean' ? reminder2hEnabled : null,
        typeof autoCancelUnconfirmedEnabled === 'boolean' ? autoCancelUnconfirmedEnabled : null,
        confirmationCutoffMinutes ?? null,
        req.owner.businessId,
      ],
    );

    if (!rows.length) return res.status(404).json({ error: 'Business not found' });

    return res.json({ noShowSettings: rows[0] });
  } catch (err) {
    console.error('[Business] Update no-show settings error:', err.message);
    return res.status(500).json({ error: 'Failed to save no-show settings' });
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

// ─── Campaigns (marketing) ────────────────────────────────────────────────────
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await listCampaigns(req.owner.businessId);
    return res.json({ campaigns });
  } catch (err) {
    console.error('[Campaigns] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load campaigns' });
  }
});

router.post('/campaigns', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const message = String(req.body?.message || '').trim();
  const audienceType = String(req.body?.audienceType || 'all_leads').trim();
  const sendMode = String(req.body?.sendMode || 'text').trim();
  const templateName = String(req.body?.templateName || '').trim();
  const templateLanguage = String(req.body?.templateLanguage || 'en').trim();
  const scheduledAtRaw = req.body?.scheduledAt || null;
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : null;
  if (!name) return res.status(400).json({ error: 'Campaign name is required' });
  if (sendMode === 'text') {
    if (!message) return res.status(400).json({ error: 'Campaign message is required' });
    if (message.length > 1024) return res.status(400).json({ error: 'Campaign message too long (max 1024 chars)' });
  }
  if (sendMode === 'template' && !templateName) {
    return res.status(400).json({ error: 'Template name is required for template campaigns' });
  }
  if (scheduledAt && Number.isNaN(scheduledAt.getTime())) {
    return res.status(400).json({ error: 'Invalid scheduledAt datetime' });
  }

  try {
    const campaign = await createCampaign({
      businessId: req.owner.businessId,
      name,
      message: message || '',
      audienceType,
      sendMode,
      templateName: templateName || null,
      templateLanguage: templateLanguage || 'en',
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      createdByOwnerId: req.owner.ownerId || null,
    });
    return res.status(201).json({ campaign });
  } catch (err) {
    console.error('[Campaigns] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to create campaign' });
  }
});

router.get('/campaigns/summary', async (req, res) => {
  try {
    const { rows } = await query(
      `WITH campaign_base AS (
         SELECT *
         FROM campaigns
         WHERE business_id = $1
           AND created_at >= NOW() - INTERVAL '30 days'
       ),
       retry_stats AS (
         SELECT
           COUNT(*) FILTER (WHERE cr.status = 'failed' AND cr.next_retry_at IS NOT NULL)::int AS retry_pending_30d,
           COUNT(*) FILTER (WHERE cr.status = 'failed' AND cr.next_retry_at IS NULL)::int AS retry_exhausted_30d
         FROM campaign_recipients cr
         JOIN campaign_base c ON c.id = cr.campaign_id
       )
       SELECT
         COUNT(*)::int AS campaigns_30d,
         COALESCE(SUM(c.total_recipients), 0)::int AS recipients_30d,
         COALESCE(SUM(c.sent_count), 0)::int AS sent_30d,
         COALESCE(SUM(c.failed_count), 0)::int AS failed_30d,
         COALESCE(MAX(rs.retry_pending_30d), 0)::int AS retry_pending_30d,
         COALESCE(MAX(rs.retry_exhausted_30d), 0)::int AS retry_exhausted_30d
       FROM campaign_base c
       CROSS JOIN retry_stats rs`,
      [req.owner.businessId],
    );
    const r = rows[0] || {};
    const sent = Number(r.sent_30d || 0);
    const failed = Number(r.failed_30d || 0);
    const deliveryRate = sent + failed > 0 ? Number(((sent / (sent + failed)) * 100).toFixed(2)) : 0;
    return res.json({
      campaigns30d: Number(r.campaigns_30d || 0),
      recipients30d: Number(r.recipients_30d || 0),
      sent30d: sent,
      failed30d: failed,
      deliveryRate30d: deliveryRate,
      retryPending30d: Number(r.retry_pending_30d || 0),
      retryExhausted30d: Number(r.retry_exhausted_30d || 0),
    });
  } catch (err) {
    console.error('[Campaigns] Summary error:', err.message);
    return res.status(500).json({ error: 'Failed to load campaign summary' });
  }
});

router.get('/messaging-preferences', async (req, res) => {
  try {
    const optedOutOnly = String(req.query.optedOut || 'true').toLowerCase() !== 'false';
    if (!optedOutOnly) return res.status(400).json({ error: 'Only optedOut=true is supported currently' });
    const rows = await listCampaignOptOutPreferences({
      businessId: req.owner.businessId,
      search: req.query.search || '',
      limit: Number(req.query.limit || 100),
    });
    return res.json({ contacts: rows });
  } catch (err) {
    console.error('[Messaging Preferences] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load messaging preferences' });
  }
});

router.put('/messaging-preferences/:phone', async (req, res) => {
  const phone = String(req.params.phone || '').trim();
  const optOut = !!req.body?.optOut;
  if (!phone) return res.status(400).json({ error: 'phone is required' });
  try {
    const pref = await setCampaignOptOut({
      businessId: req.owner.businessId,
      customerPhone: phone,
      optOut,
      reason: optOut ? (String(req.body?.reason || 'owner_toggle').trim() || 'owner_toggle') : null,
    });
    return res.json({ preference: pref });
  } catch (err) {
    console.error('[Messaging Preferences] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update messaging preference' });
  }
});

router.get('/campaigns/:id/failures', async (req, res) => {
  const campaignId = Number(req.params.id);
  const limit = Number(req.query.limit || 50);
  if (!campaignId || Number.isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const data = await getCampaignFailures({
      businessId: req.owner.businessId,
      campaignId,
      limit,
    });
    return res.json(data);
  } catch (err) {
    console.error('[Campaigns] Failures error:', err.message);
    return res.status(500).json({ error: 'Failed to load campaign failures' });
  }
});

router.get('/campaigns/:id/failures.csv', async (req, res) => {
  const campaignId = Number(req.params.id);
  if (!campaignId || Number.isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const data = await getCampaignFailures({
      businessId: req.owner.businessId,
      campaignId,
      limit: 10000,
    });
    const escapeCsv = (v) => {
      const s = String(v ?? '');
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [
      'customer_phone,error_message,failed_at',
      ...(data.failedRecipients || []).map((r) => [
        escapeCsv(r.customer_phone),
        escapeCsv(r.error_message || ''),
        escapeCsv(r.created_at || ''),
      ].join(',')),
    ];
    const csv = lines.join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="campaign-${campaignId}-failures.csv"`);
    return res.status(200).send(csv);
  } catch (err) {
    console.error('[Campaigns] Failures CSV error:', err.message);
    return res.status(500).json({ error: 'Failed to export campaign failures CSV' });
  }
});

router.post('/campaigns/:id/send', async (req, res) => {
  const campaignId = Number(req.params.id);
  if (!campaignId || Number.isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const result = await sendCampaignNow({
      businessId: req.owner.businessId,
      campaignId,
    });
    if (result?.error) return res.status(409).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[Campaigns] Send error:', err.message);
    return res.status(500).json({ error: 'Failed to send campaign' });
  }
});

router.post('/campaigns/:id/retry-failed', async (req, res) => {
  const campaignId = Number(req.params.id);
  if (!campaignId || Number.isNaN(campaignId)) return res.status(400).json({ error: 'Invalid campaign id' });
  try {
    const result = await retryFailedRecipients({
      businessId: req.owner.businessId,
      campaignId,
      max: Number(req.body?.max || 200),
    });
    if (result?.error) return res.status(404).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    console.error('[Campaigns] Retry failed error:', err.message);
    return res.status(500).json({ error: 'Failed to retry failed recipients' });
  }
});

// ─── Campaign Templates ────────────────────────────────────────────────────────
router.get('/campaign-templates', async (req, res) => {
  try {
    const templates = await listTemplates(req.owner.businessId);
    return res.json({ templates });
  } catch (err) {
    console.error('[Campaign Templates] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load templates' });
  }
});

router.post('/campaign-templates', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Template name is required' });
  try {
    const template = await createTemplate({
      businessId: req.owner.businessId,
      name,
      description: req.body?.description || null,
      sendMode: req.body?.sendMode || 'text',
      metaTemplateName: req.body?.metaTemplateName || null,
      templateLanguage: req.body?.templateLanguage || 'en',
      contentText: req.body?.contentText || null,
      contentMediaUrl: req.body?.contentMediaUrl || null,
      variableCount: Number(req.body?.variableCount || 0),
      variableLabels: req.body?.variableLabels || [],
    });
    return res.status(201).json({ template });
  } catch (err) {
    console.error('[Campaign Templates] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to create template' });
  }
});

router.get('/campaign-templates/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  if (!templateId || Number.isNaN(templateId)) return res.status(400).json({ error: 'Invalid template id' });
  try {
    const template = await getTemplate({ businessId: req.owner.businessId, templateId });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json({ template });
  } catch (err) {
    console.error('[Campaign Templates] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to load template' });
  }
});

router.put('/campaign-templates/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  if (!templateId || Number.isNaN(templateId)) return res.status(400).json({ error: 'Invalid template id' });
  try {
    const template = await updateTemplate({
      businessId: req.owner.businessId,
      templateId,
      name: req.body?.name,
      description: req.body?.description,
      sendMode: req.body?.sendMode,
      metaTemplateName: req.body?.metaTemplateName,
      templateLanguage: req.body?.templateLanguage,
      contentText: req.body?.contentText,
      contentMediaUrl: req.body?.contentMediaUrl,
      variableCount: req.body?.variableCount,
      variableLabels: req.body?.variableLabels,
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json({ template });
  } catch (err) {
    console.error('[Campaign Templates] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/campaign-templates/:id', async (req, res) => {
  const templateId = Number(req.params.id);
  if (!templateId || Number.isNaN(templateId)) return res.status(400).json({ error: 'Invalid template id' });
  try {
    await deleteTemplate({ businessId: req.owner.businessId, templateId });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Campaign Templates] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
