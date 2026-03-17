import { query } from '../config/db.js';

export const STATES = {
  IDLE:                       'IDLE',
  AWAITING_SERVICE:           'AWAITING_SERVICE',
  AWAITING_DATE:              'AWAITING_DATE',
  AWAITING_TIME:              'AWAITING_TIME',
  AWAITING_STAFF:             'AWAITING_STAFF',
  AWAITING_NAME:              'AWAITING_NAME',
  AWAITING_CONFIRMATION:      'AWAITING_CONFIRMATION',
  AWAITING_CANCEL_WHICH:      'AWAITING_CANCEL_WHICH',
  AWAITING_RESCHEDULE_WHICH:  'AWAITING_RESCHEDULE_WHICH',
  AWAITING_RESCHEDULE_DATE:   'AWAITING_RESCHEDULE_DATE',
  AWAITING_RESCHEDULE_TIME:   'AWAITING_RESCHEDULE_TIME',
  AWAITING_RESCHEDULE_CONFIRM:'AWAITING_RESCHEDULE_CONFIRM',
  AWAITING_HANDOFF:           'AWAITING_HANDOFF',
};

// Active-flow sessions (non-IDLE) expire after 10 minutes of inactivity.
// Keeps context when the user pauses (e.g. checks calendar, types slowly, or
// picks an alternative time a few minutes after "that slot is taken").
const SESSION_ACTIVE_TIMEOUT_MS = 10 * 60 * 1000;

// Idle sessions are kept for 30 minutes so the welcome message isn't repeated
// on every message from a casual returning visitor.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function normalizePhone(raw) {
  return raw.replace(/^whatsapp:/i, '').trim();
}

// ─── Get or create session ────────────────────────────────────────────────────
// Does NOT touch updated_at on a plain read — only updateSession() does so that
// the staleness timer measures time since the last real state transition.
export async function getSession(phone, businessId) {
  const { rows } = await query(
    `SELECT * FROM sessions WHERE phone = $1 AND business_id = $2`,
    [phone, businessId],
  );

  if (rows.length) {
    const row     = rows[0];
    const staleMs = Date.now() - new Date(row.updated_at).getTime();
    const isActive = row.state !== STATES.IDLE;
    const timeout  = isActive ? SESSION_ACTIVE_TIMEOUT_MS : SESSION_IDLE_TIMEOUT_MS;

    if (staleMs > timeout) {
      // Session timed out — silently reset so the next message starts fresh
      await query(
        `UPDATE sessions SET state = $1, temp_data = '{}', updated_at = NOW()
         WHERE phone = $2 AND business_id = $3`,
        [STATES.IDLE, phone, businessId],
      );
      return {
        phone,
        businessId,
        state: STATES.IDLE,
        temp: {},
        timedOut: true,
        updatedAt: new Date().toISOString(),
      };
    }

    return {
      phone:      row.phone,
      businessId: row.business_id,
      state:      row.state,
      temp:       row.temp_data || {},
      timedOut:   false,
      updatedAt:  row.updated_at,
    };
  }

  // First message from this user — create a blank session
  await query(
    `INSERT INTO sessions (phone, business_id, state, temp_data, updated_at)
     VALUES ($1, $2, $3, '{}', NOW())
     ON CONFLICT DO NOTHING`,
    [phone, businessId, STATES.IDLE],
  );

  return {
    phone,
    businessId,
    state: STATES.IDLE,
    temp: {},
    timedOut: false,
    updatedAt: new Date().toISOString(),
  };
}

// ─── Update session state + temp_data ────────────────────────────────────────
export async function updateSession(phone, businessId, state, temp = {}) {
  await query(
    `UPDATE sessions
     SET state = $1, temp_data = $2, updated_at = NOW()
     WHERE phone = $3 AND business_id = $4`,
    [state, JSON.stringify(temp), phone, businessId],
  );
}

// ─── Reset session to IDLE ────────────────────────────────────────────────────
export async function resetSession(phone, businessId) {
  await updateSession(phone, businessId, STATES.IDLE, {});
}

// ─── Delete session (for test resets) ────────────────────────────────────────
export async function deleteSession(phone, businessId) {
  await query(
    `DELETE FROM sessions WHERE phone = $1 AND business_id = $2`,
    [phone, businessId],
  );
}
