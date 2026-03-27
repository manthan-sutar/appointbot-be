import { query, getClient } from "../config/db.js";

export async function createAppointmentEvent(appointmentId, businessId, eventType, eventData = {}) {
  if (!appointmentId || !businessId || !eventType) return;
  await query(
    `INSERT INTO appointment_events (appointment_id, business_id, event_type, event_data)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [appointmentId, businessId, eventType, JSON.stringify(eventData || {})],
  );
}

// ─── Timezone utility ────────────────────────────────────────────────────────
// Convert a date + time expressed in a given IANA timezone to a UTC Date.
// e.g. localToUTC('2026-03-15', '10:00', 'Asia/Kolkata')  →  Date @ 04:30 UTC
export function localToUTC(dateStr, timeStr, tz) {
  // Step 1 – treat the input as UTC to get a reference Date
  const naive = new Date(`${dateStr}T${timeStr}:00Z`);
  // Step 2 – find how that UTC moment appears in the target timezone
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(naive).map((p) => [p.type, p.value]),
  );
  const h = parts.hour === "24" ? "00" : parts.hour;
  // Step 3 – parse that local representation back as UTC
  const tzAsUTC = new Date(
    `${parts.year}-${parts.month}-${parts.day}T${h}:${parts.minute}:00Z`,
  );
  // Step 4 – the offset tells us how far the tz is ahead of UTC at that moment
  const offsetMs = naive.getTime() - tzAsUTC.getTime();
  return new Date(naive.getTime() + offsetMs);
}

// ─── Customer persistence ─────────────────────────────────────────────────────

export async function getCustomerName(phone, businessId) {
  const { rows } = await query(
    `SELECT name FROM customers WHERE phone = $1 AND business_id = $2`,
    [phone, businessId],
  );
  return rows[0]?.name || null;
}

export async function upsertCustomer(phone, businessId, name) {
  await query(
    `INSERT INTO customers (phone, business_id, name, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (phone, business_id) DO UPDATE
       SET name = EXCLUDED.name, updated_at = NOW()`,
    [phone, businessId, name],
  );
}

// ─── Get business by ID ───────────────────────────────────────────────────────
export async function getBusiness(businessId) {
  const { rows } = await query(`SELECT * FROM businesses WHERE id = $1`, [
    businessId,
  ]);
  return rows[0] || null;
}

// ─── Get business by slug ─────────────────────────────────────────────────────
export async function getBusinessBySlug(slug) {
  const { rows } = await query(`SELECT * FROM businesses WHERE slug = $1`, [
    slug,
  ]);
  return rows[0] || null;
}

// ─── Get business by phone (for WhatsApp webhook routing) ─────────────────────
// When multiple businesses use the same number (e.g. shared test number), returns
// the latest one by creation time so the most recently registered business wins.
export async function getBusinessByPhone(phone) {
  const normalized = phone
    .replace(/^whatsapp:/i, "")
    .replace(/^\+/, "")
    .replace(/\s+/g, "")
    .trim();
  const { rows } = await query(
    `SELECT *
       FROM businesses
      WHERE TRIM(REPLACE(REPLACE(COALESCE(phone, ''), '+', ''), ' ', '')) = $1
         OR TRIM(REPLACE(REPLACE(COALESCE(whatsapp_display_phone, ''), '+', ''), ' ', '')) = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [normalized],
  );
  return rows[0] || null;
}

// ─── Get all active services for a business ───────────────────────────────────
export async function getServices(businessId) {
  const { rows } = await query(
    `SELECT * FROM services WHERE business_id = $1 AND active = TRUE ORDER BY name`,
    [businessId],
  );
  return rows;
}

// ─── Get service by name (fuzzy match) ───────────────────────────────────────
export async function findService(businessId, name) {
  const { rows } = await query(
    `SELECT * FROM services
     WHERE business_id = $1 AND active = TRUE
       AND name ILIKE $2
     LIMIT 1`,
    [businessId, `%${name}%`],
  );
  return rows[0] || null;
}

// ─── Get all active staff for a business ─────────────────────────────────────
export async function getStaff(businessId) {
  const { rows } = await query(
    `SELECT * FROM staff WHERE business_id = $1 AND active = TRUE ORDER BY name`,
    [businessId],
  );
  return rows;
}

// ─── Get available time slots for a given date + staff + service ──────────────
// Returns array of "HH:MM" strings that are free (never returns past slots).
// Uses business timezone for "today" and for filtering booked appointments.
// Pass `tz` to skip the getBusiness lookup (used by batch callers).
export async function getAvailableSlots(
  businessId,
  date,
  staffId,
  durationMinutes = 30,
  tz = null,
) {
  // eslint-disable-next-line no-param-reassign
  if (!tz) tz = (await getBusiness(businessId))?.timezone || "Asia/Kolkata";

  const todayInTz = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  if (date < todayInTz) return [];

  const dayOfWeek = new Date(date + "T12:00:00").getDay(); // 0=Sun, 6=Sat

  const { rows: avail } = await query(
    `SELECT start_time, end_time FROM availability
     WHERE staff_id = $1 AND day_of_week = $2`,
    [staffId, dayOfWeek],
  );

  if (!avail.length) return [];

  const { start_time, end_time } = avail[0];

  const { rows: booked } = await query(
    `SELECT scheduled_at, duration_minutes FROM appointments
     WHERE staff_id = $1
       AND DATE(scheduled_at AT TIME ZONE $3) = $2
       AND status NOT IN ('cancelled')`,
    [staffId, date, tz],
  );

  const blockedMinutes = new Set();
  for (const appt of booked) {
    const timeStr = new Date(appt.scheduled_at).toLocaleTimeString("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    const [h, m] = timeStr.split(":").map(Number);
    const startMin = (h || 0) * 60 + (m || 0);
    for (let i = startMin; i < startMin + appt.duration_minutes; i++) {
      blockedMinutes.add(i);
    }
  }

  const [sh, sm] = start_time.split(":").map(Number);
  const [eh, em] = end_time.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  let nowMinutes = 0;
  if (date === todayInTz) {
    const [h, m] = new Date()
      .toLocaleTimeString("en-GB", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
      .split(":")
      .map(Number);
    nowMinutes = (h || 0) * 60 + (m || 0) + 30;
  }

  const slots = [];
  for (let m = startMin; m + durationMinutes <= endMin; m += 30) {
    if (m < nowMinutes) continue; // skip past/too-soon slots
    let free = true;
    for (let i = m; i < m + durationMinutes; i++) {
      if (blockedMinutes.has(i)) {
        free = false;
        break;
      }
    }
    if (free) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      slots.push(`${hh}:${mm}`);
    }
  }

  return slots;
}

// ─── Find first staff who has slots on a given date (tries preferred staff first) ─
// Use when one staff may be off (e.g. not available Friday) but another is available.
// Fetches business once to avoid N+1 getBusiness calls across staff iteration.
export async function getFirstStaffWithSlotsOnDate(
  businessId,
  date,
  durationMinutes = 30,
  preferredStaffId = null,
) {
  const [staffList, business] = await Promise.all([
    getStaff(businessId),
    getBusiness(businessId),
  ]);
  if (!staffList.length) return null;

  const tz = business?.timezone || "Asia/Kolkata";

  const ordered = preferredStaffId
    ? [
        ...staffList.filter((s) => s.id === preferredStaffId),
        ...staffList.filter((s) => s.id !== preferredStaffId),
      ]
    : staffList;

  for (const staff of ordered) {
    const slots = await getAvailableSlots(
      businessId,
      date,
      staff.id,
      durationMinutes,
      tz,
    );
    if (slots.length) {
      return { staffId: staff.id, staffName: staff.name, slots };
    }
  }
  return null;
}

// ─── Book an appointment ──────────────────────────────────────────────────────
// Idempotent: if the exact same slot is already confirmed for this staff, return existing
export async function bookAppointment({
  businessId,
  staffId,
  serviceId,
  customerPhone,
  customerName,
  date,
  time,
  durationMinutes,
  notes,
}) {
  const business = await getBusiness(businessId);
  const tz = business?.timezone || "Asia/Kolkata";
  const scheduledAt = localToUTC(date, time, tz);

  // Check for duplicate (same customer, same slot, same staff, confirmed)
  const { rows: existing } = await query(
    `SELECT * FROM appointments
     WHERE customer_phone = $1 AND staff_id = $2
       AND scheduled_at = $3 AND status = 'confirmed'
     LIMIT 1`,
    [customerPhone, staffId, scheduledAt],
  );
  if (existing.length) return existing[0]; // idempotent — return existing booking

  // Check slot is still free (race condition guard)
  const slots = await getAvailableSlots(
    businessId,
    date,
    staffId,
    durationMinutes,
  );
  if (!slots.includes(time)) {
    const err = new Error("SLOT_TAKEN");
    err.slots = slots;
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO appointments
       (business_id, staff_id, service_id, customer_phone, customer_name,
        scheduled_at, duration_minutes, status, notes, confirmation_status, confirmation_deadline_at)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, 'confirmed', $8, 'pending',
       GREATEST(
         $6 - make_interval(mins => COALESCE((SELECT confirmation_cutoff_minutes FROM businesses WHERE id = $1), 90)),
         NOW()
       )
     )
     RETURNING *`,
    [
      businessId,
      staffId,
      serviceId,
      customerPhone,
      customerName,
      scheduledAt,
      durationMinutes,
      notes || null,
    ],
  );
  const created = rows[0];
  await createAppointmentEvent(created.id, businessId, "appointment_booked", {
    source: "booking_flow",
    staffId,
    serviceId,
  });
  return created;
}

// ─── Manual/admin booking (customer called) ────────────────────────────────
// Creates a confirmed appointment while validating against staff availability.
export async function createAppointmentManually({
  businessId,
  staffId,
  serviceId,
  customerPhone,
  customerName,
  date,
  time,
  notes,
}) {
  const normalizedPhone = String(customerPhone || '')
    .replace(/^whatsapp:/i, '')
    .replace(/^\+/, '')
    .replace(/\s+/g, '')
    .trim();

  const trimmedCustomerName = typeof customerName === 'string' ? customerName.trim() : '';

  if (!normalizedPhone) {
    const err = new Error('customerPhone is required');
    err.statusCode = 400;
    throw err;
  }
  if (!staffId || !serviceId) {
    const err = new Error('staffId and serviceId are required');
    err.statusCode = 400;
    throw err;
  }
  if (!date || !time) {
    const err = new Error('date and time are required');
    err.statusCode = 400;
    throw err;
  }

  // Validate active staff + service and fetch duration from service.
  const { rows: serviceRows } = await query(
    `SELECT id, duration_minutes
     FROM services
     WHERE id = $1 AND business_id = $2 AND active = TRUE`,
    [serviceId, businessId],
  );
  if (!serviceRows.length) return { error: 'Service not found' };

  const { rows: staffRows } = await query(
    `SELECT id
     FROM staff
     WHERE id = $1 AND business_id = $2 AND active = TRUE`,
    [staffId, businessId],
  );
  if (!staffRows.length) return { error: 'Staff not found' };

  const durationMinutes = serviceRows[0].duration_minutes || 30;

  // Persist customer name for future "my bookings" flows (optional).
  if (trimmedCustomerName) {
    await upsertCustomer(normalizedPhone, businessId, trimmedCustomerName);
  }

  // Reuse the same booking logic used by the WhatsApp chat flow.
  // This provides SLOT_TAKEN errors + idempotency checks.
  return bookAppointment({
    businessId,
    staffId,
    serviceId,
    customerPhone: normalizedPhone,
    customerName: trimmedCustomerName || null,
    date,
    time,
    durationMinutes,
    notes: notes || null,
  });
}

// ─── Get upcoming appointments for a customer ─────────────────────────────────
export async function getUpcomingAppointments(customerPhone, businessId) {
  const { rows } = await query(
    `SELECT a.*, s.name AS service_name, st.name AS staff_name
     FROM appointments a
     LEFT JOIN services s  ON a.service_id = s.id
     LEFT JOIN staff    st ON a.staff_id   = st.id
     WHERE a.customer_phone = $1
       AND a.business_id    = $2
       AND a.scheduled_at   > NOW()
       AND a.status         = 'confirmed'
     ORDER BY a.scheduled_at ASC
     LIMIT 5`,
    [customerPhone, businessId],
  );
  return rows;
}

// ─── Get most recent confirmed appointment for a customer ─────────────────────
// Used for "book again / same as last / repeat booking" flows (prefill service + staff).
export async function getMostRecentAppointment(customerPhone, businessId) {
  const { rows } = await query(
    `SELECT a.*,
            s.name AS service_name, s.duration_minutes AS service_duration_minutes, s.price AS service_price, s.active AS service_active,
            st.name AS staff_name, st.active AS staff_active
     FROM appointments a
     LEFT JOIN services s ON a.service_id = s.id
     LEFT JOIN staff   st ON a.staff_id  = st.id
     WHERE a.customer_phone = $1
       AND a.business_id    = $2
       AND a.status         = 'confirmed'
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT 1`,
    [customerPhone, businessId],
  );
  return rows[0] || null;
}

// ─── Get most recently booked service for a customer ─────────────────────────
// Used for "book the same again" / "rebook" flows.
export async function getLastBookedService(phone, businessId) {
  const { rows } = await query(
    `SELECT a.service_id, s.name AS service_name, s.duration_minutes, s.price, s.active
     FROM appointments a
     JOIN services s ON a.service_id = s.id
     WHERE a.customer_phone = $1
       AND a.business_id    = $2
       AND a.status         = 'confirmed'
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [phone, businessId],
  );
  return rows[0] || null;
}

// ─── Cancel an appointment ────────────────────────────────────────────────────
export async function cancelAppointment(appointmentId, customerPhone) {
  const { rows } = await query(
    `UPDATE appointments
     SET status = 'cancelled'
     WHERE id = $1 AND customer_phone = $2 AND status = 'confirmed'
     RETURNING *`,
    [appointmentId, customerPhone],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, updated.business_id, "appointment_cancelled", {
      source: "customer_chat",
    });
  }
  return updated;
}

