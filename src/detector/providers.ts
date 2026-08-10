import type { OpenApiDocument } from './types.js';

export type ProviderId = 'stripe' | 'openai' | 'twilio' | 'slack';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  specUrl: string;
  format: 'json' | 'yaml';
  /** PR 概要欄の「公式情報源」に記載する URL。 */
  changelogUrl: string;
  /** スペックから API バージョンを取り出す（Stripe: `2026-07-29.dahlia` / OpenAI: `2.3.0`）。 */
  extractVersion: (doc: OpenApiDocument) => string;
  /** スペック URL を上書きする環境変数名。 */
  specUrlEnvVar: string;
}

const versionFromInfo = (doc: OpenApiDocument): string => doc.info?.version ?? 'unknown';

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  stripe: {
    id: 'stripe',
    displayName: 'Stripe API',
    specUrl: 'https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json',
    format: 'json',
    changelogUrl: 'https://docs.stripe.com/changelog',
    extractVersion: versionFromInfo,
    specUrlEnvVar: 'STRIPE_OPENAPI_URL',
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI API',
    specUrl: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
    format: 'yaml',
    changelogUrl: 'https://platform.openai.com/docs/changelog',
    extractVersion: versionFromInfo,
    specUrlEnvVar: 'OPENAI_OPENAPI_URL',
  },
  twilio: {
    id: 'twilio',
    displayName: 'Twilio API',
    // twilio-oai はドメインごとにファイルが分かれている。まずは中核の Programmable Messaging / Voice を含む v2010 を対象にする。
    specUrl: 'https://raw.githubusercontent.com/twilio/twilio-oai/main/spec/json/twilio_api_v2010.json',
    format: 'json',
    changelogUrl: 'https://www.twilio.com/en-us/changelog',
    // info.version は固定値のため、パスに含まれる API バージョンを使う
    extractVersion: (doc) => {
      const first = Object.keys(doc.paths ?? {})[0];
      const match = first?.match(/^\/(\d{4}-\d{2}-\d{2})\//);
      return match?.[1] ?? versionFromInfo(doc);
    },
    specUrlEnvVar: 'TWILIO_OPENAPI_URL',
  },
  slack: {
    id: 'slack',
    displayName: 'Slack Web API',
    // Swagger 2.0。取得時に OpenAPI 3 相当へ正規化される（detector/normalize.ts）
    specUrl: 'https://raw.githubusercontent.com/slackapi/slack-api-specs/master/web-api/slack_web_openapi_v2.json',
    format: 'json',
    changelogUrl: 'https://docs.slack.dev/changelog',
    extractVersion: versionFromInfo,
    specUrlEnvVar: 'SLACK_OPENAPI_URL',
  },
};

export const isProviderId = (value: string): value is ProviderId => value in PROVIDERS;

/** 環境変数で URL が上書きされていれば反映した設定を返す。 */
export function resolveProvider(id: ProviderId, overrides: Record<string, string | undefined>): ProviderConfig {
  const base = PROVIDERS[id];
  const override = overrides[base.specUrlEnvVar];
  return override ? { ...base, specUrl: override } : base;
}
