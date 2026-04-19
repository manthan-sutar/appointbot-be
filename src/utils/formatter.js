// ─── Date / time helpers ──────────────────────────────────────────────────────

export function formatDate(dateStr) {
  if (dateStr == null || typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
    return '—';
  }
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatTime(timeStr) {
  if (timeStr == null || typeof timeStr !== 'string' || !timeStr.includes(':')) {
    return '—';
  }
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour   = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}

/** "HH:MM" → minutes since midnight (for comparing slot order). */
export function timeToMinutes(timeStr) {
  const [h, m] = (timeStr || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Reason why a requested time isn't in the available slots list.
 * @param {string} requestedTime - "HH:MM"
 * @param {string[]} allSlots - available slots "HH:MM"
 * @param {number} durationMinutes
 * @returns {string} Short explanation
 */
export function getTimeNotAvailableReason(requestedTime, allSlots, durationMinutes = 30) {
  if (!allSlots?.length) return 'That slot isn\'t available.';
  const req = timeToMinutes(requestedTime);
  const first = timeToMinutes(allSlots[0]);
  const last  = timeToMinutes(allSlots[allSlots.length - 1]);
  if (req < first) return 'That time has already passed for that day.';
  if (req > last) return 'We\'re closed by then on that day.';
  return 'That slot isn\'t available (it may be booked).';
}

export function formatDateTime(scheduledAt, tz = null) {
  const d = new Date(scheduledAt);
  const tzOpts = tz ? { timeZone: tz } : {};
  const date = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', ...tzOpts });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, ...tzOpts });
  return `${date} at ${time}`;
}

// ─── Slot curation ────────────────────────────────────────────────────────────
// Picks up to `max` evenly-spread representative slots from a full slot list.
// Exported so webhook.js can use the same curated list for both display AND
// number-to-slot lookup (reply "2" → displaySlots[1]).

export function curateSlots(slots, max = 6) {
  if (!slots || !slots.length) return [];
  if (slots.length <= max) return [...slots];
  const result = [];
  const step = (slots.length - 1) / (max - 1);
  const seen  = new Set();
  for (let i = 0; i < max; i++) {
    const idx = Math.round(i * step);
    if (!seen.has(idx)) {
      seen.add(idx);
      result.push(slots[idx]);
    }
  }
  return result;
}

// ─── Business-type persona helpers ───────────────────────────────────────────

function persona(businessType) {
  switch ((businessType || '').toLowerCase()) {
    case 'salon':   return { role: 'stylist', team: 'our team', visit: 'visit',        place: 'salon'  };
    case 'doctor':  return { role: 'doctor',  team: 'the doctor', visit: 'appointment', place: 'clinic' };
    case 'dentist': return { role: 'dentist', team: 'the dentist', visit: 'appointment', place: 'clinic' };
    case 'tutor':   return { role: 'tutor',   team: 'your tutor', visit: 'session',      place: 'centre' };
    default:        return { role: 'staff',   team: 'our team',  visit: 'appointment',  place: 'us'     };
  }
}

// Pick a random item from an array — adds natural variation
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─── Welcome / help message ───────────────────────────────────────────────────

export function formatWelcome(businessName, services = [], customerName = null, businessType = null) {
  const p = persona(businessType);
  const serviceList = services.length
    ? services.map((s, i) => `  ${i + 1}. ${s.name}${s.price ? ` — ₹${parseFloat(s.price).toLocaleString('en-IN')}` : ''}`).join('\n')
    : `  (No services listed yet)`;

  const greeting = customerName
    ? pick([
        `👋 *Hey ${customerName}!* Great to see you again.`,
        `👋 *Welcome back, ${customerName}!*`,
        `👋 *Hi ${customerName}!* Good to have you back.`,
      ])
    : pick([
        `👋 *Welcome to ${businessName}!*`,
        `👋 *Hi there! Welcome to ${businessName}.*`,
        `👋 *Hello! You've reached ${businessName}.*`,
      ]);

  const examples = services.length
    ? `_"Book a ${services[0].name.toLowerCase()} tomorrow at 5pm"_`
    : `_"Book an appointment tomorrow at 5pm"_`;

  return `${greeting}

I'm your AI booking assistant for *${businessName}*. Here's what I can do:

📅 *Book* — ${examples}
❌ *Cancel* — _"Cancel my appointment"_
🔄 *Reschedule* — _"Move my ${p.visit} to Friday"_
📋 *My Bookings* — _"Show my upcoming ${p.visit}s"_
🗓️ *Availability* — _"What's free this week?"_
📋 *Services* — _"What services do you offer?"_
📞 *Contact* — _"How do I reach you?"_

*Our Services:*
${serviceList}

Just tell me what you need! 😊`;
}

// ─── Service selection prompt ─────────────────────────────────────────────────

export function formatServiceList(services, businessType = null) {
  const list = services.map((s, i) =>
    `  ${i + 1}. *${s.name}* — ${s.duration_minutes} min${s.price ? `, ₹${parseFloat(s.price).toLocaleString('en-IN')}` : ''}`
  ).join('\n');

  const prompt = pick([
    `Which service can I book for you?`,
    `What would you like to book today?`,
    `Which service are you looking for?`,
  ]);

  return `${prompt}\n\n${list}\n\n` +
    `Reply with the number or name — *one or more* (e.g. _1, 4_ or _beard trim and facial_).`;
}

// ─── Staff selection prompt ───────────────────────────────────────────────────

export function formatStaffList(staffList, businessType = null) {
  const list = staffList.map((s, i) => `  ${i + 1}. *${s.name}*${s.role ? ` (${s.role})` : ''}`).join('\n');
  return `Who would you like to book with?\n\n${list}\n\nReply with the number, name, or _"any"_ for the first available.`;
}

// ─── Available slots prompt ───────────────────────────────────────────────────
// IMPORTANT: pass an already-curated list (curateSlots()) so the numbers match
// exactly what is stored in temp.displaySlots for lookup in AWAITING_TIME.

export function formatSlotList(slots, date) {
  if (!slots || !slots.length) {
    return pick([
      `Sorry, no slots left on *${formatDate(date)}*. Would you like to try another date?`,
      `Looks like *${formatDate(date)}* is fully booked. Want to pick a different day?`,
    ]);
  }

  const list = slots.map((t, i) => `  ${i + 1}. ${formatTime(t)}`).join('\n');

  const prompt = pick([
    `Here are some open times on *${formatDate(date)}*:`,
    `Available on *${formatDate(date)}*:`,
    `These times are free on *${formatDate(date)}*:`,
  ]);

  return `${prompt}\n\n${list}\n\nReply with the *number* or say the time (e.g. "2" or "4pm").`;
}

// ─── Booking confirmation prompt ──────────────────────────────────────────────
// Clean, scannable format — no redundant emojis per line.

export function formatConfirmationPrompt({ service, serviceName, staffName, date, time, price, customerName }, businessType = null) {
  const svc      = service || serviceName || 'Appointment';
  const priceStr = price ? `\nPrice: ₹${parseFloat(price).toLocaleString('en-IN')}` : '';

  return `Please confirm your booking:\n\n` +
    `Service: ${svc}\n` +
    `Staff: ${staffName}\n` +
    `Date: ${formatDate(date)}\n` +
    `Time: ${formatTime(time)}\n` +
    (customerName ? `Name: ${customerName}\n` : '') +
    priceStr +
    `\n\nReply *YES* to confirm or *NO* to cancel.`;
}

// ─── Booking confirmed message ────────────────────────────────────────────────

export function formatBookingConfirmed({ service, serviceName, staffName, date, time, appointmentId, customerName, businessName, businessType, reminderNote } = {}) {
  const svc = service || serviceName || 'Appointment';
  const p   = persona(businessType);

  const closing = pick([
    `We'll see you then! 😊`,
    `Looking forward to seeing you! 😊`,
    `See you at *${businessName || p.place}*! 😊`,
    `You're all set! See you soon 😊`,
  ]);

  // reminderNote=undefined → legacy (cron-handled, always show 24h line)
  // reminderNote=string    → use that line
  // reminderNote=null      → appointment is too soon for any reminder, omit line
  const rLine = reminderNote === undefined
    ? `You'll get a reminder 24 hours before.\n`
    : reminderNote
      ? `${reminderNote}\n`
      : '';

  return `✅ *Booking Confirmed!*\n\n` +
    `Service: ${svc}\n` +
    `Staff: ${staffName}\n` +
    `Date: ${formatDate(date)}\n` +
    `Time: ${formatTime(time)}\n` +
    (customerName ? `Name: ${customerName}\n` : '') +
    `Ref #: ${appointmentId}\n\n` +
    `${rLine}To cancel or reschedule, just message me anytime.\n\n${closing}`;
}

// ─── Upcoming appointments list ───────────────────────────────────────────────

export function formatAppointmentList(appointments, customerName = null, businessType = null, tz = null) {
  const p = persona(businessType);
  if (!appointments.length) {
    const noAppt = pick([
      `You have no upcoming ${p.visit}s right now.`,
      `Looks like your schedule is clear!`,
      `No upcoming bookings found.`,
    ]);
    return noAppt + `\nWant to book one? Just tell me the service and date! 😊`;
  }

  const list = appointments.map((a, i) => {
    const dt = formatDateTime(a.scheduled_at, tz);
    return `${i + 1}. *${a.service_name || 'Appointment'}* with ${a.staff_name || p.team}\n   📅 ${dt} · Ref #${a.id}`;
  }).join('\n\n');

  const header = customerName
    ? `📋 *${customerName}'s Upcoming Bookings:*`
    : `📋 *Your Upcoming Bookings:*`;

  return `${header}\n\n${list}\n\nTo cancel or reschedule, say *cancel* or *reschedule*, or reply with the booking number (*1*, *2*, …).`;
}

// ─── Cancellation confirmed ───────────────────────────────────────────────────

export function formatCancellationConfirmed(appt, businessType = null, tz = null) {
  const p = persona(businessType);
  const closing = pick([
    `Hope to see you again soon! 😊`,
    `No worries — feel free to book again anytime! 😊`,
    `Take care, and come back whenever you need us! 😊`,
  ]);
  return `✅ *Cancelled!*\n\nYour *${appt.service_name || p.visit}* on ${formatDateTime(appt.scheduled_at, tz)} has been cancelled.\n\n${closing}`;
}

// ─── Reminder message (sent 24 h before) ─────────────────────────────────────
// Clean format — customer can reply CANCEL directly.

export function formatReminderMessage(appt, tz = null) {
  return `📅 *Reminder from ${appt.business_name}*\n\n` +
    `You have an appointment tomorrow:\n\n` +
    `Service: ${appt.service_name || 'Appointment'}\n` +
    `Staff: ${appt.staff_name || 'our team'}\n` +
    `Time: ${formatDateTime(appt.scheduled_at, tz)}\n\n` +
    `Reply *CANCEL* if you cannot make it. See you soon! 😊`;
}

// ─── Reschedule confirmed ─────────────────────────────────────────────────────

export function formatRescheduleConfirmed({ serviceName, staffName, date, time, appointmentId, businessType } = {}) {
  const p = persona(businessType);
  const closing = pick([
    `See you at the new time! 😊`,
    `All updated — see you then! 😊`,
    `Done! Looking forward to seeing you. 😊`,
  ]);

  return `✅ *Rescheduled!*\n\n` +
    `Service: ${serviceName || p.visit}\n` +
    `Staff: ${staffName || p.team}\n` +
    `New Date: ${formatDate(date)}\n` +
    `New Time: ${formatTime(time)}\n` +
    `Ref #: ${appointmentId}\n\n${closing}`;
}

// ─── Availability summary ─────────────────────────────────────────────────────
// Human-friendly ranges, no numbered list (this is an overview, not a slot picker).

export function formatAvailabilitySummary(daysWithSlots, businessType = null) {
  if (!daysWithSlots.length) {
    return pick([
      `Sorry, no open slots in the next few days. 😔 Try asking about a date further ahead!`,
      `Looks like we're fully booked for now. Try a date a week or two out?`,
    ]);
  }

  const lines = daysWithSlots.map(({ date, slots }) => {
    if (!slots.length) return null;
    const first = formatTime(slots[0]);
    const last  = formatTime(slots[slots.length - 1]);
    if (slots.length <= 3) {
      return `📅 *${formatDate(date)}* — ${slots.map(formatTime).join(', ')}`;
    }
    return `📅 *${formatDate(date)}* — anytime ${first} to ${last} (${slots.length} slots free)`;
  }).filter(Boolean);

  const intro = pick([
    `Here's what's available:`,
    `Good news — here's our availability:`,
    `These dates are open:`,
  ]);

  return `${intro}\n\n${lines.join('\n')}\n\nJust say the date and time to book — e.g. _"Monday at 10am"_ 😊`;
}

// ─── Human handoff ────────────────────────────────────────────────────────────

export function formatHandoffMessage(businessName) {
  return pick([
    `Sure! I'll let the team at *${businessName}* know you'd like to speak to someone. They'll get back to you shortly.\n\nIn the meantime, I can still help you book or check appointments — just say *HELP* if you need anything!`,
    `Got it — I've flagged this for the *${businessName}* team and someone will follow up with you soon.\n\nType *HELP* if there's anything else I can do in the meantime.`,
  ]);
}

// ─── Error / fallback messages ────────────────────────────────────────────────

export function formatError(msg) {
  return `❌ ${msg}\n\nType *HELP* if you need a hand.`;
}

/** Human-friendly message when something went wrong or we couldn't handle the request. Never ghost the customer. */
export function formatFriendlyFallback(customReason = null) {
  const reason = customReason || "I couldn't quite handle that.";
  return pick([
    `Sorry — ${reason} Try again in a moment, or type *HELP* to see what I can do. I'm here! 🙂`,
    `Oops, ${reason.toLowerCase()} No worries — type *HELP* anytime and we'll get you sorted.`,
  ]);
}

export function formatNotUnderstood() {
  return pick([
    `I didn't quite catch that. 🤔\n\nYou can say:\n• *BOOK* — make a booking\n• *CANCEL* — cancel an appointment\n• *RESCHEDULE* — change a booking\n• *SERVICES* — see what we offer\n• *HELP* — see all options`,
    `Hmm, not sure I understood that. 🤔\n\nTry:\n_"Book a haircut tomorrow at 5pm"_\n_"Cancel my appointment"_\n_"What's free this week?"_\n\nOr type *HELP*.`,
  ]);
}

function stripExtraEmojis(s, maxEmojis = 2) {
  if (!s || maxEmojis == null) return s;
  let count = 0;
  // Best-effort emoji detection; works well on Node versions that support Unicode property escapes.
  const re = /\p{Extended_Pictographic}/gu;
  return s.replace(re, (m) => {
    count += 1;
    return count <= maxEmojis ? m : '';
  });
}

/**
 * Enforce WhatsApp-friendly AI reply formatting.
 * - No blank lines (no paragraphs)
 * - Max N non-empty lines
 * - Max M emojis
 */
export function formatShortWhatsAppReply(raw, { maxLines = 3, maxEmojis = 2 } = {}) {
  const text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, Math.max(1, maxLines));

  const compact = lines.join('\n').trim();
  return stripExtraEmojis(compact, maxEmojis).trim();
}
