import Razorpay from 'razorpay';

const PROVIDER = process.env.PAYMENT_PROVIDER || 'none';
const KEY_ID   = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let client = null;
if (PROVIDER === 'razorpay' && KEY_ID && KEY_SECRET) {
  client = new Razorpay({
    key_id: KEY_ID,
    key_secret: KEY_SECRET,
  });
}

export function isRazorpayEnabled() {
  return !!client;
}

// Create a Razorpay subscription for a given plan.
// We expect plan IDs to come from env so you can swap pricing without code changes.
// Optional startAt (Date) will be passed as start_at (epoch seconds) so billing
// begins in the future – useful when upgrading during an in-app free trial.
export async function createRazorpaySubscription({ businessId, plan, customerEmail, startAt = null }) {
  if (!client) {
    throw new Error('RAZORPAY_NOT_CONFIGURED');
  }

  const envKey = plan === 'business' ? 'RAZORPAY_BUSINESS_PLAN_ID' : 'RAZORPAY_PRO_PLAN_ID';
  const planId = process.env[envKey];
  if (!planId) {
    throw new Error(`Missing ${envKey} env var`);
  }

  const payload = {
    plan_id: planId,
    total_count: 12, // 12 billing cycles (1 year) – can be adjusted later
    customer_notify: 1,
    notes: {
      business_id: String(businessId),
      plan,
    },
  };

  if (startAt instanceof Date && !Number.isNaN(startAt.getTime())) {
    payload.start_at = Math.floor(startAt.getTime() / 1000);
  }

  // Attach email if available – helps in Razorpay dashboard
  if (customerEmail) {
    payload.notify_info = {
      notify_email: customerEmail,
    };
  }

  const subscription = await client.subscriptions.create(payload);
  return subscription;
}

/** @param {boolean} cancelAtCycleEnd - true = access until current period ends (Claude-style) */
export async function cancelRazorpaySubscription(subscriptionId, cancelAtCycleEnd = true) {
  if (!client) {
    throw new Error('RAZORPAY_NOT_CONFIGURED');
  }
  if (!subscriptionId) {
    throw new Error('SUBSCRIPTION_ID_REQUIRED');
  }
  return client.subscriptions.cancel(subscriptionId, cancelAtCycleEnd);
}

export async function fetchRazorpaySubscription(subscriptionId) {
  if (!client) {
    throw new Error('RAZORPAY_NOT_CONFIGURED');
  }
  if (!subscriptionId) {
    throw new Error('SUBSCRIPTION_ID_REQUIRED');
  }
  return client.subscriptions.fetch(subscriptionId);
}

