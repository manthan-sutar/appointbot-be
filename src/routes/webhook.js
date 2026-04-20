import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { runWithCorrelation } from '../context/correlation.js';
import { inc } from '../utils/metrics.js';
import {
  getSession, updateSession, resetSession, normalizePhone, STATES,
} from '../services/session.service.js';
import {
  getServices, findService, getStaff, getAvailableSlots, getAvailableSlotsForRange,
  getFirstStaffWithSlotsOnDate, localToUTC, findNextSlotNearTime,
  bookAppointment, getUpcomingAppointments, cancelAppointment, rescheduleAppointment,
  getLastBookedService, getMostRecentAppointment,
  getCustomerName, upsertCustomer, getBusiness, getBusinessByPhone, getBusinessByWhatsAppPhoneNumberId,
  markNextPendingAppointmentConfirmedForCustomer,
} from '../services/appointment.service.js';
import {
  extractBookingIntent, classifyMessage, extractConfirmation, answerConversational,
  extractRescheduleIntent, extractAvailabilityQuery,
  generateInactivityNudge, generateDynamicFallbackReply, generateHelpReply,
  generateReturningUserGreeting,
} from '../services/ai.service.js';
import {
  formatWelcome, formatServiceList, formatStaffList, formatSlotList, curateSlots,
  formatConfirmationPrompt, formatBookingConfirmed, formatAppointmentList,
  formatCancellationConfirmed, formatRescheduleConfirmed, formatAvailabilitySummary,
  formatHandoffMessage, formatError, formatNotUnderstood, formatFriendlyFallback,
  formatDate, formatTime, formatDateTime, timeToMinutes, getTimeNotAvailableReason,
  formatShortWhatsAppReply,
} from '../utils/formatter.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../services/whatsapp.service.js';
import { transcribeMetaAudio } from '../services/whisper.service.js';
import { upsertLeadActivity, trackLeadEvent, markLeadConverted } from '../services/lead.service.js';
import {
  DEFAULT_WEB_CHAT_WIDGET_SOURCE,
  LEAD_SOURCE,
} from '../constants/leadSources.js';
import { setCampaignOptOut } from '../services/messaging-preference.service.js';
import {
  matchServiceFromMessage,
  matchServicesFromMessage,
  aggregateMatchedServices,
} from '../utils/serviceMatch.js';
import {
  stripCorrectionPrefix,
  normalizeRelativeDateTypos,
  normalizeCasualServiceTypos,
  extractFallbackRelativeDate,
  specifiesNewBookingServices,
} from '../utils/conversationRepair.js';

const router = express.Router();
const DEFAULT_BUSINESS_ID = parseInt(process.env.DEFAULT_BUSINESS_ID || '1', 10);

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many webhook requests' },
  standardHeaders: true,
  legacyHeaders: false,
});
const GLOBAL_REMINDER_TEMPLATE =
  process.env.WHATSAPP_REMINDER_TEMPLATE ||
  process.env.WHATSAPP_REMINDER_TEMPLATE_NAME || // backward compat
  '';
const GLOBAL_REMINDER_TEMPLATE_LANG = process.env.WHATSAPP_REMINDER_TEMPLATE_LANG || 'en';

// ─── Inactivity nudge scheduler (per phone+business) ─────────────────────────
// After a few minutes of no reply mid-flow, send a gentle, AI-generated nudge.

const NUDGE_DELAY_MS = 5 * 60 * 1000;
const nudgeTimers = new Map(); // key: `${phone}:${businessId}` → { timeoutId, baselineUpdatedAt }

function scheduleInactivityNudge({ phone, businessId, businessName, businessType, lastStepDescription, baselineUpdatedAt }) {
  const key = `${phone}:${businessId}`;
  const existing = nudgeTimers.get(key);
  if (existing?.timeoutId) clearTimeout(existing.timeoutId);

  const timeoutId = setTimeout(async () => {
    try {
      const session = await getSession(phone, businessId);
      // Session timed out or went idle or moved since we scheduled → no nudge.
      if (session.timedOut || session.state === STATES.IDLE) return;
      if (session.updatedAt && baselineUpdatedAt != null && session.updatedAt.toString() !== baselineUpdatedAt.toString()) return;

      const message = await generateInactivityNudge({
        businessName,
        businessType,
        lastStepDescription,
      });
      await sendWhatsAppText(phone, formatShortWhatsAppReply(message), businessId);
    } catch (err) {
      console.error('[Nudge] Failed to send inactivity nudge:', err.message);
    } finally {
      nudgeTimers.delete(key);
    }
  }, NUDGE_DELAY_MS);

  nudgeTimers.set(key, { timeoutId, baselineUpdatedAt });
}

// Cancel any pending nudge for this user — call whenever a new message arrives.
function clearInactivityNudge(phone, businessId) {
  const key = `${phone}:${businessId}`;
  const existing = nudgeTimers.get(key);
  if (existing?.timeoutId) {
    clearTimeout(existing.timeoutId);
    nudgeTimers.delete(key);
  }
}

// ─── Duplicate inbound message guard (Meta can POST the same message twice) ───
// WhatsApp Cloud API includes a stable `id` (wamid.*) per inbound message.
const PROCESSED_WA_MSG_TTL_MS = 48 * 60 * 60 * 1000;
const PROCESSED_WA_MSG_MAX = 5000;
const processedWaInboundMessageIds = new Map(); // id → processedAt (ms)
const inboundWaMessagePending = new Set(); // ids currently being handled (concurrent duplicate POSTs)

function pruneProcessedWaInboundIds(now = Date.now()) {
  for (const [id, t] of processedWaInboundMessageIds) {
    if (now - t > PROCESSED_WA_MSG_TTL_MS) processedWaInboundMessageIds.delete(id);
  }
  while (processedWaInboundMessageIds.size > PROCESSED_WA_MSG_MAX) {
    const first = processedWaInboundMessageIds.keys().next().value;
    if (first === undefined) break;
    processedWaInboundMessageIds.delete(first);
  }
}

/**
 * Returns 'skip' if this POST should be ignored (already processed or another request is handling it).
 * Returns 'proceed' if this request should run; in that case `finishInboundWaDedupe` or `abortInboundWaDedupe` must be called.
 */
function beginInboundWaDedupe(id) {
  if (!id || typeof id !== 'string') return 'proceed';
  pruneProcessedWaInboundIds();
  if (processedWaInboundMessageIds.has(id)) return 'skip';
  if (inboundWaMessagePending.has(id)) return 'skip';
  inboundWaMessagePending.add(id);
  return 'proceed';
}

function finishInboundWaDedupe(id) {
  if (!id || typeof id !== 'string') return;
  inboundWaMessagePending.delete(id);
  processedWaInboundMessageIds.set(id, Date.now());
}

function abortInboundWaDedupe(id) {
  if (!id || typeof id !== 'string') return;
  inboundWaMessagePending.delete(id);
}

/**
 * When the user specifies a time but no calendar date (e.g. "book at 10am"), we treat the
 * implied day as **tomorrow** in the business timezone for slot checks. If they did pass a date,
 * we use that. Used before listing services so we never ask for a service when that day is closed.
 */
function impliedCalendarDateWhenTimeRequested(bookIntent, businessTZ) {
  if (!bookIntent?.time) return null;
  if (bookIntent.date) return bookIntent.date;
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
  const [y, m, d] = todayStr.split('-').map(Number);
  const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
  return new Date(utc + 86400000).toLocaleDateString('en-CA', { timeZone: businessTZ });
}

// ─── Re-prompt the current step when user says CONTINUE ──────────────────────
async function resumeStep(state, temp, businessId) {
  switch (state) {
    case STATES.AWAITING_SERVICE:
      return formatServiceList(temp.services || []);
    case STATES.AWAITING_DATE:
      return `Great! *${temp.serviceName}* is selected.\n\nWhat date works for you? (e.g. "tomorrow", "Monday", "March 10")`;
    case STATES.AWAITING_TIME: {
      const allSlots = await getAvailableSlots(businessId, temp.date, temp.staffId, temp.durationMinutes || 30);
      if (!allSlots.length) return `No slots left on *${formatDate(temp.date)}*. What other date works?`;
      const display = temp.displaySlots?.length ? temp.displaySlots : curateSlots(allSlots, 6);
      return `Got it — *${formatDate(temp.date)}*.\n\n` + formatSlotList(display, temp.date);
    }
    case STATES.AWAITING_NAME:
      return `Almost there! What name should we put the booking under?`;
    case STATES.AWAITING_CONFIRMATION:
      return formatConfirmationPrompt(temp.pendingBooking);
    default:
      return `Let's start fresh. What would you like to do?\n\n📅 Book · ❌ Cancel · 🔄 Reschedule · 📋 My Appointments`;
  }
}

// ─── Keyword fast-paths ───────────────────────────────────────────────────────
// Normalize for matching: trim and strip trailing ? . !
function normForKeywords(msg) {
  return (msg || '').trim().replace(/[\?\.\!]+$/, '').trim();
}

