import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import { env } from '../config/env.js';
import type { ImpactCandidate, ImpactJudgement, Verdict } from './types.js';

const MODEL = 'claude-opus-5';
/** 1 リクエストで判定する候補の上限。多すぎると 1 件あたりの判定が雑になる。 */
const BATCH_SIZE = 12;
/** 1 ファイルあたりに渡すソースの上限。 */
const MAX_FILE_CHARS = 20_000;

const ResponseSchema = z.object({
  judgements: z.array(
    z.object({
      candidateId: z.string(),
      verdict: z.enum(['affected', 'not_affected', 'uncertain']),
      reason: z.string(),
      suggestedFix: z.string(),
    }),
  ),
});

const SYSTEM_PROMPT = `あなたは Stripe / OpenAI API の破壊的変更が、既存コードに実際の影響を与えるかを判定する専門家です。

与えられるもの:
- API 仕様の破壊的変更（変更種別・変更前後・影響する API 操作）
- 呼び出し箇所を含むファイルの内容（行番号つき）

判定基準:
- affected: この変更によりコードが壊れる、または意図しない挙動になる。修正が必要。
- not_affected: 変更されたフィールドをこのコードは使っておらず、修正は不要。
- uncertain: コード断片だけでは判断できない（変数経由でパラメータを組み立てている等）。

重要な原則:
- 削除・型変更されたフィールドをコードが実際に渡している、または読んでいる場合のみ affected とすること。
- 同じエンドポイントを呼んでいるだけで、当該フィールドに一切触れていなければ not_affected。
- 不要な修正 PR を防ぐことが目的であり、確信が持てない場合は affected ではなく uncertain を選ぶこと。

出力:
- reason は日本語で 1〜2 文。そのまま PR の説明欄に転記できる具体性で書くこと。
- suggestedFix は affected の場合のみ、修正方針を日本語 1 文で書く。それ以外は空文字。`;

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export const isJudgeAvailable = (): boolean => Boolean(env.ANTHROPIC_API_KEY);

/**
 * ③ Fix Agent を無駄に起動しないため、候補が本当に影響を受けるかを LLM で判定する。
 * API キーが未設定の場合は判定せず、全件 `uncertain` として返す。
 */
export async function judgeImpact(
  candidates: ImpactCandidate[],
  sources: Map<string, string>,
  log: Logger,
): Promise<ImpactJudgement[]> {
  if (candidates.length === 0) return [];
  if (!isJudgeAvailable()) {
    log.warn({ candidates: candidates.length }, 'ANTHROPIC_API_KEY 未設定のため LLM 判定をスキップしました');
    return candidates.map((c) => toJudgement(c, 'uncertain', 'LLM 判定が未実行のため要確認です。', ''));
  }

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const judgements: ImpactJudgement[] = [];

  for (let offset = 0; offset < candidates.length; offset += BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + BATCH_SIZE);
    judgements.push(...(await judgeBatch(client, batch, sources, log)));
  }
  return judgements;
}

async function judgeBatch(
  client: Anthropic,
  batch: ImpactCandidate[],
  sources: Map<string, string>,
  log: Logger,
): Promise<ImpactJudgement[]> {
  const idOf = (index: number): string => `c${index}`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    // 安全性分類器による拒否時に自動でフォールバックさせる（コード解析は誤検知の余地があるため）
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: zodOutputFormat(ResponseSchema),
    },
    messages: [{ role: 'user', content: buildPrompt(batch, idOf, sources) }],
  });

  logUsage(log, response.usage, 'judge');

  if (response.stop_reason === 'refusal') {
    log.warn({ category: response.stop_details?.category }, 'LLM が判定を拒否しました');
    return batch.map((c) => toJudgement(c, 'uncertain', 'LLM が判定を拒否したため要確認です。', ''));
  }

  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const parsed = ResponseSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    log.warn({ error: parsed.error.message }, 'LLM 応答の形式が不正でした');
    return batch.map((c) => toJudgement(c, 'uncertain', 'LLM 応答を解釈できなかったため要確認です。', ''));
  }

  const byId = new Map(parsed.data.judgements.map((j) => [j.candidateId, j]));
  return batch.map((candidate, index) => {
    const judgement = byId.get(idOf(index));
    if (!judgement) return toJudgement(candidate, 'uncertain', 'LLM が判定を返しませんでした。', '');
    return toJudgement(candidate, judgement.verdict, judgement.reason, judgement.suggestedFix);
  });
}

