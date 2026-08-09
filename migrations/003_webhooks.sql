-- GitHub からの Webhook 配信記録。
-- GitHub は配信失敗時に同じイベントを再送するため、delivery_id で冪等性を担保する。
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           BIGSERIAL   PRIMARY KEY,
    delivery_id  TEXT        NOT NULL UNIQUE,   -- X-GitHub-Delivery ヘッダの値
    event        TEXT        NOT NULL,          -- X-GitHub-Event ヘッダの値
    action       TEXT,
    repository   TEXT,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
    ON webhook_deliveries (received_at DESC);

COMMENT ON COLUMN api_update_runs.status IS
  'detected | analyzing | fixing | fixed | pr_opened | pr_merged | pr_closed | skipped | failed';
