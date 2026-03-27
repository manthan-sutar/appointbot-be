import cron from 'node-cron';
import {
  getAppointmentsDueFor24hReminder,
  getAppointmentsDueFor2hReminder,
  markReminder24hSent,
  markReminder2hSent,
  autoCancelExpiredUnconfirmedAppointments,
} from './appointment.service.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from './whatsapp.service.js';
import { processDroppedLeadsAndFollowUps } from './lead.service.js';
import { processCampaignAutoRetries, processScheduledCampaigns } from './campaign.service.js';
import { runIdempotentJob } from './async-job.service.js';

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

async function sendTwoHourConfirmationReminder(appt) {
  const d = new Date(appt.scheduled_at);
  const tz = appt.business_timezone || 'Asia/Kolkata';
  const apptDate = d.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: tz,
  });
  const apptTime = d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: tz,
  });

  const message =
    `Reminder: Your ${appt.service_name || 'appointment'} is at ${apptTime} on ${apptDate}.\n\n` +
    `Please confirm by replying: *Yes I'll come*.\n` +
    `If not confirmed, we may auto-cancel to free your slot.`;

  await sendWhatsAppText(appt.customer_phone, message, appt.business_id);
}

// ─── Run reminder check every hour ───────────────────────────────────────────
export function startReminderScheduler() {
  cron.schedule('*/10 * * * *', async () => {
    console.log('[Reminders] Running reminder + no-show checks…');
    try {
      const bucketKey = new Date().toISOString().slice(0, 16); // minute-bucket key
      const [due24h, due2h] = await Promise.all([
        getAppointmentsDueFor24hReminder(),
        getAppointmentsDueFor2hReminder(),
      ]);
      console.log(
        `[Reminders] Due 24h: ${due24h.length}, due 2h confirmations: ${due2h.length}`,
      );

      for (const appt of due24h) {
        try {
          await sendReminder(appt);
          await markReminder24hSent(appt.id);
        } catch (err) {
          console.error(`[Reminders] Failed 24h reminder for #${appt.id}:`, err.message);
        }
      }

      for (const appt of due2h) {
        try {
          await sendTwoHourConfirmationReminder(appt);
          await markReminder2hSent(appt.id);
        } catch (err) {
          console.error(`[Reminders] Failed 2h reminder for #${appt.id}:`, err.message);
        }
      }

      const autoCancelled = await autoCancelExpiredUnconfirmedAppointments();
      if (autoCancelled.length) {
        console.log(`[Reminders] Auto-cancelled ${autoCancelled.length} unconfirmed appointment(s)`);
      }

      const droppedLeadsRun = await runIdempotentJob({
        jobName: 'process_dropped_leads',
        jobKey: bucketKey,
        maxAttempts: 3,
        handler: () => processDroppedLeadsAndFollowUps(),
      });
      if (!droppedLeadsRun.skipped && droppedLeadsRun.result) {
        console.log(`[Leads] Processed ${droppedLeadsRun.result} dropped lead(s)`);
      }

      const scheduledCampaignsRun = await runIdempotentJob({
        jobName: 'process_scheduled_campaigns',
        jobKey: bucketKey,
        maxAttempts: 3,
        handler: () => processScheduledCampaigns(),
      });
      if (!scheduledCampaignsRun.skipped && scheduledCampaignsRun.result) {
        console.log(`[Campaigns] Processed ${scheduledCampaignsRun.result} scheduled campaign(s)`);
      }

      const autoRetryRun = await runIdempotentJob({
        jobName: 'process_campaign_auto_retries',
        jobKey: bucketKey,
        maxAttempts: 3,
        handler: () => processCampaignAutoRetries(),
      });
      const autoRetryResult = autoRetryRun.result;
      if (!autoRetryRun.skipped && autoRetryResult?.processed) {
        console.log(
          `[Campaigns] Auto-retry processed ${autoRetryResult.processed} (recovered: ${autoRetryResult.recovered}, still failed: ${autoRetryResult.stillFailed})`,
        );
      }
    } catch (err) {
      console.error('[Reminders] Scheduler error:', err.message);
    }
  });

  const mode = GLOBAL_TEMPLATE_NAME
    ? `template mode ("${GLOBAL_TEMPLATE_NAME}")`
    : 'template REQUIRED (set WHATSAPP_REMINDER_TEMPLATE)';
  console.log(`[Reminders] Scheduler started — runs every 10 minutes — ${mode}`);
}
