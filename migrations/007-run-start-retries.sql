-- Unfinished run tokens are ephemeral and excluded from durable backups.
-- Retrying a lost start response must return its original server timestamp/token.
ALTER TABLE social_runs ADD COLUMN IF NOT EXISTS request_key text;
CREATE UNIQUE INDEX IF NOT EXISTS social_runs_request ON social_runs(owner_id,request_key);
