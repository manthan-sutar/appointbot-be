import twilio from 'twilio';
import 'dotenv/config';

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const from       = process.env.TWILIO_WHATSAPP_FROM;

let client = null;

function getClient() {
  if (!client && accountSid && authToken) {
    client = twilio(accountSid, authToken);
  }
  return client;
}

// ─── Send a plain WhatsApp text message via legacy provider ─────────────────
export async function sendMessage(to, body) {
  const c = getClient();
  if (!c) {
    console.warn('[LegacyWhatsApp] Not configured — skipping outbound message');
    return null;
  }
  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  return c.messages.create({ from: `whatsapp:${from}`, to: toNumber, body });
}

// ─── Send quick-reply buttons (requires Content Template SID) ─────────────────
export async function sendQuickReplies(to, contentSid, variables = {}) {
  const c = getClient();
  if (!c || !contentSid) return null;
  const toNumber = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  return c.messages.create({
    from: `whatsapp:${from}`,
    to:   toNumber,
    contentSid,
    contentVariables: JSON.stringify(variables),
  });
}
