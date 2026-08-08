import type { BreakingChange, OperationRef } from '../detector/types.js';

/** コード中で検出した SDK 呼び出し 1 箇所。 */
export interface CallSite {
  /** リポジトリルートからの相対パス */
  file: string;
  line: number;
  endLine: number;
  provider: string;
  /** 呼び出しチェーン。例: `['stripe', 'checkout', 'sessions', 'create']` */
  chain: string[];
  /** 解決できた OpenAPI 操作。SDK の命名規則から導けなかった場合は undefined */
  operation?: OperationRef;
  /**
   * 第一引数のオブジェクトリテラルで渡しているプロパティのパス。
   * `line_items.[].amount` のように、スキーマ差分と同じ表記に揃える。
   */
  passedParams: string[];
  snippet: string;
}

/** 破壊的変更 1 件と、それに影響される可能性のある呼び出し箇所の組。 */
export interface ImpactCandidate {
  change: BreakingChange;
  callSite: CallSite;
  /**
   * `direct`   … 変更されたプロパティを実際に渡している（ほぼ確実に影響あり）
   * `operation`… 同じ操作を呼んでいるが、当該プロパティは見えていない
   */
  match: 'direct' | 'operation';
}

export type Verdict = 'affected' | 'not_affected' | 'uncertain';

/** LLM による最終判定。③ 修正モジュールへの入力になる。 */
export interface ImpactJudgement {
  file: string;
  line: number;
  changeLocation: string;
  verdict: Verdict;
  /** 判定理由（日本語）。PR 概要欄にそのまま転記できる粒度で書かせる。 */
  reason: string;
  /** 必要な修正の方針。`not_affected` の場合は空文字。 */
  suggestedFix: string;
}

export interface AnalysisResult {
  repository: string;
  diffId: string;
  scannedFiles: number;
  callSites: number;
  candidates: number;
  /** LLM 判定を実行したか（API キー未設定時は false） */
  judged: boolean;
  affected: ImpactJudgement[];
  /** 影響なしと判定されたものを含む全判定 */
  judgements: ImpactJudgement[];
}
