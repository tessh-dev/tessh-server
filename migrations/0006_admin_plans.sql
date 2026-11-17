-- Admin panel: plans, per-account limit overrides, suspension and an audit log.
-- Effective limit = users override ?? plan ?? built-in default (src/limits.ts). Sizes are bytes.
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bytes_limit INTEGER NOT NULL,
  items_limit INTEGER NOT NULL,
  -- NULL = unlimited devices.
  devices_limit INTEGER,
  -- Exactly one plan is the default for new sign-ups (enforced by the partial unique index below).
  is_default INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX plans_one_default ON plans(is_default) WHERE is_default = 1;
INSERT INTO plans (id, name, bytes_limit, items_limit, devices_limit, is_default, archived, created_at, updated_at) VALUES
  ('free', 'Free', 5242880, 10000, NULL, 1, 0, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z'),
  ('pro', 'Pro', 52428800, 100000, NULL, 0, 0, '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z');

-- Per-account overrides (NULL = use the plan) and suspension (sessions are kept while suspended).
ALTER TABLE users ADD COLUMN bytes_limit INTEGER;
ALTER TABLE users ADD COLUMN items_limit INTEGER;
ALTER TABLE users ADD COLUMN devices_limit INTEGER;
ALTER TABLE users ADD COLUMN suspended_at TEXT;
CREATE INDEX users_by_plan ON users(plan);

-- Every admin write. detail is JSON with no secrets (never blobs, keys or hashes). user_id has no FK so rows
-- outlive a deleted account.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_audit_by_at ON admin_audit(at);
CREATE INDEX admin_audit_by_user ON admin_audit(user_id, at);
