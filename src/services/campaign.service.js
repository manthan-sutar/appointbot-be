import { query } from '../config/db.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp.service.js';

const VALID_AUDIENCE_TYPES = new Set([
  'all_leads',
  'dropped_leads',
  'converted_leads',
  'recent_customers_30d',
]);
const AUTO_RETRY_MAX_ATTEMPTS = Math.min(
  Math.max(parseInt(process.env.CAMPAIGN_AUTO_RETRY_MAX_ATTEMPTS || '3', 10) || 3, 1),
  10,
);
const CAMPAIGN_MAX_RECIPIENTS_PER_SEND = Math.min(
  Math.max(parseInt(process.env.CAMPAIGN_MAX_RECIPIENTS_PER_SEND || '1000', 10) || 1000, 1),
  10000,
);

function normalizeAudienceType(audienceType) {
  const v = String(audienceType || 'all_leads').trim();
  return VALID_AUDIENCE_TYPES.has(v) ? v : 'all_leads';
}

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\s+/g, '')
    .trim();
}

function getAudienceWhereClause(audienceType) {
  if (audienceType === 'dropped_leads') return `l.status = 'dropped'`;
  if (audienceType === 'converted_leads') return `l.status = 'converted'`;
  if (audienceType === 'recent_customers_30d') return `l.converted_at >= NOW() - INTERVAL '30 days'`;
  return `TRUE`;
}

export async function createCampaign({
  businessId,
  name,
  message,
  audienceType = 'all_leads',
  sendMode = 'text',
  templateName = null,
  templateLanguage = 'en',
  scheduledAt = null,
  createdByOwnerId = null,
}) {
  const normalizedAudienceType = normalizeAudienceType(audienceType);
  const normalizedSendMode = sendMode === 'template' ? 'template' : 'text';
  const { rows } = await query(
    `INSERT INTO campaigns (
       business_id,
       name,
       channel,
       audience_type,
       send_mode,
       message_text,
       template_name,
       template_language,
       scheduled_at,
       status,
       created_by_owner_id
     )
     VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8, 'draft', $9)
     RETURNING *`,
    [
      businessId,
      name,
      normalizedAudienceType,
      normalizedSendMode,
      message,
      templateName || null,
      templateLanguage || 'en',
      scheduledAt || null,
      createdByOwnerId,
    ],
  );
  return rows[0] || null;
}

export async function listCampaigns(businessId) {
  const { rows } = await query(
    `SELECT *
     FROM campaigns
     WHERE business_id = $1
     ORDER BY created_at DESC`,
    [businessId],
  );
  return rows;
}

export async function sendCampaignNow({ businessId, campaignId }) {
  const campaignRes = await query(
    `UPDATE campaigns
     SET status = 'running',
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND business_id = $2
       AND status IN ('draft', 'failed')
     RETURNING *`,
    [campaignId, businessId],
  );
  const campaign = campaignRes.rows[0];
  if (!campaign) {
    return { error: 'Campaign is not in a sendable state' };
  }
  return executeCampaign(campaign);
}

async function sendToRecipient(campaign, customerPhone) {
  const businessId = campaign.business_id;
  if (campaign.send_mode === 'template') {
    if (!campaign.template_name) {
      throw new Error('Template mode selected but template_name is missing');
    }
    await sendWhatsAppTemplate(
      customerPhone,
      campaign.template_name,
      [],
      businessId,
      campaign.template_language || 'en',
    );
  } else {
    await sendWhatsAppText(customerPhone, campaign.message_text, businessId);
  }
}

