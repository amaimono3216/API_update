import type { FetchedSpec } from '../detector/fetch-spec.js';
import type { OpenApiDocument } from '../detector/types.js';
import { pool } from './pool.js';

export interface SnapshotRow {
  id: string;
  provider: string;
  version: string;
  spec_hash: string;
  bytes: number;
  fetched_at: Date;
}

export interface SnapshotWithSpec extends SnapshotRow {
  spec: OpenApiDocument;
}

/**
 * スナップショットを保存する。同一 (provider, spec_hash) が既にあれば
 * 内容は変化していないため既存行を返す。
 */
export async function saveSnapshot(
  spec: FetchedSpec,
  sourceUrl: string,
): Promise<{ snapshot: SnapshotRow; created: boolean }> {
  const { rows } = await pool.query<SnapshotRow>(
    `INSERT INTO api_spec_snapshots (provider, version, spec_hash, source_url, bytes, spec, fetched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, spec_hash) DO NOTHING
     RETURNING id, provider, version, spec_hash, bytes, fetched_at`,
    [spec.provider, spec.version, spec.hash, sourceUrl, spec.bytes, JSON.stringify(spec.document), spec.fetchedAt],
  );

  const inserted = rows[0];
  if (inserted) return { snapshot: inserted, created: true };

  const existing = await pool.query<SnapshotRow>(
    `SELECT id, provider, version, spec_hash, bytes, fetched_at
       FROM api_spec_snapshots WHERE provider = $1 AND spec_hash = $2`,
    [spec.provider, spec.hash],
  );
  const row = existing.rows[0];
  if (!row) throw new Error('スナップショットの保存に失敗しました');
  return { snapshot: row, created: false };
}

/** 指定スナップショットより前の、直近のスナップショット（差分比較の基準）。 */
export async function findPreviousSnapshot(provider: string, excludeId: string): Promise<SnapshotWithSpec | null> {
  const { rows } = await pool.query<SnapshotWithSpec>(
    `SELECT id, provider, version, spec_hash, bytes, fetched_at, spec
       FROM api_spec_snapshots
      WHERE provider = $1 AND id <> $2
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1`,
    [provider, excludeId],
  );
  return rows[0] ?? null;
}

export async function findLatestSnapshot(provider: string): Promise<SnapshotRow | null> {
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT id, provider, version, spec_hash, bytes, fetched_at
       FROM api_spec_snapshots
      WHERE provider = $1
      ORDER BY fetched_at DESC, id DESC
      LIMIT 1`,
    [provider],
  );
  return rows[0] ?? null;
}
