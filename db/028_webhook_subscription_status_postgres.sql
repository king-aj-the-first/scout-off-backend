-- Migration 028 (PostgreSQL): webhook subscription pause/status (#1122)
-- See db/028_webhook_subscription_status.sql for the full rationale.
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE webhook_subscriptions ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_webhook_sub_status ON webhook_subscriptions (status);
