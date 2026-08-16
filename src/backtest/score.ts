import type { BacktestCase, CaseResult } from './types.js';

/**
 * 期待と実際の判定を突き合わせる。期待が無いケースは採点しない。
 *
 * 期待に載っていないファイルは、正解でも誤検知でもなく数えない。
 * 「影響なし」と人手で確認できていないものを誤検知に数えると、
 * 正解データの不足が精度の低さとして現れてしまうため。
 */
export function scoreAgainstExpected(testCase: BacktestCase, affected: string[]): CaseResult['score'] {
  const expected = testCase.expected;
  if (!expected) return undefined;

  const actual = new Set(affected);
  const shouldBeAffected = new Set(expected.affectedFiles);
  const shouldNotBeAffected = new Set(expected.notAffectedFiles);

  return {
    truePositives: [...shouldBeAffected].filter((f) => actual.has(f)).length,
    // 影響なしと分かっているファイルを影響ありと判定した数（＝不要な PR の原因）
    falsePositives: [...actual].filter((f) => shouldNotBeAffected.has(f)).length,
    falseNegatives: [...shouldBeAffected].filter((f) => !actual.has(f)).length,
    trueNegatives: [...shouldNotBeAffected].filter((f) => !actual.has(f)).length,
  };
}
