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

  // ② 影響範囲特定モジュール（未設定の場合、LLM 判定はスキップされる）
  ANTHROPIC_API_KEY: z.string().optional(),

  // 以降は各モジュール実装時に必須化する
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('環境変数の検証に失敗しました:', z.treeifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
