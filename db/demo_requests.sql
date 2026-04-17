-- Demo request leads (run on existing DBs: psql $DATABASE_URL -f db/demo_requests.sql)
CREATE TABLE IF NOT EXISTS demo_requests (
  id SERIAL PRIMARY KEY,
  business_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  business_type VARCHAR(50) NOT NULL,
  message TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'invited', 'scheduled', 'demo_done', 'won', 'lost')),
  assigned_to TEXT,
  internal_notes TEXT,
  next_followup_at TIMESTAMPTZ,
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backward-compatible upgrades for existing DBs.
ALTER TABLE demo_requests
  ADD COLUMN IF NOT EXISTS assigned_to TEXT,
  ADD COLUMN IF NOT EXISTS internal_notes TEXT,
  ADD COLUMN IF NOT EXISTS next_followup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_contacted_at TIMESTAMPTZ;

-- Update status constraint to manual-sales workflow values.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'demo_requests_status_check'
  ) THEN
    ALTER TABLE demo_requests DROP CONSTRAINT demo_requests_status_check;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

ALTER TABLE demo_requests
  ADD CONSTRAINT demo_requests_status_check
  CHECK (status IN ('new', 'invited', 'scheduled', 'demo_done', 'won', 'lost'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_requests_email_lower
  ON demo_requests (lower(btrim(email)));

CREATE INDEX IF NOT EXISTS idx_demo_requests_created
  ON demo_requests (created_at DESC);
