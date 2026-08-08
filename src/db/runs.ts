import { pool } from './pool.js';

export type RunStatus = 'analyzing' | 'detected' | 'fixing' | 'pr_opened' | 'skipped' | 'failed';

export interface RunRow {
  id: string;
  diff_id: string;
  repository: string;
  status: RunStatus;
  pr_url: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createRun(params: {
  diffId: string;
  repository: string;
  status: RunStatus;
}): Promise<RunRow> {
  const { rows } = await pool.query<RunRow>(
    `INSERT INTO api_update_runs (diff_id, repository, status)
     VALUES ($1, $2, $3)
     RETURNING id, diff_id, repository, status, pr_url, error, created_at, updated_at`,
    [params.diffId, params.repository, params.status],
  );
  const row = rows[0];
  if (!row) throw new Error('実行記録の作成に失敗しました');
  return row;
}

export async function updateRun(
  id: string,
  patch: { status?: RunStatus; impact?: unknown; prUrl?: string; error?: string },
): Promise<void> {
  await pool.query(
    `UPDATE api_update_runs
        SET status     = COALESCE($2, status),
            impact     = COALESCE($3::jsonb, impact),
            pr_url     = COALESCE($4, pr_url),
            error      = COALESCE($5, error),
            updated_at = now()
      WHERE id = $1`,
    [id, patch.status ?? null, patch.impact === undefined ? null : JSON.stringify(patch.impact), patch.prUrl ?? null, patch.error ?? null],
  );
}

export async function listRuns(repository?: string, limit = 20): Promise<RunRow[]> {
  const { rows } = repository
    ? await pool.query<RunRow>(
        `SELECT id, diff_id, repository, status, pr_url, error, created_at, updated_at
           FROM api_update_runs WHERE repository = $1
          ORDER BY created_at DESC LIMIT $2`,
        [repository, limit],
      )
    : await pool.query<RunRow>(
        `SELECT id, diff_id, repository, status, pr_url, error, created_at, updated_at
           FROM api_update_runs ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
  return rows;
}
