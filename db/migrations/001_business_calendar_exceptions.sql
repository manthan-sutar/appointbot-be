-- Business-level calendar exceptions (holidays, custom hours for a specific date).
-- Run after schema.sql on existing databases:
--   psql $DATABASE_URL -f db/migrations/001_business_calendar_exceptions.sql

CREATE TABLE IF NOT EXISTS business_calendar_exceptions (
  id              SERIAL PRIMARY KEY,
  business_id     INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  exception_date  DATE NOT NULL,
  closed          BOOLEAN NOT NULL DEFAULT TRUE,
  open_start      TIME,
  open_end        TIME,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, exception_date),
  CHECK (
    (closed = TRUE)
    OR (closed = FALSE AND open_start IS NOT NULL AND open_end IS NOT NULL AND open_end > open_start)
  )
);

CREATE INDEX IF NOT EXISTS idx_business_calendar_exceptions_biz_date
  ON business_calendar_exceptions (business_id, exception_date);
