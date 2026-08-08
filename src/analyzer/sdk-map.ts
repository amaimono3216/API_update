import { iterateOperations } from '../detector/ref-index.js';
import type { HttpMethod, OpenApiDocument, OperationRef } from '../detector/types.js';

/**
 * SDK の呼び出しチェーンを OpenAPI の操作に対応づける。
 *
 * Stripe / OpenAI いずれの公式 SDK も、名前空間がリソースパスと 1:1 に対応する
 * 命名規則（`stripe.checkout.sessions.create` → `POST /v1/checkout/sessions`）を
 * 採っているため、規則ベースで解決したうえで実スペックのパスと突き合わせて検証する。
 */

export interface SdkConvention {
  provider: string;
  /** import 元のモジュール名 */
  modules: string[];
  /** スペック上のパス接頭辞（Stripe は `/v1`、OpenAI は servers に含まれるため空） */
  pathPrefix: string;
  /** パス解決時に読み飛ばす名前空間（OpenAI の `beta` など） */
  ignoredSegments: string[];
}

export const SDK_CONVENTIONS: SdkConvention[] = [
  { provider: 'stripe', modules: ['stripe'], pathPrefix: '/v1', ignoredSegments: [] },
  { provider: 'openai', modules: ['openai'], pathPrefix: '', ignoredSegments: ['beta'] },
];

export const findConvention = (moduleName: string): SdkConvention | undefined =>
  SDK_CONVENTIONS.find((c) => c.modules.includes(moduleName));

interface VerbRule {
  method: HttpMethod;
  /** `collection` … `/resources`、`instance` … `/resources/{id}` */
  target: 'collection' | 'instance';
  /** 末尾に付与するサブパス（`search` など） */
  suffix?: string;
}

const VERB_RULES: Record<string, VerbRule> = {
  create: { method: 'post', target: 'collection' },
  list: { method: 'get', target: 'collection' },
  search: { method: 'get', target: 'collection', suffix: 'search' },
  retrieve: { method: 'get', target: 'instance' },
  update: { method: 'post', target: 'instance' },
  del: { method: 'delete', target: 'instance' },
  delete: { method: 'delete', target: 'instance' },
};

const camelToSnake = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/** パスパラメータ名はスペックごとに異なる（`{charge}` / `{session}`）ため `{}` に正規化する。 */
const normalizePath = (path: string): string => path.replace(/\{[^}]*\}/g, '{}');

/** スペックに実在する操作だけを引けるようにした索引。 */
export class OperationIndex {
  private readonly byNormalizedPath = new Map<string, { path: string; methods: Set<HttpMethod>; operationIds: Map<HttpMethod, string | undefined> }>();

  constructor(doc: OpenApiDocument) {
    for (const { ref } of iterateOperations(doc)) {
      const key = normalizePath(ref.path);
      const entry = this.byNormalizedPath.get(key) ?? { path: ref.path, methods: new Set(), operationIds: new Map() };
      entry.methods.add(ref.method);
      entry.operationIds.set(ref.method, ref.operationId);
      this.byNormalizedPath.set(key, entry);
    }
  }

  lookup(normalizedPath: string, method: HttpMethod): OperationRef | undefined {
    const entry = this.byNormalizedPath.get(normalizedPath);
    if (!entry || !entry.methods.has(method)) return undefined;
    const operationId = entry.operationIds.get(method);
    return { method, path: entry.path, ...(operationId ? { operationId } : {}) };
  }
}

/**
 * 呼び出しチェーン（クライアント変数名を除く）から操作を解決する。
 * 例: `['checkout', 'sessions', 'create']` → `POST /v1/checkout/sessions`
 */
export function resolveOperation(
  convention: SdkConvention,
  chain: string[],
  index: OperationIndex,
): OperationRef | undefined {
  if (chain.length < 2) return undefined;

  const verb = chain[chain.length - 1] as string;
  const segments = chain
    .slice(0, -1)
    .filter((s) => !convention.ignoredSegments.includes(s))
    .map(camelToSnake);
  if (segments.length === 0) return undefined;

  const rule = VERB_RULES[verb];

  for (const base of baseCandidates(convention.pathPrefix, segments)) {
    // 既知の動詞（create/retrieve/...）
    if (rule) {
      const path =
        rule.suffix !== undefined
          ? `${base}/${rule.suffix}`
          : rule.target === 'instance'
            ? `${base}/{}`
            : base;
      const found = index.lookup(path, rule.method);
      if (found) return found;
      continue;
    }

    // 未知の動詞はリソース固有アクションとみなす（`charges.capture` → POST /v1/charges/{}/capture）
    const action = camelToSnake(verb);
    const found = index.lookup(`${base}/{}/${action}`, 'post') ?? index.lookup(`${base}/${action}`, 'post');
    if (found) return found;
  }
  return undefined;
}

/**
 * リソースパスの候補を生成する。
 *
 * ネストしたサブリソースは、親 ID がパスに挟まる形になることがある
 * （`openai.beta.threads.messages` → `/threads/{thread_id}/messages`）ため、
 * 素の連結と、親セグメントごとに ID を挟んだ形の両方を候補にする。
 */
function baseCandidates(prefix: string, segments: string[]): string[] {
  const plain = `${prefix}/${segments.join('/')}`;
  if (segments.length < 2) return [plain];

  const interleaved = `${prefix}/${segments.slice(0, -1).map((s) => `${s}/{}`).join('/')}/${segments[segments.length - 1]}`;
  return [plain, interleaved];
}
