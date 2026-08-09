import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import { analyze } from './analyzer/analyze.js';
import { LocalRepository } from './analyzer/repository.js';
import { env } from './config/env.js';
import { findDiffById, findLatestDiff, listDiffs } from './db/diffs.js';
import { pool } from './db/pool.js';
import { listRuns } from './db/runs.js';
import { findLatestSnapshot } from './db/snapshots.js';
import { listDeliveries, recordDelivery } from './db/webhooks.js';
import { detect } from './detector/detect.js';
import { PROVIDERS, isProviderId } from './detector/providers.js';
import { fix } from './fixer/fix.js';
import { redis } from './lib/redis.js';
import { notifyDetection } from './notify/dispatch.js';
import { createNotifier } from './notify/notifier.js';
import { publishPullRequest } from './pr/publish.js';
import { handleGitHubEvent, repositoryOf, type GitHubPayload } from './webhook/github.js';
import { dbRunStore } from './webhook/run-store.js';
import { verifySignature } from './webhook/verify.js';

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

  /**
   * Webhook の署名検証は生のバイト列に対して行う必要があるため、
   * JSON をパースしつつ元のバッファも保持する。
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: Buffer }).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
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
    await notifyDetection(outcome, createNotifier(req.log));
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

  /**
   * ② 影響範囲の特定。指定した差分がターゲットリポジトリに影響するかを判定する。
   * GitHub App 連携までの間は、コンテナから見えるローカルパスを対象にする。
   */
  app.post<{ Body: { diffId?: string; path?: string; name?: string } }>('/analyze', async (req, reply) => {
    const { diffId, path: repositoryPath, name } = req.body ?? {};
    if (!diffId || !repositoryPath) {
      return reply.code(400).send({ error: 'diffId と path は必須です' });
    }
    const repository = new LocalRepository(repositoryPath, name ?? repositoryPath);
    return analyze(diffId, repository, req.log);
  });

  app.get<{ Querystring: { repository?: string } }>('/runs', async (req) => ({
    runs: await listRuns(req.query.repository),
  }));

  /**
   * GitHub App からの Webhook 受信口。
   *
   * 署名を検証し、配信 ID で重複を弾いてからイベントを処理する。
   * GitHub は 10 秒以内の応答を期待するため、重い処理はここでは行わない。
   */
  app.post('/webhooks/github', async (req, reply) => {
    if (!env.GITHUB_WEBHOOK_SECRET) {
      return reply.code(503).send({ error: 'GITHUB_WEBHOOK_SECRET が未設定のため受信できません' });
    }

    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-hub-signature-256'];
    if (!rawBody || !verifySignature(rawBody, typeof signature === 'string' ? signature : undefined, env.GITHUB_WEBHOOK_SECRET)) {
      req.log.warn({ ip: req.ip }, 'Webhook の署名検証に失敗しました');
      return reply.code(401).send({ error: '署名が不正です' });
    }

    const event = req.headers['x-github-event'];
    const deliveryId = req.headers['x-github-delivery'];
    if (typeof event !== 'string' || typeof deliveryId !== 'string') {
      return reply.code(400).send({ error: 'X-GitHub-Event / X-GitHub-Delivery ヘッダが必要です' });
    }

    const payload = (req.body ?? {}) as GitHubPayload;
    const isFirstDelivery = await recordDelivery({
      deliveryId,
      event,
      action: payload.action,
      repository: repositoryOf(payload),
    });
    if (!isFirstDelivery) {
      req.log.info({ deliveryId, event }, '再送された Webhook のため処理をスキップしました');
      return { status: 'duplicate' };
    }

    const result = await handleGitHubEvent(event, payload, {
      log: req.log,
      notifier: createNotifier(req.log),
      runs: dbRunStore,
    });
    return { status: result.handled ? 'handled' : 'ignored', detail: result.detail };
  });

  app.get('/webhooks/deliveries', async () => ({ deliveries: await listDeliveries() }));

  /**
   * ③ 影響ありと判定された箇所を修正し、リポジトリ既存のテストで検証する。
   * diff は巨大になりうるため、応答には要約と diff の行数のみを含める。
   */
  app.post<{ Body: { diffId?: string; path?: string; name?: string } }>('/fix', async (req, reply) => {
    const { diffId, path: repositoryPath, name } = req.body ?? {};
    if (!diffId || !repositoryPath) {
      return reply.code(400).send({ error: 'diffId と path は必須です' });
    }

    const repository = new LocalRepository(repositoryPath, name ?? repositoryPath);
    const analysis = await analyze(diffId, repository, req.log);
    if (analysis.affected.length === 0) {
      return { status: 'skipped', reason: '影響を受ける箇所はありませんでした', analysis };
    }

    const run = (await listRuns(repository.name, 1))[0];
    if (!run) return reply.code(500).send({ error: '実行記録が見つかりません' });

    const result = await fix(run.id, analysis, repositoryPath, req.log, { keepWorkdir: true });
    return {
      status: result.succeeded ? 'fixed' : 'failed',
      branch: result.branch,
      attempts: result.attempts.length,
      edits: result.edits,
      test: result.test,
      workdir: result.workdir,
      diffLines: result.diff.split('\n').length,
    };
  });

  /**
   * ②→③→④ を通しで実行する。実運用ではこれが本流の入口になる。
   * GitHub 認証情報が未設定の場合、PR の内容生成までで送信はスキップされる。
   */
  app.post<{ Body: { diffId?: string; path?: string; name?: string; baseBranch?: string } }>(
    '/run',
    async (req, reply) => {
      const { diffId, path: repositoryPath, name, baseBranch } = req.body ?? {};
      if (!diffId || !repositoryPath) {
        return reply.code(400).send({ error: 'diffId と path は必須です' });
      }

      const notifier = createNotifier(req.log);
      const repository = new LocalRepository(repositoryPath, name ?? repositoryPath);
      const analysis = await analyze(diffId, repository, req.log);

      if (analysis.affected.length === 0) {
        const diff = await findDiffById(diffId);
        await notifier.notify({
          type: 'no_impact',
          provider: diff?.provider ?? 'unknown',
          toVersion: diff?.to_version ?? 'unknown',
          repository: repository.name,
          callSites: analysis.callSites,
        });
        return { status: 'skipped', reason: '影響を受ける箇所はありませんでした', analysis };
      }

      const run = (await listRuns(repository.name, 1))[0];
      if (!run) return reply.code(500).send({ error: '実行記録が見つかりません' });

      const fixResult = await fix(run.id, analysis, repositoryPath, req.log, { keepWorkdir: true });
      const { plan, result } = await publishPullRequest(run.id, analysis, fixResult, req.log, {
        ...(baseBranch ? { baseBranch } : {}),
      });

      return {
        status: result.published ? 'pr_opened' : 'prepared',
        pullRequest: { title: plan.title, body: plan.body, branch: plan.branch, baseBranch: plan.baseBranch },
        published: result.published,
        url: result.url,
        reason: result.reason,
        fix: { succeeded: fixResult.succeeded, attempts: fixResult.attempts.length, test: fixResult.test },
      };
    },
  );

  return app;
}