function extractAttribution(text) {
  const raw = String(text || '');
  const sourceMatch = raw.match(/#src=([a-z0-9_\-]+)/i);
  const campaignMatch = raw.match(/#cmp=([a-z0-9_\-]+)/i);
  const utmMatch = raw.match(/#utm=([a-z0-9_\-]+)/i);
  const cleanMessage = raw
    .replace(/#src=[a-z0-9_\-]+/ig, '')
    .replace(/#cmp=[a-z0-9_\-]+/ig, '')
    .replace(/#utm=[a-z0-9_\-]+/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    cleanMessage: cleanMessage || raw,
    source: sourceMatch?.[1] || null,
    campaign: campaignMatch?.[1] || null,
    utmSource: utmMatch?.[1] || null,
  };
}

const KEYWORD_HELP = /^(help|hi|hello|start|menu|helo|hii|hey|sup|supp|yo)\s*[\?\.\!]*$/i;
// "What can you do?" / "How can you help?" — treat as HELP so we always show the menu, no LLM/hiccup
const KEYWORD_HELP_QUESTIONS = /^(what\s+(can\s+)?(you|u)\s+(can\s+)?do|how\s+(can\s+)?(you|u)\s+(can\s+)?help(\s+me)?|what\s+do\s+you\s+do|how\s+(you|u)\s+can\s+(help|assist)(\s+me)?)\s*[\?\.\!]*$/i;
const KEYWORD_SERVICES = /^(services|service list|what services|what do you offer|what can i book)$/i;
const KEYWORD_CANCEL_FLOW = /^(cancel|stop|quit|exit|nahi|nope|no thanks)$/i;

// "My bookings" intent fallback: when LLM says "none", treat these as my_appointments
// (1) Full phrase match for common phrasings
const KEYWORD_MY_BOOKINGS = /^(can\s+(you|u)\s+)?(show\s+(me\s+)?)?(my\s+)(bookings?|appointments?)|^(what('s|s|\s+are)\s+my\s+bookings?)|^(upcoming\s+appointments?)|^(list\s+my\s+bookings?)|^(show\s+(me\s+)?my\s+bookings?)|^(how\s+(are\s+)?)?(my\s+)(bookings?|appointments?)(\s+please)?\s*[\?\.\!]*$/i;
// (2) Loose: message contains "my booking(s)" or "my appointment(s)" (e.g. "how my bookings please", "tell me my bookings")
const CONTAINS_MY_BOOKINGS = /\bmy\s+bookings?\b|\bmy\s+appointments?\b/i;

// When the LLM returns intent "none", still route obvious cancel / book phrases (matches degraded rules).
// Avoid substrings like "want to cancel" inside "don't want to cancel".
const KEYWORD_CANCEL_INTENT_FALLBACK =
  /\b(please\s+cancel|cancel\s+it|can\s+(you|u)\s+cancel|cancellation\b|\bcancel\s+(my\s+)?(appointment|booking)s?\b)/i;
const KEYWORD_BOOK_INTENT_FALLBACK =
  /\b(book(ing)?|schedule|reserve|make\s+an?\s+(appointment|booking)|need\s+an?\s+(appointment|booking)|set\s+up\s+an?\s+appointment|book\s+an?\s+appointment|appointment\s+for)\b/i;

// Reminder intent override: if the LLM misclassifies "remind me at 7pm" as "book",
// correct it here so the reminder path always fires.
const KEYWORD_REMINDER_OVERRIDE = /\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder)\b/i;

// "Book the same again" / "rebook" — pre-fill last booked service
const KEYWORD_SAME_SERVICE = /\b(same\s+(as\s+)?(last|before|previous|usual|time)|book\s+(it\s+)?again|same\s+service|rebook|same\s+thing|same\s+appointment|similar\s+to\s+last|same\s+one|repeat\s+booking|one\s+more\s+like\s+before)\b/i;

// Post-action acknowledgements — "Great!", "Thanks", "Perfect" etc.
// Skip the LLM entirely; reply with a brief, context-free thank-you.
const KEYWORD_ACK = /^(great|thanks|thank\s*you|thankyou|thx|ty|perfect|awesome|excellent|nice|cool|sweet|ok\s*thanks|okay\s*thanks|got\s*it|noted|alright|brilliant|cheers|👍+|🙏+|😊+)[\s\!\.\,🙂😊]*$/i;
// Match reminder confirmations including common typos/variants:
// "Yes I'll come", "Yes Il come", "Yes I'll do", "Yes I will do", "confirm"
// (strict ^…$ so longer phrases still go to the LLM)
const KEYWORD_CONFIRM_ARRIVAL =
  /^(yes(?:\s+i(?:['’]?(?:ll|l)|\s+will)?\s+(?:come|do))?|i(?:['’]?(?:ll|l)|\s+will)?\s+(?:come|do)|coming|confirm|confirmed)\s*[\.\!\?]*$/i;
// Lightweight gate before AI confirmation extraction, so we only spend LLM calls
// on short messages that plausibly mean "yes I'll come".
const KEYWORD_CONFIRM_ARRIVAL_CANDIDATE =
  /^(yes|y|ok|okay|sure|confirm|confirmed|coming|haan|ha|i['’]?(?:ll|l)|i\s+will)\b/i;
const KEYWORD_GLOBAL_STOP = /^(stop|unsubscribe|opt\s*out|remove\s*me|stop\s*campaigns?)\s*[\.\!\?]*$/i;
const KEYWORD_GLOBAL_START = /^(start|subscribe|opt\s*in|resume)\s*[\.\!\?]*$/i;

// ─── Gibberish detector ────────────────────────────────────────────────────────
// Returns true for obvious keyboard-mash; single-word only (spaces = real phrase).
function looksLikeGibberish(msg) {
  const s = (msg || '').trim().toLowerCase();
  if (s.length < 3 || s.includes(' ') || /\d/.test(s)) return false;
  // Pure repeated single char: "aaaaaaa"
  if (/^(.)\1{5,}$/.test(s)) return true;
  // Repeating short pattern at the start: "hahahaha", "lalalala", "asdasd"
  if (/^(.{1,3})\1{3,}/.test(s) && s.length > 7) return true;
  // No vowels in a reasonably long string: "hjklzxcvb", "qwrty"
  if (s.length > 5 && !/[aeiou]/.test(s)) return true;
  return false;
}

// Relative reminder parser for phrases like:
// "in 5 minutes", "after 2 hours", "10 mins later", "1 hr from now".
function extractRelativeReminderDelayMs(message) {
  const text = (message || '').toLowerCase();
  if (!text) return null;

  const patterns = [
    /\b(?:in|after)\s+(\d{1,3})\s*(minutes?|mins?|min|hours?|hrs?|hr)\b/i,
    /\b(\d{1,3})\s*(minutes?|mins?|min|hours?|hrs?|hr)\s*(?:later|from\s+now)\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;

    const rawValue = parseInt(match[1], 10);
    if (!Number.isFinite(rawValue) || rawValue <= 0) return null;

    const unit = (match[2] || '').toLowerCase();
    const minutes = unit.startsWith('h') ? rawValue * 60 : rawValue;
    return minutes * 60 * 1000;
  }

  return null;
}

// ─── Meta WhatsApp Cloud API verification ────────────────────────────────────
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function resolveLeadSourceForWebhook({ explicitBusinessId, leadSource, attribution }) {
  if (!explicitBusinessId) {
    return leadSource || attribution.source || LEAD_SOURCE.WHATSAPP;
  }
  return leadSource || attribution.source || DEFAULT_WEB_CHAT_WIDGET_SOURCE;
}

function inferLeadChannel({ explicitBusinessId, resolvedSource }) {
  if (!explicitBusinessId) return LEAD_SOURCE.WHATSAPP;
  const s = String(resolvedSource || '').toLowerCase();
  if (s === LEAD_SOURCE.WEB_CHAT_PAGE || s === 'chat_page') return LEAD_SOURCE.WEB_CHAT_PAGE;
  if (s === LEAD_SOURCE.WEB_CHAT_WIDGET || s === 'website_chat_widget') {
    return LEAD_SOURCE.WEB_CHAT_WIDGET;
  }
  return LEAD_SOURCE.WEB_CHAT_WIDGET;
}

// ─── Core message handler (shared by WhatsApp Cloud + web chat proxy) ────────
export async function handleMessage({
  rawPhone,
  message,
  explicitBusinessId,
  toNumberForRouting,
  toPhoneNumberIdForRouting,
  leadSource,
  leadCampaign,
  leadUtmSource,
}) {
  if (process.env.NODE_ENV !== 'production') {
    console.log('[Webhook] Incoming message payload:', {
      rawPhone,
      explicitBusinessId,
      toNumberForRouting,
      preview: typeof message === 'string' ? message.slice(0, 120) : message,
    });
  }
  const phone = normalizePhone(rawPhone);

  // Resolve business from explicitId, WhatsApp number, or fallback
  let businessId = explicitBusinessId ? parseInt(explicitBusinessId, 10) : null;
  if (!businessId) {
    const phoneNumberId = String(toPhoneNumberIdForRouting || '').trim();
    const toNumber = toNumberForRouting || '';
    if (phoneNumberId) {
      const biz = await getBusinessByWhatsAppPhoneNumberId(phoneNumberId);
      businessId = biz?.id || null;
    }
    if (!businessId && toNumber) {
      const biz = await getBusinessByPhone(toNumber);
      businessId = biz?.id || null;
    }
    if (!businessId) {
      const fallback = await getBusiness(DEFAULT_BUSINESS_ID).catch(() => null);
      businessId = fallback?.id || null;
    }
  }

  if (!businessId) {
    console.error('[Webhook] Unable to resolve business for inbound message:', {
      explicitBusinessId,
      toNumberForRouting,
      toPhoneNumberIdForRouting,
      defaultBusinessId: DEFAULT_BUSINESS_ID,
    });
    return {
      reply: "Sorry, this WhatsApp number is not linked to an active business yet. Please reconnect WhatsApp in Settings.",
      businessId: null,
    };
  }

  inc('webhook_messages');

  let reply = '';
  const attribution = extractAttribution(message);
  const messageForIntent = attribution.cleanMessage;

  // Hoist vars used by the nudge scheduler AFTER the try-catch block
  let nextState = null;
  let lastStepDescriptionForNudge = '';
  let businessName = 'our business';
  let businessType = null;
  let updatedAt    = null;

  try {
    // User replied → cancel any pending inactivity nudge immediately
    clearInactivityNudge(phone, businessId);

    const session  = await getSession(phone, businessId);
    const { state, temp, timedOut, updatedAt: sessionUpdatedAt } = session;
    updatedAt = sessionUpdatedAt;

    const [savedName, business] = await Promise.all([
      getCustomerName(phone, businessId),
      getBusiness(businessId),
    ]);

    const resolvedLeadSource = resolveLeadSourceForWebhook({
      explicitBusinessId,
      leadSource,
      attribution,
    });
    const leadChannel = inferLeadChannel({
      explicitBusinessId,
      resolvedSource: resolvedLeadSource,
    });

    const lead = await upsertLeadActivity({
      businessId,
      customerPhone: phone,
      source: resolvedLeadSource,
      status: 'engaged',
    });
    if (lead) {
      await trackLeadEvent({
        leadId: lead.id,
        businessId,
        eventType: 'lead_message_received',
        eventData: {
          state,
          channel: leadChannel,
          source: leadSource || attribution.source || null,
          campaign: leadCampaign || attribution.campaign || null,
          utmSource: leadUtmSource || attribution.utmSource || null,
        },
      });
    }

    businessName = business?.name || 'our business';
    businessType = business?.type  || null;
    const businessTZ   = business?.timezone || 'Asia/Kolkata';

    // Normalize message for keyword matching
    const msgNorm = normForKeywords(messageForIntent);

    // ── Compliance fast-path: STOP / START for campaign messaging ────────────
    if (KEYWORD_GLOBAL_STOP.test(msgNorm)) {
      await setCampaignOptOut({
        businessId,
        customerPhone: phone,
        optOut: true,
        reason: 'user_stop_keyword',
      });
      reply = `You're unsubscribed from promotional campaigns for now.\n\nYou will still receive booking-related messages. Reply *START* anytime to opt back in.`;
      return { reply, businessId };
    }
    if (KEYWORD_GLOBAL_START.test(msgNorm)) {
      await setCampaignOptOut({
        businessId,
        customerPhone: phone,
        optOut: false,
        reason: null,
      });
      reply = `You're subscribed again for promotional updates.\n\nReply *STOP* anytime to opt out.`;
      return { reply, businessId };
    }

    // ── Reminder-confirmation fast-path (AI-backed) ───────────────────────────
    if (state === STATES.IDLE) {
      const isDirectConfirm = KEYWORD_CONFIRM_ARRIVAL.test(msgNorm);
      const isLikelyConfirmCandidate =
        !isDirectConfirm &&
        msgNorm.length <= 40 &&
        KEYWORD_CONFIRM_ARRIVAL_CANDIDATE.test(msgNorm);

      let isReminderConfirmation = isDirectConfirm;
      if (!isReminderConfirmation && isLikelyConfirmCandidate) {
        const confirmIntent = await extractConfirmation(messageForIntent);
        isReminderConfirmation = confirmIntent === 'yes';
      }

      if (isReminderConfirmation) {
        const confirmedAppt = await markNextPendingAppointmentConfirmedForCustomer(phone, businessId);
        if (confirmedAppt) {
          reply = `Perfect, you're confirmed. See you soon!`;
          return { reply, businessId };
        }
      }
    }

    if (KEYWORD_HELP.test(msgNorm) || KEYWORD_HELP_QUESTIONS.test(msgNorm)) {
      const services = await getServices(businessId);
      if (state !== STATES.IDLE && temp.serviceName) {
        reply = `👋 ${savedName ? `Welcome back, *${savedName}*!` : 'Hey there!'}\n\n` +
          `You have an unfinished booking for *${temp.serviceName}*.\n\n` +
          `Reply *CONTINUE* to pick up where you left off, or say *RESTART* / *START OVER* / *RESET* to start fresh.`;
        return { reply, businessId };
      }

      let helpReply = null;

      // Returning customer says Hi/Hello/Hey → short personal greeting, not the full menu
      if (KEYWORD_HELP.test(msgNorm) && savedName) {
        try {
          helpReply = await generateReturningUserGreeting({
            businessName, customerName: savedName, businessType, services,
          });
          helpReply = formatShortWhatsAppReply(helpReply);
        } catch (err) {
          console.error('[Webhook] generateReturningUserGreeting failed:', err.message);
        }
      }

      // New user, or "what can you do?" type question → full dynamic help menu
      if (!helpReply) {
        try {
          helpReply = await generateHelpReply({
            businessName, businessType, services, customerName: savedName || null,
          });
          helpReply = formatShortWhatsAppReply(helpReply);
        } catch (err) {
          console.error('[Webhook] generateHelpReply failed:', err.message);
        }
      }

      reply = helpReply || formatWelcome(businessName, services, savedName, businessType);
      await resetSession(phone, businessId);
      return { reply, businessId };
    }

    // ── SERVICES fast-path (works from any state) ─────────────────────────────
    if (KEYWORD_SERVICES.test(message)) {
      const services = await getServices(businessId);
      reply = formatServiceList(services, businessType);
      return { reply, businessId };
    }

    // ── MY BOOKINGS fast-path (works from any state) ───────────────────────────
    // Ensures "show my bookings" / "my bookings" always get the list, not the hiccup message.
    if (!/^cancel\s+/i.test(msgNorm) && (KEYWORD_MY_BOOKINGS.test(msgNorm) || CONTAINS_MY_BOOKINGS.test(message || ''))) {
      try {
        const appointments = await getUpcomingAppointments(phone, businessId);
        reply = formatAppointmentList(appointments, savedName, businessType, businessTZ);
        if (appointments.length > 0) {
          await updateSession(phone, businessId, STATES.IDLE, {
            lastAppointmentsList: appointments,
            lastAppointmentsListAt: Date.now(),
          });
        } else {
          await resetSession(phone, businessId);
        }
      } catch (err) {
        console.error('[Webhook] My-bookings fast-path failed:', err.message);
        reply = formatFriendlyFallback('Could not load your bookings right now. Please try again in a moment.');
      }
      return { reply, businessId };
    }

    // ── CONTINUE / RESTART mid-flow ───────────────────────────────────────────
    if (/^(continue|resume|yes\s+continue)$/i.test(msgNorm) && state !== STATES.IDLE) {
      reply = await resumeStep(state, temp, businessId);
      return { reply, businessId };
    }
    if (/^(restart|start\s+over|reset|begin\s+again|start\s+fresh|new\s+booking)$/i.test(msgNorm)) {
      const services = await getServices(businessId);
      reply = formatWelcome(businessName, services, savedName, businessType);
      await resetSession(phone, businessId);
      return { reply, businessId };
    }

    // ── CANCEL-FLOW fast-path (clears current booking flow, not an appointment) ─
    // Do not clear here while user is picking *which* appointment to cancel — "cancel" may be a reply.
    if (KEYWORD_CANCEL_FLOW.test(message) && state !== STATES.IDLE && state !== STATES.AWAITING_CANCEL_WHICH) {
      reply = `✅ No problem, I've cleared that. What else can I help you with?\n\nType *HELP* to see options.`;
      await resetSession(phone, businessId);
      return { reply, businessId };
    }

    // After "my appointments", allow "1" / "2" to cancel that row (short-lived list context).
    if (state === STATES.IDLE && temp?.lastAppointmentsList?.length && /^\s*\d+\s*$/.test(msgNorm)) {
      const at = typeof temp.lastAppointmentsListAt === 'number'
        ? temp.lastAppointmentsListAt
        : new Date(temp.lastAppointmentsListAt || 0).getTime();
      if (Date.now() - at < 15 * 60 * 1000) {
        const idx = parseInt(msgNorm, 10) - 1;
        const chosen = temp.lastAppointmentsList[idx];
        if (chosen) {
          const cancelled = await cancelAppointment(chosen.id, phone);
          reply = cancelled
            ? formatCancellationConfirmed(chosen, businessType, businessTZ)
            : formatError('Could not cancel that appointment. It may have already been cancelled.');
        } else {
          const n = temp.lastAppointmentsList.length;
          reply = `I don't have booking number *${msgNorm.trim()}*. Reply with *1*${n > 1 ? `–*${n}*` : ''} or say *cancel*.`;
        }
        await resetSession(phone, businessId);
        return { reply, businessId };
      }
      await resetSession(phone, businessId);
    }

    // ── State machine ─────────────────────────────────────────────────────────
    nextState = state;
    switch (state) {

      // ── AWAITING_HANDOFF ─────────────────────────────────────────────────
      case STATES.AWAITING_HANDOFF: {
        reply = `The *${businessName}* team will reach out to you soon.\n\nIs there anything else I can help with in the meantime? Type *HELP* to see options.`;
        await resetSession(phone, businessId);
        nextState = STATES.IDLE;
        break;
      }

      // ── AWAITING_NAME ─────────────────────────────────────────────────────
      case STATES.AWAITING_NAME: {
        const name = message.trim();
        if (!name || name.length < 2) {
          reply = 'Please enter your name so we can confirm the booking.';
          break;
        }
        await upsertCustomer(phone, businessId, name);
        const { pendingBooking } = temp;
        const updatedBooking = { ...pendingBooking, customerName: name };
        await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, {
          ...temp, customerName: name, pendingBooking: updatedBooking,
        });
        nextState = STATES.AWAITING_CONFIRMATION;
        lastStepDescriptionForNudge = 'Confirming the booking details.';
        reply = formatConfirmationPrompt(updatedBooking, businessType);
        break;
      }

      // ── AWAITING_CONFIRMATION ─────────────────────────────────────────────
      case STATES.AWAITING_CONFIRMATION: {
        const answer = await extractConfirmation(message);
        if (answer === 'yes') {
          const { pendingBooking } = temp;
          try {
            const appt = await bookAppointment(pendingBooking);
            inc('book_appointment_success');

            // ── Smart reminder scheduling ────────────────────────────────────
            const apptUTC    = localToUTC(pendingBooking.date, pendingBooking.time, businessTZ);
            const hoursUntil = (apptUTC.getTime() - Date.now()) / 3_600_000;

            let reminderNote;
            if (hoursUntil > 25) {
              // Cron job handles the 24-hour reminder; tell the user
              reminderNote = undefined; // keeps the legacy "24 hours before" line
            } else if (hoursUntil > 1.5) {
              // Schedule a 1-hour-before reminder right now
              reminderNote = `I'll send you a reminder 1 hour before your appointment.`;
              const delayMs = apptUTC.getTime() - Date.now() - 60 * 60 * 1000;
              if (delayMs > 0) {
                setTimeout(async () => {
                  try {
                    const templateName = business?.whatsapp_reminder_template || GLOBAL_REMINDER_TEMPLATE;
                    if (!templateName) throw new Error('No reminder template configured');
                    const apptDate = formatDate(pendingBooking.date);
                    const apptTime = formatTime(pendingBooking.time);
                    await sendWhatsAppTemplate(
                      phone,
                      templateName,
                      [
                        pendingBooking.customerName || savedName || 'there',
                        pendingBooking.serviceName || 'Appointment',
                        apptDate,
                        apptTime,
                        businessName || 'us',
                      ],
                      businessId,
                      GLOBAL_REMINDER_TEMPLATE_LANG,
                    );
                    if (process.env.NODE_ENV !== 'production') {
                      console.log(`[Reminder] 1-hour reminder sent to ${phone} (biz ${businessId})`);
                    } else {
                      console.log('[Reminder] 1-hour reminder sent');
                    }
                  } catch (e) {
                    console.error(`[Reminder] 1-hour reminder failed for ${phone}:`, e.message);
                  }
                }, delayMs);
              }
            } else {
              // Appointment is in under 90 minutes — no reminder possible
              reminderNote = null;
            }

            reply = formatBookingConfirmed({
              serviceName:   pendingBooking.serviceName,
              staffName:     pendingBooking.staffName,
              date:          pendingBooking.date,
              time:          pendingBooking.time,
              customerName:  pendingBooking.customerName,
              appointmentId: appt.id,
              businessName,
              businessType,
              reminderNote,
            });
            await markLeadConverted({
              businessId,
              customerPhone: phone,
              conversionSource: 'whatsapp_booking',
            });
            await resetSession(phone, businessId);
          } catch (err) {
            if (err.message === 'SLOT_TAKEN') {
              inc('slot_taken');
              const altSlots = err.slots || [];
              const display  = curateSlots(altSlots, 6);
              if (display.length) {
                await updateSession(phone, businessId, STATES.AWAITING_TIME, {
                  ...temp, time: null, displaySlots: display,
                });
                reply = `Sorry, *${formatTime(pendingBooking.time)}* was just taken by someone else! 😅\n\n` +
                  formatSlotList(display, pendingBooking.date) +
                  `\n\nPick another time and I'll lock it in for you.`;
              } else {
                await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                  ...temp, date: null, time: null, displaySlots: null,
                });
                reply = `Sorry, that slot was just taken and there are no more slots on *${formatDate(pendingBooking.date)}*.\n\nWhat other date works for you?`;
              }
            } else {
              throw err;
            }
          }
          nextState = STATES.IDLE;
        } else if (answer === 'no') {
          reply = `✅ No problem, booking cancelled. Just tell me what you need!`;
          await resetSession(phone, businessId);
          nextState = STATES.IDLE;
        } else {
          reply = `Please confirm — reply *YES* to book or *NO* to cancel.\n\n${formatConfirmationPrompt(temp.pendingBooking, businessType)}`;
          nextState = STATES.AWAITING_CONFIRMATION;
          lastStepDescriptionForNudge = 'Waiting for them to confirm YES or NO.';
        }
        break;
      }

      // ── AWAITING_SERVICE ─────────────────────────────────────────────────
      case STATES.AWAITING_SERVICE: {
        const services = temp.services || [];
        const msgForServices = normalizeCasualServiceTypos(normalizeRelativeDateTypos(message));
        let matched = matchServicesFromMessage(msgForServices, services);
        if (!matched?.length) {
          const { cleaned, hadCorrection } = stripCorrectionPrefix(msgForServices);
          if (hadCorrection && cleaned) {
            matched = matchServicesFromMessage(normalizeCasualServiceTypos(cleaned), services);
          }
        }

        if (!matched?.length) {
          reply = `I didn't recognise that. 🤔\n\n` + formatServiceList(services, businessType);
          break;
        }

        const agg = aggregateMatchedServices(matched);
        const selectedPretty = matched.map((m) => `*${m.name}*`).join(', ');
        const primaryName = matched.length === 1 ? matched[0].name : agg.serviceName;

        const baseTemp = {
          ...temp,
          serviceId: agg.serviceId,
          serviceIds: agg.serviceIds,
          serviceName: agg.serviceName,
          durationMinutes: agg.durationMinutes,
          price: agg.price,
          notes: agg.notes,
        };

        const dur = agg.durationMinutes;

        if (baseTemp.date && baseTemp.time) {
          const staffList   = await getStaff(businessId);
          const staffMember = staffList.find(s => s.id === baseTemp.staffId) || staffList[0];
          if (!staffMember) {
            reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
            await resetSession(phone, businessId);
            break;
          }
          const allSlots = await getAvailableSlots(businessId, baseTemp.date, staffMember.id, dur);
          if (!allSlots.length) {
            await updateSession(phone, businessId, STATES.AWAITING_DATE, {
              ...baseTemp, staffId: staffMember.id, displaySlots: null,
            });
            reply = `Great! ${selectedPretty} selected.\n\nSorry, no slots on *${formatDate(baseTemp.date)}*. What other date works for you?`;
            break;
          }
          const exactMatch = allSlots.find(s => s === baseTemp.time);
          if (!exactMatch) {
            const display = curateSlots(allSlots, 6);
            await updateSession(phone, businessId, STATES.AWAITING_TIME, {
              ...baseTemp, staffId: staffMember.id, displaySlots: display,
            });
            reply = `Great! ${selectedPretty} selected.\n\n` +
              `Sorry, *${formatTime(baseTemp.time)}* is not available on *${formatDate(baseTemp.date)}*.\n\n` +
              formatSlotList(display, baseTemp.date) +
              `\n\nReply with a time from the list above.`;
            break;
          }
          const resolvedName  = savedName || null;
          const pendingBooking = {
            businessId, staffId: staffMember.id, serviceId: agg.serviceId,
            serviceName: agg.serviceName, staffName: staffMember.name,
            customerPhone: phone, customerName: resolvedName,
            date: baseTemp.date, time: exactMatch,
            durationMinutes: dur, price: agg.price,
            notes: agg.notes,
          };
          if (resolvedName) {
            await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, { ...baseTemp, pendingBooking });
            reply = `*${primaryName}* — perfect choice! 😊\n\n` + formatConfirmationPrompt(pendingBooking, businessType);
          } else {
            await updateSession(phone, businessId, STATES.AWAITING_NAME, { ...baseTemp, pendingBooking });
            reply = `*${primaryName}* — great choice! Almost there.\n\nWhat name should we put the booking under?`;
          }
          break;
        }

        if (baseTemp.date) {
          const staffList2   = await getStaff(businessId);
          const staffMember2 = staffList2.find(s => s.id === baseTemp.staffId) || staffList2[0];
          if (!staffMember2) {
            reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
            await resetSession(phone, businessId);
            break;
          }
          const allSlots2    = await getAvailableSlots(businessId, baseTemp.date, staffMember2.id, dur);
          if (!allSlots2.length) {
            await updateSession(phone, businessId, STATES.AWAITING_DATE, {
              ...baseTemp, staffId: staffMember2.id, displaySlots: null,
            });
            reply = `Great! ${selectedPretty} selected.\n\nSorry, no slots on *${formatDate(baseTemp.date)}*. What other date works for you?`;
          } else {
            const display2 = curateSlots(allSlots2, 6);
            await updateSession(phone, businessId, STATES.AWAITING_TIME, {
              ...baseTemp, staffId: staffMember2.id, displaySlots: display2,
            });
            reply = `Great! ${selectedPretty} selected.\n\n` + formatSlotList(display2, baseTemp.date);
          }
          break;
        }

        // ── Smart suggestion when time preference is stored but no date ──────
        if (baseTemp.time) {
          const staffList3  = await getStaff(businessId);
          const staffMember3 = staffList3.find(s => s.id === baseTemp.staffId) || staffList3[0];
          const suggested = staffMember3
            ? await findNextSlotNearTime(businessId, staffMember3.id, dur, baseTemp.time, businessTZ)
            : null;

          if (suggested) {
            const pendingBooking = {
              businessId, staffId: staffMember3.id,
              serviceId: agg.serviceId, serviceName: agg.serviceName,
              staffName: staffMember3.name,
              customerPhone: phone, customerName: savedName,
              date: suggested.date, time: suggested.time,
              durationMinutes: dur, price: agg.price,
              notes: agg.notes,
            };
            if (savedName) {
              await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, {
                ...baseTemp, date: suggested.date, time: suggested.time, pendingBooking,
              });
              reply = `How about *${primaryName}* on *${formatDate(suggested.date)}* at *${formatTime(suggested.time)}*? 😊\n\n` +
                formatConfirmationPrompt(pendingBooking, businessType);
              nextState = STATES.AWAITING_CONFIRMATION;
              lastStepDescriptionForNudge = 'Suggested a smart slot and waiting for them to confirm.';
            } else {
              await updateSession(phone, businessId, STATES.AWAITING_NAME, {
                ...baseTemp, date: suggested.date, time: suggested.time, pendingBooking,
              });
              reply = `How about *${primaryName}* on *${formatDate(suggested.date)}* at *${formatTime(suggested.time)}*? 😊\n\nJust tell me the name for the booking!`;
              nextState = STATES.AWAITING_NAME;
              lastStepDescriptionForNudge = 'Suggested a smart slot and asking for their name.';
            }
            break;
          }
        }

        await updateSession(phone, businessId, STATES.AWAITING_DATE, { ...baseTemp, displaySlots: null });
        nextState = STATES.AWAITING_DATE;
        lastStepDescriptionForNudge = `Asking which date works for their *${primaryName}* booking.`;
        reply = `Great! ${selectedPretty} selected.\n\nWhat date works for you? (e.g. "tomorrow", "Friday", "Dec 20")`;
        break;
      }

      // ── AWAITING_DATE ─────────────────────────────────────────────────────
      // Try preferred staff first (if user chose someone); otherwise first staff with slots on that day.
      // Handles: one staff off Friday, other available Friday → use the one who works.
      case STATES.AWAITING_DATE: {
        const servicesForMerge = temp.services?.length ? temp.services : await getServices(businessId);
        if (servicesForMerge.length) {
          const msgForMerge = normalizeCasualServiceTypos(message);
          let matchedSvcs = matchServicesFromMessage(msgForMerge, servicesForMerge);
          if (!matchedSvcs?.length) {
            const lone = matchServiceFromMessage(msgForMerge, servicesForMerge);
            if (lone) matchedSvcs = [lone];
          }
          if (matchedSvcs?.length) {
            const prevIds = (Array.isArray(temp.serviceIds) && temp.serviceIds.length)
              ? temp.serviceIds
              : (temp.serviceId != null ? [temp.serviceId] : []);
            const prevSet = new Set(prevIds);
            const newIds = matchedSvcs.map((s) => s.id);
            const hasNew = newIds.some((id) => !prevSet.has(id));
            const addCue = /\b(too|also|as well|add|plus|another|other)\b/i.test(message);
            const sameOnly = newIds.every((id) => prevSet.has(id)) && newIds.length <= prevIds.length;
            if (sameOnly && prevIds.length && !addCue) {
              reply = `You already have *${temp.serviceName}* selected.\n\nWhat date works for you? (e.g. "tomorrow", "Friday", "Dec 20")`;
              break;
            }
            if (hasNew || addCue || !prevIds.length) {
              const mergedIds = [...new Set([...prevIds, ...newIds])];
              const byId = new Map(servicesForMerge.map((s) => [s.id, s]));
              const mergedObjs = mergedIds.map((id) => byId.get(id)).filter(Boolean);
              if (mergedObjs.length) {
                const agg = aggregateMatchedServices(mergedObjs);
                const selectedPretty = mergedObjs.map((m) => `*${m.name}*`).join(', ');
                await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                  ...temp,
                  services: servicesForMerge,
                  serviceId: agg.serviceId,
                  serviceIds: agg.serviceIds,
                  serviceName: agg.serviceName,
                  durationMinutes: agg.durationMinutes,
                  price: agg.price,
                  notes: agg.notes,
                  displaySlots: null,
                });
                nextState = STATES.AWAITING_DATE;
                lastStepDescriptionForNudge = `Asking which date works for their *${agg.serviceName}* booking.`;
                reply = `Got it — ${selectedPretty} (${agg.durationMinutes} min total).\n\nWhat date works for you? (e.g. "tomorrow", "Friday", "Dec 20")`;
                break;
              }
            }
          }
        }

        const workingMsg = normalizeRelativeDateTypos(message);
        let intent = await extractBookingIntent(workingMsg, [], businessTZ);
        let triedCorrection = false;
        if (!intent.date) {
          const { cleaned, hadCorrection } = stripCorrectionPrefix(workingMsg);
          triedCorrection = hadCorrection;
          if (hadCorrection && cleaned) {
            intent = await extractBookingIntent(normalizeRelativeDateTypos(cleaned), [], businessTZ);
          }
        }
        if (!intent.date) {
          const fbDate = extractFallbackRelativeDate(workingMsg, businessTZ);
          if (fbDate) intent = { ...intent, date: fbDate };
        }
        if (!intent.date) {
          reply = triedCorrection
            ? `I still couldn't read that date. 🤔 Try *tomorrow*, a weekday (e.g. *Friday*), or a date like *March 10*.`
            : `I couldn't understand that date. 🤔\n\nTry something like "tomorrow", "Monday", or "March 10".`;
          break;
        }
        const prefTime = intent.time || temp.time;
        const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
        if (intent.date < todayStr) {
          reply = `That date has already passed! 😅 Please pick a future date (e.g. "tomorrow", "next Monday").`;
          break;
        }
        const duration = temp.durationMinutes || 30;
        let staffIdForDate = null;
        let staffNameForDate = null;
        let allSlots = [];
        let staffNote = '';

        // Repeat-booking flow: keep the same staff; do NOT silently switch.
        if (temp.lockStaff && temp.staffId) {
          staffIdForDate = temp.staffId;
          staffNameForDate = temp.staffName || 'your staff member';
          allSlots = await getAvailableSlots(businessId, intent.date, staffIdForDate, duration);
          if (!allSlots.length) {
            reply = `Sorry, *${staffNameForDate}* has no slots on *${formatDate(intent.date)}*.\n\nWhat other date works for you?`;
            break;
          }
        } else {
          const staffList = await getStaff(businessId);
          if (!staffList?.length) {
            reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
            await resetSession(phone, businessId);
            break;
          }
          const result = await getFirstStaffWithSlotsOnDate(businessId, intent.date, duration, temp.staffId || null);
          if (!result) {
            reply = `Sorry, no slots are available on *${formatDate(intent.date)}*.\n\nWould you like to try a different date?`;
            break;
          }
          ({ staffId: staffIdForDate, staffName: staffNameForDate, slots: allSlots } = result);
          const preferredName = temp.staffName;
          const usedDifferentStaff = preferredName && preferredName !== staffNameForDate;
          staffNote = usedDifferentStaff
            ? `*${preferredName}* isn't available that day. Here are slots with *${staffNameForDate}*:\n\n`
            : '';
        }

        // ── Honor time preference (from this message or earlier session) ─────────
        if (prefTime) {
          const exactMatch = allSlots.find(s => s === prefTime);

          if (exactMatch) {
            // Preferred time is available → skip the slot picker entirely
            const pendingBooking = {
              businessId, staffId: staffIdForDate, serviceId: temp.serviceId,
              serviceName: temp.serviceName, staffName: staffNameForDate,
              customerPhone: phone, customerName: savedName,
              date: intent.date, time: exactMatch,
              durationMinutes: temp.durationMinutes, price: temp.price,
              notes: temp.notes || null,
            };
            if (savedName) {
              await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, {
                ...temp, date: intent.date, time: exactMatch, staffId: staffIdForDate,
                staffName: staffNameForDate, pendingBooking,
              });
              reply = `Got it — *${formatDate(intent.date)}*. ${staffNote}` +
                formatConfirmationPrompt(pendingBooking, businessType);
              nextState = STATES.AWAITING_CONFIRMATION;
              lastStepDescriptionForNudge = 'Waiting for them to confirm the booking we proposed.';
            } else {
              await updateSession(phone, businessId, STATES.AWAITING_NAME, {
                ...temp, date: intent.date, time: exactMatch, staffId: staffIdForDate,
                staffName: staffNameForDate, pendingBooking,
              });
              reply = `Almost there! What name should we put the booking under?`;
              nextState = STATES.AWAITING_NAME;
              lastStepDescriptionForNudge = 'Asking for their name to complete the booking.';
            }
            break;
          }

          // Preferred time not available — show slots sorted nearest to preference
          const prefMin = timeToMinutes(prefTime);
          const byProximity = [...allSlots].sort((a, b) =>
            Math.abs(timeToMinutes(a) - prefMin) - Math.abs(timeToMinutes(b) - prefMin)
          );
          const display = byProximity.slice(0, 6);
          const reason = getTimeNotAvailableReason(prefTime, allSlots, temp.durationMinutes || 30);
          await updateSession(phone, businessId, STATES.AWAITING_TIME, {
            ...temp, date: intent.date, time: prefTime, staffId: staffIdForDate,
            staffName: staffNameForDate, displaySlots: display,
          });
          nextState = STATES.AWAITING_TIME;
          lastStepDescriptionForNudge = `Showing available times on ${formatDate(intent.date)} for their booking.`;
          reply = `Got it — *${formatDate(intent.date)}*.\n\n` +
            `${staffNote}Your preferred time (*${formatTime(prefTime)}*) isn't available — ${reason}\n\n` +
            formatSlotList(display, intent.date);
          break;
        }

        // No time preference — show standard curated slot list
        const display = curateSlots(allSlots, 6);
        await updateSession(phone, businessId, STATES.AWAITING_TIME, {
          ...temp, date: intent.date, staffId: staffIdForDate, staffName: staffNameForDate, displaySlots: display,
        });
        nextState = STATES.AWAITING_TIME;
        lastStepDescriptionForNudge = `Showing available times on ${formatDate(intent.date)} for their booking.`;
        reply = `Got it — *${formatDate(intent.date)}*.\n\n${staffNote}`;
        reply += formatSlotList(display, intent.date);
        break;
      }

      // ── AWAITING_TIME ─────────────────────────────────────────────────────
      // Number lookup uses temp.displaySlots so "3" always maps to the 3rd slot
      // that was actually shown, not the 3rd slot in the full availability list.
      case STATES.AWAITING_TIME: {
        const { date, staffId, serviceId, serviceName, durationMinutes, price } = temp;
        const allSlots = await getAvailableSlots(businessId, date, staffId, durationMinutes || 30);

        if (!allSlots.length) {
          await updateSession(phone, businessId, STATES.AWAITING_DATE, { ...temp, displaySlots: null });
          reply = `Sorry, no slots are available on *${formatDate(date)}*.\n\nWould you like to try a different date? Just tell me the date.`;
          nextState = STATES.AWAITING_DATE;
          lastStepDescriptionForNudge = `Asking them to pick another date because that day is full.`;
          break;
        }

        // Mid-flow date change while picking a time ("actually Tuesday", "Friday instead")
        const altDateIntent = await extractBookingIntent(message, [], businessTZ);
        if (altDateIntent.date && altDateIntent.date !== date) {
          const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
          if (altDateIntent.date < todayStr) {
            reply = `That date has already passed! 😅 Please pick a future date (e.g. "tomorrow", "next Monday").`;
            break;
          }
          const duration = temp.durationMinutes || 30;
          let staffIdForDate = temp.staffId;
          let staffNameForDate = temp.staffName;
          let allSlotsForNew = [];
          let staffNoteSwitch = '';
          if (temp.lockStaff && temp.staffId) {
            staffIdForDate = temp.staffId;
            staffNameForDate = temp.staffName || 'your staff member';
            allSlotsForNew = await getAvailableSlots(businessId, altDateIntent.date, staffIdForDate, duration);
            if (!allSlotsForNew.length) {
              reply = `Sorry, *${staffNameForDate}* has no slots on *${formatDate(altDateIntent.date)}*.\n\nWhat other date works for you?`;
              await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                ...temp, date: null, time: null, displaySlots: null,
              });
              nextState = STATES.AWAITING_DATE;
              lastStepDescriptionForNudge = 'Asking for another date after no slots on chosen day.';
              break;
            }
          } else {
            const staffList = await getStaff(businessId);
            if (!staffList?.length) {
              reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
              await resetSession(phone, businessId);
              nextState = STATES.IDLE;
              break;
            }
            const result = await getFirstStaffWithSlotsOnDate(businessId, altDateIntent.date, duration, temp.staffId || null);
            if (!result) {
              reply = `Sorry, no slots are available on *${formatDate(altDateIntent.date)}*.\n\nWould you like to try a different date?`;
              break;
            }
            ({ staffId: staffIdForDate, staffName: staffNameForDate, slots: allSlotsForNew } = result);
            const preferredName = temp.staffName;
            const usedDifferentStaff = preferredName && preferredName !== staffNameForDate;
            staffNoteSwitch = usedDifferentStaff
              ? `*${preferredName}* isn't available that day. Here are slots with *${staffNameForDate}*:\n\n`
              : '';
          }
          const displayNew = curateSlots(allSlotsForNew, 6);
          await updateSession(phone, businessId, STATES.AWAITING_TIME, {
            ...temp, date: altDateIntent.date, staffId: staffIdForDate, staffName: staffNameForDate, displaySlots: displayNew,
          });
          nextState = STATES.AWAITING_TIME;
          lastStepDescriptionForNudge = `Showing times on ${formatDate(altDateIntent.date)} after a date change.`;
          reply = `Got it — *${formatDate(altDateIntent.date)}*.\n\n${staffNoteSwitch}${formatSlotList(displayNew, altDateIntent.date)}`;
          break;
        }

        const display   = temp.displaySlots?.length ? temp.displaySlots : curateSlots(allSlots, 6);
        let exactMatch  = null;
        const numPick   = parseInt(message.trim(), 10);

        if (!isNaN(numPick) && numPick >= 1 && display[numPick - 1]) {
          exactMatch = display[numPick - 1];
        } else {
          let intent = await extractBookingIntent(message, [], businessTZ);
          if (!intent.time) {
            const { cleaned, hadCorrection } = stripCorrectionPrefix(message);
            if (hadCorrection && cleaned) {
              intent = await extractBookingIntent(cleaned, [], businessTZ);
            }
          }
          if (intent.time) {
            exactMatch = allSlots.find(s => s === intent.time);
            if (!exactMatch) {
              const newDisplay = curateSlots(allSlots, 6);
              await updateSession(phone, businessId, STATES.AWAITING_TIME, {
                ...temp, displaySlots: newDisplay,
              });
              const reason = getTimeNotAvailableReason(intent.time, allSlots, durationMinutes || 30);
              reply = `Sorry, *${formatTime(intent.time)}* is not available on *${formatDate(date)}* — ${reason}\n\n` +
                formatSlotList(newDisplay, date) +
                `\n\nReply with a number or time from the list above.`;
              nextState = STATES.AWAITING_TIME;
              lastStepDescriptionForNudge = `Showing which times are actually available and asking them to pick one.`;
              break;
            }
          }
        }

        // "Why isn't 10am available?" / "Why it's not available" etc. — answer instead of "I couldn't understand"
        const isWhyQuestion = /why|how come|reason|why.*not|why it'?s? not|why is it not|explain/i.test(message.trim()) && message.trim().length < 80;
        if (!exactMatch && isWhyQuestion) {
          const firstSlot = (display[0] || allSlots[0]);
          const lastSlot  = (display[display.length - 1] || allSlots[allSlots.length - 1]);
          reply = `Those times are the only ones free on *${formatDate(date)}* — earlier ones may have passed or we're only open from *${formatTime(firstSlot)}* to *${formatTime(lastSlot)}* that day.\n\n` +
            formatSlotList(display, date) +
            `\n\nReply with a number or time from the list above.`;
          nextState = STATES.AWAITING_TIME;
          lastStepDescriptionForNudge = `Explaining why a time isn't available and re-listing the open slots.`;
          break;
        }

        if (!exactMatch) {
          reply = `I couldn't understand that. Please reply with a slot number or time (e.g. "1" or "10am").\n\n` +
            formatSlotList(display, date);
          nextState = STATES.AWAITING_TIME;
          lastStepDescriptionForNudge = `Waiting for them to choose one of the suggested times.`;
          break;
        }

        const staff       = await getStaff(businessId);
        const staffMember = staff.find(s => s.id === staffId) || staff[0];
        if (!staffMember) {
          reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
          await resetSession(phone, businessId);
          nextState = STATES.IDLE;
          break;
        }

        const resolvedName   = temp.customerName || savedName || null;
        const pendingBooking = {
          businessId, staffId: staffMember.id, serviceId, serviceName,
          staffName: staffMember.name, customerPhone: phone, customerName: resolvedName,
          date, time: exactMatch, durationMinutes: durationMinutes || 30, price,
          notes: temp.notes || null,
        };

        if (resolvedName) {
          await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, {
            ...temp, time: exactMatch, pendingBooking,
          });
          nextState = STATES.AWAITING_CONFIRMATION;
          lastStepDescriptionForNudge = 'Waiting for them to confirm the booking we just proposed.';
          reply = formatConfirmationPrompt(pendingBooking, businessType);
        } else {
          await updateSession(phone, businessId, STATES.AWAITING_NAME, {
            ...temp, time: exactMatch, pendingBooking,
          });
          nextState = STATES.AWAITING_NAME;
          lastStepDescriptionForNudge = 'Asking for their name to finish the booking.';
          reply = `Almost there! What name should we put the booking under?`;
        }
        break;
      }

      // ── AWAITING_STAFF ────────────────────────────────────────────────────
      case STATES.AWAITING_STAFF: {
        const staffList = temp.staffList || [];
        let chosen = null;
        if (message.toLowerCase().trim() === 'any') {
          chosen = staffList[0];
        } else {
          chosen = matchServiceFromMessage(message, staffList);
        }

        if (!chosen) {
          reply = formatError("I didn't recognise that name.") + '\n\n' + formatStaffList(staffList);
          break;
        }
        await updateSession(phone, businessId, STATES.AWAITING_DATE, {
          ...temp, staffId: chosen.id, staffName: chosen.name,
        });
        nextState = STATES.AWAITING_DATE;
        lastStepDescriptionForNudge = `Booking with ${chosen.name} and asking which date works.`;
        reply = `Great! Booking with *${chosen.name}*.\n\nWhat date works for you?`;
        break;
      }

      // ── AWAITING_RESCHEDULE_WHICH ─────────────────────────────────────────
      case STATES.AWAITING_RESCHEDULE_WHICH: {
        const appointments = temp.appointments || [];
        const idx          = parseInt(message, 10) - 1;
        let chosen         = Number.isFinite(idx) && idx >= 0 ? appointments[idx] : null;

        // Fuzzy text match — service name or date string
        if (!chosen) {
          const q = message.toLowerCase().trim();
          chosen = appointments.find(a =>
            a.service_name?.toLowerCase().includes(q) ||
            formatDateTime(a.scheduled_at, businessTZ).toLowerCase().includes(q)
          );
        }

        if (!chosen) {
          const list = appointments.map((a, i) =>
            `  ${i + 1}. *${a.service_name}* — ${formatDateTime(a.scheduled_at, businessTZ)}`
          ).join('\n');
          reply = `I didn't recognise that. Which appointment would you like to reschedule?\n\n${list}\n\nReply with the *number* or the service name.`;
          break;
        }
        await updateSession(phone, businessId, STATES.AWAITING_RESCHEDULE_DATE, {
          ...temp, rescheduleAppt: chosen,
        });
        nextState = STATES.AWAITING_RESCHEDULE_DATE;
        lastStepDescriptionForNudge = 'Asking which new date they want for the reschedule.';
        reply = `Got it. What new date would you like for your *${chosen.service_name}* appointment?\n(e.g. "Friday", "March 5")`;
        break;
      }

      // ── AWAITING_RESCHEDULE_DATE ──────────────────────────────────────────
      case STATES.AWAITING_RESCHEDULE_DATE: {
        const workingRe = normalizeRelativeDateTypos(message);
        let intent = await extractRescheduleIntent(workingRe, businessTZ);
        if (!intent.date) {
          const fb = extractFallbackRelativeDate(workingRe, businessTZ);
          if (fb) intent = { ...intent, date: fb };
        }
        if (!intent.date) {
          reply = `I couldn't understand that date. Please try again (e.g. "Friday", "March 5").`;
          break;
        }
        const { rescheduleAppt } = temp;
        const allSlots = await getAvailableSlots(
          businessId, intent.date, rescheduleAppt.staff_id, rescheduleAppt.duration_minutes || 30,
        );
        if (!allSlots.length) {
          reply = `Sorry, no slots on *${formatDate(intent.date)}*. Try another date?`;
          break;
        }
        const display = curateSlots(allSlots, 6);
        await updateSession(phone, businessId, STATES.AWAITING_RESCHEDULE_TIME, {
          ...temp, rescheduleDate: intent.date, displaySlots: display,
        });
        nextState = STATES.AWAITING_RESCHEDULE_TIME;
        lastStepDescriptionForNudge = 'Showing new times for their rescheduled appointment and waiting for a choice.';
        reply = `Got it — *${formatDate(intent.date)}*.\n\n` + formatSlotList(display, intent.date);
        break;
      }

      // ── AWAITING_RESCHEDULE_TIME ──────────────────────────────────────────
      case STATES.AWAITING_RESCHEDULE_TIME: {
        const { rescheduleAppt, rescheduleDate } = temp;
        const allSlots = await getAvailableSlots(
          businessId, rescheduleDate, rescheduleAppt.staff_id, rescheduleAppt.duration_minutes || 30,
        );
        const display     = temp.displaySlots?.length ? temp.displaySlots : curateSlots(allSlots, 6);
        let exactMatch    = null;
        const slotIdx     = parseInt(message, 10) - 1;

        if (!isNaN(slotIdx) && slotIdx >= 0 && display[slotIdx]) {
          exactMatch = display[slotIdx];
        } else {
          const intent = await extractRescheduleIntent(message, businessTZ);
          if (intent.time) {
            exactMatch = allSlots.find(s => s === intent.time);
          }
        }

        if (!exactMatch) {
          reply = `I couldn't understand that time. Please pick from the list.\n\n` +
            formatSlotList(display, rescheduleDate);
          break;
        }
        if (!allSlots.find(s => s === exactMatch)) {
          const newDisplay = curateSlots(allSlots, 6);
          reply = `Sorry, *${formatTime(exactMatch)}* is not available.\n\n` +
            formatSlotList(newDisplay, rescheduleDate);
          break;
        }

        await updateSession(phone, businessId, STATES.AWAITING_RESCHEDULE_CONFIRM, {
          ...temp, rescheduleTime: exactMatch,
        });
        nextState = STATES.AWAITING_RESCHEDULE_CONFIRM;
        lastStepDescriptionForNudge = 'Waiting for them to confirm the new rescheduled time.';
        reply = `Please confirm the reschedule:\n\n` +
          `Service: ${rescheduleAppt.service_name}\n` +
          `New Date: ${formatDate(rescheduleDate)}\n` +
          `New Time: ${formatTime(exactMatch)}\n\n` +
          `Reply *YES* to confirm or *NO* to cancel.`;
        break;
      }

      // ── AWAITING_RESCHEDULE_CONFIRM ───────────────────────────────────────
      case STATES.AWAITING_RESCHEDULE_CONFIRM: {
        const answer = await extractConfirmation(message);
        if (answer === 'yes') {
          const { rescheduleAppt, rescheduleDate, rescheduleTime } = temp;
          const updated = await rescheduleAppointment(rescheduleAppt.id, phone, rescheduleDate, rescheduleTime, businessTZ);
          if (updated) {
            reply = formatRescheduleConfirmed({
              serviceName:   rescheduleAppt.service_name,
              staffName:     rescheduleAppt.staff_name,
              date:          rescheduleDate,
              time:          rescheduleTime,
              appointmentId: rescheduleAppt.id,
              businessType,
            });
          } else {
            reply = formatError('Could not reschedule. The appointment may have already been cancelled.');
          }
          await resetSession(phone, businessId);
          nextState = STATES.IDLE;
        } else if (answer === 'no') {
          reply = `✅ Reschedule cancelled. Type *HELP* to start over.`;
          await resetSession(phone, businessId);
          nextState = STATES.IDLE;
        } else {
          reply = 'Please reply *YES* to confirm or *NO* to cancel.';
          nextState = STATES.AWAITING_RESCHEDULE_CONFIRM;
          lastStepDescriptionForNudge = 'Waiting for YES or NO to confirm the reschedule.';
        }
        break;
      }

      // ── AWAITING_CANCEL_WHICH ─────────────────────────────────────────────
      case STATES.AWAITING_CANCEL_WHICH: {
        const appointments = temp.appointments || [];
        const idx          = parseInt(message, 10) - 1;
        let chosen         = Number.isFinite(idx) && idx >= 0 ? appointments[idx] : null;

        // "NO" / "keep it" → abort cancel
        if (/^(no|nope|nahi|keep|cancel cancel|never mind|nevermind)$/i.test(message.trim())) {
          reply = `No problem! Your appointment is safe. Type *HELP* if you need anything. 😊`;
          await resetSession(phone, businessId);
          break;
        }

        // Fuzzy text match — service name or date string
        if (!chosen) {
          const q = message.toLowerCase().trim();
          chosen = appointments.find(a =>
            a.service_name?.toLowerCase().includes(q) ||
            formatDateTime(a.scheduled_at, businessTZ).toLowerCase().includes(q)
          );
        }

        if (!chosen) {
          const list = appointments.map((a, i) =>
            `  ${i + 1}. *${a.service_name}* — ${formatDateTime(a.scheduled_at, businessTZ)}`
          ).join('\n');
          reply = `I didn't recognise that. Which appointment would you like to cancel?\n\n${list}\n\nReply with the *number* or the service name.`;
          break;
        }
        const cancelled = await cancelAppointment(chosen.id, phone);
        reply = cancelled
          ? formatCancellationConfirmed(chosen, businessType, businessTZ)
          : formatError('Could not cancel that appointment. It may have already been cancelled.');
        await resetSession(phone, businessId);
        nextState = STATES.IDLE;
        break;
      }

      // ── IDLE: classify intent ─────────────────────────────────────────────
      default: {
        if (temp?.lastAppointmentsList && !/^\s*\d+\s*$/.test(messageForIntent.trim())) {
          await updateSession(phone, businessId, STATES.IDLE, {});
        }

        // Fast-path: post-action acknowledgements ("Great!", "Thanks", "Perfect")
        // User is just reacting to something that succeeded — no LLM, no booking pitch.
        if (KEYWORD_ACK.test(messageForIntent.trim())) {
          const acks = [
            `Glad I could help! 😊 Let me know if you need anything else.`,
            `Of course! Feel free to reach out anytime. 😊`,
            `Happy to help! Type *HELP* if you ever need anything. 😊`,
            `You're welcome! Come back anytime. 😊`,
          ];
          reply = acks[Math.floor(Math.random() * acks.length)];
          break;
        }

        // Fast-path: obvious gibberish (keyboard mash, pure repeats) — no LLM needed
        if (looksLikeGibberish(messageForIntent)) {
          try {
            reply = await answerConversational(messageForIntent, {
              name: businessName, type: businessType,
            });
            reply = formatShortWhatsAppReply(reply);
          } catch {
            reply = formatNotUnderstood();
          }
          break;
        }

        const idleServices = await getServices(businessId);

        // Single LLM call returns both handoff flag AND intent (halves latency vs two calls)
        const classification = await classifyMessage(messageForIntent, idleServices.map(s => s.name));
        const wantsHuman = classification.handoff;
        let intent = classification.intent;

        if (intent === 'none') {
          const low = messageForIntent.toLowerCase();
          if (KEYWORD_CANCEL_INTENT_FALLBACK.test(low)) intent = 'cancel';
          else if (KEYWORD_BOOK_INTENT_FALLBACK.test(low)) intent = 'book';
        }

        if (wantsHuman) {
          await updateSession(phone, businessId, STATES.AWAITING_HANDOFF, {});
          reply = formatHandoffMessage(businessName);
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[Handoff] ${phone} (biz ${businessId}) requested a human agent`);
          } else {
            console.log('[Handoff] Human agent requested');
          }
          break;
        }

        // Override: "remind me at X" → reminder (catches LLM misclassifications like "book")
        // Exclude "reschedule" so "remind me to reschedule" stays correct
        if (intent !== 'reschedule' && KEYWORD_REMINDER_OVERRIDE.test(messageForIntent)) {
          intent = 'reminder';
        }

        // If LLM said "none" but message clearly asks for "my bookings", treat as my_appointments
        if (intent === 'none' && !/^cancel\s+/i.test(msgNorm) && (KEYWORD_MY_BOOKINGS.test(msgNorm) || CONTAINS_MY_BOOKINGS.test(msgNorm))) {
          intent = 'my_appointments';
        }

        // If LLM said "book" but the user clearly meant "book the same again", route to repeat_booking
        // so we prefill *service + staff* from their most recent appointment.
        // Do not treat "book again … for facial and haircut" as repeat — that's a new booking with named services.
        if (
          intent === 'book' &&
          KEYWORD_SAME_SERVICE.test(messageForIntent) &&
          !specifiesNewBookingServices(messageForIntent, idleServices)
        ) {
          intent = 'repeat_booking';
        }

        if (intent === 'help') {
          try {
            const dynamicHelp = await generateHelpReply({
              businessName,
              businessType,
              services: idleServices,
              customerName: savedName || null,
            });
            reply = dynamicHelp ? formatShortWhatsAppReply(dynamicHelp) : formatWelcome(businessName, idleServices, savedName, businessType);
          } catch (err) {
            console.error('[Webhook] generateHelpReply (intent=help) failed:', err.message);
            reply = formatWelcome(businessName, idleServices, savedName, businessType);
          }
          break;
        }

        if (intent === 'my_appointments') {
          try {
            const appointments = await getUpcomingAppointments(phone, businessId);
            reply = formatAppointmentList(appointments, savedName, businessType, businessTZ);
            if (appointments.length > 0) {
              await updateSession(phone, businessId, STATES.IDLE, {
                lastAppointmentsList: appointments,
                lastAppointmentsListAt: Date.now(),
              });
            } else {
              await resetSession(phone, businessId);
            }
          } catch (err) {
            console.error('[Webhook] my_appointments failed:', err.message);
            reply = formatFriendlyFallback('Could not load your bookings right now. Please try again in a moment.');
          }
          break;
        }

        if (intent === 'reschedule') {
          const appointments = await getUpcomingAppointments(phone, businessId);
          if (!appointments.length) {
            reply = `You have no upcoming appointments to reschedule.`;
          } else if (appointments.length === 1) {
            await updateSession(phone, businessId, STATES.AWAITING_RESCHEDULE_DATE, {
              rescheduleAppt: appointments[0],
            });
            reply = `What new date would you like for your *${appointments[0].service_name}* appointment?\n(e.g. "Friday", "March 5")`;
          } else {
            const list = appointments.map((a, i) =>
              `${i + 1}. *${a.service_name}* — ${formatDateTime(a.scheduled_at, businessTZ)}`
            ).join('\n');
            reply = `Which appointment would you like to reschedule?\n\n${list}\n\nReply with the number.`;
            await updateSession(phone, businessId, STATES.AWAITING_RESCHEDULE_WHICH, { appointments });
          }
          break;
        }

        if (intent === 'repeat_booking') {
          if (specifiesNewBookingServices(messageForIntent, idleServices)) {
            intent = 'book';
          } else {
            const last = await getMostRecentAppointment(phone, businessId);
            if (!last?.service_id || !last?.staff_id) {
              reply = `Sure — what would you like to book?\n\nJust tell me the service and the date.`;
              break;
            }

            // If service/staff was deleted or deactivated, fall back to normal booking flow.
            if (last.service_active === false || last.staff_active === false) {
              const services = idleServices.length ? idleServices : await getServices(businessId);
              reply = `Sure — what would you like to book?\n\n` + (services.length ? formatServiceList(services, businessType) : `Just tell me the service and date.`);
              break;
            }

            const prefilled = {
              serviceId: last.service_id,
              serviceName: last.service_name,
              durationMinutes: last.service_duration_minutes || last.duration_minutes || 30,
              price: last.service_price ?? null,
              staffId: last.staff_id,
              staffName: last.staff_name,
              lockStaff: true,
              date: null,
              time: null,
              displaySlots: null,
            };

            // If they already included a date/time in the same message, proceed immediately.
            const ri = await extractBookingIntent(messageForIntent, [], businessTZ);
            if (ri?.date) {
              await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                ...prefilled,
                time: ri.time || null, // optional preference; may auto-skip slot picker if available
              });
              nextState = STATES.AWAITING_DATE;
              lastStepDescriptionForNudge = `Continuing a repeat booking by asking for a date.`;
              reply = `Got it — *${prefilled.serviceName}* with *${prefilled.staffName}* again.\n\nWhat date works for you?`;
            } else {
              await updateSession(phone, businessId, STATES.AWAITING_DATE, prefilled);
              nextState = STATES.AWAITING_DATE;
              lastStepDescriptionForNudge = `Asking which date works for their repeat booking.`;
              reply = `Got it — *${prefilled.serviceName}* with *${prefilled.staffName}* again.\n\nWhat date works for you?`;
            }
            break;
          }
        }

        if (intent === 'availability') {
          const availQuery     = await extractAvailabilityQuery(message, businessTZ);
          const services       = await getServices(businessId);
          const defaultDuration = services[0]?.duration_minutes || 30;
          const staffList      = await getStaff(businessId);
          const defaultStaffId = staffList[0]?.id;
          let daysWithSlots;
          if (availQuery.type === 'day' && availQuery.date) {
            const slots = defaultStaffId
              ? await getAvailableSlots(businessId, availQuery.date, defaultStaffId, defaultDuration)
              : [];
            daysWithSlots = slots.length ? [{ date: availQuery.date, slots }] : [];
          } else {
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
            const endDate  = new Date(todayStr + 'T12:00:00');
            endDate.setDate(endDate.getDate() + 13);
            const endStr   = endDate.toLocaleDateString('en-CA', { timeZone: businessTZ });
            const allDays  = await getAvailableSlotsForRange(businessId, todayStr, endStr, defaultDuration);
            daysWithSlots  = allDays.slice(0, 5);
          }
          reply = formatAvailabilitySummary(daysWithSlots, businessType);
          break;
        }

        if (intent === 'cancel') {
          const appointments = await getUpcomingAppointments(phone, businessId);
          if (!appointments.length) {
            reply = `You have no upcoming appointments to cancel. 😊\n\nWant to book one? Just tell me the service and date!`;
          } else if (appointments.length === 1) {
            const appt = appointments[0];
            await updateSession(phone, businessId, STATES.AWAITING_CANCEL_WHICH, { appointments });
            reply = `I found your upcoming appointment:\n\n📋 *${appt.service_name}* — ${formatDateTime(appt.scheduled_at, businessTZ)}\n\nReply *1* to cancel it, or *NO* to keep it.`;
          } else {
            const msgLower = message.toLowerCase();
            const autoMatch = appointments.find(a =>
              a.service_name?.toLowerCase().includes(msgLower.replace(/cancel\s*/i, '').trim()) ||
              formatDateTime(a.scheduled_at, businessTZ).toLowerCase().includes(msgLower.replace(/cancel\s*/i, '').trim())
            );
            if (autoMatch) {
              await updateSession(phone, businessId, STATES.AWAITING_CANCEL_WHICH, { appointments });
              const matchIdx = appointments.indexOf(autoMatch) + 1;
              reply = `I found this appointment:\n\n📋 *${autoMatch.service_name}* — ${formatDateTime(autoMatch.scheduled_at, businessTZ)}\n\nReply *${matchIdx}* to cancel it, or *NO* to keep it.`;
            } else {
              const list = appointments.map((a, i) =>
                `  ${i + 1}. *${a.service_name}* — ${formatDateTime(a.scheduled_at, businessTZ)}`
              ).join('\n');
              reply = `Which appointment would you like to cancel?\n\n${list}\n\nReply with the number.`;
              await updateSession(phone, businessId, STATES.AWAITING_CANCEL_WHICH, { appointments });
            }
          }
          break;
        }

        if (intent === 'book') {
          const services    = idleServices.length ? idleServices : await getServices(businessId);
          const staffList   = await getStaff(businessId);
          const defaultStaff = staffList[0];

          if (!staffList.length) {
            reply = `Sorry, this business hasn't set up their team yet. Please check back soon!`;
            break;
          }
          if (!services.length) {
            reply = `Sorry, this business hasn't added any services yet. Please check back soon!`;
            break;
          }

          const repairedBookingMsg = normalizeCasualServiceTypos(normalizeRelativeDateTypos(messageForIntent));
          let bookIntent = await extractBookingIntent(repairedBookingMsg, services.map(s => s.name), businessTZ);
          if (!bookIntent.date) {
            const fbDate = extractFallbackRelativeDate(repairedBookingMsg, businessTZ);
            if (fbDate) bookIntent = { ...bookIntent, date: fbDate };
          }

          let service = null;
          if (bookIntent.service) {
            service = await findService(businessId, bookIntent.service);
          }

          // "Book the same again" / "rebook" — look up their last booked service
          if (
            !service &&
            KEYWORD_SAME_SERVICE.test(message) &&
            !specifiesNewBookingServices(repairedBookingMsg, services)
          ) {
            const lastSvc = await getLastBookedService(phone, businessId);
            if (lastSvc?.active !== false) {
              service = services.find(s => s.id === lastSvc?.service_id)
                     || services.find(s => s.name.toLowerCase() === lastSvc?.service_name?.toLowerCase());
              if (service) {
                if (process.env.NODE_ENV !== 'production') {
                  console.log(`[Booking] ${phone} rebooking last service: ${service.name}`);
                } else {
                  console.log(`[Booking] Rebooking last service: ${service.name}`);
                }
              }
            }
          }

          if (!service) {
            const impliedDateForCheck = impliedCalendarDateWhenTimeRequested(bookIntent, businessTZ);
            if (impliedDateForCheck) {
              const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
              if (impliedDateForCheck < todayStr) {
                reply = `I can't book in the past! Please give me a future day and time.`;
                break;
              }
              const anyOpen = await getFirstStaffWithSlotsOnDate(
                businessId,
                impliedDateForCheck,
                30,
                null,
              );
              if (!anyOpen) {
                const dayLabel = bookIntent.date
                  ? `*${formatDate(impliedDateForCheck)}*`
                  : '*tomorrow*';
                reply =
                  `We're not taking bookings on ${dayLabel} — we're closed or have no availability that day. ` +
                  `Please pick another day first (e.g. next Monday or a specific date), then we can choose a service and time.`;
                break;
              }
            }
            await updateSession(phone, businessId, STATES.AWAITING_SERVICE, {
              services,
              staffId: defaultStaff?.id,
              date:    bookIntent.date || null,
              time:    bookIntent.time || null,
            });
            nextState = STATES.AWAITING_SERVICE;
            lastStepDescriptionForNudge = 'Showing the list of services and waiting for them to pick one.';
            reply = formatServiceList(services, businessType);
            break;
          }

          let staffMember = defaultStaff;
          if (bookIntent.staffName) {
            const found = staffList.find(s =>
              s.name.toLowerCase().includes(bookIntent.staffName.toLowerCase())
            );
            if (found) staffMember = found;
          }

          if (bookIntent.date) {
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
            if (bookIntent.date < todayStr) {
              await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                serviceId: service.id, serviceName: service.name,
                durationMinutes: service.duration_minutes, price: service.price,
                staffId: staffMember.id, staffName: staffMember.name,
              });
              reply = `Sorry, I can't book in the past! 😅\n\n*${service.name}* is selected. What date works for you? (e.g. "tomorrow", "Monday")`;
              break;
            }
          }

          if (bookIntent.date && bookIntent.time) {
            const allSlots = await getAvailableSlots(
              businessId, bookIntent.date, staffMember.id, service.duration_minutes,
            );
            if (!allSlots.length) {
              await updateSession(phone, businessId, STATES.AWAITING_DATE, {
                serviceId: service.id, serviceName: service.name,
                durationMinutes: service.duration_minutes, price: service.price,
                staffId: staffMember.id, staffName: staffMember.name,
              });
              reply = `Sorry, no slots are available on *${formatDate(bookIntent.date)}*. What other date works for you?`;
              break;
            }
            const exactMatch = allSlots.find(s => s === bookIntent.time);
            if (!exactMatch) {
              const display = curateSlots(allSlots, 6);
              await updateSession(phone, businessId, STATES.AWAITING_TIME, {
                serviceId: service.id, serviceName: service.name,
                durationMinutes: service.duration_minutes, price: service.price,
                staffId: staffMember.id, staffName: staffMember.name,
                date: bookIntent.date, displaySlots: display,
              });
              reply = `Sorry, *${formatTime(bookIntent.time)}* is not available on *${formatDate(bookIntent.date)}*.\n\n` +
                formatSlotList(display, bookIntent.date) +
                `\n\nReply with a time from the list above.`;
              nextState = STATES.AWAITING_TIME;
              lastStepDescriptionForNudge = 'Showing which times are available and waiting for them to choose.';
              break;
            }
            const pendingBooking = {
              businessId,
              staffId:       staffMember.id,
              serviceId:     service.id,
              serviceName:   service.name,
              staffName:     staffMember.name,
              customerPhone: phone,
              customerName:  savedName,
              date:          bookIntent.date,
              time:          exactMatch,
              durationMinutes: service.duration_minutes,
              price:         service.price,
            };
            if (savedName) {
              await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, { pendingBooking });
              reply = formatConfirmationPrompt(pendingBooking, businessType);
              nextState = STATES.AWAITING_CONFIRMATION;
              lastStepDescriptionForNudge = 'Waiting for them to confirm the booking we proposed.';
            } else {
              await updateSession(phone, businessId, STATES.AWAITING_NAME, { pendingBooking });
              reply = `Almost there! What name should we put the booking under?`;
              nextState = STATES.AWAITING_NAME;
              lastStepDescriptionForNudge = 'Asking for their name to finish the booking.';
            }
            break;
          }

          const newTemp = {
            serviceId: service.id, serviceName: service.name,
            durationMinutes: service.duration_minutes, price: service.price,
            staffId: staffMember.id, staffName: staffMember.name,
            date: bookIntent.date || null,
            time: bookIntent.time || null,
          };

          if (!bookIntent.date) {
            // ── Smart suggestion: no date given — find the next available slot ───
            const suggested = bookIntent.time
              ? await findNextSlotNearTime(businessId, staffMember.id, service.duration_minutes, bookIntent.time, businessTZ)
              : null;

            if (suggested) {
              const pendingBooking = {
                businessId, staffId: staffMember.id,
                serviceId: service.id, serviceName: service.name,
                staffName: staffMember.name,
                customerPhone: phone, customerName: savedName,
                date: suggested.date, time: suggested.time,
                durationMinutes: service.duration_minutes, price: service.price,
              };
              if (savedName) {
                await updateSession(phone, businessId, STATES.AWAITING_CONFIRMATION, {
                  ...newTemp, date: suggested.date, time: suggested.time, pendingBooking,
                });
                reply = `How about *${service.name}* on *${formatDate(suggested.date)}* at *${formatTime(suggested.time)}*? 😊\n\n` +
                  formatConfirmationPrompt(pendingBooking, businessType);
                nextState = STATES.AWAITING_CONFIRMATION;
                lastStepDescriptionForNudge = 'Suggested a smart slot and waiting for them to confirm.';
              } else {
                await updateSession(phone, businessId, STATES.AWAITING_NAME, {
                  ...newTemp, date: suggested.date, time: suggested.time, pendingBooking,
                });
                reply = `How about *${service.name}* on *${formatDate(suggested.date)}* at *${formatTime(suggested.time)}*? 😊\n\nJust tell me the name for the booking!`;
                nextState = STATES.AWAITING_NAME;
                lastStepDescriptionForNudge = 'Suggested a smart slot and asking for their name.';
              }
            } else {
              // No slot near preference found — fall back to asking for a date
              const noSlotNote = bookIntent.time
                ? `I couldn't find any *${formatTime(bookIntent.time)}* slots in the next week. `
                : '';
              await updateSession(phone, businessId, STATES.AWAITING_DATE, newTemp);
              reply = `Great! *${service.name}* selected.\n\n${noSlotNote}What date works for you? (e.g. "tomorrow", "Friday", "Dec 20")`;
              nextState = STATES.AWAITING_DATE;
              lastStepDescriptionForNudge = `Asking which date works for their *${service.name}* booking.`;
            }
          } else {
            const allSlots = await getAvailableSlots(
              businessId, bookIntent.date, staffMember.id, service.duration_minutes,
            );
            if (!allSlots.length) {
              await updateSession(phone, businessId, STATES.AWAITING_DATE, newTemp);
              reply = `Sorry, no slots on *${formatDate(bookIntent.date)}*. What other date works?`;
              nextState = STATES.AWAITING_DATE;
              lastStepDescriptionForNudge = `Asking them to pick another date because that day is full.`;
            } else {
              const display = curateSlots(allSlots, 6);
              await updateSession(phone, businessId, STATES.AWAITING_TIME, { ...newTemp, displaySlots: display });
              reply = `Got it — *${formatDate(bookIntent.date)}*.\n\n` + formatSlotList(display, bookIntent.date);
              nextState = STATES.AWAITING_TIME;
              lastStepDescriptionForNudge = `Showing free times on ${formatDate(bookIntent.date)} and waiting for them to choose.`;
            }
          }
          break;
        }

        if (intent === 'reminder') {
          try {
            // Prefer deterministic relative parsing first:
            // "after 5 minutes", "in 2 hours", etc.
            const relativeDelayMs = extractRelativeReminderDelayMs(message);
            let delayMs = relativeDelayMs;
            let confirmationLine = '';

            if (delayMs == null) {
              // Fallback to absolute time extraction ("at 7pm today").
              const ri = await extractBookingIntent(messageForIntent, [], businessTZ);
              if (!ri.time) {
                reply = `I automatically send you a reminder 24 hours before every appointment — no need to ask! 😊\n\nIf you'd like a reminder at a specific time, just tell me the time (e.g. "remind me at 7pm today").`;
                break;
              }

              const todayStr   = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
              const targetDate = ri.date || todayStr;

              // Convert the reminder time (expressed in business timezone) to a true UTC Date
              const reminderAt = localToUTC(targetDate, ri.time, businessTZ);
              delayMs = reminderAt.getTime() - Date.now();
              confirmationLine = `I'll remind you at *${formatTime(ri.time)}* today.`;
            } else {
              const reminderAt = new Date(Date.now() + delayMs);
              const atTime = reminderAt.toLocaleTimeString('en-IN', {
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZone: businessTZ,
              });
              const mins = Math.round(delayMs / 60000);
              confirmationLine = `I'll remind you in *${mins} minute${mins === 1 ? '' : 's'}* (around *${atTime}*).`;
            }

            if (delayMs <= 0) {
              reply = `That time has already passed! 😅\n\nWould you like me to remind you at a different time today?`;
              break;
            }

            if (delayMs > 24 * 60 * 60 * 1000) {
              reply = `That's more than 24 hours away — I already send an automatic reminder 24 hours before every appointment, so you're covered! 😊`;
              break;
            }

            const upcomingAppts = await getUpcomingAppointments(phone, businessId);
            const apptRef       = upcomingAppts[0];

            const reminderBody = apptRef
              ? null
              : `⏰ *Reminder!*\n\nThis is your custom reminder from appointbot. 😊`;

            setTimeout(async () => {
              try {
                if (apptRef) {
                  const templateName = business?.whatsapp_reminder_template || GLOBAL_REMINDER_TEMPLATE;
                  if (!templateName) throw new Error('No reminder template configured');
                  const d = new Date(apptRef.scheduled_at);
                  const apptDate = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: businessTZ });
                  const apptTime = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: businessTZ });
                  await sendWhatsAppTemplate(
                    phone,
                    templateName,
                    [
                      savedName || apptRef.customer_name || 'there',
                      apptRef.service_name || 'Appointment',
                      apptDate,
                      apptTime,
                      businessName || 'us',
                    ],
                    businessId,
                    GLOBAL_REMINDER_TEMPLATE_LANG,
                  );
                } else {
                  // Fallback: no appointment reference; this is inside an active chat anyway.
                  await sendWhatsAppText(phone, reminderBody, businessId);
                }
                if (process.env.NODE_ENV !== 'production') {
                  console.log(`[Reminder] Custom reminder sent to ${phone} (biz ${businessId}) at ${new Date().toISOString()}`);
                } else {
                  console.log('[Reminder] Custom reminder sent');
                }
              } catch (err) {
                console.error(`[Reminder] Custom reminder failed for ${phone} (biz ${businessId}):`, err.message);
              }
            }, delayMs);

            reply = `✅ Got it! ${confirmationLine}\n\nYour automatic 24-hour reminder before the appointment is still set too. 😊`;
          } catch (reminderErr) {
            console.error('[Webhook] Reminder intent failed:', reminderErr.message);
            // Never send "hiccup" for reminder — confirm they're covered by automatic reminders
            reply = `You're all set! I automatically send you a reminder 24 hours before each appointment, so you'll get one before your next visit. 😊\n\nIf you'd like a reminder at a specific time, just say the time (e.g. "remind me at 7pm today").`;
          }
          break;
        }

        if (intent === 'contact') {
          const contactPhone = process.env.BUSINESS_CONTACT_PHONE || '';
          reply = contactPhone
            ? `📞 You can reach us at *${contactPhone}*.\n\nOr just reply here and we'll get back to you!`
            : `Please visit us in person or check our website for contact details.`;
          break;
        }

        // FAQ / conversational / unknown — always give a real, helpful answer
        try {
          reply = await answerConversational(messageForIntent, {
            name:     businessName,
            type:     business?.type,
            services: idleServices.map(s => s.name).join(', '),
          });
          reply = formatShortWhatsAppReply(reply);
        } catch (convErr) {
          console.error('[Webhook] answerConversational failed:', convErr.message);
          reply = formatNotUnderstood();
        }
        if (!reply || !reply.trim()) {
          reply = formatNotUnderstood();
        }
        break;
      }
    }
  } catch (err) {
    const errMsg = err?.message || String(err);
    if (process.env.NODE_ENV !== 'production') {
      console.error(`[Webhook] Error handling message from ${rawPhone} (biz ${explicitBusinessId}):`, err);
    } else {
      console.error('[Webhook] Error handling message:', errMsg);
    }
    // Try lightweight recovery: if they asked for "my bookings", try to fulfill that
    const msgNorm = normForKeywords(messageForIntent);
    if (!/^cancel\s+/i.test(msgNorm) && CONTAINS_MY_BOOKINGS.test(messageForIntent || '')) {
      try {
      const [appointments, businessRec, savedNameRec] = await Promise.all([
          getUpcomingAppointments(phone, businessId),
          getBusiness(businessId),
          getCustomerName(phone, businessId),
        ]);
        reply = formatAppointmentList(appointments, savedNameRec, businessRec?.type || null, businessRec?.timezone || null);
      } catch (recoveryErr) {
        console.error('[Webhook] Recovery (my bookings) failed:', recoveryErr.message);
      }
    }
    if (!reply || !reply.trim()) {
      try {
        const businessRec = await getBusiness(businessId);
        const dynamic = await generateDynamicFallbackReply({
          userMessage: messageForIntent,
          businessName: businessRec?.name || 'us',
          businessType: businessRec?.type || null,
        });
        reply = dynamic ? formatShortWhatsAppReply(dynamic) : formatFriendlyFallback("I hit a small hiccup on my end.");
      } catch (fallbackErr) {
        console.error('[Webhook] Dynamic fallback failed:', fallbackErr.message);
        reply = formatFriendlyFallback("I hit a small hiccup on my end.");
      }
    }
  }

  // Never ghost: ensure we always send something human
  if (!reply || !reply.trim()) {
    try {
      const businessRec = await getBusiness(businessId);
      const dynamic = await generateDynamicFallbackReply({
        userMessage: messageForIntent,
        businessName: businessRec?.name || 'us',
        businessType: businessRec?.type || null,
      });
      reply = dynamic ? formatShortWhatsAppReply(dynamic) : formatNotUnderstood();
    } catch {
      reply = formatNotUnderstood();
    }
  }

  // Schedule a gentle inactivity nudge for active flows
  if (reply && nextState && nextState !== STATES.IDLE) {
    scheduleInactivityNudge({
      phone,
      businessId,
      businessName,
      businessType,
      lastStepDescription: lastStepDescriptionForNudge || 'Continuing their booking flow.',
      baselineUpdatedAt: updatedAt,
    });
  }

  return { reply, businessId };
}

