/**
 * Keyword / rule fallbacks when LLM is unavailable (circuit open or LLM_DEGRADED=1).
 * @see docs/IMPLEMENTATION_ROADMAP.md Phase 1
 */

import { inc } from '../utils/metrics.js';
import {
  normalizeCasualServiceTypos,
  normalizeRelativeDateTypos,
} from '../utils/conversationRepair.js';
import {
  parseBookingIntent as validateBookingIntent,
  parseRescheduleIntent as validateRescheduleIntent,
  parseAvailabilityQuery as validateAvailabilityQuery,
} from '../validation/aiOutput.js';

function todayYMD(tz) {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

function tomorrowYMD(tz) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('en-CA', { timeZone: tz });
}

/** Next 8 days as "Monday = YYYY-MM-DD" fragments for weekday matching */
function weekdayToDateMap(tz) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const map = {};
  for (let i = 0; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const str = d.toLocaleDateString('en-CA', { timeZone: tz });
    const dow = new Date(`${str}T12:00:00`).getDay();
    map[days[dow].toLowerCase()] = str;
  }
  return map;
}

function parseSimpleTime24h(message) {
  const t = message.trim();
  let m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (m) {
    let h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ap = m[3].toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  m = t.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}`;
  if (/\b(morning|subeh|subah)\b/i.test(t)) return '10:00';
  if (/\b(afternoon|dopahar)\b/i.test(t)) return '14:00';
  if (/\b(evening|shaam)\b/i.test(t)) return '17:00';
  if (/\b(night|raat)\b/i.test(t)) return '19:00';
  return null;
}

const HANDOFF_DEGRADED = /\b(human|person|agent|manager|owner|reception|real person|live (chat|support)|talk to (a |someone)|speak (to|with) (a |someone)|need help urgently)\b/i;

/**
 * @param {string} message
 * @param {string[]} serviceNames
 * @returns {{ handoff: boolean, intent: string }}
 */
export function classifyMessageDegraded(message, serviceNames = []) {
  inc('llm_degraded_handling');
  const normalized = normalizeCasualServiceTypos(normalizeRelativeDateTypos(message));
  const lower = normalized.toLowerCase().trim();

  if (HANDOFF_DEGRADED.test(normalized)) {
    return { handoff: true, intent: 'none' };
  }

  if (/\b(remind\s+me|set\s+(a\s+)?reminder|send\s+(me\s+)?(a\s+)?reminder|yaad\s+dil)/i.test(normalized)) {
    return { handoff: false, intent: 'reminder' };
  }
  if (/\b(reschedule|move\s+(my\s+)?(appointment|booking)|change\s+(the\s+)?(date|time))\b/i.test(normalized)) {
    return { handoff: false, intent: 'reschedule' };
  }
  if (
    /\b(cancel\s+(my\s+)?(appointment|booking)|cancel\s+it|please\s+cancel|can\s+(you|u)\s+cancel)\b/i.test(lower) ||
    /^cancel$/i.test(lower.trim())
  ) {
    return { handoff: false, intent: 'cancel' };
  }
  if (/\b(my\s+bookings?|my\s+appointments?|show\s+(me\s+)?my\s+bookings?|upcoming\s+appointments?|list\s+my\s+)/i.test(normalized)) {
    return { handoff: false, intent: 'my_appointments' };
  }
  if (/\b(same\s+(as\s+)?(last|before|usual)|book\s+again|rebook|repeat\s+booking|same\s+appointment)\b/i.test(normalized)) {
    return { handoff: false, intent: 'repeat_booking' };
  }
  if (/\b(available|free\s+slots?|when\s+can\s+i|openings?|any\s+slots?)\b/i.test(lower)) {
    return { handoff: false, intent: 'availability' };
  }
  if (/^(help|menu|start)\s*[\?\.\!]*$/i.test(lower) || /^(what\s+can\s+(you|u)\s+do|how\s+can\s+(you|u)\s+help)/i.test(lower)) {
    return { handoff: false, intent: 'help' };
  }
  if (/\b(phone|address|location|where\s+are\s+you|contact|reach\s+you|call\s+you|email)\b/i.test(lower)) {
    return { handoff: false, intent: 'contact' };
  }
  if (/\b(language|hindi|hinglish|what\s+is\s+this|are\s+you\s+a\s+bot|who\s+are\s+you)\b/i.test(lower)) {
    return { handoff: false, intent: 'faq' };
  }

  for (const name of serviceNames) {
    if (name && lower.includes(String(name).toLowerCase())) {
      return { handoff: false, intent: 'book' };
    }
  }

  if (/\b(book|booking|appointment|schedule|reserve|visit)\b/i.test(lower)) {
    return { handoff: false, intent: 'book' };
  }
  if (/\b(tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|kal|aaj|\d{1,2}\s*(am|pm)|\d{1,2}:\d{2})\b/i.test(lower)) {
    return { handoff: false, intent: 'book' };
  }

  return { handoff: false, intent: 'none' };
}

/**
 * @param {string} message
 * @param {string[]} serviceList
 * @param {string} tz
 */
export function extractBookingIntentDegraded(message, serviceList = [], tz = 'Asia/Kolkata') {
  inc('llm_degraded_handling');
  const cleaned = normalizeCasualServiceTypos(normalizeRelativeDateTypos(message));
  const today = todayYMD(tz);
  const tomorrow = tomorrowYMD(tz);
  const lower = cleaned.toLowerCase();

  let date = null;
  if (/\btomorrow\b|\bkal\b|\baane wala din\b/i.test(cleaned)) date = tomorrow;
  else if (/\btoday\b|\baaj\b/i.test(cleaned)) date = today;
  else {
    const wmap = weekdayToDateMap(tz);
    for (const [day, ymd] of Object.entries(wmap)) {
      if (lower.includes(day)) {
        date = ymd;
        break;
      }
    }
  }

  const time = parseSimpleTime24h(cleaned);

  let service = null;
  for (const s of serviceList) {
    const n = typeof s === 'string' ? s : s?.name;
    if (n && lower.includes(String(n).toLowerCase())) {
      service = n;
      break;
    }
  }

  const raw = { service, date, time, staffName: null };
  return validateBookingIntent(raw, { today });
}

export function extractRescheduleIntentDegraded(message, tz = 'Asia/Kolkata') {
  inc('llm_degraded_handling');
  const today = todayYMD(tz);
  const tomorrow = tomorrowYMD(tz);
  const lower = message.toLowerCase();

  let date = null;
  if (/\btomorrow\b|\bkal\b/i.test(message)) date = tomorrow;
  else if (/\btoday\b|\baaj\b/i.test(message)) date = today;
  else {
    const wmap = weekdayToDateMap(tz);
    for (const [day, ymd] of Object.entries(wmap)) {
      if (lower.includes(day)) {
        date = ymd;
        break;
      }
    }
  }
  const time = parseSimpleTime24h(message);
  return validateRescheduleIntent({ date, time }, { today });
}

export function extractAvailabilityQueryDegraded(tz = 'Asia/Kolkata') {
  inc('llm_degraded_handling');
  const today = todayYMD(tz);
  const todayDate = new Date(`${today}T12:00:00`);
  const weekEnd = new Date(todayDate);
  weekEnd.setDate(todayDate.getDate() + 6);
  const weekEndStr = weekEnd.toLocaleDateString('en-CA', { timeZone: tz });
  return validateAvailabilityQuery({ type: 'week', weekStart: today, weekEnd: weekEndStr }, { today, weekEnd: weekEndStr });
}

/** @param {string} message @param {string[]} serviceNames */
export function extractGlobalIntentDegraded(message, serviceNames = []) {
  const { intent } = classifyMessageDegraded(message, serviceNames);
  return intent;
}

export const DEGRADED_HELP_SNIPPET =
  'I\'m running in *simple mode* right now — reply with short phrases, *HELP*, or pick numbers from the lists I send.';

export const DEGRADED_CONVERSATIONAL_FALLBACK =
  'I can help you book, cancel, or reschedule appointments here. Type *HELP* for options.';

export const DEGRADED_NUDGE_FALLBACK =
  'Still here when you’re ready 🙂 Type *HELP* to see what I can do, or tell me what you need.';

export const DEGRADED_FALLBACK_REPLY =
  'Sorry — I hit a snag. Please try again or type *HELP*. I can help with bookings, cancellations, and your appointments.';

/**
 * @param {{ businessName?: string, businessType?: string, services?: { name: string, price?: unknown }[], customerName?: string | null }} p
 */
export function generateHelpReplyDegraded(p) {
  inc('llm_degraded_handling');
  const { businessName, services = [], customerName = null } = p;
  const greet = customerName ? `Hi ${String(customerName).split(' ')[0]}! ` : '';
  const svc = services.length
    ? services.map((s) => `${s.name}${s.price != null ? ` (₹${parseFloat(s.price).toLocaleString('en-IN')})` : ''}`).join(', ')
    : '';
  return (
    `${greet}I'm *${businessName || 'here'}* — running in simple mode right now. ` +
    `I can help you book, cancel, or reschedule appointments, list your bookings, and check availability.` +
    (svc ? ` Services: ${svc}.` : '') +
    ` Reply with short phrases or pick numbers from the lists I send. Type *HELP* anytime.`
  );
}

/**
 * @param {{ customerName: string, businessName?: string }} p
 */
export function generateReturningUserGreetingDegraded(p) {
  inc('llm_degraded_handling');
  const first = String(p.customerName || 'there').split(' ')[0];
  return `Hey ${first}! Good to see you again 😊 What would you like to do — book, check appointments, or something else? (I'm in simple mode — short replies work best.)`;
}
