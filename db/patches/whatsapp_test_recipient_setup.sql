-- Persists per-business checklist for Meta "test recipient" onboarding (dashboard wizard).
-- Safe to run multiple times.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS whatsapp_test_recipient_setup JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN businesses.whatsapp_test_recipient_setup IS
  'Owner checklist for adding phones as Meta WhatsApp API test recipients; not sent to Graph API.';