// ─── Extract text or voice from Meta WhatsApp message (same pattern as sparebot) ─
function extractMetaMessageContent(msg) {
  const type = msg?.type;
  if (type === 'text') return { text: msg?.text?.body || '' };
  if (type === 'button') return { text: msg?.button?.text || '' };
  if (type === 'interactive') {
    const i = msg?.interactive || {};
    const buttonTitle = i?.button_reply?.title;
    const listTitle = i?.list_reply?.title;
    return { text: buttonTitle || listTitle || '' };
  }
  if (type === 'audio') {
    return { audioId: msg?.audio?.id, audioMimeType: msg?.audio?.mime_type };
  }
  return { text: '' };
}

// ─── POST /webhook ─────────────────────────────────────────────────────────────
router.post('/', webhookLimiter, async (req, res) => {
  // WhatsApp Cloud API payload
  if (Array.isArray(req.body.entry)) {
    let inboundWaId = null;
    try {
      if (process.env.NODE_ENV !== 'production') {
        console.log('[Webhook] Incoming WhatsApp Cloud payload:', JSON.stringify(req.body, null, 2));
      } else {
        console.log('[Webhook] Incoming WhatsApp Cloud message');
      }
      const entry    = req.body.entry[0];
      const change   = entry?.changes?.[0];
      const value    = change?.value;
      const messages = value?.messages;

      if (!messages || !messages.length) return res.sendStatus(200);

      const msg = messages[0];
      inboundWaId = msg.id ?? null;
      if (beginInboundWaDedupe(inboundWaId) === 'skip') {
        console.log('[Webhook] Skipping duplicate or concurrent inbound WhatsApp message id:', inboundWaId);
        return res.sendStatus(200);
      }
      const rawPhone = msg.from || '';
      const displayNumber = value?.metadata?.display_phone_number || '';
      const phoneNumberId = value?.metadata?.phone_number_id || '';

      const { text, audioId, audioMimeType } = extractMetaMessageContent(msg);
      let message = String((text || '').trim());

      if (!message && audioId) {
        const byPhoneNumberId = phoneNumberId
          ? await getBusinessByWhatsAppPhoneNumberId(phoneNumberId)
          : null;
        const byDisplayNumber = !byPhoneNumberId && displayNumber
          ? await getBusinessByPhone(displayNumber)
          : null;
        const fallback = await getBusiness(DEFAULT_BUSINESS_ID).catch(() => null);
        const businessId = byPhoneNumberId?.id || byDisplayNumber?.id || fallback?.id || null;
        const transcript = await transcribeMetaAudio(audioId, audioMimeType, businessId);
        message = (transcript || '').trim();
      }

      if (!message) {
        try {
          const byPhoneNumberId = phoneNumberId
            ? await getBusinessByWhatsAppPhoneNumberId(phoneNumberId)
            : null;
          const byDisplayNumber = !byPhoneNumberId && displayNumber
            ? await getBusinessByPhone(displayNumber)
            : null;
          const fallback = await getBusiness(DEFAULT_BUSINESS_ID).catch(() => null);
          const businessId = byPhoneNumberId?.id || byDisplayNumber?.id || fallback?.id || null;
          await sendWhatsAppText(
            rawPhone,
            "Sorry, I couldn't read that message. Please type what you need.",
            businessId,
          );
        } catch (sendErr) {
          console.error('[Webhook] Fallback send failed:', sendErr.message);
        }
        finishInboundWaDedupe(inboundWaId);
        return res.sendStatus(200);
      }

      let reply;
      let businessIdForSend = DEFAULT_BUSINESS_ID;
      try {
        const result = await runWithCorrelation(randomUUID(), () =>
          handleMessage({
            rawPhone,
            message,
            explicitBusinessId: null,
            toNumberForRouting: displayNumber,
            toPhoneNumberIdForRouting: phoneNumberId,
            leadSource: 'whatsapp',
          }),
        );
        reply = result.reply;
        businessIdForSend = result.businessId;
      } catch (handleErr) {
        console.error('[Webhook] handleMessage threw:', handleErr);
        try {
          let businessRec = phoneNumberId ? await getBusinessByWhatsAppPhoneNumberId(phoneNumberId) : null;
          if (!businessRec && displayNumber) businessRec = await getBusinessByPhone(displayNumber);
          if (!businessRec) businessRec = await getBusiness(DEFAULT_BUSINESS_ID).catch(() => ({}));
          businessIdForSend = businessRec?.id ?? null;
          const dynamic = await generateDynamicFallbackReply({
            userMessage: message,
            businessName: businessRec?.name || 'us',
            businessType: businessRec?.type || null,
          });
          reply = dynamic ? formatShortWhatsAppReply(dynamic) : formatFriendlyFallback("I hit a small hiccup on my end.");
        } catch (fallbackErr) {
          console.error('[Webhook] Dynamic fallback failed:', fallbackErr.message);
          reply = formatFriendlyFallback("I hit a small hiccup on my end.");
        }
      }

      try {
        await sendWhatsAppText(rawPhone, reply || formatNotUnderstood(), businessIdForSend);
      } catch (sendErr) {
        if (process.env.NODE_ENV !== 'production') {
          console.error(`[Webhook] Outbound send failed (biz ${businessIdForSend}):`, sendErr.message);
        } else {
          console.error('[Webhook] Outbound send failed');
        }
      }
      finishInboundWaDedupe(inboundWaId);
      return res.sendStatus(200);
    } catch (err) {
      abortInboundWaDedupe(inboundWaId);
      console.error('[Webhook] Cloud API error:', err);
      // Don't ghost: try to send a short apology if we have enough from the request
      try {
        const entry = req.body?.entry?.[0];
        const value = entry?.changes?.[0]?.value;
        const from = value?.messages?.[0]?.from;
        const displayNumber = value?.metadata?.display_phone_number;
        const phoneNumberId = value?.metadata?.phone_number_id;
        if (from) {
          const byPhoneNumberId = phoneNumberId
            ? await getBusinessByWhatsAppPhoneNumberId(phoneNumberId)
            : null;
          const byDisplayNumber = !byPhoneNumberId && displayNumber
            ? await getBusinessByPhone(displayNumber)
            : null;
          const fallback = await getBusiness(DEFAULT_BUSINESS_ID).catch(() => null);
          const businessId = byPhoneNumberId?.id || byDisplayNumber?.id || fallback?.id || null;
          await sendWhatsAppText(
            from,
            "Sorry, I hit a small hiccup. Please try again in a moment or type *HELP*. I'm here! 🙂",
            businessId,
          );
        }
      } catch (sendErr) {
        console.error('[Webhook] Fallback send after error failed:', sendErr.message);
      }
      return res.sendStatus(200); // always acknowledge to prevent Meta retries
    }
  }

  // Internal chat proxy / legacy JSON body
  const rawPhone   = req.body.From  || req.body.phone  || 'test';
  const body       = (req.body.Body || req.body.message || '').trim();
  const buttonText = req.body.ButtonText || '';
  const message    = buttonText || body;
  const businessId = req.body.businessId;
  const toNumber   = req.body.To || '';
  const source = req.body.source || DEFAULT_WEB_CHAT_WIDGET_SOURCE;
  const campaign = req.body.campaign || null;
  const utmSource = req.body.utmSource || null;

  if (process.env.NODE_ENV !== 'production') {
    console.log('[Webhook] Incoming chat proxy payload:', { rawPhone, body, buttonText, businessId, toNumber });
  } else {
    console.log('[Webhook] Incoming chat proxy message');
  }

  let reply;
  try {
    const result = await runWithCorrelation(randomUUID(), () =>
      handleMessage({
        rawPhone,
        message,
        explicitBusinessId: businessId,
        toNumberForRouting: toNumber,
        leadSource: source,
        leadCampaign: campaign,
        leadUtmSource: utmSource,
      }),
    );
    reply = result.reply;
  } catch (err) {
    console.error('[Webhook] Chat proxy handleMessage threw:', err);
    try {
      const businessRec = businessId
        ? await getBusiness(businessId).catch(() => ({}))
        : {};
      const dynamic = await generateDynamicFallbackReply({
        userMessage: message,
        businessName: businessRec?.name || 'us',
        businessType: businessRec?.type || null,
      });
      reply = dynamic ? formatShortWhatsAppReply(dynamic) : formatFriendlyFallback("I hit a small hiccup on my end.");
    } catch (fallbackErr) {
      reply = formatFriendlyFallback("I hit a small hiccup on my end.");
    }
  }
  return res.type('text/plain').send(reply || formatNotUnderstood());
});

export default router;
