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
