-- Migration 041: Metered usage events (REV-styx-metered-billing)
-- Durable per-user record of billable consumption that drives B2B metered billing.
--
-- consumption_logs (existing) is keyed by enterprise_id and is the post-attribution
-- billing aggregate. usage_event is the upstream, per-USER source of truth captured at
-- the moment a billable action happens (e.g. a contract's proof is accepted). It retains
-- the originating user even when no enterprise is attached, so we keep an auditable trail
-- and can re-attribute / re-bill if a user is later mapped to an enterprise.

CREATE TABLE IF NOT EXISTS usage_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  enterprise_id UUID REFERENCES enterprises(id),
  event_type TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  -- Stable, caller-supplied de-duplication key (e.g. contract id). When present it is
  -- UNIQUE so an at-least-once caller retrying POST /contracts/:id/complete records the
  -- usage exactly once instead of double-billing.
  idempotency_key TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_event_user
  ON usage_event(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_event_enterprise_type
  ON usage_event(enterprise_id, event_type, created_at)
  WHERE enterprise_id IS NOT NULL;

COMMENT ON TABLE usage_event IS
  'Per-user billable consumption events (REV-styx-metered-billing). Upstream source of truth feeding B2B metered/Stripe billing; retains originating user even when unattributed to an enterprise.';
