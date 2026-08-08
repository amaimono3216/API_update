/** OpenAPI ドキュメントは巨大かつベンダ拡張が多いため、必要な部分だけを緩く型付けする。 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface OpenApiSchema {
  $ref?: string;
  type?: string | string[];
  format?: string;
  enum?: JsonValue[];
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  items?: OpenApiSchema;
  anyOf?: OpenApiSchema[];
  oneOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  nullable?: boolean;
  additionalProperties?: boolean | OpenApiSchema;
  deprecated?: boolean;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: OpenApiSchema;
  [key: string]: unknown;
}

export interface OpenApiMediaType {
  schema?: OpenApiSchema;
  [key: string]: unknown;
}

export interface OpenApiOperation {
  operationId?: string;
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, OpenApiMediaType> };
  responses?: Record<string, { content?: Record<string, OpenApiMediaType> } | undefined>;
  [key: string]: unknown;
}

export type OpenApiPathItem = Record<string, OpenApiOperation | unknown>;

export interface OpenApiDocument {
  openapi?: string;
  info?: { version?: string; title?: string; [key: string]: unknown };
  paths?: Record<string, OpenApiPathItem>;
  components?: { schemas?: Record<string, OpenApiSchema>; [key: string]: unknown };
  [key: string]: unknown;
}

/** HTTP メソッドのみを走査対象とする（parameters / summary 等の兄弟キーを除外するため）。 */
export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * 破壊的変更の種別。
 * `request` 方向はリクエスト送信側（＝ターゲットリポジトリのコード）が壊れるもの、
 * `response` 方向はレスポンス受信側の処理が壊れるもの。
 */
export type BreakingChangeKind =
  | 'path_removed'
  | 'operation_removed'
  | 'parameter_removed'
  | 'parameter_required_added'
  | 'parameter_type_changed'
  | 'request_body_removed'
  | 'request_content_type_removed'
  | 'schema_removed'
  | 'property_removed'
  | 'property_type_changed'
  | 'required_added'
  | 'required_removed'
  | 'enum_value_removed'
  | 'enum_value_added'
  | 'response_status_removed'
  | 'operation_deprecated';

export type Severity = 'breaking' | 'warning';

export interface BreakingChange {
  kind: BreakingChangeKind;
  severity: Severity;
  /** 変更が属する方向。schema 単体の差分では参照元から解決する。 */
  direction: 'request' | 'response' | 'both';
  /** 変更箇所を一意に指す JSON Pointer 風のロケーション。例: `paths./v1/charges.post.requestBody.amount` */
  location: string;
  /**
   * スキーマ内での相対プロパティパス（例: `line_items.[].amount`）。
   * ② 影響範囲特定モジュールが、呼び出し側で実際に渡している引数名と突き合わせるために使う。
   * エンドポイント自体の廃止など、プロパティ単位でない変更では undefined。
   */
  propertyPath?: string;
  /** 影響を受ける API 操作。schema 由来の変更は逆引きインデックスで補完される。 */
  operations: OperationRef[];
  before: JsonValue | undefined;
  after: JsonValue | undefined;
  /** 日本語の説明文。PR 概要欄・LLM プロンプトにそのまま利用する。 */
  message: string;
}

export interface OperationRef {
  method: HttpMethod;
  path: string;
  operationId?: string;
}
