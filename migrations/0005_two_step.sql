-- Two-step sign-in (TOTP). Secrets are AES-256-GCM encrypted under the server's TOTP_KEY (AAD = user id),
-- stored as iv (12 bytes) || ciphertext+tag. Times are ISO-8601 text like every other table.
CREATE TABLE totp (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_enc BLOB,
  enabled INTEGER NOT NULL DEFAULT 0,
  -- Highest accepted 30 s step: a code for this step or an earlier one is a replay.
  last_step INTEGER,
  pending_secret_enc BLOB,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- code_hash = HMAC-SHA-256 hex of (user id || canonical "xxxx-xxxx" code), keyed by HKDF(TOTP_KEY, "tessh/v1/backup-code").
CREATE TABLE backup_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  PRIMARY KEY (user_id, code_hash)
);
-- Only SHA-256 of the challenge is stored, like sessions and recovery tokens.
CREATE TABLE login_challenges (
  challenge_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  device_platform TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX login_challenges_by_user ON login_challenges(user_id);
CREATE INDEX login_challenges_by_expiry ON login_challenges(expires_at);
-- Second-factor attempts per account (cleared on success): more than 10 in 15 minutes is 429.
CREATE TABLE two_step_failures (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, at TEXT NOT NULL);
CREATE INDEX two_step_failures_by_user ON two_step_failures(user_id, at);
-- For the window cleanup (DELETE ... WHERE at < cutoff) across all accounts.
CREATE INDEX two_step_failures_by_at ON two_step_failures(at);
