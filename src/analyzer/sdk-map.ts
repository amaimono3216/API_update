import { iterateOperations } from '../detector/ref-index.js';
import slackGoMap from './slack-go-map.json' with { type: 'json' };
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

/** 語の区切り記号を落とした形。Go のパッケージ名は区切りを持たない（`paymentintent`）ため。 */
const squashPath = (path: string): string => path.replace(/[_-]/g, '');

interface IndexEntry {
  path: string;
  methods: Set<HttpMethod>;
  operationIds: Map<HttpMethod, string | undefined>;
}

/** スペックに実在する操作だけを引けるようにした索引。 */
export class OperationIndex {
  private readonly byNormalizedPath = new Map<string, IndexEntry>();
  private readonly bySquashedPath = new Map<string, IndexEntry>();

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
      // 区切りを落とすと別のパスと衝突しうるので、先に登録された方を残す
      const squashed = squashPath(key);
      if (squashed !== key && !this.bySquashedPath.has(squashed)) this.bySquashedPath.set(squashed, entry);
    }
  }

  lookup(normalizedPath: string, method: HttpMethod): OperationRef | undefined {
    return toRef(this.byNormalizedPath.get(normalizedPath), method);
  }

  /**
   * 語の区切りを無視して引く。
   *
   * Go の stripe-go はリソースを `paymentintent` のようなパッケージ名で表し、
   * 区切りの位置が失われている。
   */
  lookupSquashed(normalizedPath: string, method: HttpMethod): OperationRef | undefined {
    return (
      this.lookup(normalizedPath, method) ?? toRef(this.bySquashedPath.get(squashPath(normalizedPath)), method)
    );
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

function toRef(entry: IndexEntry | undefined, method: HttpMethod): OperationRef | undefined {
  if (!entry || !entry.methods.has(method)) return undefined;
  const operationId = entry.operationIds.get(method);
  return { method, path: entry.path, ...(operationId ? { operationId } : {}) };
}

/** 呼び出しチェーン（クライアント変数名を除く）から操作を解決する。 */
export type PathResolver = (chain: string[], index: OperationIndex) => OperationRef | undefined;

export type SourceLanguage = 'typescript' | 'python' | 'go';

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
  /**
   * リソースが呼び出しではなく import パスで表される SDK 向け
   * （stripe-go の `.../v84/checkout/session`）。
   * import パスから取り出したセグメントを渡すと、その import 専用の解決関数を返す。
   */
  resolveFromPackagePath?: (segments: string[]) => PathResolver;
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

/**
 * `stripe.PaymentIntent.create()` → `/v1/payment_intents` のように、
 * リソースを単数形のクラス名で表す書き方向けの解決関数。
 *
 * Stripe の Python SDK は歴史的にこの形で、現行の `client.v1.payment_intents` 形式と
 * 併存している。クラス名から単複を機械的には決められないので、候補を作って
 * 実スペックに存在するものを採用する。
 */
export function classNamespaceResolver(options: { pathPrefix: string }): PathResolver {
  const inner = restNamespaceResolver({ pathPrefix: options.pathPrefix });

  return (chain, index) => {
    if (chain.length < 2) return undefined;

    const verb = chain[chain.length - 1] as string;
    const segments = chain.slice(0, -1);
    // クラス名を含まない呼び出しは現行形式の resolver の担当
    if (!segments.some((s) => /^[A-Z]/.test(s))) return undefined;

    for (const candidate of segmentVariants(segments)) {
      const found = inner([...candidate, verb], index);
      if (found) return found;
    }
    return undefined;
  };
}

/** PascalCase のセグメントだけを snake_case 化し、単数形・複数形の両方を試す。 */
function segmentVariants(segments: string[]): string[][] {
  let variants: string[][] = [[]];

  for (const segment of segments) {
    const options = /^[A-Z]/.test(segment) ? pluralCandidates(camelToSnake(segment)) : [segment];
    variants = variants.flatMap((prefix) => options.map((option) => [...prefix, option]));
  }
  return variants;
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

// ---------------------------------------------------------------------------
// Go: リソースパスが 1 つの PascalCase 識別子に連結されている
// ---------------------------------------------------------------------------

const GO_VERB_RULES: Record<string, VerbRule> = {
  new: { method: 'post', target: 'collection' },
  create: { method: 'post', target: 'collection' },
  list: { method: 'get', target: 'collection' },
  get: { method: 'get', target: 'instance' },
  retrieve: { method: 'get', target: 'instance' },
  update: { method: 'post', target: 'instance' },
  del: { method: 'delete', target: 'instance' },
  delete: { method: 'delete', target: 'instance' },
};

/**
 * `V1PaymentIntents` を `['V1', 'Payment', 'Intents']` に分割する。
 *
 * 数字は直前の語に含める（`V1` を `V` と `1` に割らない）。
 * 連続する大文字は略語として 1 語にまとめる（`HTTPProxy` → `HTTP` / `Proxy`）。
 */
export const splitPascalCase = (value: string): string[] =>
  value.match(/[A-Z][a-z0-9]+|[A-Z]+(?![a-z])|[a-z0-9]+/g) ?? [];

/** 語の隣接関係を `_`（同一セグメント）か `/`（セグメント区切り）で埋める全通りを返す。 */
function joinCombinations(words: string[], limit: number): string[] {
  if (words.length === 0) return [];
  if (words.length > limit) return [words.map((w) => w.toLowerCase()).join('/')];

  const results: string[] = [];
  const total = 2 ** (words.length - 1);
  for (let mask = 0; mask < total; mask += 1) {
    let path = words[0]?.toLowerCase() ?? '';
    for (let i = 1; i < words.length; i += 1) {
      path += (mask & (1 << (i - 1))) === 0 ? `/${words[i]?.toLowerCase()}` : `_${words[i]?.toLowerCase()}`;
    }
    results.push(path);
  }
  return results;
}

/**
 * Go の SDK 向け。`sc.V1Customers.Create` → `POST /v1/customers` のように、
 * パスの区切りが失われた PascalCase 識別子からパスを復元する。
 *
 * `V1PaymentIntents` は `/v1/payment/intents` とも `/v1/payment_intents` とも読めるため、
 * 語の区切り方を総当たりし、実スペックに存在するものだけを採用する。
 */
export function goIdentifierResolver(options: { maxWords?: number } = {}): PathResolver {
  const limit = options.maxWords ?? 6;

  return (chain, index) => {
    if (chain.length < 2) return undefined;

    const verb = (chain[chain.length - 1] ?? '').toLowerCase();
    const rule = GO_VERB_RULES[verb];
    if (!rule) return undefined;

    const words = chain.slice(0, -1).flatMap((segment) => splitPascalCase(segment));
    if (words.length === 0) return undefined;

    for (const base of joinCombinations(words, limit)) {
      const path = rule.target === 'instance' ? `/${base}/{}` : `/${base}`;
      const found = index.lookup(path, rule.method);
      if (found) return found;
    }
    return undefined;
  };
}

/**
 * `session.New(params)` → `POST /v1/checkout/sessions` のように、
 * リソースを呼び出しではなく import パスで表す Go SDK 向け。
 *
 * stripe-go はリソースごとにパッケージが分かれており
 * （`github.com/stripe/stripe-go/v84/checkout/session`）、呼び出し側には
 * `session.New` としか現れない。パスの情報は import にしか無いため、
 * import から取り出したセグメントを渡してもらう。
 */
export function goPackagePathResolver(segments: string[], options: { pathPrefix?: string } = {}): PathResolver {
  const prefix = options.pathPrefix ?? '';
  // パッケージ名は単数形（`session`）、パスは複数形（`sessions`）
  const bases = pathVariants(segments);

  return (chain, index) => {
    // `session.New` の 1 段だけを対象にする
    if (chain.length !== 1) return undefined;

    const rule = GO_VERB_RULES[(chain[0] ?? '').toLowerCase()];
    if (!rule) return undefined;

    for (const base of bases) {
      const path = rule.target === 'instance' ? `${prefix}/${base}/{}` : `${prefix}/${base}`;
      const found = index.lookupSquashed(path, rule.method);
      if (found) return found;
    }
    return undefined;
  };
}

/** 末尾セグメントの単数形・複数形を候補にする。 */
function pathVariants(segments: string[]): string[] {
  if (segments.length === 0) return [];

  const head = segments.slice(0, -1);
  const last = segments[segments.length - 1] as string;
  return pluralCandidates(last).map((word) => [...head, word].join('/'));
}

/**
 * メソッド名 → API のメソッド名の対応表で引く。
 *
 * 規則で対応づけられない SDK（Slack の Go SDK など）向け。表は
 * `npm run generate:slack-go-map` で SDK のソースから生成する。
 * 引いた結果は必ず実スペックと突き合わせるので、表が古くなっても
 * 存在しないパスを指すことはない。
 */
export function tableResolver(table: Record<string, string>, options: { pathPrefix?: string } = {}): PathResolver {
  const prefix = options.pathPrefix ?? '';

  return (chain, index) => {
    const method = chain[chain.length - 1];
    if (!method) return undefined;

    const endpoint = table[method];
    if (!endpoint) return undefined;

    return index.lookupAny(`${prefix}/${endpoint}`, ['post', 'get']);
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

    return lookupTwilioPath(index, [segments], rule, options.pathPrefix);
  };
}

/** リソース名を含むパス候補を順に引く。アカウント配下と直下の両方を試す。 */
function lookupTwilioPath(
  index: OperationIndex,
  candidates: string[][],
  rule: VerbRule,
  pathPrefix: string,
): OperationRef | undefined {
  for (const segments of candidates) {
    const joined = segments.join('/');
    for (const base of [`${pathPrefix}/Accounts/{}/${joined}`, `${pathPrefix}/${joined}`]) {
      const path = rule.target === 'instance' ? `${base}/{}.json` : `${base}.json`;
      const found = index.lookup(path, rule.method);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * 単数形の英単語から複数形の候補を返す。
 *
 * 英語の複数形は不規則なので 1 つに決めず、候補を出して実スペックに存在するものを採る。
 */
export function pluralCandidates(word: string): string[] {
  const candidates = [word];
  if (/[^aeiou]y$/i.test(word)) candidates.push(`${word.slice(0, -1)}ies`);
  if (/(s|sh|ch|x|z)$/i.test(word)) candidates.push(`${word}es`);
  candidates.push(`${word}s`);
  return [...new Set(candidates)];
}

/** 語の並びの末尾だけを複数形にした候補を返す（`IncomingPhoneNumber` → `IncomingPhoneNumbers`）。 */
function pluralizeSegment(words: string[]): string[] {
  const last = words[words.length - 1];
  if (!last) return [];
  const prefix = words.slice(0, -1).join('');
  return pluralCandidates(last).map((plural) => `${prefix}${plural}`);
}

const TWILIO_GO_VERB_RULES: Record<string, VerbRule> = {
  Create: { method: 'post', target: 'collection' },
  Delete: { method: 'delete', target: 'instance' },
  Fetch: { method: 'get', target: 'instance' },
  Update: { method: 'post', target: 'instance' },
  List: { method: 'get', target: 'collection' },
  Page: { method: 'get', target: 'collection' },
  Stream: { method: 'get', target: 'collection' },
};

/**
 * Twilio の Go SDK 向け。`client.Api.CreateMessage(...)` → `POST /2010-04-01/Accounts/{}/Messages.json`。
 *
 * メソッド名は `<動詞><リソース単数形>` の規則になっている。リソースは単数形なので
 * 複数形の候補を作り、さらに親子リソースの区切り位置も総当たりして、
 * 実スペックに存在するパスだけを採用する。
 */
export function twilioGoResolver(options: { pathPrefix: string }): PathResolver {
  return (chain, index) => {
    const method = chain[chain.length - 1];
    if (!method) return undefined;

    // `CreateMessageWithMetadata` のような派生も同じ操作を指す
    const name = method.replace(/WithMetadata$/, '');
    const verb = Object.keys(TWILIO_GO_VERB_RULES).find((v) => name.startsWith(v) && name.length > v.length);
    if (!verb) return undefined;

    const rule = TWILIO_GO_VERB_RULES[verb] as VerbRule;
    const words = splitPascalCase(name.slice(verb.length));
    if (words.length === 0) return undefined;

    return lookupTwilioPath(index, twilioResourceCandidates(words), rule, options.pathPrefix);
  };
}

/**
 * `MessageFeedback` が 1 つのリソースか、`Messages/{}/Feedback` の親子かは名前から決まらない。
 * 区切り位置を総当たりし、それぞれ複数形の候補を展開する。
 */
function twilioResourceCandidates(words: string[]): string[][] {
  const candidates: string[][] = [];

  // 全体で 1 つのリソースとみなす場合
  for (const segment of pluralizeSegment(words)) candidates.push([segment]);

  // 親子に分ける場合（親 ID がパスに挟まる）
  for (let i = 1; i < words.length; i += 1) {
    for (const parent of pluralizeSegment(words.slice(0, i))) {
      for (const child of pluralizeSegment(words.slice(i))) {
        candidates.push([parent, '{}', child]);
      }
    }
  }
  return candidates;
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
    // v1 を含まない書き方と、`stripe.PaymentIntent.create` という旧来の
    // クラス形式も現役なので、順に試す。
    resolve: firstMatchResolver(
      restNamespaceResolver({ pathPrefix: '' }),
      restNamespaceResolver({ pathPrefix: '/v1' }),
      classNamespaceResolver({ pathPrefix: '/v1' }),
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

  // --- Go ---
  {
    provider: 'twilio',
    language: 'go',
    modules: ['github.com/twilio/twilio-go'],
    clientNames: ['twilio', 'client'],
    // `client.Api.CreateMessage` のように `<動詞><リソース単数形>` の命名
    resolve: twilioGoResolver({ pathPrefix: '/2010-04-01' }),
  },
  {
    provider: 'slack',
    language: 'go',
    modules: ['github.com/slack-go/slack'],
    clientNames: ['slack', 'api'],
    // メソッド名が API のパスから導けないため、SDK のソースから生成した表で引く
    resolve: tableResolver(slackGoMap),
  },
  {
    provider: 'stripe',
    language: 'go',
    modules: ['github.com/stripe/stripe-go'],
    clientNames: ['sc', 'stripe'],
    // `sc.V1Customers.Create` のようにパスが 1 語に連結されている
    resolve: goIdentifierResolver(),
    // 従来はリソースごとにパッケージが分かれており、`session.New(params)` と呼ぶ
    resolveFromPackagePath: (segments) => goPackagePathResolver(segments, { pathPrefix: '/v1' }),
  },
  {
    provider: 'openai',
    language: 'go',
    modules: ['github.com/openai/openai-go'],
    clientNames: ['openai'],
    // `client.Chat.Completions.New` は名前空間が分かれているが、
    // goIdentifierResolver が全セグメントを語に分解して扱うため同じ経路で解決できる
    resolve: goIdentifierResolver(),
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
