import cron from 'node-cron';
import { getAppointmentsDueForReminder, markReminderSent } from './appointment.service.js';
import { sendWhatsAppTemplate } from './whatsapp.service.js';

// ─── Global template fallback (set WHATSAPP_REMINDER_TEMPLATE in .env) ───────
// Template must be pre-approved in Meta Business Manager as a "Utility" category.
// Expected body variables (in this exact order):
//   {{1}} customer name, {{2}} service name, {{3}} appointment date,
//   {{4}} appointment time, {{5}} business name
// Example template name: "appointment_reminder"
const GLOBAL_TEMPLATE_NAME =
  process.env.WHATSAPP_REMINDER_TEMPLATE ||
  process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || // backward compat
  '';
const GLOBAL_TEMPLATE_LANG = process.env.WHATSAPP_REMINDER_TEMPLATE_LANG || 'en';

// ─── Send one reminder, preferring a template over freeform text ──────────────
// Templates bypass the 24-hour conversation window (required for bookings made
// more than 24 hours before the appointment).

async function sendReminder(appt) {
  const templateName = appt.whatsapp_reminder_template || GLOBAL_TEMPLATE_NAME;
  const tz           = appt.business_timezone || 'Asia/Kolkata';

  if (!templateName) {
    throw new Error(
      `No WhatsApp reminder template configured for biz ${appt.business_id}. Set WHATSAPP_REMINDER_TEMPLATE in .env or whatsapp_reminder_template on the business.`,
    );
  }

  const d = new Date(appt.scheduled_at);
  const tzOpts = { timeZone: tz };

  const customerName = appt.customer_name || 'there';
  const serviceName  = appt.service_name  || 'Appointment';
  const apptDate     = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', ...tzOpts });
  const apptTime     = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOpts });
  const businessName = appt.business_name || 'us';

  await sendWhatsAppTemplate(
    appt.customer_phone,
    templateName,
    [customerName, serviceName, apptDate, apptTime, businessName],
    appt.business_id,
    GLOBAL_TEMPLATE_LANG,
  );

  console.log(
    `[Reminders] Template "${templateName}" sent for appt #${appt.id} to ${appt.customer_phone}`,
  );
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
    : 'template REQUIRED (set WHATSAPP_REMINDER_TEMPLATE)';
  console.log(`[Reminders] Scheduler started — runs every hour — ${mode}`);
}
