import type { AnalysisResult } from '../analyzer/types.js';
import { env } from '../config/env.js';
import { findDiffById } from '../db/diffs.js';
import { updateRun } from '../db/runs.js';
import { PROVIDERS, isProviderId } from '../detector/providers.js';
import type { FixResult } from '../fixer/types.js';
import { createNotifier } from '../notify/notifier.js';
import type { Notifier } from '../notify/types.js';
import { createPublisher, type PublishResult, type PullRequestPlan, type PullRequestPublisher } from './publisher.js';
import { buildPullRequestBody, buildTitle } from './template.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface PublishOptions {
  /** PR のマージ先。既定は `main`。 */
  baseBranch?: string;
  /** 送信先の差し替え（テスト用）。既定は認証情報の有無で自動選択。 */
  publisher?: PullRequestPublisher;
  /** 通知先の差し替え（テスト用）。既定は設定に応じて Slack / ログ。 */
  notifier?: Notifier;
}

export interface PullRequestOutcome {
  plan: PullRequestPlan;
  result: PublishResult;
}

/**
 * ④ PR 自動生成 & 信頼性表示モジュール。
 *
 * ①〜③ の結果を突き合わせて PR の内容を組み立て、送信する。
 * 認証情報が無い場合は内容の生成までを行い、送信はスキップする。
 */
export async function publishPullRequest(
  runId: string,
  analysis: AnalysisResult,
  fix: FixResult,
  log: Logger,
  options: PublishOptions = {},
): Promise<PullRequestOutcome> {
  const diff = await findDiffById(analysis.diffId);
  if (!diff) throw new Error(`差分が見つかりません: ${analysis.diffId}`);
  if (!isProviderId(diff.provider)) throw new Error(`未対応のプロバイダです: ${diff.provider}`);

  // 表に載せるのは、実際に修正の根拠となった変更のみに絞る
  const affectedLocations = new Set(analysis.affected.map((j) => j.changeLocation));
  const relevantChanges = diff.changes.filter((change) => affectedLocations.has(change.location));

  const provider = PROVIDERS[diff.provider];
  const plan: PullRequestPlan = {
    repository: analysis.repository,
    branch: fix.branch,
    baseBranch: options.baseBranch ?? 'main',
    title: buildTitle(provider),
    body: buildPullRequestBody({
      provider,
      fromVersion: diff.from_version,
      toVersion: diff.to_version,
      detectedAt: diff.created_at,
      changes: relevantChanges,
      analysis,
      fix,
    }),
    workdir: fix.workdir,
  };

  const publisher =
    options.publisher ??
    createPublisher({ appId: env.GITHUB_APP_ID, privateKey: env.GITHUB_APP_PRIVATE_KEY });

  const result = await publisher.publish(plan);
  const notifier = options.notifier ?? createNotifier(log);
  const testPassed = fix.test?.passed ?? false;

  if (result.published && result.url) {
    log.info({ url: result.url, branch: plan.branch }, 'PR を作成しました');
    await updateRun(runId, { status: 'pr_opened', prUrl: result.url });
    await notifier.notify({
      type: 'pr_opened',
      repository: plan.repository,
      branch: plan.branch,
      url: result.url,
      testPassed,
      attempts: fix.attempts.length,
    });
  } else {
    log.warn({ reason: result.reason, branch: plan.branch }, 'PR は作成していません');
    await notifier.notify({
      type: 'pr_prepared',
      repository: plan.repository,
      branch: plan.branch,
      reason: result.reason ?? '送信されませんでした',
      testPassed,
    });
  }

  return { plan, result };
}
