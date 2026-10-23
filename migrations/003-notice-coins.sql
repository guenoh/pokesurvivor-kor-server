ALTER TABLE notice_claims ADD COLUMN IF NOT EXISTS coins bigint NOT NULL DEFAULT 0 CHECK (coins >= 0);
