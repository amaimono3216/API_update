import type { BreakingChangeKind, JsonValue, OpenApiSchema } from './types.js';

/** 方向（request/response）を解決する前の生の差分。 */
export interface SchemaDelta {
  kind: BreakingChangeKind;
  /** ルートスキーマからの相対パス。例: `line_items.unit_amount` */
  location: string;
  before?: JsonValue;
  after?: JsonValue;
}

/** `$ref` の参照先を引く。片側だけが `$ref` になった場合の判定に使う。 */
export type RefResolver = (ref: string) => OpenApiSchema | undefined;

interface DiffOptions {
  /** Stripe のスキーマは相互参照が深いため上限を設ける。 */
  maxDepth: number;
  resolveBefore?: RefResolver;
  resolveAfter?: RefResolver;
}

const DEFAULT_OPTIONS: DiffOptions = { maxDepth: 12 };

const join = (base: string, key: string): string => (base ? `${base}.${key}` : key);

/** `type` は文字列 / 配列 / nullable 併用があるため、比較可能な正規形に落とす。 */
const normalizeType = (schema: OpenApiSchema): string => {
  const raw = schema.type;
  const types = raw === undefined ? [] : Array.isArray(raw) ? [...raw] : [raw];
  if (schema.nullable === true && !types.includes('null')) types.push('null');
  return types.sort().join('|');
};

/**
 * 2 つのスキーマを再帰的に比較し、後方互換性に関わる差分を列挙する。
 *
 * `$ref` は展開しない。同一 `$ref` なら等価とみなして打ち切り、参照先の変更は
 * `components.schemas` の差分として別途検出する（循環参照とスキーマ爆発の回避）。
 */
export function diffSchema(
  before: OpenApiSchema | undefined,
  after: OpenApiSchema | undefined,
  location = '',
  options: Partial<DiffOptions> = {},
): SchemaDelta[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  return walk(before, after, location, 0, opts);
}

/**
 * 「enum を指す `$ref`」と「同じ基底型の素の型」の入れ替わりを、型変更ではなく
 * 制約の増減として扱う。
 *
 *   `$ref: usage_category_enum` → `string`  ⇒ 緩和（既存の値はそのまま通る）
 *   `string` → `$ref: ..._enum`             ⇒ 厳格化（列挙外の値が弾かれる）
 *
 * 型変更として一律に破壊的と報告すると、緩和のたびに不要な PR が出るため。
 * 判別できない場合は undefined を返し、呼び出し側の既定の扱いに任せる。
 */
function enumConstraintDelta(
  before: OpenApiSchema,
  after: OpenApiSchema,
  location: string,
  opts: DiffOptions,
): SchemaDelta | undefined {
  const relaxed = Boolean(before.$ref) && !after.$ref;
  const tightened = Boolean(after.$ref) && !before.$ref;
  if (relaxed === tightened) return undefined;

  const ref = (relaxed ? before.$ref : after.$ref) as string;
  const resolve = relaxed ? opts.resolveBefore : opts.resolveAfter;
  const enumSchema = resolve?.(ref);
  const plain = relaxed ? after : before;

  if (!enumSchema || !Array.isArray(enumSchema.enum) || Array.isArray(plain.enum)) return undefined;
  // 基底型まで変わっているなら本当の型変更
  if (normalizeType(enumSchema) !== normalizeType(plain)) return undefined;

  return relaxed
    ? { kind: 'enum_constraint_removed', location, before: enumSchema.enum as JsonValue, after: normalizeType(plain) }
    : { kind: 'enum_constraint_added', location, before: normalizeType(plain), after: enumSchema.enum as JsonValue };
}

function walk(
  before: OpenApiSchema | undefined,
  after: OpenApiSchema | undefined,
  location: string,
  depth: number,
  opts: DiffOptions,
): SchemaDelta[] {
  if (!before || !after || depth > opts.maxDepth) return [];

  const deltas: SchemaDelta[] = [];

  // --- $ref: 参照先が差し替わった場合のみ型変更として扱う ---
  if (before.$ref || after.$ref) {
    if (before.$ref !== after.$ref) {
      deltas.push(enumConstraintDelta(before, after, location, opts) ?? {
        kind: 'property_type_changed',
        location,
        before: before.$ref ?? normalizeType(before),
        after: after.$ref ?? normalizeType(after),
      });
    }
    return deltas;
  }

  // --- type ---
  const beforeType = normalizeType(before);
  const afterType = normalizeType(after);
  if (beforeType && afterType && beforeType !== afterType) {
    deltas.push({ kind: 'property_type_changed', location, before: beforeType, after: afterType });
  }

  // --- enum ---
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const afterSet = new Set(after.enum.map((v) => JSON.stringify(v)));
    const beforeSet = new Set(before.enum.map((v) => JSON.stringify(v)));
    const removed = before.enum.filter((v) => !afterSet.has(JSON.stringify(v)));
    const added = after.enum.filter((v) => !beforeSet.has(JSON.stringify(v)));
    if (removed.length > 0) {
      deltas.push({ kind: 'enum_value_removed', location, before: removed, after: after.enum });
    }
    if (added.length > 0) {
      deltas.push({ kind: 'enum_value_added', location, before: before.enum, after: added });
    }
  }

  // --- required ---
  const beforeRequired = new Set(before.required ?? []);
  const afterRequired = new Set(after.required ?? []);
  const beforeProps = before.properties ?? {};
  const afterProps = after.properties ?? {};

  for (const name of afterRequired) {
    if (!beforeRequired.has(name)) {
      deltas.push({ kind: 'required_added', location: join(location, name), before: false, after: true });
    }
  }
  for (const name of beforeRequired) {
    // プロパティごと削除された場合は property_removed 側で報告するため二重計上しない
    if (!afterRequired.has(name) && name in afterProps) {
      deltas.push({ kind: 'required_removed', location: join(location, name), before: true, after: false });
    }
  }

  // --- properties ---
  for (const [name, beforeProp] of Object.entries(beforeProps)) {
    const afterProp = afterProps[name];
    if (afterProp === undefined) {
      deltas.push({
        kind: 'property_removed',
        location: join(location, name),
        before: (beforeProp.$ref ?? normalizeType(beforeProp)) || 'unknown',
        after: undefined,
      });
      continue;
    }
    deltas.push(...walk(beforeProp, afterProp, join(location, name), depth + 1, opts));
  }

  // --- items ---
  if (before.items && after.items) {
    deltas.push(...walk(before.items, after.items, join(location, '[]'), depth + 1, opts));
  }

  // --- 合成スキーマ: 要素数が変わった場合は候補が減った＝型変更として扱う ---
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const beforeList = before[key];
    const afterList = after[key];
    if (!Array.isArray(beforeList) || !Array.isArray(afterList)) continue;
    if (beforeList.length !== afterList.length) {
      deltas.push({
        kind: 'property_type_changed',
        location: join(location, key),
        before: `${key}[${beforeList.length}]`,
        after: `${key}[${afterList.length}]`,
      });
      continue;
    }
    beforeList.forEach((item, i) => {
      const counterpart = afterList[i];
      if (counterpart) deltas.push(...walk(item, counterpart, join(location, `${key}[${i}]`), depth + 1, opts));
    });
  }

  return deltas;
}
