-- appointbot database schema
-- Run: psql $DATABASE_URL -f db/schema.sql

-- Businesses (tenants)
CREATE TABLE IF NOT EXISTS businesses (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('salon', 'doctor', 'dentist', 'tutor', 'other')),
  phone       TEXT UNIQUE NOT NULL,
  slug        TEXT UNIQUE,
  timezone    TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business owners (auth)
CREATE TABLE IF NOT EXISTS business_owners (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  business_id   INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  onboarded     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Subscription plans
CREATE TABLE IF NOT EXISTS subscriptions (
  id          SERIAL PRIMARY KEY,
  business_id INTEGER UNIQUE NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan        TEXT NOT NULL DEFAULT 'free'
                CHECK (plan IN ('free', 'pro', 'business')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Extended subscription metadata (added via ALTER so it works on existing DBs)
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  ADD COLUMN IF NOT EXISTS trial_ends_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS current_period_end  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gateway             TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS external_customer_id    TEXT,
  ADD COLUMN IF NOT EXISTS external_subscription_id TEXT;

-- Staff / providers per business
CREATE TABLE IF NOT EXISTS staff (
  id          SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- Services offered by a business
CREATE TABLE IF NOT EXISTS services (
  id          SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  price       NUMERIC(10,2),
  active      BOOLEAN NOT NULL DEFAULT TRUE
);

-- Availability slots (recurring weekly schedule per staff member)
-- day_of_week: 0=Sunday … 6=Saturday
CREATE TABLE IF NOT EXISTS availability (
  id          SERIAL PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time  TIME NOT NULL,
  end_time    TIME NOT NULL
);

-- Appointments
CREATE TABLE IF NOT EXISTS appointments (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id        INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  service_id      INTEGER REFERENCES services(id) ON DELETE SET NULL,
  customer_phone  TEXT NOT NULL,
  customer_name   TEXT,
  scheduled_at    TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status          TEXT NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  notes           TEXT,
  reminder_sent   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Known customers (persisted across sessions)
CREATE TABLE IF NOT EXISTS customers (
  phone         TEXT NOT NULL,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (phone, business_id)
);

-- CRM notes per customer (lightweight and auditable)
CREATE TABLE IF NOT EXISTS customer_notes (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  note TEXT NOT NULL,
  created_by_owner_id INTEGER REFERENCES business_owners(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation sessions (per customer phone, per business)
CREATE TABLE IF NOT EXISTS sessions (
  phone         TEXT NOT NULL,
  business_id   INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  state         TEXT NOT NULL DEFAULT 'IDLE',
  temp_data     JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (phone, business_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_appointments_business_scheduled ON appointments(business_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_appointments_customer          ON appointments(customer_phone);
CREATE INDEX IF NOT EXISTS idx_appointments_staff_scheduled   ON appointments(staff_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_availability_staff             ON availability(staff_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_sessions_phone                 ON sessions(phone);
CREATE INDEX IF NOT EXISTS idx_customers_phone                ON customers(phone);
CREATE INDEX IF NOT EXISTS idx_customer_notes_business_phone   ON customer_notes(business_id, customer_phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_owners_email          ON business_owners(email);
CREATE INDEX IF NOT EXISTS idx_businesses_slug                ON businesses(slug);

-- ─── WhatsApp per-business configuration (Cloud API) ───────────────────────────
-- These columns allow each business to use its own WhatsApp Business number
-- and access token. If not set, the app falls back to global WHATSAPP_* env vars.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whatsapp_phone_number_id TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_display_phone   TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_access_token    TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_api_version     TEXT DEFAULT 'v21.0',
  ADD COLUMN IF NOT EXISTS whatsapp_status          TEXT DEFAULT 'unverified',
  ADD COLUMN IF NOT EXISTS whatsapp_business_account_id TEXT;

-- Reminder template: name of a Meta-approved "Utility" message template to use
-- for appointment reminders. Required to reach customers outside the 24-hour
-- conversation window. If NULL, falls back to freeform text (only works when
-- the window is still open). Set globally via WHATSAPP_REMINDER_TEMPLATE_NAME env var.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whatsapp_reminder_template TEXT;

-- No-show policy controls (business-level, safe defaults enabled)
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS reminder_24h_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS reminder_2h_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS auto_cancel_unconfirmed_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS confirmation_cutoff_minutes INTEGER NOT NULL DEFAULT 90;

-- ─── Appointment confirmation lifecycle (no-show prevention) ──────────────────
-- Kept as ALTER statements for backward-compatible rollout on existing DBs.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminder_24h_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS reminder_2h_sent BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS confirmation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (confirmation_status IN ('pending', 'confirmed', 'declined', 'expired')),
  ADD COLUMN IF NOT EXISTS confirmation_deadline_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT;

-- Backfill confirmation deadlines for old rows that don't have one yet.
UPDATE appointments
SET confirmation_deadline_at = scheduled_at - make_interval(
  mins => COALESCE((SELECT b.confirmation_cutoff_minutes FROM businesses b WHERE b.id = appointments.business_id), 90)
)
WHERE confirmation_deadline_at IS NULL;

-- Append-only event stream for audit/analytics/debugging.
CREATE TABLE IF NOT EXISTS appointment_events (
  id SERIAL PRIMARY KEY,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointment_events_appointment_created
  ON appointment_events(appointment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_appointment_events_business_created
  ON appointment_events(business_id, created_at DESC);

-- Lead tracking for funnel analytics and drop-off automation
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'unknown',
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'engaged', 'converted', 'dropped')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at TIMESTAMPTZ,
  followup_sent_at TIMESTAMPTZ,
  UNIQUE (business_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS lead_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_business_activity
  ON leads(business_id, status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_events_business_created
  ON lead_events(business_id, created_at DESC);

-- Marketing campaigns (bulk WhatsApp with delivery tracking)
CREATE TABLE IF NOT EXISTS campaigns (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel IN ('whatsapp')),
  audience_type TEXT NOT NULL DEFAULT 'all_leads'
    CHECK (audience_type IN ('all_leads', 'dropped_leads', 'converted_leads', 'recent_customers_30d')),
  message_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'running', 'completed', 'failed')),
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  created_by_owner_id INTEGER REFERENCES business_owners(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaign_recipients (
  id SERIAL PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_campaigns_business_created
  ON campaigns(business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaign_recipients_campaign
  ON campaign_recipients(campaign_id, status, created_at DESC);

-- Backward-compatible campaign extensions
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS send_mode TEXT NOT NULL DEFAULT 'text'
    CHECK (send_mode IN ('text', 'template')),
  ADD COLUMN IF NOT EXISTS template_name TEXT,
  ADD COLUMN IF NOT EXISTS template_language TEXT NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;

ALTER TABLE campaign_recipients
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_retry_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

-- Durable async execution records for idempotent scheduler tasks
CREATE TABLE IF NOT EXISTS async_job_executions (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  job_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_run_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_name, job_key)
);

CREATE INDEX IF NOT EXISTS idx_async_job_executions_status_retry
  ON async_job_executions(status, next_retry_at, updated_at DESC);

-- Messaging preferences / suppression list (per business + phone)
CREATE TABLE IF NOT EXISTS messaging_preferences (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_phone TEXT NOT NULL,
  campaign_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  opt_out_reason TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, customer_phone)
);

CREATE INDEX IF NOT EXISTS idx_messaging_preferences_business_optout
  ON messaging_preferences(business_id, campaign_opt_out, updated_at DESC);
