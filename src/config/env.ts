import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),

  // ① 監視・検知モジュール
  DETECT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** スペック取得のスケジュール。既定は毎日 03:00 JST。 */
  DETECT_CRON: z.string().default('0 3 * * *'),
  DETECT_TIMEZONE: z.string().default('Asia/Tokyo'),
  STRIPE_OPENAPI_URL: z.url().optional(),
  OPENAI_OPENAPI_URL: z.url().optional(),
  TWILIO_OPENAPI_URL: z.url().optional(),
  SLACK_OPENAPI_URL: z.url().optional(),

  // ② 影響範囲特定モジュール（未設定の場合、LLM 判定はスキップされる）
  ANTHROPIC_API_KEY: z.string().optional(),

  // ④ PR 生成モジュール（未設定の場合、PR 内容の生成のみ行い送信はスキップ）
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  /** Webhook 受信の署名検証に使う。未設定の場合、受信エンドポイントは 503 を返す。 */
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  /** 通知先。未設定の場合はログ出力にフォールバックする。 */
  SLACK_WEBHOOK_URL: z.url().optional(),

  // ③ 対象リポジトリのコマンド実行を隔離するための設定
  /** false にすると対象リポジトリのコードをアプリコンテナ内で直接実行する（非推奨）。 */
  SANDBOX_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** 作業コピーの置き場。サンドボックスと共有するボリュームのマウント先。 */
  WORKSPACE_ROOT: z.string().optional(),
  /** 上記マウント先に対応する Docker ボリューム名。 */
  SANDBOX_WORKSPACE_VOLUME: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('環境変数の検証に失敗しました:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
