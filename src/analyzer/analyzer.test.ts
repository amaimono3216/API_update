import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BreakingChange, OpenApiDocument } from '../detector/types.js';
import { correlate } from './correlate.js';
import { OperationIndex, findConvention, resolveOperation } from './sdk-map.js';
import { scanSource } from './scan-typescript.js';

/** 実スペックの形を模した最小のドキュメント。 */
const spec: OpenApiDocument = {
  openapi: '3.0.0',
  paths: {
    '/v1/checkout/sessions': { post: { operationId: 'PostCheckoutSessions' }, get: {} },
    '/v1/checkout/sessions/{session}': { get: {} },
    '/v1/charges': { post: {}, get: {} },
    '/v1/charges/{charge}': { get: {}, post: {} },
    '/v1/charges/{charge}/capture': { post: {} },
    '/v1/charges/search': { get: {} },
    '/v1/payment_intents': { post: {} },
    '/chat/completions': { post: { operationId: 'createChatCompletion' } },
    '/threads/{thread_id}/messages': { post: {} },
  },
  components: { schemas: {} },
};

const index = new OperationIndex(spec);
const stripe = findConvention('stripe')!;
const openai = findConvention('openai')!;

describe('resolveOperation', () => {
  it('SDK の名前空間をリソースパスに対応づける', () => {
    assert.deepEqual(resolveOperation(stripe, ['checkout', 'sessions', 'create'], index), {
      method: 'post',
      path: '/v1/checkout/sessions',
      operationId: 'PostCheckoutSessions',
    });
  });

  it('retrieve は ID 付きパスに解決する', () => {
    assert.equal(resolveOperation(stripe, ['charges', 'retrieve'], index)?.path, '/v1/charges/{charge}');
  });

  it('camelCase を snake_case に変換する', () => {
    assert.equal(resolveOperation(stripe, ['paymentIntents', 'create'], index)?.path, '/v1/payment_intents');
  });

  it('未知の動詞はリソース固有アクションとして解決する', () => {
    const op = resolveOperation(stripe, ['charges', 'capture'], index);
    assert.equal(op?.path, '/v1/charges/{charge}/capture');
    assert.equal(op?.method, 'post');
  });

  it('search はコレクションのサブパスに解決する', () => {
    assert.equal(resolveOperation(stripe, ['charges', 'search'], index)?.path, '/v1/charges/search');
  });

  it('OpenAI は /v1 接頭辞を付けず、beta 名前空間を読み飛ばす', () => {
    assert.equal(resolveOperation(openai, ['chat', 'completions', 'create'], index)?.path, '/chat/completions');
    assert.equal(resolveOperation(openai, ['beta', 'threads', 'messages', 'create'], index)?.path, '/threads/{thread_id}/messages');
  });

  it('スペックに存在しないパスは解決しない', () => {
    assert.equal(resolveOperation(stripe, ['unicorns', 'create'], index), undefined);
  });
});