// ─── Cancel an appointment (admin/staff context) ──────────────────────────
export async function cancelAppointmentById(appointmentId, businessId) {
  const { rows } = await query(
    `UPDATE appointments
     SET status = 'cancelled'
     WHERE id = $1 AND business_id = $2 AND status = 'confirmed'
     RETURNING *`,
    [appointmentId, businessId],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, businessId, "appointment_cancelled", {
      source: "business_admin",
    });
  }
  return updated;
}

// ─── Mark an appointment as completed (admin/staff context) ──────────────
export async function completeAppointmentById(appointmentId, businessId) {
  const { rows } = await query(
    `UPDATE appointments
     SET status = 'completed'
     WHERE id = $1 AND business_id = $2 AND status = 'confirmed'
     RETURNING *`,
    [appointmentId, businessId],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, businessId, "appointment_completed", {
      source: "business_admin",
    });
  }
  return updated;
}

// ─── Reschedule an appointment ────────────────────────────────────────────────
export async function rescheduleAppointment(
  appointmentId,
  customerPhone,
  newDate,
  newTime,
  tz = "Asia/Kolkata",
) {
  const scheduledAt = localToUTC(newDate, newTime, tz);
  const { rows } = await query(
    `UPDATE appointments
     SET scheduled_at = $1,
         reminder_sent = FALSE,
         reminder_24h_sent = FALSE,
         reminder_2h_sent = FALSE,
         confirmation_status = 'pending',
         confirmation_deadline_at = GREATEST(
           $1 - make_interval(mins => COALESCE((SELECT confirmation_cutoff_minutes FROM businesses WHERE id = appointments.business_id), 90)),
           NOW()
         ),
         auto_cancelled_at = NULL,
         cancel_reason = NULL
     WHERE id = $2 AND customer_phone = $3 AND status = 'confirmed'
     RETURNING *`,
    [scheduledAt, appointmentId, customerPhone],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, updated.business_id, "appointment_rescheduled", {
      source: "customer_chat",
      newDate,
      newTime,
    });
  }
  return updated;
}

