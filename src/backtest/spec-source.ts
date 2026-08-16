import { PROVIDERS, type ProviderId } from '../detector/providers.js';
import { fetchSpec } from '../detector/fetch-spec.js';
import type { OpenApiDocument } from '../detector/types.js';

/**
 * 過去のスペックを取得する。
 *
 * 各プロバイダのスペックは GitHub で公開されており、任意のコミットの内容を
 * raw.githubusercontent.com から取れる。ここでは DB を経由せず直接取得し、
 * 差分エンジンにそのまま渡す。
 */

/** プロバイダごとの、既定のスペック URL に含まれる ref 部分。 */
const REF_PATTERN = /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)([^/]+)(\/.*)$/;

/**
 * 既定のスペック URL の ref 部分を差し替える。
 *
 *   master → a54c3888…  のように、過去の時点のスペックを指す URL を作る。
 *   `ref` が `http` で始まる場合はそのまま URL として扱う。
 */
export function specUrlAt(provider: ProviderId, ref: string): string {
  if (ref.startsWith('http')) return ref;

  const base = PROVIDERS[provider].specUrl;
  const match = REF_PATTERN.exec(base);
  if (!match) throw new Error(`${provider} のスペック URL から ref を差し替えられません: ${base}`);

  return `${match[1]}${ref}${match[3]}`;
}

/** 指定した ref のスペックを取得する。 */
export async function fetchSpecAt(provider: ProviderId, ref: string): Promise<{ version: string; document: OpenApiDocument }> {
  const config = { ...PROVIDERS[provider], specUrl: specUrlAt(provider, ref) };
  const fetched = await fetchSpec(config, { retries: 2 });
  return { version: fetched.version, document: fetched.document };
}
