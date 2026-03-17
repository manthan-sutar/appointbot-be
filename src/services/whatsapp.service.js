import 'dotenv/config';
import { query } from '../config/db.js';

const GLOBAL_ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN    || '';
const GLOBAL_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GLOBAL_API_VERSION     = process.env.WHATSAPP_API_VERSION     || 'v21.0';
const DEFAULT_BUSINESS_ID    = parseInt(process.env.DEFAULT_BUSINESS_ID || '1', 10);

async function getBusinessWhatsAppConfig(businessId) {
  if (!businessId || businessId === DEFAULT_BUSINESS_ID) {
    return {
      accessToken:   GLOBAL_ACCESS_TOKEN,
      phoneNumberId: GLOBAL_PHONE_NUMBER_ID,
      apiVersion:    GLOBAL_API_VERSION,
    };
  }

  const { rows } = await query(
    `SELECT whatsapp_access_token, whatsapp_phone_number_id, whatsapp_api_version
     FROM businesses WHERE id = $1`,
    [businessId],
  );

  const row = rows[0] || {};
  return {
    accessToken:   row.whatsapp_access_token    || '',
    phoneNumberId: row.whatsapp_phone_number_id || '',
    apiVersion:    row.whatsapp_api_version     || GLOBAL_API_VERSION,
  };
}

export { getBusinessWhatsAppConfig };

// ─── Send with retry ──────────────────────────────────────────────────────────
// Retries once after 2 s on network/5xx errors.
// Does NOT retry 401 / token errors since a second attempt would fail the same way.

async function sendWithRetry(url, payload, headers, businessId, maxRetries = 1) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify(payload),
      });
    } catch (networkErr) {
      if (attempt < maxRetries) {
        console.warn(`[WhatsApp] Network error (biz ${businessId}), retrying in 2 s…`, networkErr.message);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      throw networkErr;
    }

    if (res.ok) return; // success

    let errBody;
    try { errBody = await res.json(); } catch { errBody = {}; }
    const errMsg = errBody?.error?.message || res.statusText;
    const code   = errBody?.error?.code;

    // Token expired / auth failure — log clearly and do not retry
    // Code 190 = "session invalid because user logged out" → token revoked or expired; re-auth needed
    if (res.status === 401 || code === 190 || code === 102) {
      console.error(
        `[WhatsApp] Auth error (biz ${businessId}) — access token invalid. Code: ${code}. ${errMsg}`,
        '\n  → Fix: Get a new token (Meta Developer Console or re-run Connect WhatsApp in dashboard) and set WHATSAPP_ACCESS_TOKEN in .env or reconnect the business.',
      );
      throw new Error(`WhatsApp auth error: ${errMsg}`);
    }

    // 24-hour conversation window closed — freeform text is rejected by Meta.
    // Business must use an approved utility message template instead.
    // Code 131026 = "Message failed to send because more than 24 hours have passed since the customer last replied"
    // Code 131047 = Re-engagement message blocked (same root cause)
    if (code === 131026 || code === 131047) {
      console.error(
        `[WhatsApp] 24-hour window closed (biz ${businessId}) — freeform text rejected. Code: ${code}.`,
        '\n  → Fix: Configure a WhatsApp utility message template and set WHATSAPP_REMINDER_TEMPLATE_NAME in .env',
        '\n         or set whatsapp_reminder_template on the business record.',
        '\n         See: https://business.whatsapp.com/products/platform-pricing',
      );
      throw new Error(`WhatsApp window closed (131026): ${errMsg}`);
    }

    // Rate limit — do not retry
    if (res.status === 429) {
      console.error(`[WhatsApp] Rate limited (biz ${businessId}). ${errMsg}`);
      throw new Error(`WhatsApp rate limit: ${errMsg}`);
    }

    if (attempt < maxRetries) {
      console.warn(`[WhatsApp] Send failed (biz ${businessId}), HTTP ${res.status} — retrying in 2 s… ${errMsg}`);
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    throw new Error(`WhatsApp send failed: ${errMsg}`);
  }
}

// ─── Send a WhatsApp text message via Meta Cloud API ─────────────────────────

export async function sendWhatsAppText(to, body, businessId) {
  const { accessToken, phoneNumberId, apiVersion } = await getBusinessWhatsAppConfig(businessId);

  if (!accessToken || !phoneNumberId) {
    console.warn(
      `[WhatsApp] Cloud API not configured — skipping message to ${to} (biz ${businessId ?? 'global'})`,
    );
    return;
  }

  const url     = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const cleanTo = String(to || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();

  const payload = {
    messaging_product: 'whatsapp',
    to:    cleanTo,
    type:  'text',
    text:  { body },
  };

  console.log('[WhatsApp] Outgoing message:', {
    to:          cleanTo,
    businessId:  businessId ?? null,
    bodyPreview: typeof body === 'string' ? body.slice(0, 80) : body,
  });

  await sendWithRetry(
    url,
    payload,
    { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    businessId,
    1,
  );
}

// ─── Send a WhatsApp template message via Meta Cloud API ─────────────────────
// Templates bypass the 24-hour conversation window and are required for
// business-initiated messages (e.g. appointment reminders sent days after booking).
// bodyParams: array of plain-text values for {{1}}, {{2}}, … in the template body.

export async function sendWhatsAppTemplate(to, templateName, bodyParams = [], businessId, languageCode = 'en') {
  const { accessToken, phoneNumberId, apiVersion } = await getBusinessWhatsAppConfig(businessId);

  if (!accessToken || !phoneNumberId) {
    console.warn(
      `[WhatsApp] Cloud API not configured — skipping template "${templateName}" to ${to} (biz ${businessId ?? 'global'})`,
    );
    return;
  }

  const url     = `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`;
  const cleanTo = String(to || '').replace(/^whatsapp:/i, '').replace(/^\+/, '').trim();

  const payload = {
    messaging_product: 'whatsapp',
    to:   cleanTo,
    type: 'template',
    template: {
      name:     templateName,
      language: { code: languageCode },
      components: bodyParams.length
        ? [{ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })) }]
        : [],
    },
  };

  console.log('[WhatsApp] Outgoing template:', {
    to:           cleanTo,
    businessId:   businessId ?? null,
    template:     templateName,
    paramsCount:  bodyParams.length,
  });

  await sendWithRetry(
    url,
    payload,
    { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    businessId,
    1,
  );
}
