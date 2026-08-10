import { iterateOperations } from '../detector/ref-index.js';
import type { HttpMethod, OpenApiDocument, OperationRef } from '../detector/types.js';

/**
 * SDK の呼び出しチェーンを OpenAPI の操作に対応づける。
 *
 * 対応づけの規則は SDK ごとに大きく異なるため、プロバイダごとに解決関数を持たせる。
 *
 *   Stripe : stripe.checkout.sessions.create → POST /v1/checkout/sessions
 *   Slack  : client.chat.postMessage         → POST /chat.postMessage
 *   Twilio : client.messages.create          → POST /2010-04-01/Accounts/{AccountSid}/Messages.json
 *
 * いずれの規則も推測を含むため、生成した候補は必ず実スペックのパスと突き合わせて検証する。
 */

/** パスパラメータ名はスペックごとに異なる（`{charge}` / `{Sid}`）ため `{}` に正規化する。 */
const normalizePath = (path: string): string => path.replace(/\{[^}]*\}/g, '{}');

/** スペックに実在する操作だけを引けるようにした索引。 */
export class OperationIndex {
  private readonly byNormalizedPath = new Map<
    string,
    { path: string; methods: Set<HttpMethod>; operationIds: Map<HttpMethod, string | undefined> }
  >();

  constructor(doc: OpenApiDocument) {
    for (const { ref } of iterateOperations(doc)) {
      const key = normalizePath(ref.path);
      const entry = this.byNormalizedPath.get(key) ?? {
        path: ref.path,
        methods: new Set<HttpMethod>(),
        operationIds: new Map<HttpMethod, string | undefined>(),
      };
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

  /** 指定したメソッドのうち、最初に見つかったものを返す。 */
  lookupAny(normalizedPath: string, methods: HttpMethod[]): OperationRef | undefined {
    for (const method of methods) {
      const found = this.lookup(normalizedPath, method);
      if (found) return found;
    }
    return undefined;
  }
}

/** 呼び出しチェーン（クライアント変数名を除く）から操作を解決する。 */
export type PathResolver = (chain: string[], index: OperationIndex) => OperationRef | undefined;

export type SourceLanguage = 'typescript' | 'python';

export interface SdkConvention {
  provider: string;
  /** 同じプロバイダでも言語ごとに呼び出しの形が違うため、言語を持たせる */
  language: SourceLanguage;
  /** import 元のモジュール名 */
  modules: string[];
  /**
   * クライアントが別ファイルで生成されている場合に、変数名から推定するための候補。
   * 例: `import { slack } from './lib/slack'` の `slack`
   */
  clientNames: string[];
  resolve: PathResolver;
}

const camelToSnake = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const toPascalCase = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

interface VerbRule {
  method: HttpMethod;
  /** `collection` … `/resources`、`instance` … `/resources/{id}` */
  target: 'collection' | 'instance';
  /** 末尾に付与するサブパス（`search` など） */
  suffix?: string;
}

// ---------------------------------------------------------------------------
// Stripe / OpenAI: 名前空間がリソースパスに 1:1 対応する
// ---------------------------------------------------------------------------

const REST_VERB_RULES: Record<string, VerbRule> = {
  create: { method: 'post', target: 'collection' },
  list: { method: 'get', target: 'collection' },
  search: { method: 'get', target: 'collection', suffix: 'search' },
  retrieve: { method: 'get', target: 'instance' },
  update: { method: 'post', target: 'instance' },
  del: { method: 'delete', target: 'instance' },
  delete: { method: 'delete', target: 'instance' },
};

/**
 * リソース名前空間がそのままパスになる SDK 向けの解決関数。
 *
 * ネストしたサブリソースは親 ID がパスに挟まることがある
 * （`openai.beta.threads.messages` → `/threads/{thread_id}/messages`）ため、
 * 素の連結と ID を挟んだ形の両方を候補にする。
 */
export function restNamespaceResolver(options: { pathPrefix: string; ignoredSegments?: string[] }): PathResolver {
  const ignored = options.ignoredSegments ?? [];

  return (chain, index) => {
    if (chain.length < 2) return undefined;

    const verb = chain[chain.length - 1] as string;
    const segments = chain
      .slice(0, -1)
      .filter((s) => !ignored.includes(s))
      .map(camelToSnake);
    if (segments.length === 0) return undefined;

    const rule = REST_VERB_RULES[verb];

    for (const base of interleavedBases(options.pathPrefix, segments)) {
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
  };
}

/** 素の連結と、親セグメントごとに ID を挟んだ形の 2 通りを返す。 */
function interleavedBases(prefix: string, segments: string[]): string[] {
  const plain = `${prefix}/${segments.join('/')}`;
  if (segments.length < 2) return [plain];

  const interleaved = `${prefix}/${segments
    .slice(0, -1)
    .map((s) => `${s}/{}`)
    .join('/')}/${segments[segments.length - 1]}`;
  return [plain, interleaved];
}

// ---------------------------------------------------------------------------
// Slack: メソッド名をドットで連結したものがそのままパスになる
// ---------------------------------------------------------------------------

/**
 * `client.chat.postMessage()` → `/chat.postMessage` のように、
 * 呼び出しチェーンをドット結合したものがパスになる SDK 向け（Slack の Node SDK）。
 */
export function dottedMethodResolver(options: { pathPrefix?: string } = {}): PathResolver {
  const prefix = options.pathPrefix ?? '';

  return (chain, index) => {
    if (chain.length < 2) return undefined;
    // Slack Web API は POST が基本だが、一部 GET のみの操作がある
    return index.lookupAny(`${prefix}/${chain.join('.')}`, ['post', 'get']);
  };
}

/**
 * `client.chat_postMessage()` → `/chat.postMessage` のように、
 * メソッド名のアンダースコアがパスの区切りになる SDK 向け（Slack の Python SDK）。
 */
export function underscoreMethodResolver(options: { pathPrefix?: string } = {}): PathResolver {
  const prefix = options.pathPrefix ?? '';

  return (chain, index) => {
    // Python 版はメソッド 1 つで完結する（`client.chat_postMessage`）
    const method = chain[chain.length - 1];
    if (!method || !method.includes('_')) return undefined;
    return index.lookupAny(`${prefix}/${method.replace(/_/g, '.')}`, ['post', 'get']);
  };
}

/** 複数の解決方法を順に試す。SDK のバージョン差を吸収するために使う。 */
export function firstMatchResolver(...resolvers: PathResolver[]): PathResolver {
  return (chain, index) => {
    for (const resolve of resolvers) {
      const found = resolve(chain, index);
      if (found) return found;
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Twilio: リソースは PascalCase、パスにアカウント SID と `.json` が入る
// ---------------------------------------------------------------------------

const TWILIO_VERB_RULES: Record<string, VerbRule> = {
  create: { method: 'post', target: 'collection' },
  list: { method: 'get', target: 'collection' },
  page: { method: 'get', target: 'collection' },
  each: { method: 'get', target: 'collection' },
  fetch: { method: 'get', target: 'instance' },
  update: { method: 'post', target: 'instance' },
  remove: { method: 'delete', target: 'instance' },
};

/**
 * `client.messages.create()` → `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` 向け。
 *
 * 既知の制限: `client.messages('SM...').media.list()` のように途中に呼び出しを挟む形は、
 * チェーンが途切れるため解決できない。
 */
export function twilioResolver(options: { pathPrefix: string }): PathResolver {
  return (chain, index) => {
    if (chain.length < 2) return undefined;

    const verb = chain[chain.length - 1] as string;
    const rule = TWILIO_VERB_RULES[verb];
    if (!rule) return undefined;

    const segments = chain.slice(0, -1).map(toPascalCase);
    if (segments.length === 0) return undefined;

    // アカウント配下のリソースと、アカウント直下でないリソースの両方を試す
    const bases = [`${options.pathPrefix}/Accounts/{}/${segments.join('/')}`, `${options.pathPrefix}/${segments.join('/')}`];

    for (const base of bases) {
      const path = rule.target === 'instance' ? `${base}/{}.json` : `${base}.json`;
      const found = index.lookup(path, rule.method);
      if (found) return found;
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------

const openaiResolver = restNamespaceResolver({ pathPrefix: '', ignoredSegments: ['beta'] });
const twilioApiResolver = twilioResolver({ pathPrefix: '/2010-04-01' });

export const SDK_CONVENTIONS: SdkConvention[] = [
  // --- TypeScript / JavaScript ---
  {
    provider: 'stripe',
    language: 'typescript',
    modules: ['stripe'],
    clientNames: ['stripe'],
    resolve: restNamespaceResolver({ pathPrefix: '/v1' }),
  },
  {
    provider: 'openai',
    language: 'typescript',
    modules: ['openai'],
    clientNames: ['openai'],
    // OpenAI のスペックは servers に /v1 を含むため、パス側に接頭辞は無い
    resolve: openaiResolver,
  },
  {
    provider: 'slack',
    language: 'typescript',
    modules: ['@slack/web-api'],
    clientNames: ['slack', 'web', 'webclient'],
    resolve: dottedMethodResolver(),
  },
  {
    provider: 'twilio',
    language: 'typescript',
    modules: ['twilio'],
    clientNames: ['twilio'],
    resolve: twilioApiResolver,
  },

  // --- Python ---
  {
    provider: 'stripe',
    language: 'python',
    modules: ['stripe'],
    clientNames: ['stripe', 'stripeclient'],
    // StripeClient は `client.v1.customers.create` と、チェーンに v1 を含む。
    // v1 を含まない旧バージョンの書き方にも対応するため両方試す。
    resolve: firstMatchResolver(
      restNamespaceResolver({ pathPrefix: '' }),
      restNamespaceResolver({ pathPrefix: '/v1' }),
    ),
  },
  {
    provider: 'openai',
    language: 'python',
    modules: ['openai'],
    clientNames: ['openai'],
    resolve: openaiResolver,
  },
  {
    provider: 'slack',
    language: 'python',
    modules: ['slack_sdk', 'slack_sdk.web'],
    clientNames: ['slack', 'webclient'],
    // Python 版は `client.chat_postMessage(...)` とアンダースコア記法
    resolve: underscoreMethodResolver(),
  },
  {
    provider: 'twilio',
    language: 'python',
    modules: ['twilio', 'twilio.rest'],
    clientNames: ['twilio', 'client'],
    resolve: twilioApiResolver,
  },
];

export const findConvention = (
  moduleName: string,
  language: SourceLanguage = 'typescript',
): SdkConvention | undefined =>
  SDK_CONVENTIONS.find((c) => c.language === language && c.modules.includes(moduleName));

/** 後方互換のための薄いラッパ。呼び出し側は convention.resolve を直接使ってもよい。 */
export const resolveOperation = (
  convention: SdkConvention,
  chain: string[],
  index: OperationIndex,
): OperationRef | undefined => convention.resolve(chain, index);
