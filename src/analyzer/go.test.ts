import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import type { OpenApiDocument } from '../detector/types.js';
import { scanGoFiles } from './scan-go.js';
import { OperationIndex, pluralCandidates, SDK_CONVENTIONS, splitPascalCase } from './sdk-map.js';

/** 解析用バイナリが無い環境（開発マシンなど）ではスキップする。 */
const extractorAvailable =
  spawnSync(process.env['GO_EXTRACT_BIN'] ?? 'go-extract', [], { input: '{"files":[]}', shell: false }).status === 0;
const skip = extractorAvailable ? false : 'go-extract が利用できないためスキップします';

const spec: OpenApiDocument = {
  openapi: '3.0.0',
  paths: {
    '/v1/customers': { post: {}, get: {} },
    '/v1/customers/{customer}': { get: {} },
    '/v1/checkout/sessions': { post: {} },
    '/v1/payment_intents': { post: {} },
    '/chat/completions': { post: {} },
  },
  components: { schemas: {} },
};

const index = new OperationIndex(spec);
const silentLog = { warn: () => {} };
const scan = (path: string, content: string) => scanGoFiles([{ path, content }], index, silentLog);

describe('splitPascalCase', () => {
  it('数字を直前の語に含める', () => {
    assert.deepEqual(splitPascalCase('V1Customers'), ['V1', 'Customers']);
    assert.deepEqual(splitPascalCase('V1PaymentIntents'), ['V1', 'Payment', 'Intents']);
  });

  it('連続する大文字を 1 語にまとめる', () => {
    assert.deepEqual(splitPascalCase('HTTPProxy'), ['HTTP', 'Proxy']);
  });
});

describe('pluralCandidates', () => {
  it('英語の複数形の候補を出す', () => {
    // 1 つに決めず候補を出し、実スペックに存在するものを採る
    assert.ok(pluralCandidates('Message').includes('Messages'));
    assert.ok(pluralCandidates('Address').includes('Addresses'));
    assert.ok(pluralCandidates('Country').includes('Countries'));
    // 既に複数形・不可算のものはそのままも候補に含める
    assert.ok(pluralCandidates('Media').includes('Media'));
  });
});

