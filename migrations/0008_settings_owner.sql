-- Server settings as key/value text (for example default_bytes: storage per person, -1 = no limit).
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- The one owner of this server, signed in on the web panel with a password and optional two-step code.
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  totp_secret BLOB,
  totp_last_step INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Panel sign-ins. Only a hash of the cookie token is stored.
CREATE TABLE owner_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  agent TEXT NOT NULL
);
