import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pool } from './pool.js';

/** dist/ からでも src/ からでも同じ migrations/ を指すようにリポジトリルートを解決する。 */
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * `migrations/*.sql` をファイル名順に適用する。
 * 適用済みのファイル名を `schema_migrations` に記録し、再実行時はスキップする。
 */
export async function migrate(log: { info: (obj: object, msg: string) => void }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));

    for (const file of pending) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        log.info({ migration: file }, 'マイグレーションを適用しました');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`マイグレーション ${file} に失敗しました: ${String(error)}`);
      }
    }

    log.info({ applied: pending.length, total: files.length }, 'マイグレーション完了');
  } finally {
    client.release();
  }
}
