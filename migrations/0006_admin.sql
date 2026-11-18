-- Per-account storage override (NULL = the server default from settings) and suspension (sessions are kept while
-- suspended). Sizes are bytes; -1 means no limit.
ALTER TABLE users ADD COLUMN bytes_limit INTEGER;
ALTER TABLE users ADD COLUMN suspended_at TEXT;

-- Every owner write. actor is who did it (the owner's email). detail is JSON with no secrets (never blobs, keys or
-- hashes). user_id has no FK so rows outlive a deleted account.
CREATE TABLE admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  user_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX admin_audit_by_at ON admin_audit(at);
CREATE INDEX admin_audit_by_user ON admin_audit(user_id, at);
