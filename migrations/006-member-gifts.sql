CREATE TABLE IF NOT EXISTS member_grants (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  notice_id text NOT NULL REFERENCES notice_campaigns(id),
  ticket1 integer NOT NULL DEFAULT 0 CHECK (ticket1 >= 0),
  coins bigint NOT NULL DEFAULT 0 CHECK (coins >= 0),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, notice_id)
);
