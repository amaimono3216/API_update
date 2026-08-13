import 'dotenv/config';

import { judgeImpact } from '../analyzer/llm-judge.js';
import type { ImpactCandidate } from '../analyzer/types.js';

/**
 * 実 API に対して ② 影響判定を 1 回だけ実行する（費用を抑えた確認用）。
 *
 *   npm run verify:llm:live
 *
 * モック検証では確認できない「実 API がこのパラメータの組み合わせを受理するか」
 * （`fallbacks: "default"` と `output_config.format` の併用など）を確かめる。
 */

if (!process.env['ANTHROPIC_API_KEY']) {
  console.error('ANTHROPIC_API_KEY が未設定です');
  process.exit(1);
}

const change = {
  kind: 'property_removed' as const,
  severity: 'breaking' as const,
  direction: 'request' as const,
  location: 'POST /v1/terminal/refunds requestBody.amount',
  propertyPath: 'amount',
  operations: [{ method: 'post' as const, path: '/v1/terminal/refunds' }],
  before: 'integer',
  after: undefined,
  message: 'リクエストボディから amount が削除されました',
};

/** 影響あり / 影響なし の 2 件だけ投げ、判定が分かれるかを見る。 */
const candidates: ImpactCandidate[] = [
  {
    change,
    match: 'direct',
    callSite: {
      file: 'src/refund.ts',
      line: 3,
      endLine: 8,
      provider: 'stripe',
      chain: ['stripe', 'terminal', 'refunds', 'create'],
      operation: { method: 'post', path: '/v1/terminal/refunds' },
      passedParams: ['charge', 'amount'],
      snippet: [
        'export async function refund(chargeId: string, amountJpy: number) {',
        '  return stripe.terminal.refunds.create({',
        '    charge: chargeId,',
        '    amount: amountJpy,',
        '  });',
        '}',
      ].join('\n'),
    },
  },
  {
    change,
    match: 'operation',
    callSite: {
      file: 'src/list.ts',
      line: 2,
      endLine: 4,
      provider: 'stripe',
      chain: ['stripe', 'terminal', 'refunds', 'create'],
      operation: { method: 'post', path: '/v1/terminal/refunds' },
      passedParams: ['payment_intent'],
      snippet: [
        'export async function refundByIntent(paymentIntentId: string) {',
        '  return stripe.terminal.refunds.create({ payment_intent: paymentIntentId });',
        '}',
      ].join('\n'),
    },
  },
];

const log = {
  info: (o: object, m: string) => console.log('INFO ', m, JSON.stringify(o)),
  warn: (o: object, m: string) => console.log('WARN ', m, JSON.stringify(o)),
};

console.log('実 API に ② 影響判定を 1 リクエスト送ります（候補 2 件）\n');
const startedAt = Date.now();
const sources = new Map([
  [
    'src/refund.ts',
    [
      "import { stripe } from './lib/stripe';",
      '',
      'export async function refund(chargeId: string, amountJpy: number) {',
      '  return stripe.terminal.refunds.create({',
      '    charge: chargeId,',
      '    amount: amountJpy,',
      '  });',
      '}',
      '',
    ].join('\n'),
  ],
  [
    'src/list.ts',
    [
      "import { stripe } from './lib/stripe';",
      '',
      'export async function refundByIntent(paymentIntentId: string) {',
      '  return stripe.terminal.refunds.create({ payment_intent: paymentIntentId });',
      '}',
      '',
    ].join('\n'),
  ],
]);

const judgements = await judgeImpact(candidates, sources, log);

console.log(`\n--- 応答（${((Date.now() - startedAt) / 1000).toFixed(1)} 秒） ---`);
for (const j of judgements) {
  console.log(`\n[${j.verdict}] ${j.file}:${j.line}`);
  console.log(`  理由    : ${j.reason}`);
  console.log(`  修正方針: ${j.suggestedFix || '(なし)'}`);
}

console.log('\n--- 期待する挙動 ---');
console.log('  src/refund.ts : amount を渡している → affected');
console.log('  src/list.ts   : amount を渡していない → not_affected');