// ─── Reschedule an appointment (admin/staff context) ──────────────────────
// Validates the new slot against the staff availability and existing bookings.
export async function rescheduleAppointmentById(appointmentId, businessId, newDate, newTime) {
  const { rows: apptRows } = await query(
    `SELECT staff_id, duration_minutes
     FROM appointments
     WHERE id = $1 AND business_id = $2 AND status = 'confirmed'`,
    [appointmentId, businessId],
  );
  if (!apptRows.length) return null;

  const { staff_id: staffId, duration_minutes: durationMinutes } = apptRows[0];
  const business = await getBusiness(businessId);
  const tz = business?.timezone || 'Asia/Kolkata';

  const slots = await getAvailableSlots(businessId, newDate, staffId, durationMinutes, tz);
  if (!slots.includes(newTime)) {
    const err = new Error('SLOT_TAKEN');
    err.slots = slots;
    throw err;
  }

  const scheduledAt = localToUTC(newDate, newTime, tz);
  const { rows } = await query(
    `UPDATE appointments
     SET scheduled_at = $1,
         reminder_sent = FALSE,
         reminder_24h_sent = FALSE,
         reminder_2h_sent = FALSE,
         confirmation_status = 'pending',
         confirmation_deadline_at = GREATEST(
           $1 - make_interval(mins => COALESCE((SELECT confirmation_cutoff_minutes FROM businesses WHERE id = $3), 90)),
           NOW()
         ),
         auto_cancelled_at = NULL,
         cancel_reason = NULL
     WHERE id = $2 AND business_id = $3 AND status = 'confirmed'
     RETURNING *`,
    [scheduledAt, appointmentId, businessId],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, businessId, "appointment_rescheduled", {
      source: "business_admin",
      newDate,
      newTime,
    });
  }
  return updated;
}

