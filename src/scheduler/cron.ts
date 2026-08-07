import cron from 'node-cron';

import { env } from '../config/env.js';
import { detect } from '../detector/detect.js';
import { PROVIDERS, type ProviderId } from '../detector/providers.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
}

/** 全プロバイダを順に検知する（同時実行によるメモリ圧を避けて直列）。 */
export async function detectAll(log: Logger): Promise<void> {
  for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
    try {
      const outcome = await detect(id, log);
      if (outcome.status === 'breaking') {
        // TODO(②): 影響範囲特定モジュールへ diffId を引き渡す
        log.warn(
          { provider: id, diffId: outcome.diffId, breaking: outcome.breakingCount },
          '破壊的変更を検知しました',
        );
      }
    } catch (error) {
      log.error({ provider: id, err: String(error) }, '検知処理に失敗しました');
    }
  }
}

export function startScheduler(log: Logger): { stop: () => void } | null {
  if (!env.DETECT_ENABLED) {
    log.info({}, '検知スケジューラは無効化されています (DETECT_ENABLED=false)');
    return null;
  }
  if (!cron.validate(env.DETECT_CRON)) {
    throw new Error(`DETECT_CRON の書式が不正です: ${env.DETECT_CRON}`);
  }

  const task = cron.schedule(env.DETECT_CRON, () => void detectAll(log), { timezone: env.DETECT_TIMEZONE });
  log.info({ cron: env.DETECT_CRON, timezone: env.DETECT_TIMEZONE }, '検知スケジューラを起動しました');
  return { stop: () => void task.stop() };
}