describe('プロバイダごとのパス解決', () => {
  /** Twilio / Slack は Stripe とパスの組み立て規則が根本的に異なる。 */
  const twilioSpec: OpenApiDocument = {
    openapi: '3.0.1',
    paths: {
      '/2010-04-01/Accounts.json': { post: {}, get: {} },
      '/2010-04-01/Accounts/{AccountSid}/Messages.json': { post: {}, get: {} },
      '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json': { get: {}, post: {}, delete: {} },
      '/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json': { get: {} },
    },
    components: { schemas: {} },
  };
  const slackSpec: OpenApiDocument = {
    openapi: '3.0.0',
    paths: {
      '/chat.postMessage': { post: {} },
      '/conversations.list': { get: {} },
      '/admin.apps.approve': { post: {} },
    },
    components: { schemas: {} },
  };

  const twilio = findConvention('twilio')!;
  const slack = findConvention('@slack/web-api')!;
  const twilioIndex = new OperationIndex(twilioSpec);
  const slackIndex = new OperationIndex(slackSpec);

  it('Twilio はリソースを PascalCase にし、アカウント配下の .json パスに解決する', () => {
    assert.deepEqual(twilio.resolve(['messages', 'create'], twilioIndex), {
      method: 'post',
      path: '/2010-04-01/Accounts/{AccountSid}/Messages.json',
    });
    assert.equal(
      twilio.resolve(['incomingPhoneNumbers', 'list'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/IncomingPhoneNumbers.json',
    );
  });

  it('Twilio の fetch / remove は ID 付きパスに解決する', () => {
    assert.equal(twilio.resolve(['messages', 'fetch'], twilioIndex)?.method, 'get');
    assert.equal(
      twilio.resolve(['messages', 'fetch'], twilioIndex)?.path,
      '/2010-04-01/Accounts/{AccountSid}/Messages/{Sid}.json',
    );
    assert.equal(twilio.resolve(['messages', 'remove'], twilioIndex)?.method, 'delete');
  });

  it('Twilio のアカウント直下リソースも解決する', () => {
    assert.equal(twilio.resolve(['accounts', 'create'], twilioIndex)?.path, '/2010-04-01/Accounts.json');
  });

  it('Twilio の未知の動詞は解決しない', () => {
    assert.equal(twilio.resolve(['messages', 'sendNow'], twilioIndex), undefined);
  });

  it('Slack はチェーンをドット結合したパスに解決する', () => {
    assert.deepEqual(slack.resolve(['chat', 'postMessage'], slackIndex), {
      method: 'post',
      path: '/chat.postMessage',
    });
    assert.equal(slack.resolve(['admin', 'apps', 'approve'], slackIndex)?.path, '/admin.apps.approve');
  });

  it('Slack は GET のみの操作も解決する', () => {
    assert.equal(slack.resolve(['conversations', 'list'], slackIndex)?.method, 'get');
  });

  it('スペックに存在しない呼び出しは解決しない', () => {
    assert.equal(slack.resolve(['chat', 'deleteScheduledMessage'], slackIndex), undefined);
    assert.equal(twilio.resolve(['unicorns', 'create'], twilioIndex), undefined);
  });
});

describe('scanSource', () => {
  it('import と new から生成したクライアントの呼び出しを検出する', () => {
    const source = `
      import Stripe from 'stripe';
      const stripe = new Stripe(process.env.STRIPE_KEY!);

      export async function createSession() {
        return stripe.checkout.sessions.create({
          mode: 'payment',
          line_items: [{ price: 'price_123', quantity: 1, amount: 2000 }],
          metadata: { orderId: '1' },
        });
      }
    `;
    const sites = scanSource('src/pay.ts', source, index);
    assert.equal(sites.length, 1);
    const site = sites[0]!;
    assert.equal(site.provider, 'stripe');
    assert.equal(site.operation?.path, '/v1/checkout/sessions');
    assert.deepEqual(site.chain, ['stripe', 'checkout', 'sessions', 'create']);
    assert.equal(site.file, 'src/pay.ts');
    assert.equal(site.line, 6);
  });

  it('ネストしたパラメータを配列表記込みで抽出する', () => {
    const source = `
      import Stripe from 'stripe';
      const stripe = new Stripe('k');
      stripe.checkout.sessions.create({
        line_items: [{ amount: 100, price_data: { currency: 'jpy' } }],
        mode: 'payment',
      });
    `;
    const params = scanSource('a.ts', source, index)[0]!.passedParams;
    assert.ok(params.includes('line_items.[].amount'), params.join(','));
    assert.ok(params.includes('line_items.[].price_data.currency'), params.join(','));
    assert.ok(params.includes('mode'));
  });

  it('require 形式と this プロパティのクライアントを検出する', () => {
    const requireSource = `
      const stripe = require('stripe')('sk_test');
      stripe.charges.retrieve('ch_1');
    `;
    const requireSites = scanSource('a.js', requireSource, index);
    assert.equal(requireSites.length, 1);
    assert.equal(requireSites[0]?.operation?.path, '/v1/charges/{charge}');

    const classSource = `
      import Stripe from 'stripe';
      class PaymentService {
        private client = new Stripe('k');
        constructor() { this.stripe = new Stripe('k'); }
        pay() { return this.stripe.charges.create({ amount: 100 }); }
      }
    `;
    const sites = scanSource('svc.ts', classSource, index);
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.operation?.path, '/v1/charges');
  });

  it('別ファイルで生成されたクライアントも名前から推定する', () => {
    const source = `
      import { stripe } from './lib/stripe';
      export const run = () => stripe.charges.create({ amount: 100 });
    `;
    assert.equal(scanSource('a.ts', source, index)[0]?.operation?.path, '/v1/charges');
  });

  it('SDK と無関係な呼び出しは拾わない', () => {
    const source = `
      const db = require('./db');
      db.charges.create({ amount: 100 });
      logger.checkout.sessions.create({});
    `;
    assert.deepEqual(scanSource('a.ts', source, index), []);
  });

  it('Twilio SDK の関数呼び出し形式のクライアント生成を検出する', () => {
    // twilio-node は `new` ではなく関数呼び出しでクライアントを作る
    const source = `
      import twilio from 'twilio';
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

      export async function sendSms(to: string, body: string) {
        return client.messages.create({ to, from: '+15551234567', body });
      }
    `;
    const twilioIndex = new OperationIndex({
      openapi: '3.0.1',
      paths: { '/2010-04-01/Accounts/{AccountSid}/Messages.json': { post: {} } },
      components: { schemas: {} },
    });

    const site = scanSource('sms.ts', source, twilioIndex)[0]!;
    assert.equal(site.provider, 'twilio');
    assert.equal(site.operation?.path, '/2010-04-01/Accounts/{AccountSid}/Messages.json');
    assert.deepEqual(site.passedParams.sort(), ['body', 'from', 'to']);
  });

  it('Slack SDK の名前付き import からのクライアント生成を検出する', () => {
    const source = `
      import { WebClient } from '@slack/web-api';
      const client = new WebClient(process.env.SLACK_TOKEN);

      export async function notify(channel: string) {
        return client.chat.postMessage({ channel, text: 'デプロイが完了しました', unfurl_links: false });
      }
    `;
    const slackIndex = new OperationIndex({
      openapi: '3.0.0',
      paths: { '/chat.postMessage': { post: {} } },
      components: { schemas: {} },
    });

    const site = scanSource('notify.ts', source, slackIndex)[0]!;
    assert.equal(site.provider, 'slack');
    assert.equal(site.operation?.path, '/chat.postMessage');
    assert.ok(site.passedParams.includes('unfurl_links'));
  });

  it('OpenAI SDK の呼び出しを検出する', () => {
    const source = `
      import OpenAI from 'openai';
      const client = new OpenAI();
      await client.chat.completions.create({ model: 'gpt-4', messages: [], max_tokens: 100 });
    `;
    const site = scanSource('ai.ts', source, index)[0]!;
    assert.equal(site.provider, 'openai');
    assert.equal(site.operation?.path, '/chat/completions');
    assert.ok(site.passedParams.includes('max_tokens'));
  });
});

describe('correlate', () => {
  const callSites = scanSource(
    'src/pay.ts',
    `
      import Stripe from 'stripe';
      const stripe = new Stripe('k');
      stripe.checkout.sessions.create({ mode: 'payment', line_items: [{ amount: 2000 }] });
      stripe.charges.create({ amount: 100 });
    `,
    index,
  );

  const change = (overrides: Partial<BreakingChange>): BreakingChange => ({
    kind: 'property_removed',
    severity: 'breaking',
    direction: 'request',
    location: 'POST /v1/checkout/sessions requestBody.line_items.[].amount',
    propertyPath: 'line_items.[].amount',
    operations: [{ method: 'post', path: '/v1/checkout/sessions' }],
    before: 'integer',
    after: undefined,
    message: 'テスト',
    ...overrides,
  });

  it('実際に渡しているプロパティの変更を direct として分類する', () => {
    const candidates = correlate([change({})], callSites);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]?.match, 'direct');
    assert.equal(candidates[0]?.callSite.file, 'src/pay.ts');
  });

  it('同じ操作でも渡していないプロパティは operation 止まりにする', () => {
    const candidates = correlate([change({ propertyPath: 'shipping_options.[].shipping_rate' })], callSites);
    assert.equal(candidates[0]?.match, 'operation');
  });

  it('レスポンス側の変更は direct にしない', () => {
    const candidates = correlate([change({ direction: 'response' })], callSites);
    assert.equal(candidates[0]?.match, 'operation');
  });

  it('呼び出していない操作の変更は候補にしない', () => {
    const other = change({ operations: [{ method: 'post', path: '/v1/payment_intents' }] });
    assert.deepEqual(correlate([other], callSites), []);
  });

  it('同じ変更と同じ行の組み合わせは重複させない', () => {
    const duplicated = change({ operations: [{ method: 'post', path: '/v1/checkout/sessions' }, { method: 'post', path: '/v1/checkout/sessions' }] });
    assert.equal(correlate([duplicated], callSites).length, 1);
  });
});
