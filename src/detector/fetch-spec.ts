import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

import type { ProviderConfig } from './providers.js';
import type { OpenApiDocument } from './types.js';

export interface FetchedSpec {
  provider: string;
  version: string;
  /** 生テキストの SHA-256。前回取得分と同一かの判定に使う。 */
  hash: string;
  document: OpenApiDocument;
  bytes: number;
  fetchedAt: Date;
}

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
}

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 公開されている OpenAPI スペックを取得し、パースとハッシュ化を行う。 */
export async function fetchSpec(provider: ProviderConfig, options: FetchOptions = {}): Promise<FetchedSpec> {
  const { timeoutMs = 60_000, retries = 3 } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(provider.specUrl, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json, application/yaml, text/plain' },
      });
      if (!response.ok) {
        throw new Error(`スペック取得に失敗しました: ${response.status} ${response.statusText}`);
      }

      const text = await response.text();
      const document = parseSpec(text, provider.format);

      return {
        provider: provider.id,
        version: provider.extractVersion(document),
        hash: sha256(text),
        document,
        bytes: Buffer.byteLength(text),
        fetchedAt: new Date(),
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(attempt * 2_000);
    }
  }

  throw new Error(`${provider.displayName} のスペック取得に ${retries} 回失敗しました: ${String(lastError)}`);
}

export function parseSpec(text: string, format: 'json' | 'yaml'): OpenApiDocument {
  const document = format === 'json' ? JSON.parse(text) : parseYaml(text);
  if (!document || typeof document !== 'object') {
    throw new Error('OpenAPI ドキュメントとして解釈できませんでした。');
  }
  return document as OpenApiDocument;
}
