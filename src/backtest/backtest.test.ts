import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatReport } from './report.js';
import { scoreAgainstExpected } from './score.js';
import { specUrlAt } from './spec-source.js';
import type { BacktestCase, CaseResult } from './types.js';

const baseCase: BacktestCase = {
  id: 'sample',
  description: '説明',
  provider: 'stripe',
  spec: { from: 'aaa', to: 'bbb' },
  repository: { url: 'https://github.com/example/repo' },
};

const withExpected = (affected: string[], notAffected: string[]): BacktestCase => ({
  ...baseCase,
  expected: { affectedFiles: affected, notAffectedFiles: notAffected },
});

test('期待が無いケースは採点しない', () => {
  assert.equal(scoreAgainstExpected(baseCase, ['a.ts']), undefined);
});

test('正解・誤検知・見逃しを数える', () => {
  const score = scoreAgainstExpected(withExpected(['a.ts', 'b.ts'], ['c.ts']), ['a.ts', 'c.ts']);

  assert.deepEqual(score, { truePositives: 1, falsePositives: 1, falseNegatives: 1, trueNegatives: 0 });
});

test('期待に載っていないファイルは誤検知に数えない', () => {
  // 影響なしと確認できていないファイルを誤検知扱いすると、正解データの不足が
  // 精度の低さとして現れてしまう
  const score = scoreAgainstExpected(withExpected(['a.ts'], []), ['a.ts', 'unknown.ts']);

  assert.deepEqual(score, { truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 0 });
});

test('影響なしと分かっているものを除外できたら数える', () => {
  // 不要な PR を出さなかったこと自体が成果なので、正解 0 でも見えるようにする
  const score = scoreAgainstExpected(withExpected([], ['a.ts', 'b.ts']), []);

  assert.deepEqual(score, { truePositives: 0, falsePositives: 0, falseNegatives: 0, trueNegatives: 2 });
});

test('集計では実行できなかったケースを除く', () => {
  const ok: CaseResult = {
    case: withExpected(['a.ts'], ['b.ts']),
    breakingChanges: 3,
    scannedFiles: 10,
    callSites: 5,
    candidates: 2,
    directMatches: 1,
    candidateSummaries: [],
    judged: true,
    affectedFiles: ['a.ts'],
    notAffectedFiles: ['b.ts'],
    uncertainFiles: [],
    score: { truePositives: 1, falsePositives: 0, falseNegatives: 0, trueNegatives: 1 },
    durationMs: 1000,
  };
  const failed: CaseResult = {
    ...ok,
    case: { ...baseCase, id: 'broken' },
    error: '取得に失敗しました',
  };

  const report = formatReport([ok, failed]);

  assert.match(report, /実行: 1 \/ 2 ケース（1 件は実行できず）/);
  assert.match(report, /SDK 呼び出しの検出: 合計 5 箇所/);
  assert.match(report, /適合率（誤検知の少なさ）: 100\.0%/);
  assert.match(report, /再現率（見逃しの少なさ）: 100\.0%/);
});

test('採点対象が無い場合は精度を出さない', () => {
  const report = formatReport([
    {
      case: baseCase,
      breakingChanges: 1,
      scannedFiles: 1,
      callSites: 0,
      candidates: 0,
      directMatches: 0,
    candidateSummaries: [],
      judged: false,
      affectedFiles: [],
      notAffectedFiles: [],
      uncertainFiles: [],
      durationMs: 100,
    },
  ]);

  assert.match(report, /採点対象なし/);
  assert.doesNotMatch(report, /適合率/);
});

test('スペックの URL は ref だけを差し替える', () => {
  const url = specUrlAt('stripe', 'a54c3888eb6f227e15eeaa97d0adbd561b01e2c2');

  assert.match(url, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.match(url, /\/a54c3888eb6f227e15eeaa97d0adbd561b01e2c2\//);
});

test('完全な URL を指定した場合はそのまま使う', () => {
  const url = specUrlAt('stripe', 'https://example.com/spec.json');

  assert.equal(url, 'https://example.com/spec.json');
});
