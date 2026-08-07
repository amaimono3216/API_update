import 'dotenv/config';

import { buildApp } from './app.js';
import { env } from './config/env.js';
import { migrate } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { closeRedis } from './lib/redis.js';
import { startScheduler } from './scheduler/cron.js';

const app = buildApp();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'シャットダウンします');
  scheduler?.stop();
  await app.close();
  await Promise.allSettled([closePool(), closeRedis()]);
  process.exit(0);
};

let scheduler: { stop: () => void } | null = null;

try {
  await migrate(app.log);
  scheduler = startScheduler(app.log);
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}
