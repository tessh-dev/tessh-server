-- Invite codes: with SIGNUPS=invite, a new account needs a code. A code makes a member or a second owner, can
-- expire or be cancelled, and is kept after use so the owner can see who joined with it.
CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('member', 'owner')),
  created_at TEXT NOT NULL,
  expires_at TEXT,
  cancelled_at TEXT,
  used_at TEXT,
  used_by TEXT
);
