import { z } from 'zod';

/**
 * 再現テストのケース定義。
 *
 * 「過去に実際に起きた破壊的変更」と「その SDK を使っている実在のリポジトリ」を組にして、
 * ② 影響範囲特定モジュールの判定精度を測る。
 */
export const CaseSchema = z.object({
  id: z.string(),
  description: z.string(),
  provider: z.enum(['stripe', 'openai', 'twilio', 'slack']),

  /** 比較する 2 つのスペック。git の ref または完全な URL で指定する。 */
  spec: z.object({
    from: z.string(),
    to: z.string(),
  }),

  /** 対象リポジトリ。`ref` を省略すると既定ブランチの先端を使う。 */
  repository: z.object({
    url: z.url(),
    ref: z.string().optional(),
    /** 走査対象を絞る（モノレポの一部だけを見る場合）。 */
    subdirectory: z.string().optional(),
  }),

  /**
   * 期待する判定。人手で確認した内容を書く。
   *
   * 自動で正解を作らないのは、誤った正解データは測定そのものを無意味にするため。
   * 未記入のケースも「何が検出されたか」の観察には使える。
   */
  expected: z
    .object({
      /** 影響ありと判定されるべきファイル。 */
      affectedFiles: z.array(z.string()).default([]),
      /** 影響なしと判定されるべきファイル（呼び出しはあるが当該変更の影響は受けない）。 */
      notAffectedFiles: z.array(z.string()).default([]),
    })
    .optional(),
});

export type BacktestCase = z.infer<typeof CaseSchema>;

export const CaseFileSchema = z.object({ cases: z.array(CaseSchema) });

export interface CaseResult {
  case: BacktestCase;
  /** 実行できなかった場合の理由。 */
  error?: string;

  breakingChanges: number;
  scannedFiles: number;
  callSites: number;
  candidates: number;
  directMatches: number;
  /** 候補の内訳（`file:line` と対象の操作・項目）。expected を書くための手がかり。 */
  candidateSummaries: string[];

  /** LLM 判定を行った場合のみ。 */
  judged: boolean;
  affectedFiles: string[];
  notAffectedFiles: string[];
  uncertainFiles: string[];

  /** 期待と突き合わせた結果。expected が無い場合は undefined。 */
  score?: {
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    /** 影響なしと分かっているものを正しく除外した数（＝回避できた不要な PR）。 */
    trueNegatives: number;
  };

  durationMs: number;
}
