import { RefIndex, iterateOperations, type RefDirection } from './ref-index.js';
import { diffSchema, type RefResolver, type SchemaDelta } from './schema-diff.js';
import {
  HTTP_METHODS,
  type BreakingChange,
  type BreakingChangeKind,
  type JsonValue,
  type OpenApiDocument,
  type OpenApiOperation,
  type OperationRef,
  type Severity,
} from './types.js';

/** 1 変更あたりに列挙する影響操作の上限（低レイヤのスキーマは数百の操作から参照されるため）。 */
const MAX_OPERATIONS_PER_CHANGE = 20;

export interface SpecDiff {
  breakingCount: number;
  warningCount: number;
  changes: BreakingChange[];
}

/**
 * 差分の種別と方向から深刻度を決める。`null` は後方互換（＝報告不要）。
 *
 * 方向によって結論が逆転するものがある点が要点で、たとえば
 * 「必須プロパティの追加」はリクエストでは破壊的だがレスポンスでは無害、
 * 「必須の解除」はその逆になる。
 */
function classify(kind: BreakingChangeKind, direction: RefDirection): Severity | null {
  const table: Record<string, { request: Severity | null; response: Severity | null }> = {
    property_removed: { request: 'breaking', response: 'breaking' },
    property_type_changed: { request: 'breaking', response: 'breaking' },
    required_added: { request: 'breaking', response: null },
    required_removed: { request: null, response: 'breaking' },
    enum_value_removed: { request: 'breaking', response: 'warning' },
    enum_value_added: { request: null, response: 'warning' },
    // enum → 素の型。リクエストは緩和なので無害、レスポンスは未知の値が来うる
    enum_constraint_removed: { request: null, response: 'warning' },
    enum_constraint_added: { request: 'breaking', response: 'warning' },
    operation_deprecated: { request: 'warning', response: 'warning' },
  };
  const entry = table[kind];
  if (!entry) return 'breaking';
  if (direction === 'both') {
    const both = [entry.request, entry.response];
    if (both.includes('breaking')) return 'breaking';
    if (both.includes('warning')) return 'warning';
    return null;
  }
  return entry[direction];
}

const label = (op: OperationRef): string => `${op.method.toUpperCase()} ${op.path}`;

function describe(kind: BreakingChangeKind, location: string, before: JsonValue | undefined, after: JsonValue | undefined): string {
  const fmt = (v: JsonValue | undefined): string =>
    v === undefined ? 'なし' : typeof v === 'string' ? v : JSON.stringify(v);
  switch (kind) {
    case 'path_removed':
      return `エンドポイント ${location} が廃止されました。`;
    case 'operation_removed':
      return `操作 ${location} が廃止されました。`;
    case 'parameter_removed':
      return `パラメータ ${location} が削除されました。`;
    case 'parameter_required_added':
      return `パラメータ ${location} が必須になりました。`;
    case 'parameter_type_changed':
      return `パラメータ ${location} の型が ${fmt(before)} から ${fmt(after)} に変更されました。`;
    case 'request_body_removed':
      return `${location} のリクエストボディが廃止されました。`;
    case 'request_content_type_removed':
      return `${location} が受け付けていた Content-Type が削除されました (${fmt(before)})。`;
    case 'schema_removed':
      return `スキーマ ${location} が削除されました。`;
    case 'property_removed':
      return `${location} が削除されました。`;
    case 'property_type_changed':
      return `${location} の型が ${fmt(before)} から ${fmt(after)} に変更されました。`;
    case 'required_added':
      return `${location} が必須になりました。`;
    case 'required_removed':
      return `${location} が必須ではなくなりました（値が返らない場合があります）。`;
    case 'enum_value_removed':
      return `${location} から許容値 ${fmt(before)} が削除されました。`;
    case 'enum_value_added':
      return `${location} に新しい値 ${fmt(after)} が追加されました。`;
    case 'enum_constraint_removed':
      return `${location} の許容値の列挙 (${fmt(before)}) が外れ、${fmt(after)} 一般になりました。`;
    case 'enum_constraint_added':
      return `${location} が ${fmt(before)} 一般から許容値 ${fmt(after)} の列挙に限定されました。`;
    case 'response_status_removed':
      return `${location} のレスポンスが返らなくなりました。`;
    case 'operation_deprecated':
      return `${location} が非推奨になりました。`;
    default:
      return `${location} に変更がありました。`;
  }
}

