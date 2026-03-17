import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { deleteSession } from '../services/session.service.js';
import { getBusinessBySlug, getBusiness } from '../services/appointment.service.js';

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

  const { message } = req.body;
  const testPhone = `test-${biz.slug || biz.id}`;
  const port = process.env.PORT || 3000;

  try {
    const response = await fetch(`http://localhost:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ From: testPhone, Body: message, businessId: biz.id }),
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
      body: JSON.stringify({ From: testPhone, Body: req.body.message, businessId: biz?.id || DEFAULT_BUSINESS_ID }),
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
