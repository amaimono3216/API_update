import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

import type { OpenApiDocument } from '../detector/types.js';
import { scanPythonFiles } from './scan-python.js';
import { OperationIndex } from './sdk-map.js';

/** Python が無い環境（開発マシンなど）ではスキップする。 */
const pythonAvailable = spawnSync('python3', ['--version'], { shell: false }).status === 0;
const skip = pythonAvailable ? false : 'python3 が利用できないためスキップします';

const spec: OpenApiDocument = {
  openapi: '3.0.0',
  paths: {
    '/v1/customers': { post: {}, get: {} },
    '/v1/checkout/sessions': { post: {} },
    '/chat.postMessage': { post: {} },
    '/conversations.list': { get: {} },
    '/chat/completions': { post: {} },
    '/2010-04-01/Accounts/{AccountSid}/Messages.json': { post: {} },
  },
  components: { schemas: {} },
};

const index = new OperationIndex(spec);
const silentLog = { warn: () => {} };

const scan = (path: string, content: string) => scanPythonFiles([{ path, content }], index, silentLog);

describe('scanPythonFiles', () => {
  it('Stripe の StripeClient 呼び出しを検出する', { skip }, async () => {
    const sites = await scan(
      'billing.py',
      ['from stripe import StripeClient', '', 'client = StripeClient("sk")', '', 'client.v1.customers.create(email="a@b.c")', ''].join('\n'),
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.provider, 'stripe');
    assert.equal(sites[0]?.operation?.path, '/v1/customers');
    assert.deepEqual(sites[0]?.passedParams, ['email']);
  });

  it('モジュールを直接使う形も検出する', { skip }, async () => {
    const sites = await scan(
      'checkout.py',
      ['import stripe', '', 'stripe.checkout.sessions.create(mode="payment")', ''].join('\n'),
    );
    assert.equal(sites[0]?.operation?.path, '/v1/checkout/sessions');
  });

  it('Slack のアンダースコア記法を検出する', { skip }, async () => {
    const sites = await scan(
      'notify.py',
      [
        'from slack_sdk import WebClient',
        '',
        'client = WebClient(token="x")',
        '',
        'client.chat_postMessage(channel="#dev", text="hi")',
        'client.conversations_list(limit=100)',
        '',
      ].join('\n'),
    );
    assert.equal(sites.length, 2);
    assert.equal(sites[0]?.operation?.path, '/chat.postMessage');
    assert.equal(sites[1]?.operation?.path, '/conversations.list');
    assert.equal(sites[1]?.operation?.method, 'get');
  });

  it('Twilio の from_ を含む呼び出しを検出する', { skip }, async () => {
    const sites = await scan(
      'sms.py',
      [
        'from twilio.rest import Client',
        '',
        'client = Client("AC", "token")',
        '',
        'client.messages.create(to="+81", from_="+1", body="hi")',
        '',
      ].join('\n'),
    );
    assert.equal(sites[0]?.provider, 'twilio');
    assert.equal(sites[0]?.operation?.path, '/2010-04-01/Accounts/{AccountSid}/Messages.json');
    assert.deepEqual(sites[0]?.passedParams, ['body', 'from_', 'to']);
  });

  it('ネストした辞書とリストをパス表記で抽出する', { skip }, async () => {
    const sites = await scan(
      'ai.py',
      [
        'from openai import OpenAI',
        '',
        'client = OpenAI()',
        '',
        'client.chat.completions.create(',
        '    model="gpt-4",',
        '    messages=[{"role": "user", "content": "hi"}],',
        ')',
        '',
      ].join('\n'),
    );
    const params = sites[0]?.passedParams ?? [];
    assert.ok(params.includes('messages.[].role'), params.join(','));
    assert.ok(params.includes('messages.[].content'), params.join(','));
  });

  it('SDK と無関係な呼び出しは拾わない', { skip }, async () => {
    const sites = await scan('other.py', ['import requests', '', 'requests.get("https://example.com")', ''].join('\n'));
    assert.deepEqual(sites, []);
  });

  it('構文エラーのファイルで全体を止めない', { skip }, async () => {
    const warnings: string[] = [];
    const sites = await scanPythonFiles(
      [
        { path: 'broken.py', content: 'def f(:\n  pass\n' },
        { path: 'ok.py', content: 'import stripe\n\nstripe.v1.customers.create(email="a")\n' },
      ],
      index,
      { warn: (_o, m) => warnings.push(m) },
    );
    assert.equal(sites.length, 1);
    assert.equal(sites[0]?.file, 'ok.py');
    assert.equal(warnings.length, 1);
  });

  it('空の入力では Python を起動しない', async () => {
    assert.deepEqual(await scanPythonFiles([], index, silentLog), []);
  });
});