function toChange(
  kind: BreakingChangeKind,
  direction: RefDirection,
  location: string,
  operations: OperationRef[],
  before: JsonValue | undefined,
  after: JsonValue | undefined,
  propertyPath?: string,
): BreakingChange | null {
  const severity = classify(kind, direction);
  if (severity === null) return null;

  const truncated = operations.length > MAX_OPERATIONS_PER_CHANGE;
  let message = describe(kind, location, before, after);
  if (truncated) {
    message += `（影響する操作は ${operations.length} 件。うち ${MAX_OPERATIONS_PER_CHANGE} 件を記載）`;
  }

  return {
    kind,
    severity,
    direction,
    location,
    ...(propertyPath ? { propertyPath } : {}),
    operations: operations.slice(0, MAX_OPERATIONS_PER_CHANGE),
    before,
    after,
    message,
  };
}

const paramKey = (p: { in?: string; name?: string }): string => `${p.in ?? 'query'}:${p.name ?? ''}`;

interface SchemaResolvers {
  resolveBefore: RefResolver;
  resolveAfter: RefResolver;
}

/** `#/components/schemas/X` を引く。他形式の `$ref` は解決しない（外部参照は扱わない）。 */
function schemaResolver(doc: OpenApiDocument): RefResolver {
  const schemas = doc.components?.schemas ?? {};
  return (ref) => {
    const name = ref.startsWith('#/components/schemas/') ? ref.slice('#/components/schemas/'.length) : undefined;
    return name ? schemas[name] : undefined;
  };
}

const isSuccessStatus = (status: string): boolean => status.startsWith('2');

/** リクエスト側の deltas とレスポンス側の deltas をまとめて BreakingChange に変換する。 */
function deltasToChanges(
  deltas: SchemaDelta[],
  direction: RefDirection,
  prefix: string,
  operations: OperationRef[],
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  for (const delta of deltas) {
    const location = delta.location ? `${prefix}.${delta.location}` : prefix;
    const change = toChange(delta.kind, direction, location, operations, delta.before, delta.after, delta.location);
    if (change) changes.push(change);
  }
  return changes;
}

function operationsOf(path: string, pathItem: unknown): OperationRef[] {
  const refs: OperationRef[] = [];
  if (!pathItem || typeof pathItem !== 'object') return refs;
  for (const method of HTTP_METHODS) {
    const op = (pathItem as Record<string, unknown>)[method];
    if (op && typeof op === 'object') {
      refs.push({ method, path, operationId: (op as OpenApiOperation).operationId });
    }
  }
  return refs;
}

/** 新旧 2 つの OpenAPI ドキュメントを比較し、破壊的変更を抽出する。 */
export function diffOpenApi(before: OpenApiDocument, after: OpenApiDocument): SpecDiff {
  const changes: BreakingChange[] = [];
  const resolvers: SchemaResolvers = {
    resolveBefore: schemaResolver(before),
    resolveAfter: schemaResolver(after),
  };

  // ---- パス / 操作の削除 ----
  const afterPaths = after.paths ?? {};
  for (const [path, pathItem] of Object.entries(before.paths ?? {})) {
    const counterpart = afterPaths[path];
    if (counterpart === undefined) {
      const change = toChange('path_removed', 'request', path, operationsOf(path, pathItem), path, undefined);
      if (change) changes.push(change);
      continue;
    }
    for (const method of HTTP_METHODS) {
      const beforeOp = (pathItem as Record<string, unknown>)[method] as OpenApiOperation | undefined;
      const afterOp = (counterpart as Record<string, unknown>)[method] as OpenApiOperation | undefined;
      if (!beforeOp || typeof beforeOp !== 'object') continue;
      const ref: OperationRef = { method, path, operationId: beforeOp.operationId };

      if (!afterOp || typeof afterOp !== 'object') {
        const change = toChange('operation_removed', 'request', label(ref), [ref], label(ref), undefined);
        if (change) changes.push(change);
        continue;
      }
      changes.push(...diffOperation(ref, beforeOp, afterOp, resolvers));
    }
  }

  // ---- components.schemas ----
  const beforeSchemas = before.components?.schemas ?? {};
  const afterSchemas = after.components?.schemas ?? {};
  const beforeIndex = new RefIndex(before);

  for (const [name, beforeSchema] of Object.entries(beforeSchemas)) {
    const { operations, direction } = beforeIndex.findOperations(name);
    const afterSchema = afterSchemas[name];

    if (afterSchema === undefined) {
      const change = toChange('schema_removed', direction, name, operations, name, undefined);
      if (change) changes.push(change);
      continue;
    }

    const deltas = diffSchema(beforeSchema, afterSchema, '', resolvers);
    if (deltas.length === 0) continue;
    changes.push(...deltasToChanges(deltas, direction, name, operations));
  }

  return {
    breakingCount: changes.filter((c) => c.severity === 'breaking').length,
    warningCount: changes.filter((c) => c.severity === 'warning').length,
    changes,
  };
}

