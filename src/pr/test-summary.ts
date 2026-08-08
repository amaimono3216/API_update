import type { TestResult } from '../fixer/types.js';

export interface TestCounts {
  passed: number;
  total: number;
}

/**
 * テストランナーの出力から件数を取り出す。
 *
 * PR 概要欄に「12/12 passed」と具体的な数字を出すため。
 * 対応していない形式では undefined を返し、PASSED / FAILED のみ表示する。
 */
export function parseTestCounts(output: string): TestCounts | undefined {
  // Jest / Vitest: "Tests:  1 failed, 11 passed, 12 total"
  const jest = /Tests:\s+(?:\d+ failed,\s*)?(?:\d+ skipped,\s*)?(?:\d+ todo,\s*)?(\d+) passed,\s*(\d+) total/.exec(output);
  if (jest) return { passed: Number(jest[1]), total: Number(jest[2]) };

  // node:test: "ℹ pass 12" / "ℹ fail 0"（TAP 形式では "# pass 12"）
  const nodePass = /(?:^|\n)\s*(?:ℹ|#)\s*pass (\d+)/.exec(output);
  const nodeFail = /(?:^|\n)\s*(?:ℹ|#)\s*fail (\d+)/.exec(output);
  if (nodePass && nodeFail) {
    const passed = Number(nodePass[1]);
    return { passed, total: passed + Number(nodeFail[1]) };
  }

  // pytest: "12 passed in 0.5s" / "1 failed, 11 passed in 0.5s"
  const pytestPassed = /(\d+) passed/.exec(output);
  if (pytestPassed) {
    const passed = Number(pytestPassed[1]);
    const failed = Number(/(\d+) failed/.exec(output)?.[1] ?? 0);
    const errors = Number(/(\d+) errors?\b/.exec(output)?.[1] ?? 0);
    return { passed, total: passed + failed + errors };
  }

  // Mocha: "12 passing" / "1 failing"
  const mochaPassing = /(\d+) passing/.exec(output);
  if (mochaPassing) {
    const passed = Number(mochaPassing[1]);
    return { passed, total: passed + Number(/(\d+) failing/.exec(output)?.[1] ?? 0) };
  }

  return undefined;
}

/** PR 概要欄に載せる 1 行のテスト結果表現を組み立てる。 */
export function formatTestResult(test: TestResult | null): string {
  if (!test) return '⚠️ テストコマンドを検出できなかったため未実行';
  if (!test.executed) return `⚠️ 実行できませんでした（${test.output.trim()}）`;
  if (test.timedOut) return '❌ TIMEOUT（タイムアウトのため打ち切り）';

  const counts = parseTestCounts(test.output);
  const detail = counts ? `（実行結果: ${counts.passed}/${counts.total} passed）` : '';
  return test.passed ? `✅ PASSED${detail}` : `❌ FAILED${detail}`;
}
