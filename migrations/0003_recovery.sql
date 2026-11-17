ALTER TABLE users ADD COLUMN recovery_hash TEXT;
ALTER TABLE users ADD COLUMN wrapped_vault_key_recovery TEXT;
ALTER TABLE users ADD COLUMN recovery_created_at TEXT;
CREATE TABLE recovery_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE recovery_failures (email TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX recovery_failures_by_email ON recovery_failures(email, at);
CREATE INDEX login_failures_by_email ON login_failures(email, at);
