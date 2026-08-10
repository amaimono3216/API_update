import { env } from '../config/env.js';
import { saveDiff } from '../db/diffs.js';
import { findPreviousSnapshot, saveSnapshot } from '../db/snapshots.js';
import { withLock } from '../lib/redis.js';
import { diffOpenApi, summarize } from './diff.js';
import { fetchSpec } from './fetch-spec.js';
import { resolveProvider, type ProviderId } from './providers.js';
import type { BreakingChange } from './types.js';

export type DetectionOutcome =
  /** 別プロセスが同じプロバイダを処理中。 */
  | { status: 'locked'; provider: ProviderId }
  /** 前回取得分とハッシュが一致。API 側に変更なし。 */
  | { status: 'unchanged'; provider: ProviderId; version: string; snapshotId: string }
  /** 初回取得。比較対象がないため差分は取らない。 */
  | { status: 'baseline'; provider: ProviderId; version: string; snapshotId: string }
  /** 差分はあったが後方互換の範囲。②以降は起動しない。 */
  | { status: 'compatible'; provider: ProviderId; diffId: string; fromVersion: string; toVersion: string }
  /** 破壊的変更を検知。②影響範囲特定モジュールへ引き渡す。 */
  | {
      status: 'breaking';
      provider: ProviderId;
      diffId: string;
      fromVersion: string;
      toVersion: string;
      breakingCount: number;
      warningCount: number;
      changes: BreakingChange[];
    };

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * ① 監視・検知モジュールの本体。
 * スペック取得 → スナップショット保存 → 前回分との差分抽出 → 永続化 までを 1 回実行する。
 */
export async function detect(providerId: ProviderId, log: Logger): Promise<DetectionOutcome> {
  const result = await withLock(`detect:${providerId}`, 900, () => run(providerId, log));
  if (result === null) {
    log.warn({ provider: providerId }, '他プロセスが実行中のためスキップしました');
    return { status: 'locked', provider: providerId };
  }
  return result;
}

async function run(providerId: ProviderId, log: Logger): Promise<DetectionOutcome> {
  const provider = resolveProvider(providerId, {
    STRIPE_OPENAPI_URL: env.STRIPE_OPENAPI_URL,
    OPENAI_OPENAPI_URL: env.OPENAI_OPENAPI_URL,
    TWILIO_OPENAPI_URL: env.TWILIO_OPENAPI_URL,
    SLACK_OPENAPI_URL: env.SLACK_OPENAPI_URL,
  });

  const startedAt = Date.now();
  const spec = await fetchSpec(provider);
  log.info(
    { provider: providerId, version: spec.version, bytes: spec.bytes, ms: Date.now() - startedAt },
    'スペックを取得しました',
  );

  const { snapshot, created } = await saveSnapshot(spec, provider.specUrl);
  if (!created) {
    log.info({ provider: providerId, version: spec.version }, '前回から変更なし');
    return { status: 'unchanged', provider: providerId, version: spec.version, snapshotId: snapshot.id };
  }

  const previous = await findPreviousSnapshot(providerId, snapshot.id);
  if (!previous) {
    log.info({ provider: providerId, version: spec.version }, '初回取得のため基準として保存しました');
    return { status: 'baseline', provider: providerId, version: spec.version, snapshotId: snapshot.id };
  }

  const diffStartedAt = Date.now();
  const diff = diffOpenApi(previous.spec, spec.document);
  const row = await saveDiff({
    provider: providerId,
    fromSnapshot: previous.id,
    toSnapshot: snapshot.id,
    fromVersion: previous.version,
    toVersion: spec.version,
    diff,
  });

  log.info(
    {
      provider: providerId,
      from: previous.version,
      to: spec.version,
      breaking: diff.breakingCount,
      warning: diff.warningCount,
      ms: Date.now() - diffStartedAt,
    },
    summarize(diff),
  );

  const base = { provider: providerId, diffId: row.id, fromVersion: previous.version, toVersion: spec.version };
  if (diff.breakingCount === 0) return { status: 'compatible', ...base };

  return {
    status: 'breaking',
    ...base,
    breakingCount: diff.breakingCount,
    warningCount: diff.warningCount,
    changes: diff.changes.filter((c) => c.severity === 'breaking'),
  };
}