async function executeCampaign(campaign) {
  const businessId = campaign.business_id;
  const lockRes = await query(
    `SELECT pg_try_advisory_lock($1::bigint) AS locked`,
    [Number(campaign.id) + 8000000],
  );
  const hasLock = !!lockRes.rows[0]?.locked;
  if (!hasLock) {
    return { ok: false, campaignId: campaign.id, skipped: true, reason: 'campaign_locked' };
  }
  try {

    const { rows: recipients } = await query(
    `SELECT DISTINCT normalize_phone AS customer_phone
     FROM (
       SELECT
         regexp_replace(replace(l.customer_phone, '+', ''), '\s+', '', 'g') AS normalize_phone
       FROM leads l
       LEFT JOIN messaging_preferences mp
         ON mp.business_id = l.business_id
        AND mp.customer_phone = regexp_replace(replace(l.customer_phone, '+', ''), '\s+', '', 'g')
       WHERE l.business_id = $1
         AND ${getAudienceWhereClause(campaign.audience_type)}
         AND l.customer_phone IS NOT NULL
         AND l.customer_phone != ''
         AND COALESCE(mp.campaign_opt_out, FALSE) = FALSE
       UNION
       SELECT
         regexp_replace(replace(a.customer_phone, '+', ''), '\s+', '', 'g') AS normalize_phone
       FROM appointments a
       LEFT JOIN messaging_preferences mp
         ON mp.business_id = a.business_id
        AND mp.customer_phone = regexp_replace(replace(a.customer_phone, '+', ''), '\s+', '', 'g')
       WHERE $2 = 'recent_customers_30d'
         AND a.business_id = $1
         AND a.status = 'completed'
         AND a.scheduled_at >= NOW() - INTERVAL '30 days'
         AND COALESCE(mp.campaign_opt_out, FALSE) = FALSE
     ) r
     WHERE normalize_phone IS NOT NULL
       AND normalize_phone != ''
     LIMIT $3`,
    [businessId, campaign.audience_type, CAMPAIGN_MAX_RECIPIENTS_PER_SEND],
  );

    let sent = 0;
    let failed = 0;

    for (const r of recipients) {
    const customerPhone = normalizePhone(r.customer_phone);
    if (!customerPhone) continue;
    if (customerPhone.startsWith('test-')) {
      await query(
        `INSERT INTO campaign_recipients (campaign_id, business_id, customer_phone, status, error_message, retry_count, next_retry_at)
         VALUES ($1, $2, $3, 'skipped', 'test phone')
         ON CONFLICT (campaign_id, customer_phone) DO UPDATE
           SET status = 'skipped',
               error_message = EXCLUDED.error_message,
               next_retry_at = NULL`,
        [campaign.id, businessId, customerPhone],
      );
      continue;
    }
    try {
      await sendToRecipient(campaign, customerPhone);
      sent += 1;
      await query(
        `INSERT INTO campaign_recipients (campaign_id, business_id, customer_phone, status, sent_at, retry_count, next_retry_at)
         VALUES ($1, $2, $3, 'sent', NOW())
         ON CONFLICT (campaign_id, customer_phone) DO UPDATE
           SET status = 'sent',
               sent_at = NOW(),
               error_message = NULL,
               next_retry_at = NULL`,
        [campaign.id, businessId, customerPhone],
      );
    } catch (err) {
      failed += 1;
      await query(
        `INSERT INTO campaign_recipients (campaign_id, business_id, customer_phone, status, error_message, retry_count, next_retry_at)
         VALUES ($1, $2, $3, 'failed', $4, 0, NOW() + INTERVAL '15 minutes')
         ON CONFLICT (campaign_id, customer_phone) DO UPDATE
           SET status = 'failed',
               error_message = EXCLUDED.error_message,
               next_retry_at = CASE
                 WHEN COALESCE(campaign_recipients.retry_count, 0) >= ${AUTO_RETRY_MAX_ATTEMPTS}
                 THEN NULL
                 ELSE NOW() + INTERVAL '15 minutes'
               END`,
        [campaign.id, businessId, customerPhone, err.message || 'send failed'],
      );
    }
    }

    const totalRecipients = recipients.length;
    const finalStatus = failed > 0 ? 'failed' : 'completed';
    await query(
    `UPDATE campaigns
     SET status = $1,
         sent_at = NOW(),
         total_recipients = $2,
         sent_count = $3,
         failed_count = $4,
         updated_at = NOW()
     WHERE id = $5
       AND business_id = $6`,
    [finalStatus, totalRecipients, sent, failed, campaign.id, businessId],
  );

    return {
      ok: true,
      campaignId: campaign.id,
      totalRecipients,
      sentCount: sent,
      failedCount: failed,
      status: finalStatus,
    };
  } finally {
    await query(`SELECT pg_advisory_unlock($1::bigint)`, [Number(campaign.id) + 8000000]);
  }
}

