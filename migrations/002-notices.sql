CREATE TABLE IF NOT EXISTS notice_campaigns (
  id text PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS notice_claims (
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  notice_id text NOT NULL REFERENCES notice_campaigns(id),
  ticket10 integer NOT NULL CHECK (ticket10 > 0),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, notice_id)
);
