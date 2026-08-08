/** LLM に生成させる 1 件の編集。文字列の完全一致置換で適用する。 */
export interface CodeEdit {
  file: string;
  /** 置換前の文字列。ファイル内に厳密に 1 箇所だけ存在する必要がある。 */
  oldString: string;
  newString: string;
  /** この編集が何をしたかの説明（日本語）。PR 概要欄に転記する。 */
  description: string;
}

export interface EditApplyResult {
  applied: CodeEdit[];
  /** 適用できなかった編集とその理由。LLM へのフィードバックに使う。 */
  failures: { edit: CodeEdit; reason: string }[];
}

export interface TestResult {
  /** テストコマンドが定義されていない場合は false */
  executed: boolean;
  passed: boolean;
  command: string;
  exitCode: number | null;
  /** 標準出力・標準エラーの末尾（LLM へのフィードバック用に切り詰め済み） */
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface FixAttempt {
  attempt: number;
  edits: CodeEdit[];
  applyFailures: number;
  test: TestResult | null;
  summary: string;
}

export interface FixResult {
  branch: string;
  /** 最終的にテストが通った（またはテスト未定義で編集が完了した）か */
  succeeded: boolean;
  attempts: FixAttempt[];
  /** 最終的に適用された編集 */
  edits: CodeEdit[];
  test: TestResult | null;
  /** 作業ブランチの diff。④ PR 生成モジュールが利用する。 */
  diff: string;
  workdir: string;
}
