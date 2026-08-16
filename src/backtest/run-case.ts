import path from 'node:path';

import { correlate } from '../analyzer/correlate.js';
import { judgeImpact } from '../analyzer/llm-judge.js';
import { LocalRepository } from '../analyzer/repository.js';
import { scanFiles } from '../analyzer/scan.js';
import { OperationIndex } from '../analyzer/sdk-map.js';
import { diffOpenApi } from '../detector/diff.js';
import { checkoutRepository } from './checkout.js';
import { scoreAgainstExpected } from './score.js';
import { fetchSpecAt } from './spec-source.js';
import type { BacktestCase, CaseResult } from './types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface RunOptions {
  /** LLM 判定を行うか。false なら静的解析までで止める（課金なし）。 */
  useLlm: boolean;
}

/**
 * 1 ケースを実行する。
 *
 *   過去のスペック 2 つを取得 → 差分 → 対象リポジトリを当時の状態で取得
 *   → 走査・突合 → （任意で）LLM 判定 → 期待との突き合わせ
 *
 * ③ 以降は動かさない。測りたいのは「影響箇所を正しく絞り込めるか」であり、
 * 修正の生成は別の問題だから。
 */
export async function runCase(testCase: BacktestCase, options: RunOptions, log: Logger): Promise<CaseResult> {
  const startedAt = Date.now();
  const base: CaseResult = {
    case: testCase,
    breakingChanges: 0,
    scannedFiles: 0,
    callSites: 0,
    candidates: 0,
    directMatches: 0,
    candidateSummaries: [],
    judged: false,
    affectedFiles: [],
    notAffectedFiles: [],
    uncertainFiles: [],
    durationMs: 0,
  };

  let checkout: Awaited<ReturnType<typeof checkoutRepository>> | undefined;

  try {
    const [from, to] = await Promise.all([
      fetchSpecAt(testCase.provider, testCase.spec.from),
      fetchSpecAt(testCase.provider, testCase.spec.to),
    ]);

    const diff = diffOpenApi(from.document, to.document);
    const breaking = diff.changes.filter((c) => c.severity === 'breaking');
    base.breakingChanges = breaking.length;

    if (breaking.length === 0) {
      return { ...base, error: '破壊的変更が検出されませんでした（スペックの指定を確認してください）', durationMs: Date.now() - startedAt };
    }

    checkout = await checkoutRepository(testCase.repository.url, testCase.repository.ref);
    const root = testCase.repository.subdirectory
      ? path.join(checkout.dir, testCase.repository.subdirectory)
      : checkout.dir;

    const files = await new LocalRepository(root, testCase.id).listSourceFiles();
    const index = new OperationIndex(to.document);
    const callSites = await scanFiles(files, index, log);
    const candidates = correlate(breaking, callSites);

    base.scannedFiles = files.length;
    base.callSites = callSites.length;
    base.candidates = candidates.length;
    base.directMatches = candidates.filter((c) => c.match === 'direct').length;
    // 変更側の operations は共有スキーマ経由で多数になりうるため、
    // 実際に突合したのは呼び出し側が解決した操作の方
    base.candidateSummaries = candidates.map(
      (c) =>
        `${c.callSite.file}:${c.callSite.line} ${c.callSite.chain.join('.')} ` +
        `→ ${c.callSite.operation?.method.toUpperCase() ?? '?'} ${c.callSite.operation?.path ?? '?'} ` +
        `／ ${c.change.kind}${c.change.propertyPath ? ` ${c.change.propertyPath}` : ''} (${c.match})`,
    );

    log.info(
      {
        case: testCase.id,
        sha: checkout.sha.slice(0, 7),
        breaking: breaking.length,
        files: files.length,
        callSites: callSites.length,
        candidates: candidates.length,
        direct: base.directMatches,
      },
      '静的解析が完了しました',
    );

    if (!options.useLlm || candidates.length === 0) {
      return { ...base, durationMs: Date.now() - startedAt };
    }

    const sources = new Map(files.map((f) => [f.path, f.content]));
    const judgements = await judgeImpact(candidates, sources, log);

    const byVerdict = (verdict: string): string[] =>
      [...new Set(judgements.filter((j) => j.verdict === verdict).map((j) => j.file))].sort();

    base.judged = true;
    base.affectedFiles = byVerdict('affected');
    base.notAffectedFiles = byVerdict('not_affected');
    base.uncertainFiles = byVerdict('uncertain');
    base.score = scoreAgainstExpected(testCase, base.affectedFiles);

    return { ...base, durationMs: Date.now() - startedAt };
  } catch (error) {
    return { ...base, error: String(error), durationMs: Date.now() - startedAt };
  } finally {
    await checkout?.dispose();
  }
}
