import type { AnalysisResult } from '../analyzer/types.js';
import { findDiffById } from '../db/diffs.js';
import { updateRun } from '../db/runs.js';
import { isFixAgentAvailable } from './fix-agent.js';
import { buildBranchName, runFixLoop, type EditGenerator } from './fix-loop.js';
import { detectInstallCommand, detectTestCommand, runCommand } from './test-runner.js';
import type { FixResult } from './types.js';
import { Workspace } from './workspace.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface FixOptions {
  /** 依存関係のインストールを試みるか。オフラインで検証したい場合は false。 */
  installDependencies?: boolean;
  /** 作業ディレクトリを残すか（④ PR 生成へ引き渡す場合など）。既定では削除する。 */
  keepWorkdir?: boolean;
  /** 修正案の生成器。既定は LLM。 */
  generateEdits?: EditGenerator;
}

/**
 * ③ AI コード自動修正 & テスト検証モジュールのエントリポイント。
 *
 * 作業ブランチを切り、② が影響ありと判定した箇所を修正し、
 * リポジトリ既存のテストで検証したうえで diff を返す。
 */
export async function fix(
  runId: string,
  analysis: AnalysisResult,
  repositoryPath: string,
  log: Logger,
  options: FixOptions = {},
): Promise<FixResult> {
  if (!options.generateEdits && !isFixAgentAvailable()) {
    throw new Error('ANTHROPIC_API_KEY が未設定のため修正を実行できません');
  }
  if (analysis.affected.length === 0) throw new Error('影響を受ける箇所がないため修正は不要です');

  const diff = await findDiffById(analysis.diffId);
  if (!diff) throw new Error(`差分が見つかりません: ${analysis.diffId}`);

  const branch = buildBranchName(diff.provider, diff.to_version);
  const workspace = await Workspace.create(repositoryPath, branch);
  log.info({ branch, workdir: workspace.dir }, '作業ブランチを作成しました');

  try {
    await updateRun(runId, { status: 'fixing' });

    if (options.installDependencies !== false) await installDependencies(workspace.dir, log);

    const testCommand = await detectTestCommand(workspace.dir);
    if (!testCommand) log.warn({}, 'テストコマンドを検出できませんでした。修正のみ行い検証はスキップします');

    const loop = await runFixLoop(
      workspace,
      {
        provider: diff.provider,
        fromVersion: diff.from_version,
        toVersion: diff.to_version,
        affected: analysis.affected,
        changesByLocation: new Map(diff.changes.map((c) => [c.location, c])),
        testCommand,
        ...(options.generateEdits ? { generateEdits: options.generateEdits } : {}),
      },
      log,
    );

    await workspace.commitAll(
      `fix: ${diff.provider} API (${diff.to_version}) の破壊的変更に追随\n\n${
        loop.succeeded ? loop.summary : `${loop.summary}\n\n(テスト未通過)`
      }`,
    );

    const result: FixResult = {
      branch,
      succeeded: loop.succeeded,
      attempts: loop.attempts,
      edits: loop.edits,
      test: loop.test,
      diff: await workspace.diff(),
      workdir: workspace.dir,
    };

    await updateRun(runId, { status: loop.succeeded ? 'fixed' : 'failed', fix: toFixSummary(result) });
    if (!options.keepWorkdir) await workspace.dispose();
    return result;
  } catch (error) {
    await updateRun(runId, { status: 'failed', error: String(error) });
    if (!options.keepWorkdir) await workspace.dispose();
    throw error;
  }
}

/** DB には diff 本体を含めない要約だけを残す（巨大化を避けるため）。 */
const toFixSummary = (result: FixResult) => ({
  branch: result.branch,
  succeeded: result.succeeded,
  attempts: result.attempts.length,
  edits: result.edits.map((e) => ({ file: e.file, description: e.description })),
  test: result.test
    ? { command: result.test.command, passed: result.test.passed, exitCode: result.test.exitCode }
    : null,
});

async function installDependencies(dir: string, log: Logger): Promise<void> {
  const install = await detectInstallCommand(dir);
  if (!install) return;

  const result = await runCommand(dir, install);
  // 依存解決に失敗してもテスト実行まで進め、実際の失敗内容を LLM に見せる
  if (!result.passed) {
    log.warn({ command: result.command, exitCode: result.exitCode }, '依存関係のインストールに失敗しました');
  }
}
