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
    .trim();
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
