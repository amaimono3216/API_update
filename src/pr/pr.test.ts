import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AnalysisResult, ImpactJudgement } from '../analyzer/types.js';
import { PROVIDERS } from '../detector/providers.js';
import type { BreakingChange } from '../detector/types.js';
import type { FixResult, TestResult } from '../fixer/types.js';
import { DryRunPublisher, createPublisher, GitHubPublisher, shouldForcePush } from './publisher.js';
import { buildPullRequestBody, buildTitle, type TemplateInput } from './template.js';
import { formatTestResult, parseTestCounts } from './test-summary.js';

const testResult = (overrides: Partial<TestResult> = {}): TestResult => ({
  executed: true,
  passed: true,
  command: 'npm test',
  exitCode: 0,
  output: 'ℹ pass 12\nℹ fail 0\n',
  durationMs: 100,
  timedOut: false,
  ...overrides,
});

const judgement = (overrides: Partial<ImpactJudgement> = {}): ImpactJudgement => ({
  file: 'src/refund.js',
  line: 4,
  changeLocation: 'POST /v1/terminal/refunds requestBody.amount',
  verdict: 'affected',
  reason: 'amount を渡しているため影響を受けます。',
  suggestedFix: '削除されたため取り除く。',
  ...overrides,
});

const change = (overrides: Partial<BreakingChange> = {}): BreakingChange => ({
  kind: 'property_removed',
  severity: 'breaking',
  direction: 'request',
  location: 'POST /v1/terminal/refunds requestBody.amount',
  propertyPath: 'amount',
  operations: [{ method: 'post', path: '/v1/terminal/refunds' }],
  before: 'integer',
  after: undefined,
  message: 'amount が削除されました',
  ...overrides,
});

const analysis = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
  repository: 'acme/payments',
  diffId: '2',
  scannedFiles: 4,
  callSites: 5,
  candidates: 3,
  judged: true,
  affected: [judgement()],
  judgements: [judgement()],
  ...overrides,
});

const fixResult = (overrides: Partial<FixResult> = {}): FixResult => ({
  branch: 'api-update/stripe-2026-07-29.dahlia',
  succeeded: true,
  attempts: [{ attempt: 1, edits: [], applyFailures: 0, test: testResult(), summary: '修正しました' }],
  edits: [
    { file: 'src/refund.js', oldString: 'a', newString: 'b', description: '削除された amount を除去' },
  ],
  test: testResult(),
  diff: 'diff --git a/src/refund.js',
  workdir: '/tmp/work',
  ...overrides,
});

const input = (overrides: Partial<TemplateInput> = {}): TemplateInput => ({
  provider: PROVIDERS.stripe,
  fromVersion: '2026-03-25.dahlia',
  toVersion: '2026-07-29.dahlia',
  detectedAt: new Date('2026-08-08T05:00:00Z'),
  changes: [change()],
  analysis: analysis(),
  fix: fixResult(),
  ...overrides,
});

describe('parseTestCounts', () => {
  it('node:test の出力を読む', () => {
    assert.deepEqual(parseTestCounts('ℹ pass 12\nℹ fail 0\n'), { passed: 12, total: 12 });
    assert.deepEqual(parseTestCounts('# pass 11\n# fail 1\n'), { passed: 11, total: 12 });
  });

  it('Jest / Vitest の出力を読む', () => {
    assert.deepEqual(parseTestCounts('Tests:       12 passed, 12 total'), { passed: 12, total: 12 });
    assert.deepEqual(parseTestCounts('Tests:       1 failed, 11 passed, 12 total'), { passed: 11, total: 12 });
  });

  it('pytest の出力を読む', () => {
    assert.deepEqual(parseTestCounts('===== 12 passed in 0.53s ====='), { passed: 12, total: 12 });
    assert.deepEqual(parseTestCounts('===== 1 failed, 11 passed in 0.53s ====='), { passed: 11, total: 12 });
  });

  it('Mocha の出力を読む', () => {
    assert.deepEqual(parseTestCounts('  12 passing (34ms)'), { passed: 12, total: 12 });
    assert.deepEqual(parseTestCounts('  11 passing (34ms)\n  1 failing'), { passed: 11, total: 12 });
  });

  it('未知の形式では undefined を返す', () => {
    assert.equal(parseTestCounts('ok\tgithub.com/example/pkg\t0.012s'), undefined);
  });
});

