-- Migration 028: webhook subscription pause/status (#1122)
--
-- Operators need to quarantine a broken subscriber endpoint without deleting
-- the row (and forcing the scout to re-register with a new HMAC secret).
-- `status` is 'active' | 'paused'; dispatch only delivers to active rows.
-- `consecutive_failures` supports optional auto-pause after N dead-letters.

ALTER TABLE webhook_subscriptions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE webhook_subscriptions ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_webhook_sub_status ON webhook_subscriptions (status);
