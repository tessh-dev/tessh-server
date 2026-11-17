-- Invites: with SIGNUPS=invite, only these emails may create an account. Emails are stored normalised
-- (trimmed, lowercase). An invite stays after the account is made, so the admin can see who joined.
CREATE TABLE invites (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);
