-- One-time magic links for demo sandbox login (hashed at rest).
CREATE TABLE IF NOT EXISTS magic_login_tokens (
  id SERIAL PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  business_owner_id INTEGER NOT NULL REFERENCES business_owners(id) ON DELETE CASCADE,
  demo_request_id INTEGER REFERENCES demo_requests(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_magic_login_tokens_expires
  ON magic_login_tokens (expires_at)
  WHERE used_at IS NULL;
