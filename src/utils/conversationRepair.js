import {
  matchServiceFromMessage,
  matchServicesFromMessage,
} from './serviceMatch.js';

/**
 * Phase 2 — conversation repair: strip "actually / I meant / sorry" style prefixes
 * so the remainder can be matched by extractBookingIntent / matchServicesFromMessage.
 */

const LEADING_CORRECTION =
  /^\s*(actually|i\s+meant|sorry,?\s*|wait,?\s*|no,?\s*|scratch\s+that|change\s+(it\s+)?to|make\s+it|instead,?\s*|not\s+that,?\s*|correction,?\s*)\s*[,:\s\u2013\u2014-]*/i;
const LEADING_PUNCT = /^[—–\-:,]\s*/;

/**
 * @param {string} message
 * @returns {{ cleaned: string, hadCorrection: boolean }}
 */
export function stripCorrectionPrefix(message) {
  const raw = String(message || '').trim();
  if (!raw) return { cleaned: '', hadCorrection: false };

  let rest = raw.replace(LEADING_CORRECTION, '').trim();
  if (rest !== raw) {
    rest = rest.replace(LEADING_PUNCT, '').trim();
    return { cleaned: rest, hadCorrection: true };
  }

  // Trailing "instead" / "instead of that"
  const trimmed = raw.replace(/\s+(instead|rather)\s*\.?$/i, '').trim();
  if (trimmed !== raw && trimmed.length >= 2) {
    return { cleaned: trimmed, hadCorrection: true };
  }

  return { cleaned: raw, hadCorrection: false };
}

/**
 * Fix casual typos so extractBookingIntent can resolve relative dates.
 * @param {string} message
 */
export function normalizeRelativeDateTypos(message) {
  let s = String(message || '').trim();
  // Common "tomorrow" / "today" misspellings (user-typed + speech-to-text)
  s = s.replace(/\b(tommorow|tommorrow|tomorow|tommotow|tommow)\b/gi, 'tomorrow');
  s = s.replace(/\b(tod ?ay|todays)\b/gi, 'today');
  return s;
}

/** Obvious service-name typos before fuzzy matching (e.g. "beard trip" → beard trim). */
export function normalizeCasualServiceTypos(message) {
  return String(message || '')
    .replace(/\bbeard\s+trip\b/gi, 'beard trim')
    .replace(/\bharicut\b/gi, 'haircut')
    .replace(/\bhair\s*cutt\b/gi, 'haircut')
    .replace(/\bhaircolor\b/gi, 'hair colour')
    .trim();
}

/**
 * True when the user names specific catalog services (new booking), so we should not treat
 * phrases like "book again" as "repeat last appointment only".
 * Example: "I would like to book again on Tuesday for facial, hair colour and haircut" → true.
 * @param {string} message
 * @param {{ name: string }[]} services
 */
export function specifiesNewBookingServices(message, services) {
  if (!message?.trim() || !services?.length) return false;
  const repaired = normalizeCasualServiceTypos(normalizeRelativeDateTypos(message));
  const lower = repaired.toLowerCase();

  const againIdx = lower.search(/\bbook\s+again\b/);
  const forIdx = lower.search(/\bfor\b/);
  if (againIdx !== -1 && forIdx !== -1 && forIdx > againIdx) {
    const afterFor = repaired.slice(forIdx).replace(/^for\s+/i, '').trim();
    if (matchServicesFromMessage(afterFor, services)?.length) return true;
    if (matchServiceFromMessage(afterFor, services)) return true;
  }

  if (matchServicesFromMessage(repaired, services)?.length >= 2) return true;

  const forMatch = repaired.match(/\bfor\s+(.+)/is);
  if (forMatch) {
    const rest = forMatch[1].trim();
    if (matchServicesFromMessage(rest, services)?.length) return true;
    if (matchServiceFromMessage(rest, services)) return true;
  }

  for (const s of services) {
    const n = String(s.name || '').toLowerCase().trim();
    if (n.length >= 4 && lower.includes(n)) return true;
  }
  return false;
}

/**
 * Deterministic YYYY-MM-DD for "today" / "tomorrow" when the LLM returns no date
 * (e.g. noisy phrasing "tommorow at 10").
 * @param {string} message — ideally already passed through {@link normalizeRelativeDateTypos}
 * @param {string} businessTZ IANA timezone
 * @returns {string | null}
 */
export function extractFallbackRelativeDate(message, businessTZ) {
  const s = normalizeRelativeDateTypos(message).toLowerCase();
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: businessTZ });
  if (/\btomorrow\b/.test(s)) {
    const [y, m, d] = todayStr.split('-').map(Number);
    const utc = Date.UTC(y, m - 1, d, 12, 0, 0);
    return new Date(utc + 86400000).toLocaleDateString('en-CA', { timeZone: businessTZ });
  }
  if (/\btoday\b/.test(s)) return todayStr;
  return null;
}
