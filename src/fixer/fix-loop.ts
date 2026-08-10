import type { ImpactJudgement } from '../analyzer/types.js';
import type { BreakingChange } from '../detector/types.js';
import { applyEdits } from './edit.js';
import type { EditRequest, FileContext } from './fix-agent.js';
import type { Runtime } from './runtime.js';
import type { CommandRunner } from './sandbox.js';
import type { CodeEdit, EditApplyResult, FixAttempt, TestResult } from './types.js';
import type { Workspace } from './workspace.js';

/** テスト失敗時に LLM へフィードバックして再修正する回数の上限（仕様どおり最大 3 回）。 */
export const MAX_ATTEMPTS = 3;

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** 修正案の生成器。既定は LLM だが、テストでは差し替えられるようにしている。 */
export type EditGenerator = (request: EditRequest, log: Logger) => Promise<{ edits: CodeEdit[]; summary: string }>;

export interface FixLoopParams {
  provider: string;
  fromVersion: string | null;
  toVersion: string;
  affected: ImpactJudgement[];
  changesByLocation: Map<string, BreakingChange>;
  /** 未検出の場合、テスト検証はスキップして修正のみ行う。 */
  runtime?: Runtime | undefined;
  /** コマンド実行の主体。runtime を指定する場合は必須。 */
  runner?: CommandRunner | undefined;
  generateEdits?: EditGenerator;
}

export interface FixLoopResult {
  succeeded: boolean;
  attempts: FixAttempt[];
  edits: CodeEdit[];
  test: TestResult | null;
  summary: string;
}

/**
 * 修正 → テスト → 失敗ならフィードバックして再修正、のループ本体。
 *
 * ファイル内容は毎回作業コピーから読み直すため、LLM は常に前回の編集が反映された
 * 最新の状態を見て判断する。
 */
export async function runFixLoop(
  workspace: Workspace,
  params: FixLoopParams,
  log: Logger,
): Promise<FixLoopResult> {
  // 既定の生成器は API キーを要求するため、差し替えられている場合は読み込まない
  const generate = params.generateEdits ?? (await import('./fix-agent.js')).requestEdits;

  const attempts: FixAttempt[] = [];
  const allEdits: CodeEdit[] = [];

  let feedback: { applyResult: EditApplyResult; test: TestResult | null } | undefined;
  let lastTest: TestResult | null = null;
  let lastSummary = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const files = await buildFileContexts(workspace, params.affected, params.changesByLocation, log);
    if (files.length === 0) throw new Error('影響を受けるファイルを作業コピー内で読み込めませんでした');

    const { edits, summary } = await generate(
      {
        provider: params.provider,
        fromVersion: params.fromVersion,
        toVersion: params.toVersion,
        files,
        ...(feedback ? { feedback } : {}),
      },
      log,
    );
    lastSummary = summary;

    const applyResult = await applyEdits(workspace, edits);
    allEdits.push(...applyResult.applied);
    log.info(
      { attempt, applied: applyResult.applied.length, failed: applyResult.failures.length },
      '修正を適用しました',
    );

    // テスト実行時はネットワークを遮断する（依存取得は事前に済ませている）
    const test =
      params.runtime && params.runner
        ? await params.runner.run(workspace.dir, params.runtime, params.runtime.test, { network: false })
        : null;
    lastTest = test;
    attempts.push({
      attempt,
      edits: applyResult.applied,
      applyFailures: applyResult.failures.length,
      test,
      summary,
    });

    if (applyResult.failures.length === 0 && (test === null || test.passed)) {
      log.info({ attempt, tested: test !== null }, '修正が完了しました');
      return { succeeded: true, attempts, edits: allEdits, test, summary };
    }

    log.warn(
      { attempt, applyFailures: applyResult.failures.length, testPassed: test?.passed ?? null },
      '適用またはテストに失敗したため再修正します',
    );
    feedback = { applyResult, test };
  }

  log.warn({ attempts: MAX_ATTEMPTS }, '最大試行回数に達しました');
  return { succeeded: false, attempts, edits: allEdits, test: lastTest, summary: lastSummary };
}

/** 影響を受けたファイルごとに、現在の内容と関連する破壊的変更をまとめる。 */
async function buildFileContexts(
  workspace: Workspace,
  affected: ImpactJudgement[],
  changesByLocation: Map<string, BreakingChange>,
  log: Logger,
): Promise<FileContext[]> {
  const byFile = new Map<string, FileContext>();

  for (const judgement of affected) {
    let context = byFile.get(judgement.file);
    if (!context) {
      let content: string;
      try {
        content = await workspace.readFile(judgement.file);
      } catch (error) {
        log.warn({ file: judgement.file, err: String(error) }, 'ファイルを読み込めませんでした');
        continue;
      }
      context = { file: judgement.file, content, judgements: [], changes: [] };
      byFile.set(judgement.file, context);
    }

    context.judgements.push(judgement);
    const change = changesByLocation.get(judgement.changeLocation);
    if (change && !context.changes.includes(change)) context.changes.push(change);
  }

  return [...byFile.values()];
}

/**
 * git のブランチ名として使える形に整える。
 *
 * @see https://git-scm.com/docs/git-check-ref-format
 */
function sanitizeRefSegment(value: string): string {
  const safe = value
    // 使用できない文字はまとめて 1 つのハイフンにする
    .replace(/[^A-Za-z0-9.-]+/g, '-')
    // 連続するドットと、先頭・末尾の記号は git が受け付けない
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
    // `.lock` で終わる参照名も拒否される
    .replace(/\.lock$/i, 'lock');
  return safe || 'unknown';
}

/**
 * `api-update/stripe-2026-07-29.dahlia-12` 形式のブランチ名を組み立てる。
 *
 * 末尾の差分 ID が無いと、API バージョンが変わらないまま仕様だけ更新される
 * プロバイダ（Twilio の `2010-04-01` など）で、別の破壊的変更が同じブランチ名に
 * なってしまう。差分 ID を含めることで、
 *
 *   - 異なる差分 → 必ず別ブランチ
 *   - 同じ差分の再実行 → 同じブランチ（やり直しとして扱える）
 *
 * という性質が得られる。
 */
export const buildBranchName = (provider: string, version: string, diffId: string): string =>
  `api-update/${sanitizeRefSegment(provider)}-${sanitizeRefSegment(version)}-${sanitizeRefSegment(diffId)}`;
