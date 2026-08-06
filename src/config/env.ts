import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // 以降は各モジュール実装時に必須化する（環境構築段階では任意）
  GITHUB_APP_ID: z.string().optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().optional(),
  GITHUB_WEBHOOK_SECRET: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  STRIPE_OPENAPI_URL: z.string().url().optional(),
  OPENAI_OPENAPI_URL: z.string().url().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('環境変数の検証に失敗しました:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
