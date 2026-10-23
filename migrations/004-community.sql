CREATE TABLE IF NOT EXISTS social_friends (
  a text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  b text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  requested_by text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(a,b), CHECK(a<b), CHECK(requested_by=a OR requested_by=b)
);
CREATE INDEX IF NOT EXISTS social_friends_b ON social_friends(b);
CREATE TABLE IF NOT EXISTS social_runs (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK(mode IN ('s','g')),
  roster jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS social_runs_owner ON social_runs(owner_id);
CREATE TABLE IF NOT EXISTS survival_records (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK(mode IN ('s','g')),
  team_key text NOT NULL,
  seconds integer NOT NULL CHECK(seconds BETWEEN 1 AND 21600),
  level integer NOT NULL CHECK(level BETWEEN 1 AND 1000),
  kills integer NOT NULL CHECK(kills BETWEEN 0 AND 10000000),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS survival_records_board ON survival_records(mode,recorded_at,seconds DESC);
CREATE TABLE IF NOT EXISTS record_members (
  record_id text NOT NULL REFERENCES survival_records(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  dex integer NOT NULL CHECK(dex BETWEEN 1 AND 2000),
  shiny boolean NOT NULL DEFAULT false,
  seat integer NOT NULL CHECK(seat BETWEEN 0 AND 3),
  PRIMARY KEY(record_id,account_id)
);
CREATE INDEX IF NOT EXISTS record_members_account ON record_members(account_id);
