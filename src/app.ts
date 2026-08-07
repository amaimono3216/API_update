import Fastify, { type FastifyInstance } from 'fastify';

import { env } from './config/env.js';
import { findLatestDiff, listDiffs } from './db/diffs.js';
import { pool } from './db/pool.js';
import { findLatestSnapshot } from './db/snapshots.js';
import { detect } from './detector/detect.js';
import { PROVIDERS, isProviderId } from './detector/providers.js';
import { redis } from './lib/redis.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
        : {}),
    },
    // Stripe のスペックは 8MB 超。将来の Webhook ペイロードも見込んで上限を上げる
    bodyLimit: 16 * 1024 * 1024,
  });

  app.get('/health', async (_req, reply) => {
    const checks = await Promise.allSettled([
      pool.query('SELECT 1'),
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

  /** 監視対象と、各プロバイダの最新スナップショット。 */
  app.get('/providers', async () => {
    const providers = await Promise.all(
      Object.values(PROVIDERS).map(async (p) => ({
        id: p.id,
        displayName: p.displayName,
        specUrl: p.specUrl,
        changelogUrl: p.changelogUrl,
        latestSnapshot: await findLatestSnapshot(p.id),
      })),
    );
    return { providers };
  });

  /** 検知の手動実行。cron を待たずに動作確認・再実行するための入口。 */
  app.post<{ Params: { provider: string } }>('/detect/:provider', async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderId(provider)) {
      return reply.code(404).send({ error: `未対応のプロバイダです: ${provider}` });
    }
    const outcome = await detect(provider, req.log);
    return reply.code(outcome.status === 'locked' ? 409 : 200).send(outcome);
  });

  /** 直近の差分（破壊的変更の一覧を含む）。 */
  app.get<{ Params: { provider: string } }>('/diffs/:provider/latest', async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderId(provider)) {
      return reply.code(404).send({ error: `未対応のプロバイダです: ${provider}` });
    }
    const diff = await findLatestDiff(provider);
    if (!diff) return reply.code(404).send({ error: '差分がまだ記録されていません' });
    return diff;
  });

  app.get<{ Params: { provider: string } }>('/diffs/:provider', async (req, reply) => {
    const { provider } = req.params;
    if (!isProviderId(provider)) {
      return reply.code(404).send({ error: `未対応のプロバイダです: ${provider}` });
    }
    return { diffs: await listDiffs(provider) };
  });

  return app;
}
