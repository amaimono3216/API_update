import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import type { OpenApiDocument } from '../detector/types.js';
import { scanGoFiles } from './scan-go.js';
import { OperationIndex, splitPascalCase } from './sdk-map.js';

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
