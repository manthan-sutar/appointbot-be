import { query } from '../config/db.js';
import { sendWhatsAppText } from './whatsapp.service.js';

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\s+/g, '')
    .trim();
}

export async function upsertLeadActivity({
  businessId,
  customerPhone,
  source = 'unknown',
  status = 'engaged',
}) {
  const phone = normalizePhone(customerPhone);
  if (!businessId || !phone) return null;

  const { rows } = await query(
    `INSERT INTO leads (business_id, customer_phone, source, status, first_seen_at, last_activity_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())
     ON CONFLICT (business_id, customer_phone) DO UPDATE
       SET source = COALESCE(leads.source, EXCLUDED.source),
           status = CASE
             WHEN leads.status = 'converted' THEN leads.status
             ELSE EXCLUDED.status
           END,
           last_activity_at = NOW()
     RETURNING *`,
    [businessId, phone, source, status],
  );
  return rows[0] || null;
}

export async function trackLeadEvent({ leadId, businessId, eventType, eventData = {} }) {
  if (!leadId || !businessId || !eventType) return;
  await query(
    `INSERT INTO lead_events (lead_id, business_id, event_type, event_data)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [leadId, businessId, eventType, JSON.stringify(eventData || {})],
  );
}

export async function markLeadConverted({ businessId, customerPhone, conversionSource = 'booking' }) {
  const phone = normalizePhone(customerPhone);
  if (!businessId || !phone) return null;

  const { rows } = await query(
    `UPDATE leads
     SET status = 'converted',
         converted_at = COALESCE(converted_at, NOW()),
         last_activity_at = NOW()
     WHERE business_id = $1
       AND customer_phone = $2
     RETURNING *`,
    [businessId, phone],
  );
  const lead = rows[0] || null;
  if (lead) {
    await trackLeadEvent({
      leadId: lead.id,
      businessId,
      eventType: 'lead_converted',
      eventData: {
        conversionSource,
        leadSource: lead.source || null,
      },
    });
  }
  return lead;
}

export async function processDroppedLeadsAndFollowUps() {
  const { rows } = await query(
    `WITH stale AS (
       SELECT id, business_id, customer_phone
       FROM leads
       WHERE status IN ('new', 'engaged')
         AND converted_at IS NULL
         AND last_activity_at <= NOW() - INTERVAL '30 minutes'
       LIMIT 200
     )
     UPDATE leads l
     SET status = 'dropped'
     FROM stale s
     WHERE l.id = s.id
     RETURNING l.id, l.business_id, l.customer_phone, l.followup_sent_at`,
    [],
  );

  for (const lead of rows) {
    await trackLeadEvent({
      leadId: lead.id,
      businessId: lead.business_id,
      eventType: 'lead_dropped_auto',
      eventData: { reason: 'inactive_30m' },
    });

    const isTestPhone = String(lead.customer_phone).startsWith('test-');
    if (!isTestPhone && !lead.followup_sent_at) {
      try {
        await sendWhatsAppText(
          lead.customer_phone,
          "Hi! We noticed you didn't complete your booking. Reply here and we'll help you lock your preferred slot.",
          lead.business_id,
        );
        await query(
          `UPDATE leads
           SET followup_sent_at = NOW()
           WHERE id = $1`,
          [lead.id],
        );
        await trackLeadEvent({
          leadId: lead.id,
          businessId: lead.business_id,
          eventType: 'lead_followup_sent',
          eventData: {},
        });
      } catch (err) {
        // Keep job resilient; next scheduler run can retry if needed.
        // eslint-disable-next-line no-console
        console.error('[Lead] Failed follow-up send:', err.message);
      }
    }
  }

  return rows.length;
}
