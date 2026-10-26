-- Add a metric without rewriting or deleting existing survival records or saves.
ALTER TABLE survival_records ADD COLUMN IF NOT EXISTS arceus_damage bigint NOT NULL DEFAULT 0
  CHECK (arceus_damage BETWEEN 0 AND 10000000000000);
CREATE INDEX IF NOT EXISTS survival_records_damage ON survival_records(mode,recorded_at,arceus_damage DESC)
  WHERE arceus_damage > 0;
