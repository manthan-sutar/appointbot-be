import cron from 'node-cron';
import { getAppointmentsDueForReminder, markReminderSent } from './appointment.service.js';
import { sendWhatsAppText, sendWhatsAppTemplate } from './whatsapp.service.js';
import { formatReminderMessage, formatDateTime } from '../utils/formatter.js';

// ─── Global template fallback (set WHATSAPP_REMINDER_TEMPLATE_NAME in .env) ──
// Template must be pre-approved in Meta Business Manager as a "Utility" category.
// Expected body variables: {{1}} customer name, {{2}} business name,
//   {{3}} service name, {{4}} staff name, {{5}} date & time string.
// Example template name: "appointbot_reminder"
const GLOBAL_TEMPLATE_NAME = process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || '';
const GLOBAL_TEMPLATE_LANG = process.env.WHATSAPP_REMINDER_TEMPLATE_LANG || 'en';

// ─── Send one reminder, preferring a template over freeform text ──────────────
// Templates bypass the 24-hour conversation window (required for bookings made
// more than 24 hours before the appointment).
// Falls back to plain text only when no template is configured — this works for
// same-day / next-few-hours bookings where the window is still open.

async function sendReminder(appt) {
  const templateName = appt.whatsapp_reminder_template || GLOBAL_TEMPLATE_NAME;
  const tz           = appt.business_timezone || 'Asia/Kolkata';

  if (templateName) {
    // ── Template path ─────────────────────────────────────────────────────────
    const customerName = appt.customer_name || 'there';
    const businessName = appt.business_name || 'us';
    const serviceName  = appt.service_name  || 'Appointment';
    const staffName    = appt.staff_name    || 'our team';
    const dateTime     = formatDateTime(appt.scheduled_at, tz);

    await sendWhatsAppTemplate(
      appt.customer_phone,
      templateName,
      [customerName, businessName, serviceName, staffName, dateTime],
      appt.business_id,
      GLOBAL_TEMPLATE_LANG,
    );

    console.log(
      `[Reminders] Template "${templateName}" sent for appt #${appt.id} to ${appt.customer_phone}`,
    );
  } else {
    // ── Plain-text fallback ───────────────────────────────────────────────────
    // ⚠ Will fail with error 131026 if customer's last message was >24 hours ago.
    // Configure WHATSAPP_REMINDER_TEMPLATE_NAME to fix this.
    console.warn(
      `[Reminders] No template configured for biz ${appt.business_id} — sending freeform text.`,
      'If the customer\'s last message was >24 h ago, Meta will reject this.',
      'Set WHATSAPP_REMINDER_TEMPLATE_NAME in .env to fix.',
    );
    const message = formatReminderMessage(appt, tz);
    await sendWhatsAppText(appt.customer_phone, message, appt.business_id);

    console.log(
      `[Reminders] Plain-text reminder sent for appt #${appt.id} to ${appt.customer_phone}`,
    );
  }
}

// ─── Run reminder check every hour ───────────────────────────────────────────
export function startReminderScheduler() {
  cron.schedule('0 * * * *', async () => {
    console.log('[Reminders] Checking for upcoming appointments…');
    try {
      const appointments = await getAppointmentsDueForReminder();
      console.log(`[Reminders] Found ${appointments.length} appointment(s) to remind`);

      for (const appt of appointments) {
        try {
          await sendReminder(appt);
          await markReminderSent(appt.id);
        } catch (err) {
          console.error(`[Reminders] Failed to send reminder for #${appt.id}:`, err.message);
        }
      }
    } catch (err) {
      console.error('[Reminders] Scheduler error:', err.message);
    }
  });

  const mode = GLOBAL_TEMPLATE_NAME
    ? `template mode ("${GLOBAL_TEMPLATE_NAME}")`
    : 'plain-text mode (no template configured — set WHATSAPP_REMINDER_TEMPLATE_NAME)';
  console.log(`[Reminders] Scheduler started — runs every hour — ${mode}`);
}
