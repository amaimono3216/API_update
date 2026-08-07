import { HTTP_METHODS, type HttpMethod, type OpenApiDocument, type OpenApiOperation, type OperationRef } from './types.js';

export type RefDirection = 'request' | 'response' | 'both';

const SCHEMA_REF_PREFIX = '#/components/schemas/';

export const mergeDirection = (a: RefDirection | undefined, b: RefDirection): RefDirection =>
  a === undefined || a === b ? b : 'both';

/** 任意の JSON 断片から `#/components/schemas/*` の参照名を収集する。 */
function collectRefs(node: unknown, out: Set<string>, depth = 0): Set<string> {
  if (depth > 30 || node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
      out.add(value.slice(SCHEMA_REF_PREFIX.length));
      continue;
    }
    collectRefs(value, out, depth + 1);
  }
  return out;
}

export function* iterateOperations(doc: OpenApiDocument): Generator<{ ref: OperationRef; operation: OpenApiOperation }> {
  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const operation = (pathItem as Record<string, unknown>)[method];
      if (!operation || typeof operation !== 'object') continue;
      const op = operation as OpenApiOperation;
      yield { ref: { method: method as HttpMethod, path, operationId: op.operationId }, operation: op };
    }
  }
}

/**
 * 「スキーマ名 → それを参照する操作」を逆引きするためのインデックス。
 *
 * 参照は推移的（操作 → A → B）なので、スキーマ間の逆辺も保持し、
 * 変更されたスキーマから後ろ向きに BFS して影響操作を求める。
 */
export class RefIndex {
  /** スキーマ名 → そのスキーマを直接参照しているスキーマ名 */
  private readonly parents = new Map<string, Set<string>>();
  /** スキーマ名 → そのスキーマを直接参照している操作 */
  private readonly directOperations = new Map<string, Array<{ ref: OperationRef; direction: RefDirection }>>();

  constructor(doc: OpenApiDocument) {
    for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
      for (const child of collectRefs(schema, new Set())) {
        if (child === name) continue; // 自己参照は無視
        this.addParent(child, name);
      }
    }

    for (const { ref, operation } of iterateOperations(doc)) {
      const requestNode = { parameters: operation.parameters, requestBody: operation.requestBody };
      for (const name of collectRefs(requestNode, new Set())) this.addOperation(name, ref, 'request');
      for (const name of collectRefs(operation.responses, new Set())) this.addOperation(name, ref, 'response');
    }
  }

  private addParent(child: string, parent: string): void {
    const set = this.parents.get(child) ?? new Set<string>();
    set.add(parent);
    this.parents.set(child, set);
  }

  private addOperation(name: string, ref: OperationRef, direction: RefDirection): void {
    const list = this.directOperations.get(name) ?? [];
    list.push({ ref, direction });
    this.directOperations.set(name, list);
  }

  /** 指定スキーマの変更が影響する操作を、参照グラフを遡って列挙する。 */
  findOperations(schemaName: string): { operations: OperationRef[]; direction: RefDirection } {
    const visited = new Set<string>([schemaName]);
    const queue = [schemaName];
    const found = new Map<string, OperationRef>();
    let direction: RefDirection | undefined;

    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const { ref, direction: dir } of this.directOperations.get(current) ?? []) {
        found.set(`${ref.method} ${ref.path}`, ref);
        direction = mergeDirection(direction, dir);
      }
      for (const parent of this.parents.get(current) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        queue.push(parent);
      }
    }

    return { operations: [...found.values()], direction: direction ?? 'response' };
  }
}