describe('Twilio Go / Slack Go の対応づけ', () => {
  const twilioIndex = new OperationIndex({
    openapi: '3.0.1',
    paths: {
      '/2010-04-01/Accounts.json': { post: {} },
      '/2010-04-01/Accounts/{AccountSid}/Messages.json': { post: {}, get: {} },
      '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json': { get: {}, delete: {} },
      '/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Feedback.json': { post: {} },
      '/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json': { get: {} },
      '/2010-04-01/Accounts/{AccountSid}/Addresses.json': { get: {} },
    },
    components: { schemas: {} },
  });
  const slackIndex = new OperationIndex({
    openapi: '3.0.0',
    paths: { '/chat.postMessage': { post: {} }, '/users.info': { get: {} } },
    components: { schemas: {} },
  });

  const twilioGo = SDK_CONVENTIONS.find((c) => c.language === 'go' && c.provider === 'twilio')!;
  const slackGo = SDK_CONVENTIONS.find((c) => c.language === 'go' && c.provider === 'slack')!;

  it('動詞とリソース単数形からパスを組み立てる', () => {
    assert.deepEqual(twilioGo.resolve(['Api', 'CreateMessage'], twilioIndex), {
      method: 'post',
      path: '/2010-04-01/Accounts/{AccountSid}/Messages.json',
    });
    assert.equal(
      twilioGo.resolve(['Api', 'FetchMessage'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json',
    );
    assert.equal(twilioGo.resolve(['Api', 'DeleteMessage'], twilioIndex)?.method, 'delete');
  });

  it('不規則な複数形も実スペックで判別する', () => {
    assert.equal(
      twilioGo.resolve(['Api', 'ListAddress'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/Addresses.json',
    );
    assert.equal(
      twilioGo.resolve(['Api', 'ListIncomingPhoneNumber'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json',
    );
  });

  it('親子リソースの区切りを実スペックで判別する', () => {
    // `MessageFeedback` が 1 リソースか親子かは名前から決まらない
    assert.equal(
      twilioGo.resolve(['Api', 'CreateMessageFeedback'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/Messages/{MessageSid}/Feedback.json',
    );
  });

  it('WithMetadata 派生も同じ操作として扱う', () => {
    assert.equal(
      twilioGo.resolve(['Api', 'CreateMessageWithMetadata'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/Messages.json',
    );
  });

  it('アカウント直下のリソースも解決する', () => {
    assert.equal(twilioGo.resolve(['Api', 'CreateAccount'], twilioIndex)?.path, '/2010-04-01/Accounts.json');
  });

  it('未知の動詞やスペックに無いリソースは解決しない', () => {
    assert.equal(twilioGo.resolve(['Api', 'TeleportMessage'], twilioIndex), undefined);
    assert.equal(twilioGo.resolve(['Api', 'CreateUnicorn'], twilioIndex), undefined);
  });

  it('Slack Go は生成した対応表で引く', () => {
    assert.deepEqual(slackGo.resolve(['PostMessage'], slackIndex), { method: 'post', path: '/chat.postMessage' });
    assert.equal(slackGo.resolve(['GetUserInfoContext'], slackIndex)?.path, '/users.info');
  });

  it('実行時にエンドポイントが決まるメソッドは対応表に含めない', () => {
    // `SendMessage` はオプション次第で chat.postMessage / chat.update いずれにもなる
    assert.equal(slackGo.resolve(['SendMessage'], slackIndex), undefined);
  });

  it('対応表に無いメソッドは解決しない', () => {
    assert.equal(slackGo.resolve(['DoSomethingUnknown'], slackIndex), undefined);
  });
});

describe('scanGoFiles', () => {
  const stripeHeader = ['package main', '', 'import (', '\t"context"', '', '\t"github.com/stripe/stripe-go/v86"', ')', ''];

  it('連結された識別子からパスを復元する', { skip }, async () => {
    const sites = await scan(
      'pay.go',
      [
        ...stripeHeader,
        'func pay(sc *stripe.Client) {',
        '\tsc.V1PaymentIntents.Create(context.TODO(), &stripe.PaymentIntentCreateParams{Amount: stripe.Int64(2000)})',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.provider, 'stripe');
    // `/v1/payment/intents` ではなく実スペックに存在する側を選ぶ
    assert.equal(sites[0]?.operation?.path, '/v1/payment_intents');
    assert.deepEqual(sites[0]?.passedParams, ['Amount']);
  });

  it('区切りが曖昧な識別子を実スペックで判別する', { skip }, async () => {
    const sites = await scan(
      'checkout.go',
      [
        ...stripeHeader,
        'func start(sc *stripe.Client) {',
        '\tsc.V1CheckoutSessions.Create(context.TODO(), &stripe.CheckoutSessionCreateParams{Mode: stripe.String("payment")})',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(sites[0]?.operation?.path, '/v1/checkout/sessions');
  });

  it('動詞から HTTP メソッドと対象を決める', { skip }, async () => {
    const sites = await scan(
      'get.go',
      [...stripeHeader, 'func get(sc *stripe.Client) {', '\tsc.V1Customers.Retrieve(context.TODO(), "cus_1", nil)', '}', ''].join('\n'),
    );
    assert.equal(sites[0]?.operation?.method, 'get');
    assert.equal(sites[0]?.operation?.path, '/v1/customers/{customer}');
  });

  it('変数に入れてから渡した構造体のフィールドを拾う', { skip }, async () => {
    const sites = await scan(
      'billing.go',
      [
        ...stripeHeader,
        'func create(sc *stripe.Client) {',
        '\tparams := &stripe.CustomerCreateParams{',
        '\t\tEmail:       stripe.String("a@b.c"),',
        '\t\tDescription: stripe.String("test"),',
        '\t}',
        '\tsc.V1Customers.Create(context.TODO(), params)',
        '}',
        '',
      ].join('\n'),
    );
    assert.deepEqual(sites[0]?.passedParams, ['Description', 'Email']);
  });

  it('OpenAI の名前空間つき呼び出しを解決する', { skip }, async () => {
    const sites = await scan(
      'ai.go',
      [
        'package main',
        '',
        'import (',
        '\t"context"',
        '',
        '\t"github.com/openai/openai-go/v3"',
        ')',
        '',
        'func ask() {',
        '\tclient := openai.NewClient()',
        '\tclient.Chat.Completions.New(context.TODO(), openai.ChatCompletionNewParams{Model: openai.ChatModelGPT5_2})',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(sites[0]?.provider, 'openai');
    assert.equal(sites[0]?.operation?.path, '/chat/completions');
    assert.deepEqual(sites[0]?.passedParams, ['Model']);
  });

  it('リソースが import パスにある形も解決する', { skip }, async () => {
    // stripe-go の従来の形。呼び出し側には `session.New` としか現れない
    const sites = await scan(
      'checkout.go',
      [
        'package main',
        '',
        'import (',
        '\t"github.com/stripe/stripe-go/v84"',
        '\t"github.com/stripe/stripe-go/v84/checkout/session"',
        '\t"github.com/stripe/stripe-go/v84/paymentintent"',
        ')',
        '',
        'func start() {',
        '\ts, _ := session.New(&stripe.CheckoutSessionParams{Mode: stripe.String("payment")})',
        '\tpaymentintent.New(&stripe.PaymentIntentParams{Amount: stripe.Int64(2000)})',
        '}',
        '',
      ].join('\n'),
    );
    assert.equal(sites.length, 2);
    assert.equal(sites[0]?.operation?.path, '/v1/checkout/sessions');
    // パッケージ名に区切りが無くても実スペックの `payment_intents` に対応づける
    assert.equal(sites[1]?.operation?.path, '/v1/payment_intents');
  });

  it('SDK と無関係な呼び出しは拾わない', { skip }, async () => {
    const sites = await scan(
      'other.go',
      ['package main', '', 'import "net/http"', '', 'func f() {', '\thttp.Get("https://example.com")', '}', ''].join('\n'),
    );
    assert.deepEqual(sites, []);
  });

  it('構文エラーのファイルで全体を止めない', { skip }, async () => {
    const warnings: string[] = [];
    const sites = await scanGoFiles(
      [
        { path: 'broken.go', content: 'package main\n\nfunc f( {\n' },
        {
          path: 'ok.go',
          content: [...stripeHeader, 'func f(sc *stripe.Client) {', '\tsc.V1Customers.Create(context.TODO(), nil)', '}', ''].join('\n'),
        },
      ],
      index,
      { warn: (_o, m) => warnings.push(m) },
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.file, 'ok.go');
    assert.equal(warnings.length, 1);
  });

  it('空の入力では解析器を起動しない', async () => {
    assert.deepEqual(await scanGoFiles([], index, silentLog), []);
  });
});