export async function getCampaignFailures({ businessId, campaignId, limit = 50 }) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const [reasonsRes, failedRecipientsRes] = await Promise.all([
    query(
      `SELECT
         COALESCE(NULLIF(error_message, ''), 'unknown_error') AS reason,
         COUNT(*)::int AS count
       FROM campaign_recipients
       WHERE business_id = $1
         AND campaign_id = $2
         AND status = 'failed'
       GROUP BY COALESCE(NULLIF(error_message, ''), 'unknown_error')
       ORDER BY count DESC
       LIMIT 10`,
      [businessId, campaignId],
    ),
    query(
      `SELECT customer_phone, error_message, created_at
       FROM campaign_recipients
       WHERE business_id = $1
         AND campaign_id = $2
         AND status = 'failed'
       ORDER BY created_at DESC
       LIMIT $3`,
      [businessId, campaignId, safeLimit],
    ),
  ]);

  return {
    topReasons: reasonsRes.rows.map((r) => ({
      reason: r.reason,
      count: Number(r.count || 0),
    })),
    failedRecipients: failedRecipientsRes.rows,
  };
}

export async function retryFailedRecipients({ businessId, campaignId, max = 200 }) {
  const campaignRes = await query(
    `SELECT *
     FROM campaigns
     WHERE id = $1
       AND business_id = $2`,
    [campaignId, businessId],
  );
  const campaign = campaignRes.rows[0];
  if (!campaign) return { error: 'Campaign not found' };

  const safeMax = Math.min(Math.max(Number(max) || 200, 1), 500);
  const failedRes = await query(
    `SELECT DISTINCT customer_phone
     FROM campaign_recipients
     WHERE business_id = $1
       AND campaign_id = $2
       AND status = 'failed'
     ORDER BY customer_phone ASC
     LIMIT $3`,
    [businessId, campaignId, safeMax],
  );

  let retried = 0;
  let recovered = 0;
  let stillFailed = 0;
  for (const row of failedRes.rows) {
    const customerPhone = normalizePhone(row.customer_phone);
    if (!customerPhone) continue;
    retried += 1;
    try {
      await sendToRecipient(campaign, customerPhone);
      recovered += 1;
      await query(
        `UPDATE campaign_recipients
         SET status = 'sent',
             sent_at = NOW(),
             error_message = NULL,
             next_retry_at = NULL
         WHERE campaign_id = $1
           AND business_id = $2
           AND customer_phone = $3`,
        [campaignId, businessId, customerPhone],
      );
    } catch (err) {
      stillFailed += 1;
      await query(
        `UPDATE campaign_recipients
         SET status = 'failed',
             error_message = $4,
             retry_count = COALESCE(retry_count, 0) + 1,
             last_retry_at = NOW(),
             next_retry_at = CASE
               WHEN COALESCE(retry_count, 0) + 1 >= ${AUTO_RETRY_MAX_ATTEMPTS}
               THEN NULL
               WHEN COALESCE(retry_count, 0) = 0 THEN NOW() + INTERVAL '15 minutes'
               WHEN COALESCE(retry_count, 0) = 1 THEN NOW() + INTERVAL '30 minutes'
               ELSE NOW() + INTERVAL '60 minutes'
             END
         WHERE campaign_id = $1
           AND business_id = $2
           AND customer_phone = $3`,
        [campaignId, businessId, customerPhone, err.message || 'retry failed'],
      );
    }
  }

  await query(
    `UPDATE campaigns c
     SET sent_count = sub.sent_count,
         failed_count = sub.failed_count,
         status = CASE WHEN sub.failed_count > 0 THEN 'failed' ELSE 'completed' END,
         updated_at = NOW()
     FROM (
       SELECT
         COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
       FROM campaign_recipients
       WHERE campaign_id = $1
         AND business_id = $2
     ) sub
     WHERE c.id = $1
       AND c.business_id = $2`,
    [campaignId, businessId],
  );

  return { ok: true, retried, recovered, stillFailed };
}