// ─── Get available slots across a date range ──────────────────────────────────
// Returns array of { date, slots[] } for dates that have at least one free slot.
// Fetches business and staff once — no N+1 getBusiness calls per day.
export async function getAvailableSlotsForRange(
  businessId,
  startDate,
  endDate,
  durationMinutes = 30,
) {
  const [staffList, business] = await Promise.all([
    getStaff(businessId),
    getBusiness(businessId),
  ]);
  if (!staffList.length) return [];

  const staff = staffList[0];
  const tz = business?.timezone || "Asia/Kolkata";
  const result = [];

  // Use noon UTC to avoid DST edge cases when iterating days
  const current = new Date(startDate + "T12:00:00Z");
  const end = new Date(endDate + "T12:00:00Z");

  while (current <= end) {
    const dateStr = current.toISOString().split("T")[0];
    const slots = await getAvailableSlots(
      businessId,
      dateStr,
      staff.id,
      durationMinutes,
      tz,
    );
    if (slots.length) result.push({ date: dateStr, slots });
    current.setUTCDate(current.getUTCDate() + 1);
  }

  return result;
}

// ─── Get today's appointments for admin view (uses business timezone for "today") ─
export async function getTodaysAppointments(businessId) {
  const { rows } = await query(
    `SELECT a.*, s.name AS service_name, st.name AS staff_name
     FROM appointments a
     LEFT JOIN services s  ON a.service_id = s.id
     LEFT JOIN staff    st ON a.staff_id   = st.id
     JOIN businesses   b  ON a.business_id = b.id
     WHERE a.business_id = $1
       AND DATE(a.scheduled_at AT TIME ZONE COALESCE(b.timezone, 'Asia/Kolkata'))
         = DATE((NOW() AT TIME ZONE COALESCE(b.timezone, 'Asia/Kolkata'))::timestamp)
       AND a.status = 'confirmed'
     ORDER BY a.scheduled_at ASC`,
    [businessId],
  );
  return rows;
}

