import type { JsonValue, OpenApiDocument } from './types.js';

/**
 * Swagger 2.0 のドキュメントを OpenAPI 3 相当の構造へ正規化する。
 *
 * 差分エンジン（schema-diff / ref-index / diff）は OpenAPI 3 の構造を前提にしている。
 * 取得時にここで吸収しておけば、既にテストで守られている差分ロジックを一切変更せずに
 * Swagger 2.0 のサービス（Slack など）を扱える。
 *
 * 変換するのは差分検出に必要な範囲だけで、完全な変換器ではない。
 */

const isObject = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Swagger 2.0 かどうか。 */
export const isSwagger2 = (doc: OpenApiDocument): boolean =>
  typeof (doc as Record<string, unknown>)['swagger'] === 'string' &&
  String((doc as Record<string, unknown>)['swagger']).startsWith('2');

/** `#/definitions/X` を `#/components/schemas/X` に書き換える。 */
function rewriteRefs(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(rewriteRefs);
  if (!isObject(value)) return value;

  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$ref' && typeof child === 'string' && child.startsWith('#/definitions/')) {
      result[key] = child.replace('#/definitions/', '#/components/schemas/');
      continue;
    }
    result[key] = rewriteRefs(child);
  }
  return result;
}

/**
 * Swagger 2.0 の parameters を OpenAPI 3 の requestBody + parameters に分解する。
 *
 * - `in: body`     → requestBody（スキーマそのもの）
 * - `in: formData` → requestBody（各パラメータをプロパティとして持つオブジェクト）
 * - それ以外        → parameters のまま残す
 */
function convertParameters(operation: Record<string, JsonValue>): void {
  const parameters = operation['parameters'];
  if (!Array.isArray(parameters)) return;

  const remaining: JsonValue[] = [];
  const formDataProperties: Record<string, JsonValue> = {};
  const formDataRequired: string[] = [];
  let bodySchema: JsonValue | undefined;

  for (const parameter of parameters) {
    if (!isObject(parameter)) {
      remaining.push(parameter);
      continue;
    }

    const location = parameter['in'];
    if (location === 'body') {
      bodySchema = parameter['schema'];
      continue;
    }
    if (location === 'formData') {
      const name = parameter['name'];
      if (typeof name !== 'string') continue;
      // type / format / description などをそのままプロパティ定義として使う
      const { in: _in, name: _name, required, ...rest } = parameter;
      formDataProperties[name] = rest as JsonValue;
      if (required === true) formDataRequired.push(name);
      continue;
    }
    remaining.push(parameter);
  }

  operation['parameters'] = remaining;

  const schema =
    bodySchema ??
    (Object.keys(formDataProperties).length > 0
      ? ({
          type: 'object',
          properties: formDataProperties,
          ...(formDataRequired.length > 0 ? { required: formDataRequired } : {}),
        } as JsonValue)
      : undefined);

  if (schema === undefined) return;

  const mediaType = bodySchema ? 'application/json' : 'application/x-www-form-urlencoded';
  operation['requestBody'] = { content: { [mediaType]: { schema } } } as JsonValue;
}

/** Swagger 2.0 のレスポンス（`schema` 直下）を OpenAPI 3 の `content` 形式にする。 */
function convertResponses(operation: Record<string, JsonValue>): void {
  const responses = operation['responses'];
  if (!isObject(responses)) return;

  for (const response of Object.values(responses)) {
    if (!isObject(response)) continue;
    const schema = response['schema'];
    if (schema === undefined) continue;

    response['content'] = { 'application/json': { schema } } as JsonValue;
    delete response['schema'];
  }
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

/**
 * Swagger 2.0 なら OpenAPI 3 相当へ変換し、そうでなければそのまま返す。
 */
export function normalizeDocument(doc: OpenApiDocument): OpenApiDocument {
  if (!isSwagger2(doc)) return doc;

  const converted = rewriteRefs(doc as unknown as JsonValue) as unknown as Record<string, JsonValue>;

  // definitions → components.schemas
  const definitions = converted['definitions'];
  if (isObject(definitions)) {
    const components = isObject(converted['components']) ? converted['components'] : {};
    components['schemas'] = definitions;
    converted['components'] = components as JsonValue;
    delete converted['definitions'];
  }

  const paths = converted['paths'];
  if (isObject(paths)) {
    for (const pathItem of Object.values(paths)) {
      if (!isObject(pathItem)) continue;
      for (const [method, operation] of Object.entries(pathItem)) {
        if (!HTTP_METHODS.includes(method) || !isObject(operation)) continue;
        convertParameters(operation);
        convertResponses(operation);
      }
    }
  }

  // 変換済みであることを示す（差分エンジンは openapi フィールドを見ない）
  converted['openapi'] = '3.0.0';
  delete converted['swagger'];

  return converted as unknown as OpenApiDocument;
}
