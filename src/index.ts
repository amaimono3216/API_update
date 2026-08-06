import 'dotenv/config';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

import { env } from './config/env.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
      : {}),
  },
});

const db = new Pool({ connectionString: env.DATABASE_URL });
const redis = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2 });

/** コンテナ起動確認用。DB / Redis への疎通も含めて検証する。 */
app.get('/health', async (_req, reply) => {
  const checks = await Promise.allSettled([
    db.query('SELECT 1'),
    redis.status === 'ready' ? redis.ping() : redis.connect().then(() => redis.ping()),
  ]);

  const [dbCheck, redisCheck] = checks;
  const body = {
    status: checks.every((c) => c.status === 'fulfilled') ? 'ok' : 'degraded',
    uptime: Math.round(process.uptime()),
    dependencies: {
      postgres: dbCheck?.status === 'fulfilled' ? 'ok' : 'error',
      redis: redisCheck?.status === 'fulfilled' ? 'ok' : 'error',
    },
  };

  return reply.code(body.status === 'ok' ? 200 : 503).send(body);
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'シャットダウンします');
  await app.close();
  await Promise.allSettled([db.end(), redis.quit()]);
  process.exit(0);
};

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
