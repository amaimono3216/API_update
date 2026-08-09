import type { NotificationEvent } from './types.js';

export interface SlackMessage {
  /** 通知一覧やプッシュ通知で使われるフォールバックテキスト。 */
  text: string;
  blocks: SlackBlock[];
}

type SlackBlock =
  | { type: 'header'; text: { type: 'plain_text'; text: string; emoji: true } }
  | { type: 'section'; text: { type: 'mrkdwn'; text: string } }
  | { type: 'context'; elements: { type: 'mrkdwn'; text: string }[] };

const header = (text: string): SlackBlock => ({
  // Slack のヘッダは 150 文字上限
  type: 'header',
  text: { type: 'plain_text', text: text.slice(0, 150), emoji: true },
});
const section = (text: string): SlackBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string): SlackBlock => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

const versionRange = (from: string | null, to: string): string => (from ? `\`${from}\` → \`${to}\`` : `\`${to}\``);

/**
 * 通知内容を組み立てる。
 *
 * 受け取った側が「対応が必要か」を一目で判断できることを優先し、
 * 見出しで結論を、本文で根拠を示す。
 */
export function buildSlackMessage(event: NotificationEvent): SlackMessage {
  switch (event.type) {
    case 'breaking_detected': {
      const text = `[${event.provider}] 破壊的変更を ${event.breakingCount} 件検知しました`;
      return {
        text,
        blocks: [
          header(`⚠️ ${event.provider} API に破壊的変更`),
          section(
            [
              `*バージョン*: ${versionRange(event.fromVersion, event.toVersion)}`,
              `*破壊的変更*: ${event.breakingCount} 件`,
              `*要注意の変更*: ${event.warningCount} 件`,
            ].join('\n'),
          ),
          context(`差分 ID: \`${event.diffId}\` — 影響範囲の特定を開始します`),
        ],
      };
    }

    case 'no_impact': {
      const text = `[${event.repository}] ${event.provider} の変更による影響はありません`;
      return {
        text,
        blocks: [
          header('✅ 影響なし'),
          section(
            [
              `*リポジトリ*: \`${event.repository}\``,
              `*対象*: ${event.provider} \`${event.toVersion}\``,
              `検出した ${event.callSites} 箇所の API 呼び出しを確認しましたが、修正は不要です。`,
            ].join('\n'),
          ),
          context('PR は作成していません'),
        ],
      };
    }

    case 'pr_opened': {
      const text = `[${event.repository}] 自動修正 PR を作成しました: ${event.url}`;
      return {
        text,
        blocks: [
          header('🤖 自動修正 PR を作成しました'),
          section(
            [
              `*リポジトリ*: \`${event.repository}\``,
              `*ブランチ*: \`${event.branch}\``,
              `*テスト*: ${event.testPassed ? '✅ PASSED' : '❌ FAILED'}`,
              `<${event.url}|PR を開く>`,
            ].join('\n'),
          ),
          context(
            event.testPassed
              ? `修正試行 ${event.attempts} 回 — レビューをお願いします`
              : `修正試行 ${event.attempts} 回 — *テストが通っていません*。手動での確認が必要です`,
          ),
        ],
      };
    }

    case 'pr_prepared': {
      const text = `[${event.repository}] PR の内容を生成しました（未送信）`;
      return {
        text,
        blocks: [
          header('📝 PR の内容を生成しました（未送信）'),
          section(
            [
              `*リポジトリ*: \`${event.repository}\``,
              `*ブランチ*: \`${event.branch}\``,
              `*テスト*: ${event.testPassed ? '✅ PASSED' : '❌ FAILED'}`,
            ].join('\n'),
          ),
          context(event.reason),
        ],
      };
    }

    case 'fix_failed': {
      const text = `[${event.repository}] 自動修正に失敗しました`;
      return {
        text,
        blocks: [
          header('❌ 自動修正に失敗しました'),
          section(
            [
              `*リポジトリ*: \`${event.repository}\``,
              `*ブランチ*: \`${event.branch}\``,
              `*試行回数*: ${event.attempts} 回`,
              `*理由*: ${event.reason}`,
            ].join('\n'),
          ),
          context('手動での対応が必要です'),
        ],
      };
    }

    case 'pr_merged': {
      const text = `[${event.repository}] 自動修正 PR がマージされました`;
      return {
        text,
        blocks: [
          header('🎉 自動修正 PR がマージされました'),
          section([`*リポジトリ*: \`${event.repository}\``, `<${event.url}|PR を開く>`].join('\n')),
        ],
      };
    }
  }
}