describe('formatTestResult', () => {
  it('成功時は件数つきで表示する', () => {
    assert.equal(formatTestResult(testResult()), '✅ PASSED（実行結果: 12/12 passed）');
  });

  it('失敗時は FAILED として表示する', () => {
    const result = formatTestResult(testResult({ passed: false, output: 'ℹ pass 11\nℹ fail 1\n' }));
    assert.equal(result, '❌ FAILED（実行結果: 11/12 passed）');
  });

  it('件数を読めない場合でも成否は示す', () => {
    assert.equal(formatTestResult(testResult({ output: 'ok\tpkg\t0.01s' })), '✅ PASSED');
  });

  it('未実行・タイムアウトを区別する', () => {
    assert.match(formatTestResult(null), /未実行/);
    assert.match(formatTestResult(testResult({ timedOut: true, passed: false })), /TIMEOUT/);
    assert.match(formatTestResult(testResult({ executed: false, passed: false, output: 'not found' })), /実行できません/);
  });
});

describe('buildTitle', () => {
  it('仕様どおりの形式にする', () => {
    assert.equal(buildTitle(PROVIDERS.stripe), '[API Auto-Update] Stripe API 変更に伴う自動修正');
    assert.equal(buildTitle(PROVIDERS.openai), '[API Auto-Update] OpenAI API 変更に伴う自動修正');
  });
});

describe('buildPullRequestBody', () => {
  it('仕様が要求する 3 つの節をすべて含む', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /## 1\. API 仕様の変更概要/);
    assert.match(body, /## 2\. 影響を受けるファイルと修正内容/);
    assert.match(body, /## 3\. テスト実行結果/);
    assert.match(body, /## 4\. この修正の信頼性について/);
  });

  it('対象サービスとバージョン、公式情報源を明記する', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /Stripe API \(`2026-03-25\.dahlia` → `2026-07-29\.dahlia`\)/);
    assert.match(body, /https:\/\/docs\.stripe\.com\/changelog/);
  });

  it('変更前後を表にする', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /\| 変更項目 \| 変更前 \(Before\) \| 変更後 \(After\) \|/);
    assert.match(body, /`POST \/v1\/terminal\/refunds` の `amount` \| `integer` \| （削除）/);
  });

  it('型変更は変更前後の型を並べる', () => {
    const body = buildPullRequestBody(
      input({
        changes: [change({ kind: 'property_type_changed', before: 'integer', after: 'string' })],
      }),
    );
    assert.match(body, /\| `integer` \| `string` \|/);
  });

  it('影響ファイルを行番号つきで示し、修正内容を列挙する', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /### `src\/refund\.js` \(L4\)/);
    assert.match(body, /- 削除された amount を除去/);
    assert.match(body, /amount を渡しているため影響を受けます。/);
  });

  it('複数行にまたがる場合は範囲で示す', () => {
    const body = buildPullRequestBody(
      input({ analysis: analysis({ affected: [judgement({ line: 4 }), judgement({ line: 9 })] }) }),
    );
    assert.match(body, /### `src\/refund\.js` \(L4-L9\)/);
  });

  it('テスト結果とコマンドを記載する', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /\*\*既存のユニットテスト\*\*: ✅ PASSED（実行結果: 12\/12 passed）/);
    assert.match(body, /\*\*実行コマンド\*\*: `npm test`/);
  });

  it('テスト失敗時は警告と出力を載せる', () => {
    const failing = testResult({ passed: false, output: 'AssertionError: 失敗しました' });
    const body = buildPullRequestBody(
      input({ fix: fixResult({ succeeded: false, test: failing }) }),
    );
    assert.match(body, /❌ FAILED/);
    assert.match(body, /テストが通っていません/);
    assert.match(body, /AssertionError: 失敗しました/);
  });

  it('テストは通ったが編集を適用できなかった場合、テスト失敗と混同しない', () => {
    const body = buildPullRequestBody(
      input({
        fix: fixResult({
          succeeded: false,
          test: testResult({ passed: true }),
          attempts: [
            { attempt: 1, edits: [], applyFailures: 2, test: testResult({ passed: true }), summary: '1 回目' },
            { attempt: 2, edits: [], applyFailures: 1, test: testResult({ passed: true }), summary: '2 回目' },
          ],
        }),
      }),
    );
    assert.match(body, /適用できなかった修正が 3 件あります/);
    assert.doesNotMatch(body, /テストが通っていません/);
  });

  it('再修正した場合は試行回数を明示する', () => {
    const body = buildPullRequestBody(
      input({
        fix: fixResult({
          attempts: [
            { attempt: 1, edits: [], applyFailures: 0, test: testResult({ passed: false }), summary: '1 回目' },
            { attempt: 2, edits: [], applyFailures: 0, test: testResult(), summary: '2 回目' },
          ],
        }),
      }),
    );
    assert.match(body, /\*\*修正の試行回数\*\*: 2 回（テスト失敗を受けて再修正しています）/);
  });

  it('判断できなかった箇所を手動確認対象として列挙する', () => {
    const uncertain = judgement({ file: 'src/report.js', line: 7, verdict: 'uncertain', reason: '判断できません。' });
    const body = buildPullRequestBody(
      input({ analysis: analysis({ judgements: [judgement(), uncertain] }) }),
    );
    assert.match(body, /手動での確認をおすすめする箇所（1 件）/);
    assert.match(body, /`src\/report\.js:7`/);
  });

  it('影響箇所は重複を除いた実数で示す（呼び出し箇所数との比率にしない）', () => {
    // 同じ行が複数の変更に該当する場合、単純な件数だと呼び出し箇所数を上回り誤解を招く
    const body = buildPullRequestBody(
      input({
        analysis: analysis({
          callSites: 1,
          scannedFiles: 3,
          affected: [
            judgement({ line: 14, changeLocation: 'POST /v1/terminal/refunds requestBody.amount' }),
            judgement({ line: 14, changeLocation: 'POST /v1/terminal/refunds requestBody.charge' }),
            judgement({ line: 4, changeLocation: 'POST /v1/terminal/refunds requestBody.amount' }),
          ],
        }),
      }),
    );
    assert.match(body, /\*\*検出した API 呼び出し\*\*: 1 箇所（走査ファイル 3 件）/);
    assert.match(body, /\*\*修正が必要と判定した箇所\*\*: 2 箇所/);
    assert.doesNotMatch(body, /1 箇所の API 呼び出しのうち、3/);
  });

  it('LLM 判定が未実行の場合は警告する', () => {
    const body = buildPullRequestBody(input({ analysis: analysis({ judged: false }) }));
    assert.match(body, /LLM による影響判定は実行されていません/);
  });

  it('自動生成であることを明示する', () => {
    const body = buildPullRequestBody(input());
    assert.match(body, /このPRは自動生成されています/);
    assert.match(body, /api-update（API 破壊的変更の自動追随システム）が生成しました/);
  });

  it('リンク切れになる URL を含めない', () => {
    const body = buildPullRequestBody(input());
    for (const match of body.matchAll(/\]\((https?:\/\/[^)]*)\)/g)) {
      const url = match[1] as string;
      assert.ok(new URL(url).pathname.length > 1, `リンク先が空です: ${url}`);
    }
  });
});

