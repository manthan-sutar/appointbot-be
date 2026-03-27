import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { deleteSession } from '../services/session.service.js';
import { getBusinessBySlug, getBusiness } from '../services/appointment.service.js';
import { upsertLeadActivity, trackLeadEvent } from '../services/lead.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const DEFAULT_BUSINESS_ID = parseInt(process.env.DEFAULT_BUSINESS_ID || '1', 10);

// ─── Helper: resolve business from slug or fallback ───────────────────────────
async function resolveBusiness(slug) {
  if (slug) {
    const biz = await getBusinessBySlug(slug);
    if (biz) return biz;
  }
  return getBusiness(DEFAULT_BUSINESS_ID);
}

// ─── GET /chat/:slug/widget.js — embeddable website chat bubble ──────────────
router.get('/:slug/widget.js', async (req, res) => {
  const biz = await resolveBusiness(req.params.slug);
  if (!biz) return res.status(404).type('application/javascript').send('// Business not found');

  const script = `(function () {
    if (window.__appointbotWidgetLoaded) return;
    window.__appointbotWidgetLoaded = true;
    var slug = ${JSON.stringify(biz.slug || req.params.slug)};
    var iframe = document.createElement('iframe');
    iframe.src = window.location.origin + '/chat/' + encodeURIComponent(slug) + '?embed=1&source=website_chat_widget';
    iframe.style.position = 'fixed';
    iframe.style.right = '20px';
    iframe.style.bottom = '20px';
    iframe.style.width = '380px';
    iframe.style.height = '620px';
    iframe.style.border = '0';
    iframe.style.borderRadius = '16px';
    iframe.style.boxShadow = '0 18px 50px rgba(0,0,0,0.25)';
    iframe.style.zIndex = '2147483000';
    iframe.style.display = 'none';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Chat with us';
    btn.style.position = 'fixed';
    btn.style.right = '20px';
    btn.style.bottom = '20px';
    btn.style.background = '#16a34a';
    btn.style.color = '#fff';
    btn.style.border = '0';
    btn.style.borderRadius = '9999px';
    btn.style.padding = '12px 16px';
    btn.style.font = '600 14px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
    btn.style.boxShadow = '0 10px 24px rgba(0,0,0,0.2)';
    btn.style.cursor = 'pointer';
    btn.style.zIndex = '2147483001';

    var open = false;
    btn.addEventListener('click', function () {
      open = !open;
      iframe.style.display = open ? 'block' : 'none';
      btn.textContent = open ? 'Close chat' : 'Chat with us';
    });

    document.body.appendChild(iframe);
    document.body.appendChild(btn);
  })();`;

  return res.type('application/javascript').send(script);
});

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
  // Serve chat.html — business info is injected via query params read by the UI
  res.sendFile(path.join(__dirname, '../../public/chat.html'));
});

// ─── POST /chat/:slug/send — proxy message to webhook ────────────────────────
router.post('/:slug/send', async (req, res) => {
  const biz = await resolveBusiness(req.params.slug);
  if (!biz) return res.status(404).json({ reply: 'Business not found' });

  const { message, source, campaign, utmSource } = req.body;
  const testPhone = `test-${biz.slug || biz.id}`;
  const port = process.env.PORT || 3000;

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

    const response = await fetch(`http://localhost:${port}/webhook`, {
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
  const port = process.env.PORT || 3000;
  try {
    const response = await fetch(`http://localhost:${port}/webhook`, {
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