// ─── Smart slot suggestion ────────────────────────────────────────────────────
// Scans the next `daysAhead` days and returns the soonest slot within ±toleranceMin
// of the requested time. Used to proactively suggest "How about Wednesday at 5 PM?"
function _timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export async function findNextSlotNearTime(
  businessId,
  staffId,
  duration,
  preferredTime,
  tz,
  { daysAhead = 7, toleranceMin = 120 } = {},
) {
  const prefMin = _timeToMinutes(preferredTime);

  for (let i = 1; i <= daysAhead; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dateStr = d.toLocaleDateString("en-CA", { timeZone: tz });

    const slots = await getAvailableSlots(
      businessId,
      dateStr,
      staffId,
      duration,
    );
    if (!slots.length) continue;

    const candidates = slots
      .map((s) => ({ time: s, dist: Math.abs(_timeToMinutes(s) - prefMin) }))
      .filter((c) => c.dist <= toleranceMin)
      .sort((a, b) => a.dist - b.dist);

    if (candidates.length) {
      return { date: dateStr, time: candidates[0].time };
    }
  }
  return null;
}

// ─── Get appointments due for reminders (within next 24h, not yet sent) ───────
export async function getAppointmentsDueForReminder() {
  const { rows } = await query(
    `SELECT a.*, b.name AS business_name, b.timezone AS business_timezone,
            b.whatsapp_reminder_template,
            s.name AS service_name, st.name AS staff_name
     FROM appointments a
     JOIN businesses b ON a.business_id = b.id
     LEFT JOIN services s  ON a.service_id = s.id
     LEFT JOIN staff    st ON a.staff_id   = st.id
     WHERE a.status        = 'confirmed'
       AND a.reminder_sent = FALSE
       AND a.scheduled_at  BETWEEN NOW() + INTERVAL '23 hours'
                               AND NOW() + INTERVAL '25 hours'`,
    [],
  );
  return rows;
}

// ─── Mark reminder sent ───────────────────────────────────────────────────────
export async function markReminderSent(appointmentId) {
  await query(`UPDATE appointments SET reminder_sent = TRUE WHERE id = $1`, [
    appointmentId,
  ]);
}

