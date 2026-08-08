import type { AnalysisResult, ImpactJudgement } from '../analyzer/types.js';
import type { ProviderConfig } from '../detector/providers.js';
import type { BreakingChange, JsonValue } from '../detector/types.js';
import type { CodeEdit, FixResult } from '../fixer/types.js';
import { formatTestResult } from './test-summary.js';

export interface TemplateInput {
  provider: ProviderConfig;
  fromVersion: string | null;
  toVersion: string;
  detectedAt: Date;
  changes: BreakingChange[];
  analysis: AnalysisResult;
  fix: FixResult;
}

export interface PullRequestContent {
  title: string;
  body: string;
}

/** 仕様どおり `[API Auto-Update] Stripe API 変更に伴う自動修正` 形式にする。 */
export const buildTitle = (provider: ProviderConfig): string =>
  `[API Auto-Update] ${provider.displayName} 変更に伴う自動修正`;

/**
 * 開発者が安心してレビューできるよう、以下を必ず含めた PR 概要欄を生成する。
 *
 *   1. API 仕様の変更概要（出典つき）
 *   2. 影響を受けるファイルと修正内容
 *   3. テスト実行結果
 *   4. この修正の信頼性（試行回数・判定根拠・要確認事項）
 *
 * 「何を根拠に、何を変えたのか」が追跡できることを最優先にしている。
 */
export function buildPullRequestBody(input: TemplateInput): string {
  const sections = [
    '破壊的変更（Breaking Change）を検知したため、自動修正 PR を作成しました。',
    '',
    '> 🤖 このPRは自動生成されています。マージ前に内容をご確認ください。',
    '',
    buildChangeOverview(input),
    buildImpactSection(input),
    buildTestSection(input),
    buildReliabilitySection(input),
  ];

  return sections.join('\n');
}

