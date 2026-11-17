CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, auth_hash TEXT NOT NULL, salt TEXT NOT NULL, kdf TEXT NOT NULL, wrapped_vault_key TEXT NOT NULL, encrypted_signing_key TEXT NOT NULL, signer_public_key TEXT NOT NULL, username TEXT UNIQUE, plan TEXT NOT NULL DEFAULT 'free', cursor INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE devices (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, platform TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE items (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, version INTEGER NOT NULL, deleted INTEGER NOT NULL, blob TEXT, size INTEGER NOT NULL, PRIMARY KEY (user_id, id));
CREATE INDEX items_by_version ON items(user_id, version);
CREATE TABLE keypages (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, authorized_keys TEXT NOT NULL, authorized_keys_sig TEXT NOT NULL, revoked TEXT NOT NULL, revoked_sig TEXT NOT NULL, keys_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE login_failures (email TEXT NOT NULL, at TEXT NOT NULL);
