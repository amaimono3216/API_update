import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { logUsage } from '../analyzer/llm-judge.js';
import { env } from '../config/env.js';
import type { BreakingChange } from '../detector/types.js';
import type { ImpactJudgement } from '../analyzer/types.js';
import type { CodeEdit, EditApplyResult, TestResult } from './types.js';

const MODEL = 'claude-opus-5';
/** コーディング用途では effort=xhigh が推奨されるため、出力欄も広く取りストリーミングで受ける。 */
const MAX_TOKENS = 64_000;
/** 1 ファイルあたりに渡すソースの上限。超える場合は該当箇所の周辺のみ渡す。 */
const MAX_FILE_CHARS = 40_000;

const ResponseSchema = z.object({
  summary: z.string(),
  edits: z.array(
    z.object({
      file: z.string(),
      oldString: z.string(),
      newString: z.string(),
      description: z.string(),
    }),
  ),
});

const SYSTEM_PROMPT = `あなたは Stripe / OpenAI API の破壊的変更に追随するコード修正を行う専門家です。

与えられた「API の破壊的変更」と「影響を受けるファイルの現在の内容」をもとに、
コードが新しい API 仕様で正しく動作するよう修正してください。

編集の指定方法:
- oldString / newString による完全一致置換で指定します。
- oldString は対象ファイル内に**厳密に 1 箇所だけ**一致する必要があります。
  一意にならない場合は、前後の行を含めて範囲を広げてください。
- oldString はインデント・空白・改行を含め、ファイルの内容と 1 文字も違わないようにしてください。
- 1 つの編集は 1 つの意味のあるまとまりにし、file には与えられたパスをそのまま使ってください。

修正方針:
- 破壊的変更に対応するために必要な最小限の変更に留めること。
- リファクタリング、書式変更、コメントの整理、無関係な改善は一切行わないこと。
- 周囲のコードのスタイル（命名・インデント・引用符・コメントの粒度）に合わせること。
- 削除されたフィールドに代替がある場合は置き換え、無い場合は呼び出しから取り除くこと。
- 型が変わった場合は、値の変換も含めて辻褄が合うようにすること。
- テスト失敗のフィードバックがある場合は、その原因を特定して直すこと。
  テストコード自体が古い仕様を前提にしているなら、テストコードも修正対象とすること。

summary には、何をどう変えたかを日本語 1〜3 文で書いてください。PR の概要欄に転記します。`;

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** 1 ファイル分の修正コンテキスト。 */
export interface FileContext {
  file: string;
  content: string;
  judgements: ImpactJudgement[];
  changes: BreakingChange[];
}

export interface EditRequest {
  provider: string;
  fromVersion: string | null;
  toVersion: string;
  files: FileContext[];
  /** 前回の試行結果。初回は undefined。 */
  feedback?: { applyResult: EditApplyResult; test: TestResult | null };
}

export const isFixAgentAvailable = (): boolean => Boolean(env.ANTHROPIC_API_KEY);

/** LLM に修正案（編集の集合）を生成させる。 */
export async function requestEdits(
  request: EditRequest,
  log: Logger,
): Promise<{ edits: CodeEdit[]; summary: string }> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });

  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'xhigh', format: zodOutputFormat(ResponseSchema) },
    messages: [{ role: 'user', content: buildPrompt(request) }],
  });

  const message = await stream.finalMessage();
  logUsage(log, message.usage, 'fix');

  if (message.stop_reason === 'refusal') {
    throw new Error(`LLM が修正を拒否しました (${message.stop_details?.category ?? '理由不明'})`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error('LLM の出力が上限に達しました。対象ファイルを分割してください');
  }

  const text = message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = ResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`LLM 応答の形式が不正です: ${parsed.error.message}`);

  log.info({ edits: parsed.data.edits.length }, 'LLM が修正案を生成しました');
  return parsed.data;
}

function buildPrompt(request: EditRequest): string {
  const sections: string[] = [
    `# 対象: ${request.provider} API`,
    `変更前バージョン: ${request.fromVersion ?? '不明'} → 変更後バージョン: ${request.toVersion}`,
    '',
  ];

  for (const file of request.files) {
    sections.push(`# ファイル: ${file.file}`, '', '## このファイルに影響する破壊的変更', '');

    for (const change of file.changes) {
      sections.push(
        `- ${change.message}`,
        `  - 種別: ${change.kind} / 方向: ${change.direction}`,
        change.propertyPath ? `  - 対象プロパティ: ${change.propertyPath}` : '',
        `  - 変更前: ${JSON.stringify(change.before)} → 変更後: ${JSON.stringify(change.after)}`,
      );
    }

    sections.push('', '## 影響判定（② 影響範囲特定モジュールの出力）', '');
    for (const judgement of file.judgements) {
      sections.push(`- ${file.file}:${judgement.line} ${judgement.reason}`, `  - 修正方針: ${judgement.suggestedFix}`);
    }

    sections.push('', '## 現在のファイル内容', '', '```', truncate(file.content), '```', '');
  }

  if (request.feedback) {
    sections.push('# 前回の試行結果', '');

    const { applyResult, test } = request.feedback;
    if (applyResult.failures.length > 0) {
      sections.push('## 適用できなかった編集', '');
      for (const { edit, reason } of applyResult.failures) {
        sections.push(`- ${edit.file}: ${reason}`, '  - 指定された oldString:', '```', truncate(edit.oldString, 2_000), '```');
      }
      sections.push('');
    }
    if (test && !test.passed) {
      sections.push(
        '## テスト実行結果（失敗）',
        '',
        `コマンド: \`${test.command}\` / 終了コード: ${test.exitCode}${test.timedOut ? ' (タイムアウト)' : ''}`,
        '',
        '```',
        test.output,
        '```',
        '',
        '上記の失敗原因を特定し、修正してください。ファイル内容は前回の編集を反映した最新の状態です。',
      );
    }
  }

  return sections.filter((line) => line !== '').join('\n');
}

const truncate = (text: string, limit = MAX_FILE_CHARS): string =>
  text.length > limit ? `${text.slice(0, limit)}\n…（以降省略）` : text;
