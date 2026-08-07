import type { SpecDiff } from '../detector/diff.js';
import type { BreakingChange } from '../detector/types.js';
import { pool } from './pool.js';

export interface DiffRow {
  id: string;
  provider: string;
  from_snapshot: string;
  to_snapshot: string;
  from_version: string;
  to_version: string;
  breaking_count: number;
  warning_count: number;
  created_at: Date;
}

export interface DiffRowWithChanges extends DiffRow {
  changes: BreakingChange[];
}

export async function saveDiff(params: {
  provider: string;
  fromSnapshot: string;
  toSnapshot: string;
  fromVersion: string;
  toVersion: string;
  diff: SpecDiff;
}): Promise<DiffRow> {
  const { rows } = await pool.query<DiffRow>(
    `INSERT INTO api_spec_diffs
       (provider, from_snapshot, to_snapshot, from_version, to_version, breaking_count, warning_count, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (from_snapshot, to_snapshot) DO UPDATE
       SET breaking_count = EXCLUDED.breaking_count,
           warning_count  = EXCLUDED.warning_count,
           changes        = EXCLUDED.changes
     RETURNING id, provider, from_snapshot, to_snapshot, from_version, to_version,
               breaking_count, warning_count, created_at`,
    [
      params.provider,
      params.fromSnapshot,
      params.toSnapshot,
      params.fromVersion,
      params.toVersion,
      params.diff.breakingCount,
      params.diff.warningCount,
      JSON.stringify(params.diff.changes),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('差分の保存に失敗しました');
  return row;
}

export async function findLatestDiff(provider: string): Promise<DiffRowWithChanges | null> {
  const { rows } = await pool.query<DiffRowWithChanges>(
    `SELECT id, provider, from_snapshot, to_snapshot, from_version, to_version,
            breaking_count, warning_count, created_at, changes
       FROM api_spec_diffs
      WHERE provider = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [provider],
  );
  return rows[0] ?? null;
}

export async function listDiffs(provider: string, limit = 20): Promise<DiffRow[]> {
  const { rows } = await pool.query<DiffRow>(
    `SELECT id, provider, from_snapshot, to_snapshot, from_version, to_version,
            breaking_count, warning_count, created_at
       FROM api_spec_diffs
      WHERE provider = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [provider, limit],
  );
  return rows;
}
