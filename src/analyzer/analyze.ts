import { findDiffById } from '../db/diffs.js';
import { getSnapshotSpec } from '../db/snapshots.js';
import { createRun, updateRun } from '../db/runs.js';
import { OperationIndex } from './sdk-map.js';
import { correlate } from './correlate.js';
import { isJudgeAvailable, judgeImpact } from './llm-judge.js';
import type { RepositorySource } from './repository.js';
import { scanSource } from './scan-typescript.js';
import type { AnalysisResult, CallSite } from './types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * ② 影響範囲特定モジュールの本体。
 *
 * リポジトリ走査 → SDK 呼び出し抽出 → 破壊的変更との突合 → LLM 判定 の順に実行し、
 * 実行結果を `api_update_runs` に記録する。影響なしの場合はここで終了し、
 * ③ 以降を起動しない（無駄な PR を防ぐ）。
 */
export async function analyze(
  diffId: string,
  repository: RepositorySource,
  log: Logger,
): Promise<AnalysisResult> {
  const diff = await findDiffById(diffId);
  if (!diff) throw new Error(`差分が見つかりません: ${diffId}`);

  const run = await createRun({ diffId, repository: repository.name, status: 'analyzing' });

  try {
    const spec = await getSnapshotSpec(diff.to_snapshot);
    if (!spec) throw new Error(`スナップショットが見つかりません: ${diff.to_snapshot}`);

    const index = new OperationIndex(spec);
    const files = await repository.listSourceFiles();

    const callSites: CallSite[] = [];
    for (const file of files) {
      try {
        callSites.push(...scanSource(file.path, file.content, index));
      } catch (error) {
        // 構文エラーのあるファイルで全体を止めない
        log.warn({ file: file.path, err: String(error) }, 'ファイルの解析に失敗しました');
      }
    }

    const breaking = diff.changes.filter((c) => c.severity === 'breaking');
    const candidates = correlate(breaking, callSites);
    log.info(
      { repository: repository.name, files: files.length, callSites: callSites.length, candidates: candidates.length },
      '静的解析が完了しました',
    );

    const judgements = await judgeImpact(candidates, log);
    const affected = judgements.filter((j) => j.verdict === 'affected');

    const result: AnalysisResult = {
      repository: repository.name,
      diffId,
      scannedFiles: files.length,
      callSites: callSites.length,
      candidates: candidates.length,
      judged: isJudgeAvailable(),
      affected,
      judgements,
    };

    await updateRun(run.id, {
      status: affected.length > 0 ? 'detected' : 'skipped',
      impact: result,
    });
    log.info({ repository: repository.name, affected: affected.length }, '影響範囲の特定が完了しました');

    return result;
  } catch (error) {
    await updateRun(run.id, { status: 'failed', error: String(error) });
    throw error;
  }
}