function buildPrompt(
  batch: ImpactCandidate[],
  idOf: (index: number) => string,
  sources: Map<string, string>,
): string {
  const sections: string[] = [];

  // 呼び出し箇所の抜粋だけでは、パラメータを別の関数で組み立てている場合に
  // 判断材料が足りない。ファイル全体を 1 度だけ載せ、候補からは行番号で参照する。
  const files = [...new Set(batch.map((c) => c.callSite.file))];
  const available = files.filter((file) => sources.has(file));

  if (available.length > 0) {
    sections.push('# 対象ファイルの内容', '');
    for (const file of available) {
      sections.push(`## ${file}`, '', '```', withLineNumbers(truncate(sources.get(file) as string)), '```', '');
    }
  }

  sections.push('# 判定する候補', '');
  for (const [index, candidate] of batch.entries()) {
    const { change, callSite, match } = candidate;
    sections.push(
      `## 候補 ${idOf(index)}`,
      '',
      '### API の破壊的変更',
      `- 種別: ${change.kind}`,
      `- 方向: ${change.direction === 'request' ? 'リクエスト（送信側）' : change.direction === 'response' ? 'レスポンス（受信側）' : '双方'}`,
      `- 内容: ${change.message}`,
      `- 変更前: ${JSON.stringify(change.before)}`,
      `- 変更後: ${JSON.stringify(change.after)}`,
      change.propertyPath ? `- 対象プロパティ: ${change.propertyPath}` : '',
      '',
      '### 呼び出し箇所',
      `- ファイル: ${callSite.file}:${callSite.line}`,
      `- 呼び出し: ${callSite.chain.join('.')}`,
      `- 対応する操作: ${callSite.operation ? `${callSite.operation.method.toUpperCase()} ${callSite.operation.path}` : '不明'}`,
      `- 静的解析の突合結果: ${match === 'direct' ? '変更されたプロパティを実際に渡している' : '同じ操作を呼んでいるが当該プロパティは未検出'}`,
      '',
    );

    // ファイル全体を載せられない場合のみ、従来どおり抜粋を添える
    if (!sources.has(callSite.file)) {
      sections.push('```', callSite.snippet, '```', '');
    }
  }

  return [
    `以下の ${batch.length} 件の候補それぞれについて、影響の有無を判定してください。`,
    '',
    ...sections.filter((line) => line !== ''),
  ].join('\n');
}

/** 行番号を付けて、候補が指す行と対応づけられるようにする。 */
const withLineNumbers = (content: string): string =>
  content
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join('\n');

/** 巨大なファイルは判定に必要な範囲を超えるため上限を設ける。 */
const truncate = (content: string): string =>
  content.length > MAX_FILE_CHARS ? `${content.slice(0, MAX_FILE_CHARS)}\n…（以降省略）` : content;

/** 実運用で費用を追えるよう、トークン使用量を残す。 */
export function logUsage(
  log: { info: (obj: object, msg: string) => void },
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null } | undefined,
  phase: string,
): void {
  if (!usage) return;
  log.info(
    {
      phase,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    },
    'LLM のトークン使用量',
  );
}

const toJudgement = (
  candidate: ImpactCandidate,
  verdict: Verdict,
  reason: string,
  suggestedFix: string,
): ImpactJudgement => ({
  file: candidate.callSite.file,
  line: candidate.callSite.line,
  changeLocation: candidate.change.location,
  verdict,
  reason,
  suggestedFix,
});
