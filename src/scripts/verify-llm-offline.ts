import 'dotenv/config';

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * LLM 連携を課金なしで検証する。
 *
 * Anthropic SDK の接続先をローカルのモックサーバへ向け、②影響判定と③修正案生成を
 * 実際に SDK 経由で往復させる。これにより次を確認できる。
 *
 *   - リクエストの組み立て（モデル・beta ヘッダ・output_config・thinking・prompt caching）
 *   - 構造化出力の受け取りと zod による検証
 *   - ストリーミング応答の処理（③ は streaming を使う）
 *   - 拒否（refusal）時のフォールバック挙動
 *
 * 確認できないのは「実 API がこのパラメータ組み合わせを受理するか」だけ。
 *
 *   npm run verify:llm
 */

interface CapturedRequest {
  path: string;
  betaHeader: string | undefined;
  body: Record<string, unknown>;
}

const captured: CapturedRequest[] = [];

/** 応答の中身。テストしたいシナリオに応じて差し替える。 */
let nextResponse: { text: string } | { refusal: string } = { text: '{}' };

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });

/** 非ストリーミング応答。 */
function sendMessage(res: ServerResponse, text: string, refusal?: string): void {
  const body = {
    id: 'msg_mock_01',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: refusal ? [] : [{ type: 'text', text }],
    stop_reason: refusal ? 'refusal' : 'end_turn',
    stop_sequence: null,
    ...(refusal ? { stop_details: { type: 'refusal', category: refusal, explanation: 'mock' } } : {}),
    usage: { input_tokens: 1200, output_tokens: 300 },
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** ストリーミング応答（③ の修正案生成が使う経路）。 */
function sendStream(res: ServerResponse, text: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_mock_stream',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2400, output_tokens: 0 },
    },
  });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  // 実際の応答と同様、複数チャンクに分割して送る
  for (let i = 0; i < text.length; i += 120) {
    send('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: text.slice(i, i + 120) },
    });
  }

  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 640 },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

const server = createServer((req, res) => {
  void (async () => {
    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    captured.push({
      path: req.url ?? '',
      betaHeader: req.headers['anthropic-beta'] as string | undefined,
      body,
    });

    if ('refusal' in nextResponse) {
      sendMessage(res, '', nextResponse.refusal);
      return;
    }
    if (body['stream'] === true) sendStream(res, nextResponse.text);
    else sendMessage(res, nextResponse.text);
  })();
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

// SDK が読む環境変数を、対象モジュールの読み込み前に差し替える
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
process.env.ANTHROPIC_API_KEY = 'sk-ant-mock-key-for-offline-verification';

console.log(`モック Anthropic API を起動しました: ${process.env.ANTHROPIC_BASE_URL}\n`);

// env.ts は読み込み時に検証されるため、差し替え後に動的 import する
const { judgeImpact } = await import('../analyzer/llm-judge.js');
const { requestEdits } = await import('../fixer/fix-agent.js');

const log = {
  info: (o: object, m: string) => console.log('  INFO ', m, JSON.stringify(o)),
  warn: (o: object, m: string) => console.log('  WARN ', m, JSON.stringify(o)),
};

const change = {
  kind: 'property_removed' as const,
  severity: 'breaking' as const,
  direction: 'request' as const,
  location: 'POST /v1/terminal/refunds requestBody.amount',
  propertyPath: 'amount',
  operations: [{ method: 'post' as const, path: '/v1/terminal/refunds' }],
  before: 'integer',
  after: undefined,
  message: 'amount が削除されました',
};

const callSite = {
  file: 'src/refund.js',
  line: 14,
  endLine: 18,
  provider: 'stripe',
  chain: ['stripe', 'terminal', 'refunds', 'create'],
  operation: { method: 'post' as const, path: '/v1/terminal/refunds' },
  passedParams: ['charge', 'amount', 'reason'],
  snippet: 'stripe.terminal.refunds.create({ charge: chargeId, amount: amountJpy })',
};

// --- ② 影響判定 -----------------------------------------------------------
console.log('=== ② 影響判定（非ストリーミング + 構造化出力） ===');
nextResponse = {
  text: JSON.stringify({
    judgements: [
      {
        candidateId: 'c0',
        verdict: 'affected',
        reason: '`amount` を渡していますが、このパラメータは削除されました。',
        suggestedFix: '`payment_intent` ベースの指定へ置き換える。',
      },
    ],
  }),
};

const judgements = await judgeImpact([{ change, callSite, match: 'direct' }], log);
console.log('  受け取った判定:', JSON.stringify(judgements, null, 2).split('\n').slice(0, 8).join('\n  '));

// --- ③ 修正案生成 ---------------------------------------------------------
console.log('\n=== ③ 修正案生成（ストリーミング + 構造化出力） ===');
nextResponse = {
  text: JSON.stringify({
    summary: '削除された `amount` を取り除きました。',
    edits: [
      {
        file: 'src/refund.js',
        oldString: '    amount: amountJpy,\n',
        newString: '',
        description: '削除された `amount` を除去',
      },
    ],
  }),
};

const edits = await requestEdits(
  {
    provider: 'stripe',
    fromVersion: '2026-03-25.dahlia',
    toVersion: '2026-07-29.dahlia',
    files: [
      {
        file: 'src/refund.js',
        content: 'export function buildRefundParams(chargeId, amountJpy) {\n  return { charge: chargeId, amount: amountJpy };\n}\n',
        judgements,
        changes: [change],
      },
    ],
  },
  log,
);
console.log('  要約:', edits.summary);
console.log('  編集:', edits.edits.map((e) => `${e.file} — ${e.description}`).join(' / '));

// --- 拒否時の挙動 ---------------------------------------------------------
console.log('\n=== 安全性分類器による拒否時の挙動（② のみ確認） ===');
nextResponse = { refusal: 'cyber' };
const refused = await judgeImpact([{ change, callSite, match: 'direct' }], log);
console.log('  判定:', refused[0]?.verdict, '/', refused[0]?.reason);

// --- 送信内容の検証 -------------------------------------------------------
console.log('\n=== 実際に送信されたリクエスト ===');
captured.forEach((req, i) => {
  const b = req.body;
  const outputConfig = b['output_config'] as Record<string, unknown> | undefined;
  const system = b['system'] as { cache_control?: unknown }[] | undefined;
  console.log(`\n[${i + 1}] ${req.path}`);
  console.log(`  model            : ${b['model']}`);
  console.log(`  max_tokens       : ${b['max_tokens']}`);
  console.log(`  stream           : ${b['stream'] ?? false}`);
  console.log(`  anthropic-beta   : ${req.betaHeader ?? '(なし)'}`);
  console.log(`  fallbacks        : ${JSON.stringify(b['fallbacks'])}`);
  console.log(`  thinking         : ${JSON.stringify(b['thinking'])}`);
  console.log(`  effort           : ${outputConfig?.['effort']}`);
  console.log(`  出力スキーマ指定 : ${outputConfig?.['format'] ? 'あり' : 'なし'}`);
  console.log(`  system の cache_control: ${system?.[0]?.cache_control ? 'あり' : 'なし'}`);
});

server.close();
console.log('\nモックサーバを停止しました。');
