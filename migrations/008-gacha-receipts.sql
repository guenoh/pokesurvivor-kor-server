CREATE TABLE IF NOT EXISTS gacha_receipts (
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 request_id text NOT NULL,
 n integer NOT NULL,
 gen integer NOT NULL,
 ticket_kind text NOT NULL,
 results jsonb NOT NULL,
 iris integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,request_id)
);
