import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { diffOpenApi } from './diff.js';
import { RefIndex } from './ref-index.js';
import { diffSchema } from './schema-diff.js';
import type { OpenApiDocument, OpenApiSchema } from './types.js';

/** 最小構成のドキュメントを組み立てるヘルパ。 */
const doc = (overrides: Partial<OpenApiDocument>): OpenApiDocument => ({
  openapi: '3.0.0',
  info: { version: 'test' },
  paths: {},
  components: { schemas: {} },
  ...overrides,
});

const kinds = (d: ReturnType<typeof diffOpenApi>): string[] => d.changes.map((c) => c.kind);

describe('diffSchema', () => {
  it('プロパティの削除と型変更を検出する', () => {
    const deltas = diffSchema(
      { type: 'object', properties: { amount: { type: 'integer' }, currency: { type: 'string' } } },
      { type: 'object', properties: { amount: { type: 'string' } } },
    );
    assert.deepEqual(
      deltas.map((d) => [d.kind, d.location]),
      [
        ['property_type_changed', 'amount'],
        ['property_removed', 'currency'],
      ],
    );
  });

  it('同一の $ref は等価とみなし、参照先の差し替えのみ型変更とする', () => {
    assert.equal(diffSchema({ $ref: '#/components/schemas/a' }, { $ref: '#/components/schemas/a' }).length, 0);
    const changed = diffSchema({ $ref: '#/components/schemas/a' }, { $ref: '#/components/schemas/b' });
    assert.equal(changed[0]?.kind, 'property_type_changed');
  });

  it('required の増減を両方向とも検出する', () => {
    const deltas = diffSchema(
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['a'] },
      { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['b'] },
    );
    assert.deepEqual(
      deltas.map((d) => [d.kind, d.location]).sort(),
      [
        ['required_added', 'b'],
        ['required_removed', 'a'],
      ].sort(),
    );
  });

  it('enum の増減を検出する', () => {
    const deltas = diffSchema({ enum: ['a', 'b'] }, { enum: ['a', 'c'] });
    assert.deepEqual(deltas.map((d) => d.kind).sort(), ['enum_value_added', 'enum_value_removed']);
  });

  describe('enum を指す $ref と素の型の入れ替わり', () => {
    const enumSchema = { type: 'string', enum: ['sms', 'calls'] };
    const resolvers = {
      resolveBefore: (ref: string) => (ref === '#/components/schemas/category' ? enumSchema : undefined),
      resolveAfter: (ref: string) => (ref === '#/components/schemas/category' ? enumSchema : undefined),
    };

    it('列挙が外れた場合は制約の解除として扱う', () => {
      const deltas = diffSchema({ $ref: '#/components/schemas/category' }, { type: 'string' }, '', resolvers);
      assert.equal(deltas[0]?.kind, 'enum_constraint_removed');
    });

    it('列挙に限定された場合は制約の追加として扱う', () => {
      const deltas = diffSchema({ type: 'string' }, { $ref: '#/components/schemas/category' }, '', resolvers);
      assert.equal(deltas[0]?.kind, 'enum_constraint_added');
    });

    it('基底型まで変わる場合は型変更のまま', () => {
      const deltas = diffSchema({ $ref: '#/components/schemas/category' }, { type: 'integer' }, '', resolvers);
      assert.equal(deltas[0]?.kind, 'property_type_changed');
    });

    it('参照先を解決できない場合は型変更のまま', () => {
      const deltas = diffSchema({ $ref: '#/components/schemas/unknown' }, { type: 'string' }, '', resolvers);
      assert.equal(deltas[0]?.kind, 'property_type_changed');
    });
  });

  it('nullable と type 配列を同じ正規形として扱う', () => {
    assert.equal(diffSchema({ type: 'string', nullable: true }, { type: ['string', 'null'] }).length, 0);
  });

  it('ネストしたプロパティのパスを組み立てる', () => {
    const deltas = diffSchema(
      { properties: { line_items: { type: 'array', items: { properties: { amount: { type: 'integer' } } } } } },
      { properties: { line_items: { type: 'array', items: { properties: {} } } } },
    );
    assert.equal(deltas[0]?.location, 'line_items.[].amount');
  });

  it('再帰的なスキーマでも停止する', () => {
    const recursive = { type: 'object', properties: {} } as Record<string, unknown>;
    (recursive.properties as Record<string, unknown>).self = recursive;
    assert.doesNotThrow(() => diffSchema(recursive, structuredClone(recursive) as never));
  });
});

