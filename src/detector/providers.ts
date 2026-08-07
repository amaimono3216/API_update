import type { OpenApiDocument } from './types.js';

export type ProviderId = 'stripe' | 'openai';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  specUrl: string;
  format: 'json' | 'yaml';
  /** PR 概要欄の「公式情報源」に記載する URL。 */
  changelogUrl: string;
  /** スペックから API バージョンを取り出す（Stripe: `2026-07-29.dahlia` / OpenAI: `2.3.0`）。 */
  extractVersion: (doc: OpenApiDocument) => string;
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
  },
  openai: {
    id: 'openai',
    displayName: 'OpenAI API',
    specUrl: 'https://raw.githubusercontent.com/openai/openai-openapi/master/openapi.yaml',
    format: 'yaml',
    changelogUrl: 'https://platform.openai.com/docs/changelog',
    extractVersion: versionFromInfo,
  },
};

export const isProviderId = (value: string): value is ProviderId => value in PROVIDERS;

/** 環境変数で URL が上書きされていれば反映した設定を返す。 */
export function resolveProvider(
  id: ProviderId,
  overrides: { stripeSpecUrl?: string | undefined; openaiSpecUrl?: string | undefined },
): ProviderConfig {
  const base = PROVIDERS[id];
  const override = id === 'stripe' ? overrides.stripeSpecUrl : overrides.openaiSpecUrl;
  return override ? { ...base, specUrl: override } : base;
}
