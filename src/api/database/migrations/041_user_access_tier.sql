-- Migration 041: User access tiers for beta contract creation gating.

DO $$
BEGIN
  CREATE TYPE access_tier AS ENUM ('free', 'early_access', 'pro');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS access_tier access_tier NOT NULL DEFAULT 'free';

UPDATE users
SET access_tier = 'pro'
WHERE email IN ('demo@styx.protocol', 'fury@styx.protocol', 'admin@styx.protocol')
  AND access_tier = 'free';

COMMENT ON TYPE access_tier IS
  'Product access tier: free, early_access, or pro.';

COMMENT ON COLUMN users.access_tier IS
  'Controls contract creation access. early_access is capped by TierGuard to 3 active contracts and $0 escrow.';
