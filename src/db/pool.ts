import { Pool } from 'pg';

import { env } from '../config/env.js';

/** アプリ全体で共有する接続プール。 */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const closePool = (): Promise<void> => pool.end();
