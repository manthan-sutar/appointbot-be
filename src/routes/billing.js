import express from 'express';
import { query } from '../config/db.js';
import { requireAuth } from '../middleware/auth.js';
import { createRazorpaySubscription, isRazorpayEnabled } from '../services/razorpay.service.js';

const router = express.Router();
router.use(requireAuth);

// Helper to load subscription + derived trial info
async function getSubscriptionForBusiness(businessId) {
  const { rows } = await query(
    `SELECT business_id, plan, status, trial_ends_at, current_period_end, gateway,
            external_customer_id, external_subscription_id, started_at
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

  return {
    ...sub,
    trialActive,
    trialDaysLeft,
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

export default router;

