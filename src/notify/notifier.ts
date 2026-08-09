import { env } from '../config/env.js';
import { buildSlackMessage } from './messages.js';
import type { Notifier, NotificationEvent } from './types.js';

const SLACK_TIMEOUT_MS = 10_000;

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * 通知先が未設定の場合の既定実装。ログにだけ出す。
 *
 * 通知はシステムの本流ではないため、送信先が無くても処理は止めない。
 */
export class LogNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async notify(event: NotificationEvent): Promise<void> {
    this.log.info({ event: event.type, detail: event }, buildSlackMessage(event).text);
  }
}

/** Slack Incoming Webhook への通知。 */
export class SlackNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly log: Logger,
  ) {}

  async notify(event: NotificationEvent): Promise<void> {
    const message = buildSlackMessage(event);

    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
      });

      if (!response.ok) {
        // 通知の失敗で本流を止めない。検知や修正の結果は DB に残っている
        this.log.warn(
          { status: response.status, body: (await response.text()).slice(0, 200) },
          'Slack への通知に失敗しました',
        );
        return;
      }
      this.log.info({ event: event.type }, 'Slack へ通知しました');
    } catch (error) {
      this.log.warn({ event: event.type, err: String(error) }, 'Slack への通知に失敗しました');
    }
  }
}

/** 通知先が設定されていれば Slack、無ければログ出力を返す。 */
export const createNotifier = (log: Logger): Notifier =>
  env.SLACK_WEBHOOK_URL ? new SlackNotifier(env.SLACK_WEBHOOK_URL, log) : new LogNotifier(log);
