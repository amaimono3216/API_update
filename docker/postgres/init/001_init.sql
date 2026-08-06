-- ① 監視・検知モジュールが取得した OpenAPI スペックのスナップショット。
-- 前回取得分との差分比較に利用する。
CREATE TABLE IF NOT EXISTS api_spec_snapshots (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT        NOT NULL,           -- 'stripe' | 'openai'
    version      TEXT        NOT NULL,           -- 例: '2026-01-15'
    spec_hash    TEXT        NOT NULL,           -- 取得スペックの SHA-256
    spec         JSONB       NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, spec_hash)
);

CREATE INDEX IF NOT EXISTS idx_api_spec_snapshots_provider_fetched
    ON api_spec_snapshots (provider, fetched_at DESC);

-- ② 影響範囲特定〜④ PR生成までの 1 サイクルを表す実行ログ。
CREATE TABLE IF NOT EXISTS api_update_runs (
    id             BIGSERIAL PRIMARY KEY,
    provider       TEXT        NOT NULL,
    from_snapshot  BIGINT      REFERENCES api_spec_snapshots (id),
    to_snapshot    BIGINT      NOT NULL REFERENCES api_spec_snapshots (id),
    repository     TEXT        NOT NULL,         -- 'owner/repo'
    status         TEXT        NOT NULL,         -- detected | analyzing | fixing | pr_opened | skipped | failed
    breaking_diff  JSONB,                        -- openapi-diff の抽出結果
    pr_url         TEXT,
    error          TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_update_runs_repo_created
    ON api_update_runs (repository, created_at DESC);