function diffOperation(
  ref: OperationRef,
  before: OpenApiOperation,
  after: OpenApiOperation,
  resolvers: SchemaResolvers,
): BreakingChange[] {
  const changes: BreakingChange[] = [];
  const ops = [ref];
  const push = (c: BreakingChange | null): void => {
    if (c) changes.push(c);
  };

  // ---- parameters ----
  const beforeParams = new Map((before.parameters ?? []).map((p) => [paramKey(p), p]));
  const afterParams = new Map((after.parameters ?? []).map((p) => [paramKey(p), p]));

  for (const [key, beforeParam] of beforeParams) {
    const afterParam = afterParams.get(key);
    const loc = `${label(ref)} parameters.${beforeParam.name ?? key}`;
    if (!afterParam) {
      push(toChange('parameter_removed', 'request', loc, ops, beforeParam.name ?? key, undefined));
      continue;
    }
    if (afterParam.required === true && beforeParam.required !== true) {
      push(toChange('parameter_required_added', 'request', loc, ops, false, true));
    }
    changes.push(...deltasToChanges(diffSchema(beforeParam.schema, afterParam.schema, '', resolvers), 'request', loc, ops));
  }
  for (const [key, afterParam] of afterParams) {
    if (afterParam.required === true && !beforeParams.has(key)) {
      const loc = `${label(ref)} parameters.${afterParam.name ?? key}`;
      push(toChange('parameter_required_added', 'request', loc, ops, undefined, true));
    }
  }

  // ---- requestBody ----
  const beforeContent = before.requestBody?.content;
  const afterContent = after.requestBody?.content;
  if (beforeContent && !afterContent) {
    push(toChange('request_body_removed', 'request', label(ref), ops, 'requestBody', undefined));
  } else if (beforeContent && afterContent) {
    for (const [contentType, beforeMedia] of Object.entries(beforeContent)) {
      const afterMedia = afterContent[contentType];
      if (!afterMedia) {
        push(toChange('request_content_type_removed', 'request', label(ref), ops, contentType, undefined));
        continue;
      }
      const loc = `${label(ref)} requestBody`;
      changes.push(...deltasToChanges(diffSchema(beforeMedia.schema, afterMedia.schema, '', resolvers), 'request', loc, ops));
    }
  }

  // ---- responses（成功レスポンスのみ後方互換性の対象とする） ----
  for (const [status, beforeRes] of Object.entries(before.responses ?? {})) {
    if (!isSuccessStatus(status) || !beforeRes) continue;
    const afterRes = after.responses?.[status];
    if (!afterRes) {
      push(toChange('response_status_removed', 'response', `${label(ref)} responses.${status}`, ops, status, undefined));
      continue;
    }
    for (const [contentType, beforeMedia] of Object.entries(beforeRes.content ?? {})) {
      const afterMedia = afterRes.content?.[contentType];
      if (!afterMedia) continue;
      const loc = `${label(ref)} responses.${status}`;
      changes.push(...deltasToChanges(diffSchema(beforeMedia.schema, afterMedia.schema, '', resolvers), 'response', loc, ops));
    }
  }

  // ---- deprecated ----
  if (after.deprecated === true && before.deprecated !== true) {
    push(toChange('operation_deprecated', 'request', label(ref), ops, false, true));
  }

  return changes;
}

/** 差分結果の要約文（PR 概要欄・通知用）。 */
export function summarize(diff: SpecDiff): string {
  if (diff.changes.length === 0) return '破壊的変更は検出されませんでした。';
  return `破壊的変更 ${diff.breakingCount} 件、警告 ${diff.warningCount} 件を検出しました。`;
}

export { iterateOperations };
