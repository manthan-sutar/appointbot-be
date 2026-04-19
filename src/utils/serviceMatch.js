/**
 * Fuzzy match user text to a catalog service (handles typos like "beared" → "beard").
 */

export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j < n + 1; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Lower score = better match. Infinity = no match.
 */
function scoreService(raw, msgLower, msgWords, msgFold, s) {
  const name = String(s.name || '').trim();
  const nameLower = name.toLowerCase();
  if (!nameLower) return Infinity;

  if (msgLower.includes(nameLower)) return 0;
  if (raw.length <= 48 && nameLower.includes(msgLower) && msgFold.length >= 3) return 0.5;

  const nameWords = nameLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  const nameFold = nameLower.replace(/[^a-z0-9]+/g, '');

  let best = Infinity;

  if (nameFold.length >= 3 && msgFold.length >= 3) {
    const dWhole = levenshtein(msgFold, nameFold);
    const maxL = Math.max(msgFold.length, nameFold.length);
    const maxDist = Math.max(2, Math.ceil(maxL * 0.38));
    if (dWhole <= maxDist) best = dWhole;
  }

  if (nameWords.length > 0 && msgWords.length > 0) {
    let sum = 0;
    let tokenOk = true;
    for (const nw of nameWords) {
      let localMin = Infinity;
      for (const mw of msgWords) {
        const d = levenshtein(nw, mw);
        if (d < localMin) localMin = d;
      }
      const limit = nw.length <= 5 ? 2 : nw.length <= 12 ? 3 : 4;
      if (localMin > limit) {
        tokenOk = false;
        break;
      }
      sum += localMin;
    }
    if (tokenOk) best = Math.min(best, sum);
  }

  return best;
}

/**
 * @param {string} message - user reply (number or free text)
 * @param {{ id: unknown, name: string }[]} services
 * @returns {typeof services[0] | null}
 */
export function matchServiceFromMessage(message, services) {
  if (!services?.length) return null;
  const raw = String(message || '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < services.length) return services[idx];
  }

  const msgLower = raw.toLowerCase();
  const msgWords = msgLower.split(/[^a-z0-9]+/).filter((w) => w.length >= 1);
  const msgFold = msgLower.replace(/[^a-z0-9]+/g, '');

  let best = null;
  let bestScore = Infinity;

  for (const s of services) {
    const sc = scoreService(raw, msgLower, msgWords, msgFold, s);
    if (sc < bestScore) {
      bestScore = sc;
      best = s;
    }
  }

  return bestScore < Infinity ? best : null;
}

/** Leading phrases like "please book," — removed before splitting. */
export function stripBookingPrefix(raw) {
  return String(raw || '')
    .trim()
    .replace(/^(?:\s*please\s+)?(?:book|booking)\s*[,:\s]*/i, '')
    .trim();
}

/**
 * Split a user message into segments, each expected to name one service
 * (commas, "and", "&", ";", or whitespace between digits-only tokens).
 * @returns {string[]}
 */
export function segmentServiceMessage(raw) {
  const cleaned = stripBookingPrefix(raw);
  if (!cleaned) return [];

  if (/^[\d\s,]+$/.test(cleaned)) {
    return cleaned.split(/[\s,]+/).filter(Boolean);
  }

  return cleaned
    .split(/\s*(?:,|;|(?:\s+and\s+)|(?:\s*&\s+))\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Combine several matched catalog rows for one appointment (duration / price summed).
 * `serviceId` is the first service (FK); `notes` documents the full combo for the DB row.
 */
export function aggregateMatchedServices(matched) {
  if (!matched?.length) return null;
  const durationMinutes = matched.reduce((sum, s) => sum + (Number(s.duration_minutes) || 0), 0);
  const price = matched.reduce((sum, s) => sum + (parseFloat(s.price) || 0), 0);
  const serviceName = matched.map((s) => s.name).join(', ');
  const serviceId = matched[0].id;
  const serviceIds = matched.map((s) => s.id);
  const notes =
    matched.length > 1
      ? `Combined booking: ${matched.map((s) => `${s.name} (${Number(s.duration_minutes) || 0} min)`).join('; ')}`
      : null;
  return { serviceId, serviceIds, serviceName, durationMinutes, price, notes };
}

/**
 * Match multiple services from one reply (e.g. "1, 4", "beard trim and haircut",
 * "please book, beard trup, facial and haircut.").
 * @returns {Array<typeof services[0]> | null} — null if any segment does not match a distinct service
 */
export function matchServicesFromMessage(message, services) {
  if (!services?.length) return null;
  const segments = segmentServiceMessage(message);
  if (!segments.length) return null;

  const seen = new Set();
  const matched = [];

  for (const seg of segments) {
    const svc = matchServiceFromMessage(seg, services);
    if (!svc) return null;
    const key = svc.id;
    if (!seen.has(key)) {
      seen.add(key);
      matched.push(svc);
    }
  }
  return matched.length ? matched : null;
}
