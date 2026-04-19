import { z } from 'zod';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** @param {string|null|undefined} s */
export function normalizeDateOrNull(s, todayYMD) {
  if (s == null || typeof s !== 'string') return null;
  const t = s.trim();
  if (!ISO_DATE.test(t)) return null;
  if (todayYMD && t < todayYMD) return null;
  return t;
}

/** @param {string|null|undefined} s */
export function normalizeTimeOrNull(s) {
  if (s == null || typeof s !== 'string') return null;
  const m = s.trim().match(TIME_HHMM);
  if (!m) return null;
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

const nullableTrimmedString = z.preprocess((v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, 500);
}, z.union([z.string().max(500), z.null()]));

const bookingIntentRawSchema = z.object({
  service: nullableTrimmedString,
  date: z.any(),
  time: z.any(),
  staffName: nullableTrimmedString,
});

/**
 * @param {unknown} raw
 * @param {{ today: string }} ctx
 */
export function parseBookingIntent(raw, ctx) {
  const parsed = bookingIntentRawSchema.safeParse(raw);
  if (!parsed.success) {
    return { service: null, date: null, time: null, staffName: null };
  }
  const o = parsed.data;
  return {
    service: o.service ?? null,
    date: normalizeDateOrNull(o.date, ctx.today),
    time: normalizeTimeOrNull(o.time),
    staffName: o.staffName ?? null,
  };
}

const classifyRawSchema = z.object({
  handoff: z.preprocess((v) => {
    if (v === true || v === 'true') return true;
    return false;
  }, z.boolean()),
  intent: z.preprocess((v) => {
    if (typeof v !== 'string') return 'none';
    return v.toLowerCase().replace(/[^a-z_]/g, '') || 'none';
  }, z.string()),
});

const VALID_INTENTS = new Set([
  'book', 'cancel', 'reschedule', 'repeat_booking', 'reminder', 'my_appointments',
  'availability', 'help', 'contact', 'faq', 'none',
]);

/**
 * @param {unknown} raw
 */
export function parseClassifyMessage(raw) {
  const parsed = classifyRawSchema.safeParse(raw);
  if (!parsed.success) {
    return { handoff: false, intent: 'none' };
  }
  const intent = VALID_INTENTS.has(parsed.data.intent) ? parsed.data.intent : 'none';
  return { handoff: parsed.data.handoff, intent };
}

const rescheduleRawSchema = z.object({
  date: z.any(),
  time: z.any(),
});

/**
 * @param {unknown} raw
 * @param {{ today: string }} ctx
 */
export function parseRescheduleIntent(raw, ctx) {
  const parsed = rescheduleRawSchema.safeParse(raw);
  if (!parsed.success) {
    return { date: null, time: null };
  }
  const o = parsed.data;
  return {
    date: normalizeDateOrNull(o.date, ctx.today),
    time: normalizeTimeOrNull(o.time),
  };
}

const availabilityRawSchema = z.object({
  type: z.preprocess((v) => (v === 'day' || v === 'week' ? v : 'week'), z.enum(['day', 'week'])),
  date: z.any(),
  weekStart: z.any(),
  weekEnd: z.any(),
});

function normalizeWeekDateLoose(s) {
  if (s == null || typeof s !== 'string') return null;
  const t = s.trim();
  return ISO_DATE.test(t) ? t : null;
}

/**
 * @param {unknown} raw
 * @param {{ today: string, weekEnd: string }} ctx
 */
export function parseAvailabilityQuery(raw, ctx) {
  const parsed = availabilityRawSchema.safeParse(raw);
  if (!parsed.success) {
    return { type: 'week', weekStart: ctx.today, weekEnd: ctx.weekEnd };
  }
  const o = parsed.data;
  if (o.type === 'day') {
    const date = normalizeDateOrNull(o.date, ctx.today);
    return {
      type: 'day',
      date,
      weekStart: ctx.today,
      weekEnd: ctx.weekEnd,
    };
  }
  let ws = normalizeWeekDateLoose(o.weekStart);
  if (!ws || ws < ctx.today) ws = ctx.today;
  let we = normalizeWeekDateLoose(o.weekEnd);
  if (!we || we < ws) we = ctx.weekEnd;
  return {
    type: 'week',
    weekStart: ws,
    weekEnd: we,
  };
}