/** 3-1. API 仕様の変更概要 */
function buildChangeOverview(input: TemplateInput): string {
  const { provider, fromVersion, toVersion, detectedAt, changes } = input;
  const versionRange = fromVersion ? `\`${fromVersion}\` → \`${toVersion}\`` : `\`${toVersion}\``;

  const lines = [
    '## 1. API 仕様の変更概要',
    '',
    `- **対象サービス**: ${provider.displayName} (${versionRange})`,
    `- **公式情報源**: [${provider.displayName} Changelog](${provider.changelogUrl})`,
    `- **検知日時**: ${formatDateTime(detectedAt)}`,
    '',
  ];

  if (changes.length === 0) {
    lines.push('（この修正に対応する破壊的変更の詳細を特定できませんでした）', '');
    return lines.join('\n');
  }

  lines.push('| 変更項目 | 変更前 (Before) | 変更後 (After) |', '| --- | --- | --- |');
  for (const change of changes) {
    lines.push(`| ${changeLabel(change)} | ${formatValue(change.before)} | ${formatValue(change.after)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** 3-2. 影響を受けるファイルと修正内容 */
function buildImpactSection(input: TemplateInput): string {
  const lines = ['## 2. 影響を受けるファイルと修正内容', ''];

  const judgementsByFile = groupBy(input.analysis.affected, (j) => j.file);
  const editsByFile = groupBy(input.fix.edits, (e) => e.file);
  const files = [...new Set([...judgementsByFile.keys(), ...editsByFile.keys()])].sort();

  if (files.length === 0) {
    lines.push('（修正対象のファイルはありません）', '');
    return lines.join('\n');
  }

  for (const file of files) {
    const judgements = judgementsByFile.get(file) ?? [];
    const edits = editsByFile.get(file) ?? [];
    lines.push(`### \`${file}\`${formatLines(judgements)}`, '');

    if (edits.length > 0) {
      for (const edit of edits) lines.push(`- ${edit.description}`);
    } else {
      lines.push('- （このファイルへの変更は適用されませんでした）');
    }

    if (judgements.length > 0) {
      lines.push('', '<details><summary>影響と判定した理由</summary>', '');
      for (const judgement of judgements) {
        lines.push(`- **L${judgement.line}**: ${judgement.reason}`);
      }
      lines.push('', '</details>');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 3-3. テスト実行結果 */
function buildTestSection(input: TemplateInput): string {
  const { test } = input.fix;
  const lines = [
    '## 3. テスト実行結果',
    '',
    `- **既存のユニットテスト**: ${formatTestResult(test)}`,
    `- **実行コマンド**: ${test ? `\`${test.command}\`` : '—'}`,
    '',
  ];

  if (test && !test.passed && test.output.trim()) {
    lines.push('<details><summary>テスト出力</summary>', '', '```', test.output.trim(), '```', '', '</details>', '');
  }
  return lines.join('\n');
}

/** 開発者の信頼度を上げるための補足。自動修正の限界を明示する。 */
function buildReliabilitySection(input: TemplateInput): string {
  const { analysis, fix } = input;
  const uncertain = analysis.judgements.filter((j) => j.verdict === 'uncertain');

  const lines = [
    '## 4. この修正の信頼性について',
    '',
    `- **修正の試行回数**: ${fix.attempts.length} 回${fix.attempts.length > 1 ? '（テスト失敗を受けて再修正しています）' : ''}`,
    `- **影響判定**: 検出した ${analysis.callSites} 箇所の API 呼び出しのうち、${analysis.affected.length} 箇所を「影響あり」と判定`,
  ];

  if (!analysis.judged) {
    lines.push('- ⚠️ **LLM による影響判定は実行されていません**（静的解析の結果のみに基づいています）');
  }
  if (!fix.succeeded) {
    lines.push('- ⚠️ **テストが通っていません**。マージ前に手動での確認・修正が必要です');
  }

  if (uncertain.length > 0) {
    lines.push('', `### 手動での確認をおすすめする箇所（${uncertain.length} 件）`, '');
    lines.push('影響の有無を自動で判断できなかったため、この PR では変更していません。', '');
    for (const judgement of uncertain.slice(0, 10)) {
      lines.push(`- \`${judgement.file}:${judgement.line}\` — ${judgement.reason}`);
    }
    if (uncertain.length > 10) lines.push(`- ほか ${uncertain.length - 10} 件`);
  }

  lines.push('', '---', '', '🤖 このPRは api-update（API 破壊的変更の自動追随システム）が生成しました。');
  return lines.join('\n');
}

/** 変更項目の表示名。操作とプロパティが分かる形にする。 */
function changeLabel(change: BreakingChange): string {
  const operation = change.operations[0];
  const scope = operation ? `\`${operation.method.toUpperCase()} ${operation.path}\`` : '';
  if (change.propertyPath) {
    return scope ? `${scope} の \`${change.propertyPath}\`` : `\`${change.propertyPath}\``;
  }
  return scope || change.location;
}

/** 表のセルに収まるよう値を整形する。 */
function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) return '（削除）';
  if (value === null) return '`null`';
  if (typeof value === 'object') {
    const json = JSON.stringify(value);
    return `\`${json.length > 80 ? `${json.slice(0, 77)}…` : json}\``;
  }
  return `\`${String(value)}\``;
}

const formatLines = (judgements: ImpactJudgement[]): string => {
  if (judgements.length === 0) return '';
  const lines = [...new Set(judgements.map((j) => j.line))].sort((a, b) => a - b);
  const first = lines[0];
  const last = lines[lines.length - 1];
  return first === last ? ` (L${first})` : ` (L${first}-L${last})`;
};

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const group = map.get(key(item)) ?? [];
    group.push(item);
    map.set(key(item), group);
  }
  return map;
}

/** 日本時間で表示する（運用者が読む前提のため）。 */
function formatDateTime(date: Date): string {
  const formatted = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
  return `${formatted} JST`;
}

export type { CodeEdit };
