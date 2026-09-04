-- The hub's own database. Accounts, sessions, and where each participant's instance lives.
--
-- NOTHING ABOUT ANYONE'S PORTFOLIO IS IN HERE. Holdings, orders, broker credentials and scores
-- all live in the participant's own file, which only their own instance opens. The hub knows who
-- someone is and which port to send them to, and that is the whole of its knowledge. A hub
-- database that leaked would expose a list of names, not anyone's trading.

CREATE TABLE IF NOT EXISTS participants (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id             TEXT NOT NULL UNIQUE,
  display_name         TEXT NOT NULL,
  password_hash        TEXT NOT NULL,
  password_salt        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'participant'
                         CHECK (role IN ('admin', 'participant')),
  -- Forced on first sign-in. The admin issues a generated password and reads it out; it should
  -- stop being valid the moment the participant has one of their own.
  must_change_password INTEGER NOT NULL DEFAULT 1,

  -- The port this participant's instance listens on. Assigned once at creation and never reused
  -- while the account exists, so a stale proxy target can never point at somebody else.
  -- NULL for admins, who have no instance: the admin manages people and does not trade.
  instance_port        INTEGER UNIQUE,
  -- Their own database file, relative to the data directory. Recorded rather than derived, so
  -- renaming the convention later cannot orphan an existing participant's data.
  db_file              TEXT,

  disabled_at          TEXT,
  created_at           TEXT NOT NULL,
  last_login_at        TEXT
);

-- Server-side sessions rather than a self-contained token, so an account can be cut off
-- immediately: disabling a participant deletes their rows and their next request fails, instead
-- of staying valid until a signed token happens to expire.
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,          -- 32 random bytes, hex
  participant_id INTEGER NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  created_at     TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  user_agent     TEXT,
  ip             TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_participant ON sessions (participant_id, expires_at);

-- Who did what, kept because a workshop is exactly the setting where "I never got a password"
-- and "somebody reset mine" both come up.
CREATE TABLE IF NOT EXISTS audit_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  at             TEXT NOT NULL,
  actor          TEXT,                      -- login_id, or 'system'
  action         TEXT NOT NULL,
  subject        TEXT,
  detail         TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at DESC);
