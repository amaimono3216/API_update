-- ① 監視・検知モジュールが取得した OpenAPI スペックのスナップショット。
-- 同一内容（spec_hash が同じ）なら再保存せず、前回分との差分比較の基準に使う。
CREATE TABLE IF NOT EXISTS api_spec_snapshots (
    id           BIGSERIAL PRIMARY KEY,
    provider     TEXT        NOT NULL,           -- 'stripe' | 'openai'
    version      TEXT        NOT NULL,           -- 例: '2026-07-29.dahlia'
    spec_hash    TEXT        NOT NULL,           -- 取得した生テキストの SHA-256
    source_url   TEXT        NOT NULL,
    bytes        INTEGER     NOT NULL,
    spec         JSONB       NOT NULL,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, spec_hash)
);

CREATE INDEX IF NOT EXISTS idx_api_spec_snapshots_provider_fetched
    ON api_spec_snapshots (provider, fetched_at DESC);

-- 2 つのスナップショット間で検出した破壊的変更。リポジトリ非依存の「API 側の事実」。
CREATE TABLE IF NOT EXISTS api_spec_diffs (
    id             BIGSERIAL PRIMARY KEY,
    provider       TEXT        NOT NULL,
    from_snapshot  BIGINT      NOT NULL REFERENCES api_spec_snapshots (id) ON DELETE CASCADE,
    to_snapshot    BIGINT      NOT NULL REFERENCES api_spec_snapshots (id) ON DELETE CASCADE,
    from_version   TEXT        NOT NULL,
    to_version     TEXT        NOT NULL,
    breaking_count INTEGER     NOT NULL DEFAULT 0,
    warning_count  INTEGER     NOT NULL DEFAULT 0,
    changes        JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (from_snapshot, to_snapshot)
);

CREATE INDEX IF NOT EXISTS idx_api_spec_diffs_provider_created
    ON api_spec_diffs (provider, created_at DESC);

-- ②〜④（影響範囲特定 → 修正 → PR 作成）の 1 サイクル。差分 1 件に対しリポジトリ数だけ作られる。
CREATE TABLE IF NOT EXISTS api_update_runs (
    id          BIGSERIAL PRIMARY KEY,
    diff_id     BIGINT      NOT NULL REFERENCES api_spec_diffs (id) ON DELETE CASCADE,
    repository  TEXT        NOT NULL,            -- 'owner/repo'
    status      TEXT        NOT NULL,            -- detected | analyzing | fixing | pr_opened | skipped | failed
    impact      JSONB,                           -- ② の影響範囲特定の結果
    pr_url      TEXT,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_update_runs_repo_created
    ON api_update_runs (repository, created_at DESC);
