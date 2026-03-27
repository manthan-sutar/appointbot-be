import express from 'express';
import { query } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createRazorpaySubscription,
  isRazorpayEnabled,
  cancelRazorpaySubscription,
  fetchRazorpaySubscription,
} from '../services/razorpay.service.js';

const router = express.Router();
router.use(requireAuth);

// Helper to load subscription + derived trial info
async function getSubscriptionForBusiness(businessId) {
  const { rows } = await query(
    `SELECT business_id, plan, status, trial_ends_at, current_period_end, gateway,
            external_customer_id, external_subscription_id, started_at, cancel_at_period_end
       FROM subscriptions
      WHERE business_id = $1`,
    [businessId],
  );
  const sub = rows[0] || null;
  if (!sub) return null;

  const now = new Date();
  const trialActive = sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) > now;
  const trialDaysLeft = trialActive
    ? Math.ceil((new Date(sub.trial_ends_at) - now) / (24 * 60 * 60 * 1000))
    : 0;

  // Live next charge / period end from Razorpay when possible (keeps “next billing date” accurate in UI)
  let currentPeriodEnd = sub.current_period_end;
  if (
    process.env.PAYMENT_PROVIDER === 'razorpay' &&
    isRazorpayEnabled() &&
    sub.gateway === 'razorpay' &&
    sub.external_subscription_id &&
    sub.status !== 'canceled'
  ) {
    try {
      const rz = await fetchRazorpaySubscription(sub.external_subscription_id);
      if (rz?.current_end) {
        currentPeriodEnd = new Date(rz.current_end * 1000);
      }
    } catch (e) {
      console.warn('[Billing] Could not refresh subscription from Razorpay:', e.message);
    }
  }

  return {
    ...sub,
    current_period_end: currentPeriodEnd,
    trialActive,
    trialDaysLeft,
    cancel_at_period_end: !!sub.cancel_at_period_end,
  };
}

// GET /api/billing/subscription
router.get('/subscription', async (req, res) => {
  try {
    const businessId = req.owner.businessId;
    const sub = await getSubscriptionForBusiness(businessId);
    if (!sub) {
      return res.json({
        subscription: {
          business_id: businessId,
          plan: 'free',
          status: 'trialing',
          trialActive: false,
          trialDaysLeft: 0,
          cancel_at_period_end: false,
        },
      });
    }
    res.json({ subscription: sub });
  } catch (err) {
    console.error('[Billing] subscription load failed:', err);
    res.status(500).json({ error: 'Failed to load subscription' });
  }
});

// POST /api/billing/checkout
// Body: { plan: 'pro' | 'business' }
// Returns provider-specific payload the frontend can use to open checkout.
router.post('/checkout', async (req, res) => {
  const businessId = req.owner.businessId;
  const email = req.owner.email;
  const { plan } = req.body;

  if (!plan || !['pro', 'business'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be one of: pro, business' });
  }

  // Prevent downgrades: you can always move to a higher tier, but not lower.
  const sub = await getSubscriptionForBusiness(businessId);
  const rank = { free: 0, pro: 1, business: 2 };
  if (sub && sub.plan && rank[sub.plan] != null && rank[plan] < rank[sub.plan] && sub.status !== 'canceled') {
    return res.status(400).json({ error: 'Downgrades are not allowed from your current plan.' });
  }

  const provider = process.env.PAYMENT_PROVIDER || 'none';

  if (provider === 'razorpay') {
    if (!isRazorpayEnabled()) {
      return res.status(500).json({ error: 'Razorpay is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.' });
    }
    try {
      // If they are currently in our in-app trial, align Razorpay start date
      // to the end of that trial so they truly get the full free period.
      const sub = await getSubscriptionForBusiness(businessId);
      let startAt = null;
      if (sub?.trialActive && sub.trial_ends_at) {
        const trialEnd = new Date(sub.trial_ends_at);
        if (trialEnd > new Date()) {
          startAt = trialEnd;
        }
      }

      const subscription = await createRazorpaySubscription({
        businessId,
        plan,
        customerEmail: email,
        startAt,
      });
      // Persist external subscription id so webhook can look it up later
      await query(
        `UPDATE subscriptions
            SET gateway = 'razorpay',
                external_subscription_id = $1,
                plan = $2,
                cancel_at_period_end = FALSE,
                status = CASE WHEN status = 'trialing' THEN status ELSE 'active' END
          WHERE business_id = $3`,
        [subscription.id, plan, businessId],
      );

      return res.json({
        provider: 'razorpay',
        subscriptionId: subscription.id,
        shortUrl: subscription.short_url || null,
        status: subscription.status,
        keyId: process.env.RAZORPAY_KEY_ID || '',
      });
    } catch (err) {
      console.error('[Billing] Razorpay subscription create failed:', err);
      return res.status(502).json({ error: 'Failed to create payment session. Please try again later.' });
    }
  }

  // No payment provider configured
  return res.status(501).json({
    error: 'Payments are not configured for this deploy. Set PAYMENT_PROVIDER=razorpay to enable.',
  });
});

// POST /api/billing/cancel
// Body: { cancelAtPeriodEnd?: boolean } — default true (keep access until period ends)
router.post('/cancel', async (req, res) => {
  try {
    const businessId = req.owner.businessId;
    const cancelAtPeriodEnd = req.body?.cancelAtPeriodEnd !== false;

    const sub = await getSubscriptionForBusiness(businessId);
    if (!sub?.external_subscription_id || sub.gateway !== 'razorpay') {
      return res.status(400).json({
        error:
          'There is no card billing subscription to cancel. Trial and free plans do not need cancellation.',
      });
    }

    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'Your subscription is already canceled.' });
    }

    if (sub.cancel_at_period_end) {
      return res.status(400).json({ error: 'Cancellation is already scheduled for the end of this period.' });
    }

    if (process.env.PAYMENT_PROVIDER !== 'razorpay' || !isRazorpayEnabled()) {
      return res.status(501).json({ error: 'Payment provider is not configured.' });
    }

    await cancelRazorpaySubscription(sub.external_subscription_id, cancelAtPeriodEnd);

    let periodEnd = sub.current_period_end;
    try {
      const rz = await fetchRazorpaySubscription(sub.external_subscription_id);
      if (rz?.current_end) {
        periodEnd = new Date(rz.current_end * 1000);
      }
    } catch (fetchErr) {
      console.warn('[Billing] Could not refresh subscription from Razorpay after cancel:', fetchErr.message);
    }

    if (cancelAtPeriodEnd) {
      await query(
        `UPDATE subscriptions
            SET cancel_at_period_end = TRUE,
                current_period_end = COALESCE($1::timestamptz, current_period_end)
          WHERE business_id = $2`,
        [periodEnd, businessId],
      );
    } else {
      await query(
        `UPDATE subscriptions
            SET status = 'canceled',
                cancel_at_period_end = FALSE,
                current_period_end = COALESCE($1::timestamptz, current_period_end)
          WHERE business_id = $2`,
        [periodEnd, businessId],
      );
    }

    const updated = await getSubscriptionForBusiness(businessId);
    res.json({ subscription: updated });
  } catch (err) {
    console.error('[Billing] cancel failed:', err);
    res.status(502).json({ error: 'Failed to cancel subscription. Please try again or contact support.' });
  }
});

export default router;

