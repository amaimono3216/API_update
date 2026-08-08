-- ③ AI コード自動修正 & テスト検証モジュールの結果を保持する。
-- diff 本体は巨大になるため、ここには要約（ブランチ名・編集一覧・テスト結果）のみを入れる。
ALTER TABLE api_update_runs ADD COLUMN IF NOT EXISTS fix JSONB;

COMMENT ON COLUMN api_update_runs.status IS
  'detected | analyzing | fixing | fixed | pr_opened | skipped | failed';
