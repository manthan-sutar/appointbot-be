import { query } from '../config/db.js';

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\s+/g, '')
    .trim();
}

export async function setCampaignOptOut({
  businessId,
  customerPhone,
  optOut,
  reason = null,
}) {
  const phone = normalizePhone(customerPhone);
  if (!businessId || !phone) return null;
  const { rows } = await query(
    `INSERT INTO messaging_preferences (
       business_id, customer_phone, campaign_opt_out, opt_out_reason, updated_at
     )
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (business_id, customer_phone) DO UPDATE
       SET campaign_opt_out = EXCLUDED.campaign_opt_out,
           opt_out_reason = EXCLUDED.opt_out_reason,
           updated_at = NOW()
     RETURNING *`,
    [businessId, phone, !!optOut, reason || null],
  );
  return rows[0] || null;
}

export async function isCampaignOptedOut({ businessId, customerPhone }) {
  const phone = normalizePhone(customerPhone);
  if (!businessId || !phone) return false;
  const { rows } = await query(
    `SELECT campaign_opt_out
     FROM messaging_preferences
     WHERE business_id = $1
       AND customer_phone = $2`,
    [businessId, phone],
  );
  return !!rows[0]?.campaign_opt_out;
}

export async function listCampaignOptOutPreferences({
  businessId,
  search = '',
  limit = 100,
}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const trimmedSearch = String(search || '').trim().toLowerCase();
  const params = [businessId];
  let where = `mp.business_id = $1 AND mp.campaign_opt_out = TRUE`;
  if (trimmedSearch) {
    params.push(`%${trimmedSearch}%`);
    where += ` AND LOWER(mp.customer_phone) LIKE $${params.length}`;
  }
  params.push(safeLimit);
  const { rows } = await query(
    `SELECT mp.customer_phone, mp.opt_out_reason, mp.updated_at
     FROM messaging_preferences mp
     WHERE ${where}
     ORDER BY mp.updated_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows;
}