describe('方向による深刻度の判定', () => {
  const withRequestBody = (props: Record<string, unknown>, required: string[] = []): OpenApiDocument =>
    doc({
      paths: {
        '/v1/charges': {
          post: {
            operationId: 'PostCharges',
            requestBody: {
              content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: props, required } } },
            },
          },
        },
      },
    });

  it('リクエストへの必須追加は破壊的', () => {
    const d = diffOpenApi(withRequestBody({ a: { type: 'string' } }), withRequestBody({ a: { type: 'string' } }, ['a']));
    assert.equal(d.breakingCount, 1);
    assert.equal(d.changes[0]?.kind, 'required_added');
  });

  it('プロパティ単位の変更は propertyPath を持つ（② の突合が依存している）', () => {
    const d = diffOpenApi(
      withRequestBody({ amount: { type: 'integer' }, charge: { type: 'string' } }),
      withRequestBody({ charge: { type: 'string' } }),
    );
    assert.equal(d.changes[0]?.propertyPath, 'amount');
  });

  it('エンドポイント自体の廃止は propertyPath を持たない', () => {
    const d = diffOpenApi(doc({ paths: { '/v1/a': { get: {} } } }), doc({ paths: {} }));
    assert.equal(d.changes[0]?.propertyPath, undefined);
  });

  it('レスポンスへの必須追加は破壊的ではない', () => {
    const withResponse = (required: string[]): OpenApiDocument =>
      doc({
        paths: {
          '/v1/charges': {
            get: {
              responses: {
                '200': { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } }, required } } } },
              },
            },
          },
        },
      });
    assert.equal(diffOpenApi(withResponse([]), withResponse(['a'])).changes.length, 0);
  });

  it('レスポンスの必須解除は破壊的', () => {
    const withResponse = (required: string[]): OpenApiDocument =>
      doc({
        paths: {
          '/v1/charges': {
            get: {
              responses: {
                '200': { content: { 'application/json': { schema: { type: 'object', properties: { a: { type: 'string' } }, required } } } },
              },
            },
          },
        },
      });
    const d = diffOpenApi(withResponse(['a']), withResponse([]));
    assert.deepEqual(kinds(d), ['required_removed']);
    assert.equal(d.breakingCount, 1);
  });
});

describe('diffOpenApi', () => {
  it('エンドポイントと操作の廃止を検出する', () => {
    const before = doc({ paths: { '/v1/a': { get: {}, post: {} }, '/v1/b': { get: {} } } });
    const after = doc({ paths: { '/v1/a': { get: {} } } });
    const d = diffOpenApi(before, after);
    assert.deepEqual(kinds(d).sort(), ['operation_removed', 'path_removed']);
    assert.equal(d.breakingCount, 2);
  });

  it('パラメータの削除・必須化を検出する', () => {
    const before = doc({
      paths: { '/v1/a': { get: { parameters: [{ name: 'expand', in: 'query' }, { name: 'limit', in: 'query' }] } } },
    });
    const after = doc({
      paths: { '/v1/a': { get: { parameters: [{ name: 'limit', in: 'query', required: true }] } } },
    });
    assert.deepEqual(kinds(diffOpenApi(before, after)).sort(), ['parameter_removed', 'parameter_required_added']);
  });

  it('成功レスポンスの消失のみを破壊的として扱う', () => {
    const before = doc({ paths: { '/v1/a': { get: { responses: { '200': {}, '404': {} } } } } });
    const after = doc({ paths: { '/v1/a': { get: { responses: {} } } } });
    assert.deepEqual(kinds(diffOpenApi(before, after)), ['response_status_removed']);
  });

  it('components のスキーマ変更を、それを参照する操作に紐付ける', () => {
    const build = (props: Record<string, OpenApiSchema>): OpenApiDocument =>
      doc({
        paths: {
          '/v1/checkout/sessions': {
            post: {
              operationId: 'PostCheckoutSessions',
              responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/checkout.session' } } } } },
            },
          },
        },
        components: { schemas: { 'checkout.session': { type: 'object', properties: props } } },
      });

    const d = diffOpenApi(build({ amount: { type: 'integer' } }), build({ unit_amount_decimal: { type: 'string' } }));
    const removed = d.changes.find((c) => c.kind === 'property_removed');
    assert.equal(removed?.location, 'checkout.session.amount');
    assert.equal(removed?.direction, 'response');
    assert.deepEqual(removed?.operations, [
      { method: 'post', path: '/v1/checkout/sessions', operationId: 'PostCheckoutSessions' },
    ]);
  });

  it('変更がなければ何も報告しない', () => {
    const same = doc({ paths: { '/v1/a': { get: { responses: { '200': {} } } } } });
    assert.equal(diffOpenApi(same, structuredClone(same)).changes.length, 0);
  });
});

describe('RefIndex', () => {
  const document = doc({
    paths: {
      '/v1/charges': {
        post: {
          operationId: 'PostCharges',
          requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/charge_params' } } } },
          responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/charge' } } } } },
        },
      },
    },
    components: {
      schemas: {
        charge_params: { type: 'object' },
        charge: { type: 'object', properties: { customer: { $ref: '#/components/schemas/customer' } } },
        customer: { type: 'object', properties: { address: { $ref: '#/components/schemas/address' } } },
        address: { type: 'object' },
        unused: { type: 'object' },
      },
    },
  });

  it('推移的な参照をたどって影響操作を特定する', () => {
    const index = new RefIndex(document);
    const found = index.findOperations('address');
    assert.deepEqual(found.operations, [{ method: 'post', path: '/v1/charges', operationId: 'PostCharges' }]);
    assert.equal(found.direction, 'response');
  });

  it('リクエストとレスポンス両方から参照される場合は both になる', () => {
    const both = structuredClone(document);
    both.components!.schemas!.charge_params = { $ref: '#/components/schemas/address' };
    assert.equal(new RefIndex(both).findOperations('address').direction, 'both');
  });

  it('どこからも参照されないスキーマは操作を持たない', () => {
    assert.deepEqual(new RefIndex(document).findOperations('unused').operations, []);
  });
});
