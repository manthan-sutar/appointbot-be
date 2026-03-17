-- Clear all appointbot data (keeps tables and schema)
-- Run: psql $DATABASE_URL -f db/clear.sql

TRUNCATE
  sessions,
  customers,
  appointments,
  availability,
  staff,
  services,
  subscriptions,
  business_owners,
  businesses
RESTART IDENTITY CASCADE;