// ─── 24-hour reminders (new no-show flow) ─────────────────────────────────────
export async function getAppointmentsDueFor24hReminder() {
  const { rows } = await query(
    `SELECT a.*, b.name AS business_name, b.timezone AS business_timezone,
            b.whatsapp_reminder_template,
            s.name AS service_name, st.name AS staff_name
     FROM appointments a
     JOIN businesses b ON a.business_id = b.id
     LEFT JOIN services s  ON a.service_id = s.id
     LEFT JOIN staff    st ON a.staff_id   = st.id
     WHERE a.status            = 'confirmed'
       AND a.reminder_24h_sent = FALSE
       AND COALESCE(b.reminder_24h_enabled, TRUE) = TRUE
       AND a.scheduled_at      BETWEEN NOW() + INTERVAL '23 hours'
                                  AND NOW() + INTERVAL '25 hours'`,
    [],
  );
  return rows;
}

export async function markReminder24hSent(appointmentId) {
  const { rows } = await query(
    `UPDATE appointments
     SET reminder_24h_sent = TRUE, reminder_sent = TRUE
     WHERE id = $1
     RETURNING id, business_id`,
    [appointmentId],
  );
  if (rows[0]) {
    await createAppointmentEvent(rows[0].id, rows[0].business_id, "reminder_24h_sent", {});
  }
}

// ─── 2-hour reminders requiring customer confirmation ─────────────────────────
export async function getAppointmentsDueFor2hReminder() {
  const { rows } = await query(
    `SELECT a.*, b.name AS business_name, b.timezone AS business_timezone,
            s.name AS service_name, st.name AS staff_name
     FROM appointments a
     JOIN businesses b ON a.business_id = b.id
     LEFT JOIN services s  ON a.service_id = s.id
     LEFT JOIN staff    st ON a.staff_id   = st.id
     WHERE a.status = 'confirmed'
       AND a.reminder_2h_sent = FALSE
       AND a.confirmation_status = 'pending'
       AND COALESCE(b.reminder_2h_enabled, TRUE) = TRUE
       AND a.scheduled_at BETWEEN NOW() + INTERVAL '105 minutes'
                             AND NOW() + INTERVAL '135 minutes'`,
    [],
  );
  return rows;
}

export async function markReminder2hSent(appointmentId) {
  const { rows } = await query(
    `UPDATE appointments
     SET reminder_2h_sent = TRUE
     WHERE id = $1
     RETURNING id, business_id`,
    [appointmentId],
  );
  if (rows[0]) {
    await createAppointmentEvent(rows[0].id, rows[0].business_id, "reminder_2h_sent", {});
  }
}

// ─── Customer confirms "Yes I'll come" ────────────────────────────────────────
export async function markNextPendingAppointmentConfirmedForCustomer(customerPhone, businessId) {
  const { rows } = await query(
    `WITH target AS (
       SELECT id
       FROM appointments
       WHERE customer_phone = $1
         AND business_id    = $2
         AND status         = 'confirmed'
         AND confirmation_status = 'pending'
         AND scheduled_at > NOW()
       ORDER BY scheduled_at ASC
       LIMIT 1
     )
     UPDATE appointments a
     SET confirmation_status = 'confirmed'
     FROM target
     WHERE a.id = target.id
     RETURNING a.*`,
    [customerPhone, businessId],
  );
  const updated = rows[0] || null;
  if (updated) {
    await createAppointmentEvent(updated.id, businessId, "appointment_confirmed", {
      source: "whatsapp_confirmation",
    });
  }
  return updated;
}

// ─── Auto-cancel unconfirmed appointments after deadline ──────────────────────
export async function autoCancelExpiredUnconfirmedAppointments() {
  const { rows } = await query(
    `UPDATE appointments a
     SET status = 'cancelled',
         confirmation_status = 'expired',
         auto_cancelled_at = NOW(),
         cancel_reason = 'auto_cancel_unconfirmed'
     FROM businesses b
     WHERE a.business_id = b.id
       AND COALESCE(b.auto_cancel_unconfirmed_enabled, TRUE) = TRUE
       AND a.status = 'confirmed'
       AND a.confirmation_status = 'pending'
       AND a.confirmation_deadline_at IS NOT NULL
       AND a.confirmation_deadline_at <= NOW()
     RETURNING a.id, a.business_id, a.customer_phone, a.customer_name, a.scheduled_at`,
    [],
  );
  for (const row of rows) {
    await createAppointmentEvent(row.id, row.business_id, "appointment_auto_cancelled", {
      reason: "unconfirmed_before_deadline",
    });
  }
  return rows;
}