describe('shouldForcePush', () => {
  it('自動生成ブランチは force push を許す', () => {
    assert.equal(shouldForcePush('api-update/stripe-2026-07-29.dahlia-2'), true);
    assert.equal(shouldForcePush('api-update/twilio-2010-04-01-7'), true);
  });

  it('自動生成ブランチ以外には絶対に force push しない', () => {
    for (const branch of ['main', 'master', 'develop', 'release/v1', 'feature/api-update/x', '']) {
      assert.equal(shouldForcePush(branch), false, `${branch} を force push 対象にしてはいけない`);
    }
  });

  it('接頭辞だけのブランチ名は対象外にする', () => {
    assert.equal(shouldForcePush('api-update/'), false);
  });

  it('パス操作で接頭辞の外に出ようとするものは拒否する', () => {
    assert.equal(shouldForcePush('api-update/../main'), false);
    assert.equal(shouldForcePush('api-update/x/../../main'), false);
  });
});

describe('createPublisher', () => {
  it('認証情報が無ければ dry-run になる', () => {
    assert.ok(createPublisher({}) instanceof DryRunPublisher);
    assert.ok(createPublisher({ appId: '1' }) instanceof DryRunPublisher);
    assert.ok(createPublisher({ privateKey: 'k' }) instanceof DryRunPublisher);
  });

  it('認証情報が揃えば GitHub 実装になる', () => {
    assert.ok(createPublisher({ appId: '1', privateKey: 'k' }) instanceof GitHubPublisher);
  });

  it('dry-run は理由つきで未送信を返す', async () => {
    const result = await new DryRunPublisher().publish();
    assert.equal(result.published, false);
    assert.equal(result.url, null);
    assert.match(result.reason ?? '', /認証情報/);
  });
});
