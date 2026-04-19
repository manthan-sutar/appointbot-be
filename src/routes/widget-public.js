import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { deleteSession } from '../services/session.service.js';
import { upsertLeadActivity, trackLeadEvent } from '../services/lead.service.js';
import { validateWidgetApiKeyHeader } from '../middleware/widgetAuth.js';
import {
  getPublicBackendUrlForWidget,
  internalWebhookBaseUrl,
} from '../utils/publicBackendUrl.js';
import {
  DEFAULT_WEB_CHAT_WIDGET_SOURCE,
  LEAD_SOURCE,
} from '../constants/leadSources.js';
import { widgetChatBodySchema, formatZodError } from '../validation/schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * GET /widget.js?api_key= — returns self-contained script (same UI as /chat/:slug, no iframe).
 */
export async function serveWidgetScript(req, res) {
  const biz = req.business;
  if (!biz) {
    return res.status(500).type('application/javascript').send('// Missing business context.');
  }

  const apiKey = req.query.api_key || req.query.apiKey;

  const baseUrl = getPublicBackendUrlForWidget(req);

  const publicDir = path.join(__dirname, '../../public');
  let css;
  let runtime;
  try {
    css = await fs.readFile(path.join(publicDir, 'widget-embed.css'), 'utf8');
    runtime = await fs.readFile(path.join(publicDir, 'widget-embed-runtime.js'), 'utf8');
  } catch (e) {
    console.error('[Widget] Failed to read embed assets:', e.message);
    return res.status(500).type('application/javascript').send('// Widget bundle missing on server.');
  }

  const cfg = {
    baseUrl,
    apiKey,
    brandName: biz.name || 'Chat',
    slug: biz.slug || String(biz.id),
    css,
  };

  const payload = `window.__APPOINTBOT_WIDGET__=${JSON.stringify(cfg)};\n${runtime}`;
  res.type('application/javascript').send(payload);
}

const router = express.Router();

router.post('/chat', validateWidgetApiKeyHeader, async (req, res) => {
  const biz = req.business;
  const parsed = widgetChatBodySchema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: formatZodError(parsed.error) });
  }
  const { message, source, campaign, utmSource } = parsed.data;

  const resolvedSource = source || DEFAULT_WEB_CHAT_WIDGET_SOURCE;
  const testPhone = `test-${biz.slug || biz.id}`;

  try {
    const lead = await upsertLeadActivity({
      businessId: biz.id,
      customerPhone: testPhone,
      source: resolvedSource,
      status: 'engaged',
    });
    if (lead) {
      await trackLeadEvent({
        leadId: lead.id,
        businessId: biz.id,
        eventType: 'lead_message_received',
        eventData: {
          channel: LEAD_SOURCE.WEB_CHAT_WIDGET,
          source: resolvedSource,
          campaign: campaign || null,
          utmSource: utmSource || null,
        },
      });
    }

    const response = await fetch(`${internalWebhookBaseUrl(req)}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: testPhone,
        Body: message,
        businessId: biz.id,
        source: resolvedSource,
        campaign: campaign || null,
        utmSource: utmSource || null,
      }),
    });
    const text = await response.text();
    res.json({ reply: text, businessName: biz.name });
  } catch (err) {
    console.error('[Widget API] Chat error:', err.message);
    res.status(500).json({ reply: 'Error connecting to bot.' });
  }
});

router.delete('/session', validateWidgetApiKeyHeader, async (req, res) => {
  const biz = req.business;
  const testPhone = `test-${biz.slug || biz.id}`;
  try {
    await deleteSession(testPhone, biz.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
