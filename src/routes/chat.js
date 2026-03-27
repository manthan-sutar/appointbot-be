import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { deleteSession } from '../services/session.service.js';
import { getBusinessBySlug, getBusiness } from '../services/appointment.service.js';
import { upsertLeadActivity, trackLeadEvent } from '../services/lead.service.js';
import { validateWidgetApiKey } from '../middleware/widgetAuth.js';
import { serveWidgetScript } from './widget-public.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const DEFAULT_BUSINESS_ID = parseInt(process.env.DEFAULT_BUSINESS_ID || '1', 10);

/**
 * Base URL to POST /webhook on this same Node process.
 * Do NOT use BACKEND_URL here — it often points at production (emails, widget embeds)
 * while you are running locally; that breaks the chat proxy with timeouts / wrong DB.
 */
function webhookBaseUrl(req) {
  const host = req?.get?.("host");
  if (host) {
    const proto = req.protocol || "http";
    return `${proto}://${host}`.replace(/\/$/, "");
  }
  const port = process.env.PORT || 3000;
  const fallback =
    process.env.INTERNAL_WEBHOOK_BASE_URL || `http://127.0.0.1:${port}`;
  return String(fallback).replace(/\/$/, "");
}

// ─── Helper: resolve business from slug or fallback ───────────────────────────
async function resolveBusiness(slug) {
  if (slug) {
    const biz = await getBusinessBySlug(slug);
    if (biz) return biz;
  }
  return getBusiness(DEFAULT_BUSINESS_ID);
}

// ─── GET /chat/:slug/widget.js — same self-contained bundle as GET /widget.js (legacy path)
router.get('/:slug/widget.js', validateWidgetApiKey, serveWidgetScript);

// ─── GET /chat — legacy root (redirects to default slug) ─────────────────────
router.get('/', async (req, res) => {
  const biz = await getBusiness(DEFAULT_BUSINESS_ID);
  if (biz?.slug) return res.redirect(`/chat/${biz.slug}`);
  res.sendFile(path.join(__dirname, '../../public/chat.html'));
});

// ─── GET /chat/:slug — per-tenant chat UI ────────────────────────────────────
router.get('/:slug', async (req, res) => {
  const biz = await resolveBusiness(req.params.slug);
  if (!biz) return res.status(404).send('Business not found');
  const htmlPath = path.join(__dirname, '../../public/chat.html');
  let html = await fs.readFile(htmlPath, 'utf8');
  const inject =
    '<script>window.__APPOINTBOT__=' +
    JSON.stringify({
      name: biz.name,
      slug: biz.slug || req.params.slug,
    }) +
    '<\/script>';
  html = html.replace('</head>', `${inject}</head>`);
  res.type('html').send(html);
});

// ─── POST /chat/:slug/send — proxy message to webhook ────────────────────────
router.post('/:slug/send', async (req, res) => {
  const biz = await resolveBusiness(req.params.slug);
  if (!biz) return res.status(404).json({ reply: 'Business not found' });

  const { message, source, campaign, utmSource } = req.body;
  const testPhone = `test-${biz.slug || biz.id}`;

  try {
    const lead = await upsertLeadActivity({
      businessId: biz.id,
      customerPhone: testPhone,
      source: source || 'website_chat_widget',
      status: 'engaged',
    });
    if (lead) {
      await trackLeadEvent({
        leadId: lead.id,
        businessId: biz.id,
        eventType: 'lead_message_received',
        eventData: { channel: 'chat_widget', source: source || 'website_chat_widget', campaign: campaign || null, utmSource: utmSource || null },
      });
    }

    const response = await fetch(`${webhookBaseUrl(req)}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: testPhone,
        Body: message,
        businessId: biz.id,
        source: source || 'website_chat_widget',
        campaign: campaign || null,
        utmSource: utmSource || null,
      }),
    });
    const text = await response.text();
    res.json({ reply: text, businessName: biz.name });
  } catch (err) {
    console.error('[Chat] Proxy error:', err.message);
    res.status(500).json({ reply: 'Error connecting to bot. Is the server running?' });
  }
});

// ─── POST /chat/send — legacy (uses default business) ────────────────────────
router.post('/send', async (req, res) => {
  const biz = await getBusiness(DEFAULT_BUSINESS_ID);
  const slug = biz?.slug || 'default';
  req.params = { slug };
  // Re-use slug handler
  const testPhone = `test-${slug}`;
  try {
    const response = await fetch(`${webhookBaseUrl(req)}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        From: testPhone,
        Body: req.body.message,
        businessId: biz?.id || DEFAULT_BUSINESS_ID,
        source: req.body.source || 'website_chat_widget',
        campaign: req.body.campaign || null,
        utmSource: req.body.utmSource || null,
      }),
    });
    const text = await response.text();
    res.json({ reply: text });
  } catch (err) {
    res.status(500).json({ reply: 'Error connecting to bot.' });
  }
});

// ─── DELETE /chat/:slug/reset — reset test session ───────────────────────────
router.delete('/:slug/reset', async (req, res) => {
  try {
    const biz = await resolveBusiness(req.params.slug);
    if (!biz) return res.status(404).json({ ok: false });
    await deleteSession(`test-${biz.slug || biz.id}`, biz.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── DELETE /chat/reset — legacy reset ───────────────────────────────────────
router.delete('/reset', async (req, res) => {
  try {
    const biz = await getBusiness(DEFAULT_BUSINESS_ID);
    await deleteSession(`test-${biz?.slug || DEFAULT_BUSINESS_ID}`, DEFAULT_BUSINESS_ID);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
