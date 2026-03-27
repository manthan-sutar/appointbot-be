import { query } from '../config/db.js';

export const PLAN_LIMITS = {
  free:     { staff: 2,         services: 3,         bookingsPerMonth: 50 },
  pro:      { staff: 10,        services: 20,        bookingsPerMonth: 500 },
  business: { staff: Infinity,  services: Infinity,  bookingsPerMonth: Infinity },
};

/** Exported for GET /api/business/plan and limit checks — same rules. */
export function effectivePlanFromSubscriptionRow(row) {
  if (!row) return 'free';
  if (row.status === 'canceled') return 'free';
  // Active trial → treat as pro plan for limits / UI
  if (
    row.status === 'trialing' &&
    row.trial_ends_at &&
    new Date(row.trial_ends_at) > new Date()
  ) {
    return 'pro';
  }
  const p = String(row.plan || 'free').toLowerCase();
  if (p === 'business' || p === 'pro' || p === 'free') return p;
  return 'free';
}

async function getEffectivePlan(businessId) {
  const { rows } = await query(
    `SELECT plan, status, trial_ends_at
       FROM subscriptions
      WHERE business_id = $1`,
    [businessId]
  );
  return effectivePlanFromSubscriptionRow(rows[0]);
}

async function countRows(table, businessId) {
  const { rows } = await query(
    `SELECT COUNT(*) AS n FROM ${table} WHERE business_id = $1 AND active = TRUE`,
    [businessId]
  );
  return parseInt(rows[0].n, 10);
}

export function limitStaff(req, res, next) {
  return checkLimit('staff', req, res, next);
}

export function limitServices(req, res, next) {
  return checkLimit('services', req, res, next);
}

async function checkLimit(resource, req, res, next) {
  try {
    const businessId = req.owner.businessId;
    const plan  = await getEffectivePlan(businessId);
    const limit = PLAN_LIMITS[plan][resource];
    const count = await countRows(resource, businessId);

    if (count >= limit) {
      return res.status(403).json({
        error: `Your ${plan} plan allows up to ${limit} ${resource}. Upgrade to add more.`,
        upgrade: true,
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}