export async function processCampaignAutoRetries({ maxAttempts = AUTO_RETRY_MAX_ATTEMPTS, limit = 200 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const safeMaxAttempts = Math.min(Math.max(Number(maxAttempts) || AUTO_RETRY_MAX_ATTEMPTS, 1), 10);

  const { rows } = await query(
    `SELECT
       cr.campaign_id,
       cr.business_id,
       cr.customer_phone,
       cr.retry_count,
       c.send_mode,
       c.message_text,
       c.template_name,
       c.template_language
     FROM campaign_recipients cr
     JOIN campaigns c ON c.id = cr.campaign_id AND c.business_id = cr.business_id
     WHERE cr.status = 'failed'
       AND cr.next_retry_at IS NOT NULL
       AND cr.next_retry_at <= NOW()
       AND COALESCE(cr.retry_count, 0) < $1
     ORDER BY cr.next_retry_at ASC
     LIMIT $2`,
    [safeMaxAttempts, safeLimit],
  );

  if (!rows.length) return { processed: 0, recovered: 0, stillFailed: 0 };

  let recovered = 0;
  let stillFailed = 0;
  const campaignIdsTouched = new Set();

  for (const row of rows) {
    const campaign = {
      id: row.campaign_id,
      business_id: row.business_id,
      send_mode: row.send_mode,
      message_text: row.message_text,
      template_name: row.template_name,
      template_language: row.template_language,
    };
    const customerPhone = normalizePhone(row.customer_phone);
    campaignIdsTouched.add(campaign.id);
    if (!customerPhone) continue;
    try {
      await sendToRecipient(campaign, customerPhone);
      recovered += 1;
      await query(
        `UPDATE campaign_recipients
         SET status = 'sent',
             sent_at = NOW(),
             error_message = NULL,
             last_retry_at = NOW(),
             next_retry_at = NULL
         WHERE campaign_id = $1
           AND business_id = $2
           AND customer_phone = $3`,
        [campaign.id, campaign.business_id, customerPhone],
      );
    } catch (err) {
      stillFailed += 1;
      await query(
        `UPDATE campaign_recipients
         SET status = 'failed',
             error_message = $4,
             retry_count = COALESCE(retry_count, 0) + 1,
             last_retry_at = NOW(),
             next_retry_at = CASE
               WHEN COALESCE(retry_count, 0) + 1 >= $5 THEN NULL
               WHEN COALESCE(retry_count, 0) = 0 THEN NOW() + INTERVAL '15 minutes'
               WHEN COALESCE(retry_count, 0) = 1 THEN NOW() + INTERVAL '30 minutes'
               ELSE NOW() + INTERVAL '60 minutes'
             END
         WHERE campaign_id = $1
           AND business_id = $2
           AND customer_phone = $3`,
        [campaign.id, campaign.business_id, customerPhone, err.message || 'auto retry failed', safeMaxAttempts],
      );
    }
  }

  for (const campaignId of campaignIdsTouched) {
    await query(
      `UPDATE campaigns c
       SET sent_count = sub.sent_count,
           failed_count = sub.failed_count,
           status = CASE WHEN sub.failed_count > 0 THEN 'failed' ELSE 'completed' END,
           updated_at = NOW()
       FROM (
         SELECT
           COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_count,
           COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count
         FROM campaign_recipients
         WHERE campaign_id = $1
       ) sub
       WHERE c.id = $1`,
      [campaignId],
    );
  }

  return { processed: rows.length, recovered, stillFailed };
}

export async function processScheduledCampaigns() {
  const { rows } = await query(
    `UPDATE campaigns
     SET status = 'running',
         started_at = COALESCE(started_at, NOW()),
         updated_at = NOW()
     WHERE status IN ('draft', 'failed')
       AND scheduled_at IS NOT NULL
       AND scheduled_at <= NOW()
     RETURNING *`,
    [],
  );

  let processed = 0;
  for (const campaign of rows) {
    try {
      await executeCampaign(campaign);
      processed += 1;
    } catch (err) {
      await query(
        `UPDATE campaigns
         SET status = 'failed',
             failed_count = failed_count + 1,
             updated_at = NOW()
         WHERE id = $1`,
        [campaign.id],
      );
      // eslint-disable-next-line no-console
      console.error('[Campaigns] Scheduled campaign failed:', campaign.id, err.message);
    }
  }
  return processed;
}
