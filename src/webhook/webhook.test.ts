import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { buildSlackMessage } from '../notify/messages.js';
import type { NotificationEvent, Notifier } from '../notify/types.js';
import { handleGitHubEvent, repositoryOf, type HandlerContext } from './github.js';
import { verifySignature } from './verify.js';

const SECRET = 'it-is-a-secret';
const sign = (body: string, secret = SECRET): string =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body)).digest('hex')}`;

describe('verifySignature', () => {
  const body = JSON.stringify({ action: 'closed', number: 7 });

  it('正しい署名を受理する', () => {
    assert.equal(verifySignature(Buffer.from(body), sign(body), SECRET), true);
  });

  it('ボディが改竄されていれば拒否する', () => {
    assert.equal(verifySignature(Buffer.from(`${body} `), sign(body), SECRET), false);
  });

  it('別のシークレットで署名されていれば拒否する', () => {
    assert.equal(verifySignature(Buffer.from(body), sign(body, 'wrong-secret'), SECRET), false);
  });

  it('署名ヘッダが無ければ拒否する', () => {
    assert.equal(verifySignature(Buffer.from(body), undefined, SECRET), false);
    assert.equal(verifySignature(Buffer.from(body), '', SECRET), false);
  });

  it('シークレット未設定なら拒否する', () => {
    assert.equal(verifySignature(Buffer.from(body), sign(body), ''), false);
  });

  it('長さの違う署名でも例外を投げずに拒否する', () => {
    assert.equal(verifySignature(Buffer.from(body), 'sha256=short', SECRET), false);
    assert.equal(verifySignature(Buffer.from(body), `${sign(body)}extra`, SECRET), false);
  });

  it('prefix が違えば拒否する（sha1 形式など）', () => {
    const hex = createHmac('sha256', SECRET).update(Buffer.from(body)).digest('hex');
    assert.equal(verifySignature(Buffer.from(body), `sha1=${hex}`, SECRET), false);
  });

  it('マルチバイト文字を含むボディでも検証できる', () => {
    const japanese = JSON.stringify({ title: '破壊的変更に伴う自動修正' });
    assert.equal(verifySignature(Buffer.from(japanese), sign(japanese), SECRET), true);
  });
});

describe('buildSlackMessage', () => {
  /** Slack に送る形として最低限の妥当性を確認する。 */
  const assertWellFormed = (event: NotificationEvent): ReturnType<typeof buildSlackMessage> => {
    const message = buildSlackMessage(event);
    assert.ok(message.text.length > 0, 'フォールバックテキストが空です');
    assert.ok(message.blocks.length > 0, 'blocks が空です');
    for (const block of message.blocks) {
      if (block.type === 'header') assert.ok(block.text.text.length <= 150, 'ヘッダが 150 文字を超えています');
    }
    return message;
  };

  it('破壊的変更の検知を件数つきで通知する', () => {
    const message = assertWellFormed({
      type: 'breaking_detected',
      provider: 'stripe',
      fromVersion: '2026-03-25.dahlia',
      toVersion: '2026-07-29.dahlia',
      breakingCount: 34,
      warningCount: 12,
      diffId: '2',
    });
    assert.match(message.text, /34 件/);
    assert.match(JSON.stringify(message.blocks), /2026-03-25\.dahlia.*2026-07-29\.dahlia/);
  });

  it('初回検知（比較対象なし）でもバージョンを表示する', () => {
    const message = assertWellFormed({
      type: 'breaking_detected',
      provider: 'openai',
      fromVersion: null,
      toVersion: '2.3.0',
      breakingCount: 1,
      warningCount: 0,
      diffId: '9',
    });
    assert.match(JSON.stringify(message.blocks), /2\.3\.0/);
  });

  it('PR 作成をリンクつきで通知する', () => {
    const message = assertWellFormed({
      type: 'pr_opened',
      repository: 'acme/payments',
      branch: 'api-update/stripe-2026-07-29.dahlia',
      url: 'https://github.com/acme/payments/pull/42',
      testPassed: true,
      attempts: 2,
    });
    assert.match(JSON.stringify(message.blocks), /https:\/\/github\.com\/acme\/payments\/pull\/42/);
    assert.match(JSON.stringify(message.blocks), /PASSED/);
  });

  it('テスト未通過の PR は警告を添える', () => {
    const message = buildSlackMessage({
      type: 'pr_opened',
      repository: 'acme/payments',
      branch: 'b',
      url: 'https://example.com/pr/1',
      testPassed: false,
      attempts: 3,
    });
    assert.match(JSON.stringify(message.blocks), /テストが通っていません/);
  });

  it('未送信（認証情報なし）を理由つきで通知する', () => {
    const message = assertWellFormed({
      type: 'pr_prepared',
      repository: 'acme/payments',
      branch: 'b',
      reason: 'GitHub App の認証情報が未設定',
      testPassed: true,
    });
    assert.match(message.text, /未送信/);
    assert.match(JSON.stringify(message.blocks), /認証情報が未設定/);
  });

  it('影響なし・修正失敗・マージも通知できる', () => {
    assert.match(
      assertWellFormed({ type: 'no_impact', provider: 'stripe', toVersion: 'v1', repository: 'a/b', callSites: 5 }).text,
      /影響はありません/,
    );
    assert.match(
      assertWellFormed({ type: 'fix_failed', repository: 'a/b', branch: 'x', attempts: 3, reason: 'テスト失敗' }).text,
      /失敗/,
    );
    assert.match(
      assertWellFormed({ type: 'pr_merged', repository: 'a/b', url: 'https://example.com/pr/1' }).text,
      /マージ/,
    );
  });
});

describe('handleGitHubEvent', () => {
  const log = { info: () => {}, warn: () => {} };

  /** 通知と実行記録の更新を記録するテスト用のコンテキスト。 */
  function createContext(run: { id: string; repository: string } | null = null): HandlerContext & {
    notifications: NotificationEvent[];
    updates: { id: string; status: string }[];
  } {
    const notifications: NotificationEvent[] = [];
    const updates: { id: string; status: string }[] = [];
    const notifier: Notifier = {
      notify: async (event) => {
        notifications.push(event);
      },
    };

    return {
      log,
      notifier,
      notifications,
      updates,
      runs: {
        findAllByPrUrl: async () => (run ? [run] : []),
        setStatus: async (id, status) => {
          updates.push({ id, status });
        },
      },
    };
  }

  it('ping は受理するが処理はしない', async () => {
    const result = await handleGitHubEvent('ping', {}, createContext());
    assert.equal(result.handled, false);
    assert.match(result.detail, /ping/);
  });

  it('未対応のイベントでも例外にしない', async () => {
    const result = await handleGitHubEvent('star', { action: 'created' }, createContext());
    assert.equal(result.handled, false);
    assert.match(result.detail, /未対応/);
  });

  it('closed 以外の pull_request は処理しない', async () => {
    const result = await handleGitHubEvent('pull_request', { action: 'opened' }, createContext());
    assert.equal(result.handled, false);
    assert.match(result.detail, /処理対象外/);
  });

  it('URL の無い pull_request は処理しない', async () => {
    const result = await handleGitHubEvent('pull_request', { action: 'closed', pull_request: {} }, createContext());
    assert.equal(result.handled, false);
    assert.match(result.detail, /URL/);
  });

  it('マージされた PR を記録し通知する', async () => {
    const ctx = createContext({ id: '7', repository: 'acme/payments' });
    const result = await handleGitHubEvent(
      'pull_request',
      { action: 'closed', pull_request: { html_url: 'https://github.com/acme/payments/pull/42', merged: true } },
      ctx,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(ctx.updates, [{ id: '7', status: 'pr_merged' }]);
    assert.equal(ctx.notifications.length, 1);
    assert.equal(ctx.notifications[0]?.type, 'pr_merged');
  });

  it('同じ PR に紐づく複数の実行記録をすべて更新する', async () => {
    // 同じ差分を再実行すると 1 つの PR に複数の実行記録が紐づく
    const notifications: NotificationEvent[] = [];
    const updates: { id: string; status: string }[] = [];
    const ctx: HandlerContext = {
      log,
      notifier: {
        notify: async (event) => {
          notifications.push(event);
        },
      },
      runs: {
        findAllByPrUrl: async () => [
          { id: '17', repository: 'acme/payments' },
          { id: '16', repository: 'acme/payments' },
          { id: '12', repository: 'acme/payments' },
        ],
        setStatus: async (id, status) => {
          updates.push({ id, status });
        },
      },
    };

    const result = await handleGitHubEvent(
      'pull_request',
      { action: 'closed', pull_request: { html_url: 'https://github.com/acme/payments/pull/2', merged: true } },
      ctx,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(
      updates.map((u) => u.id),
      ['17', '16', '12'],
    );
    assert.ok(updates.every((u) => u.status === 'pr_merged'));
    // 通知は 1 回だけ
    assert.equal(notifications.length, 1);
    assert.match(result.detail, /3 件/);
  });

  it('マージされずに閉じられた PR は通知しない', async () => {
    const ctx = createContext({ id: '7', repository: 'acme/payments' });
    const result = await handleGitHubEvent(
      'pull_request',
      { action: 'closed', pull_request: { html_url: 'https://github.com/acme/payments/pull/42', merged: false } },
      ctx,
    );

    assert.equal(result.handled, true);
    assert.deepEqual(ctx.updates, [{ id: '7', status: 'pr_closed' }]);
    assert.equal(ctx.notifications.length, 0);
  });

  it('このシステムが作成していない PR は無視する', async () => {
    const ctx = createContext(null);
    const result = await handleGitHubEvent(
      'pull_request',
      { action: 'closed', pull_request: { html_url: 'https://github.com/other/repo/pull/1', merged: true } },
      ctx,
    );

    assert.equal(result.handled, false);
    assert.deepEqual(ctx.updates, []);
    assert.equal(ctx.notifications.length, 0);
  });

  it('インストール変更を記録する', async () => {
    const result = await handleGitHubEvent(
      'installation_repositories',
      { action: 'added', installation: { id: 1 }, repositories_added: [{ full_name: 'a/b' }] },
      createContext(),
    );
    assert.equal(result.handled, false);
    assert.match(result.detail, /インストール状況/);
  });
});

describe('repositoryOf', () => {
  it('ペイロードからリポジトリ名を取り出す', () => {
    assert.equal(repositoryOf({ repository: { full_name: 'acme/payments' } }), 'acme/payments');
    assert.equal(repositoryOf({}), undefined);
  });
});
