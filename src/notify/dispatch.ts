import type { DetectionOutcome } from '../detector/detect.js';
import type { Notifier } from './types.js';

/**
 * 検知結果のうち通知すべきものだけを通知する。
 *
 * 変更なし・後方互換の変更は日常的に発生するため通知しない。
 * 通知が多すぎると読まれなくなり、肝心の破壊的変更を見落とす。
 */
export async function notifyDetection(outcome: DetectionOutcome, notifier: Notifier): Promise<void> {
  if (outcome.status !== 'breaking') return;

  await notifier.notify({
    type: 'breaking_detected',
    provider: outcome.provider,
    fromVersion: outcome.fromVersion,
    toVersion: outcome.toVersion,
    breakingCount: outcome.breakingCount,
    warningCount: outcome.warningCount,
    diffId: outcome.diffId,
  });
}
