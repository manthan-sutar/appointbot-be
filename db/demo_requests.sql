-- Demo request leads (run on existing DBs: psql $DATABASE_URL -f db/demo_requests.sql)
CREATE TABLE IF NOT EXISTS demo_requests (
  id SERIAL PRIMARY KEY,
  business_name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(30) NOT NULL,
  business_type VARCHAR(50) NOT NULL,
  message TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'contacted', 'converted', 'rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_demo_requests_email_lower
  ON demo_requests (lower(btrim(email)));

CREATE INDEX IF NOT EXISTS idx_demo_requests_created
  ON demo_requests (created_at DESC);
