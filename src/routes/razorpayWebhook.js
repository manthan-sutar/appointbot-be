import express from 'express';
import crypto from 'crypto';
import { query } from '../config/db.js';

const router = express.Router();

// Razorpay sends events like:
// - subscription.activated
// - subscription.charged
// - subscription.completed
// - subscription.halted / paused
// - subscription.cancelled
//
// We only care about subscription.* for now. We verify the signature using
// RAZORPAY_WEBHOOK_SECRET so you can safely expose this endpoint publicly.

function verifySignature(payload, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[Razorpay] No RAZORPAY_WEBHOOK_SECRET set — skipping verification (NOT recommended in production).');
    return true;
  }
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');
  return expected === signature;
}

async function updateSubscriptionFromEvent(event) {
  const { entity } = event;
  if (!entity || entity.entity !== 'subscription') return;

  const extId = entity.id;
  if (!extId) return;

  // Map Razorpay status → internal status
  let status = 'active';
  switch (entity.status) {
    case 'active':
    case 'authenticated':
      status = 'active';
      break;
    case 'completed':
      status = 'active';
      break;
    case 'halted':
    case 'paused':
      status = 'past_due';
      break;
    case 'cancelled':
      status = 'canceled';
      break;
    default:
      status = 'active';
  }

  const periodEnd = entity.current_end ? new Date(entity.current_end * 1000) : null;

  // Plan can be taken either from notes.plan (we set this when creating)
  // or fall back to existing value in DB.
  const notedPlan = entity.notes?.plan;

  const params = [];
  const sets = [];

  sets.push(`status = $${sets.length + 1}`);
  params.push(status);

  if (periodEnd) {
    sets.push(`current_period_end = $${sets.length + 1}`);
    params.push(periodEnd);
  }

  if (notedPlan) {
    sets.push(`plan = $${sets.length + 1}`);
    params.push(notedPlan);
  }

  // If we were in trial and got activated, end the trial
  sets.push(`trial_ends_at = CASE WHEN status = 'trialing' AND trial_ends_at < NOW() THEN trial_ends_at ELSE NULL END`);

  const sql = `
    UPDATE subscriptions
       SET ${sets.join(', ')}
     WHERE external_subscription_id = $${sets.length + 1}
  `;
  params.push(extId);

  await query(sql, params);
}

// Note: we use express.raw *only* for this route so the signature check can use
// the exact raw body. This is mounted under /webhooks so it doesn't conflict
// with normal JSON API routes.
router.post('/razorpay', express.raw({ type: 'application/json' }), async (req, res) => {
  const payload = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
  const signature = req.headers['x-razorpay-signature'];

  if (!verifySignature(payload, signature)) {
    console.warn('[Razorpay] Invalid webhook signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(payload.toString('utf8'));
  } catch (err) {
    console.error('[Razorpay] Failed to parse webhook JSON:', err);
    return res.status(400).send('Invalid payload');
  }

  try {
    if (event.entity && event.entity.entity === 'subscription') {
      await updateSubscriptionFromEvent(event);
    } else if (event.payload && event.payload.subscription) {
      // Some events nest under payload.subscription.entity
      await updateSubscriptionFromEvent(event.payload.subscription);
    }
  } catch (err) {
    console.error('[Razorpay] Webhook handling failed:', err);
    // Still 200 so Razorpay does not keep retrying forever; log for investigation.
  }

  res.status(200).send('ok');
});

export default router;

