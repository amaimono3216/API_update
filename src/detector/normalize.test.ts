import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isSwagger2, normalizeDocument } from './normalize.js';
import type { OpenApiDocument } from './types.js';

const swagger2 = (overrides: Partial<Record<string, unknown>> = {}): OpenApiDocument =>
  ({
    swagger: '2.0',
    info: { version: '1.7.0' },
    paths: {},
    definitions: {},
    ...overrides,
  }) as unknown as OpenApiDocument;

describe('isSwagger2', () => {
  it('swagger フィールドで判定する', () => {
    assert.equal(isSwagger2(swagger2()), true);
    assert.equal(isSwagger2({ openapi: '3.0.0', paths: {} } as OpenApiDocument), false);
  });
});

describe('normalizeDocument', () => {
  it('OpenAPI 3 のドキュメントはそのまま返す', () => {
    const doc = { openapi: '3.1.0', paths: { '/a': { get: {} } } } as unknown as OpenApiDocument;
    assert.equal(normalizeDocument(doc), doc);
  });

  it('definitions を components.schemas に移す', () => {
    const result = normalizeDocument(swagger2({ definitions: { User: { type: 'object' } } }));
    assert.deepEqual(result.components?.schemas?.['User'], { type: 'object' });
    assert.equal((result as unknown as Record<string, unknown>)['definitions'], undefined);
  });

  it('$ref を components.schemas 形式に書き換える', () => {
    const result = normalizeDocument(
      swagger2({
        definitions: { User: { type: 'object', properties: { boss: { $ref: '#/definitions/User' } } } },
        paths: { '/u': { get: { responses: { '200': { schema: { $ref: '#/definitions/User' } } } } } },
      }),
    );

    const user = result.components?.schemas?.['User'] as { properties?: Record<string, { $ref?: string }> };
    assert.equal(user.properties?.['boss']?.$ref, '#/components/schemas/User');

    const operation = result.paths?.['/u']?.get as { responses?: Record<string, unknown> };
    const response = operation.responses?.['200'] as {
      content?: Record<string, { schema?: { $ref?: string } }>;
    };
    assert.equal(response.content?.['application/json']?.schema?.$ref, '#/components/schemas/User');
  });

  it('in:body の parameter を requestBody に変換する', () => {
    const result = normalizeDocument(
      swagger2({
        paths: {
          '/u': {
            post: {
              parameters: [
                { in: 'body', name: 'payload', schema: { $ref: '#/definitions/User' } },
                { in: 'header', name: 'token', type: 'string' },
              ],
            },
          },
        },
      }),
    );

    const operation = result.paths?.['/u']?.post as Record<string, unknown>;
    const body = operation['requestBody'] as { content: Record<string, { schema: { $ref: string } }> };
    assert.equal(body.content['application/json']?.schema.$ref, '#/components/schemas/User');
    // body 以外の parameter は残す
    assert.deepEqual(operation['parameters'], [{ in: 'header', name: 'token', type: 'string' }]);
  });

  it('in:formData の parameter をまとめて requestBody にする', () => {
    const result = normalizeDocument(
      swagger2({
        paths: {
          '/chat.postMessage': {
            post: {
              parameters: [
                { in: 'formData', name: 'channel', type: 'string', required: true },
                { in: 'formData', name: 'text', type: 'string' },
                { in: 'header', name: 'token', type: 'string' },
              ],
            },
          },
        },
      }),
    );

    const operation = result.paths?.['/chat.postMessage']?.post as Record<string, unknown>;
    const schema = (
      operation['requestBody'] as {
        content: Record<string, { schema: { properties: Record<string, unknown>; required?: string[] } }>;
      }
    ).content['application/x-www-form-urlencoded']?.schema;

    assert.deepEqual(Object.keys(schema?.properties ?? {}), ['channel', 'text']);
    assert.deepEqual(schema?.required, ['channel']);
    // in / name / required はプロパティ定義から除く
    assert.deepEqual(schema?.properties['channel'], { type: 'string' });
    assert.deepEqual(operation['parameters'], [{ in: 'header', name: 'token', type: 'string' }]);
  });

  it('パラメータが無ければ requestBody を作らない', () => {
    const result = normalizeDocument(
      swagger2({ paths: { '/u': { get: { parameters: [{ in: 'query', name: 'q', type: 'string' }] } } } }),
    );
    const operation = result.paths?.['/u']?.get as Record<string, unknown>;
    assert.equal(operation['requestBody'], undefined);
  });

  it('変換後は OpenAPI 3 として扱える形にする', () => {
    const result = normalizeDocument(swagger2()) as unknown as Record<string, unknown>;
    assert.equal(result['openapi'], '3.0.0');
    assert.equal(result['swagger'], undefined);
  });
});
