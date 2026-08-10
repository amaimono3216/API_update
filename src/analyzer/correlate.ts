import type { BreakingChange, OperationRef } from '../detector/types.js';
import type { CallSite, ImpactCandidate } from './types.js';

const operationKey = (op: OperationRef): string => `${op.method} ${op.path}`;

/**
 * 仕様側とコード側で命名規則が異なるため、比較用に正規化する。
 *
 *   Twilio  : 仕様は `To` / `StatusCallback`、SDK は `to` / `statusCallback` / `status_callback`
 *   Python  : 予約語との衝突を避けて `from_` のように末尾へアンダースコアを付ける
 *
 * 大小文字と区切り文字を落として比較する。
 */
const normalizeName = (name: string): string => name.toLowerCase().replace(/[_-]/g, '');

const leafOf = (propertyPath: string): string | undefined =>
  propertyPath
    .split('.')
    .filter((segment) => segment !== '[]')
    .pop();

const normalizePath = (propertyPath: string): string =>
  propertyPath
    .split('.')
    .map((segment) => (segment === '[]' ? segment : normalizeName(segment)))
    .join('.');

/**
 * プロパティパスが一致するかを判定する。
 *
 * 呼び出し側は必ずしも全階層を書くとは限らない（`line_items` の配列要素を
 * 変数経由で組み立てるなど）ため、末尾セグメントの一致も許容する。
 */
function matchesProperty(propertyPath: string, passedParams: string[]): boolean {
  const target = normalizePath(propertyPath);
  if (passedParams.some((param) => normalizePath(param) === target)) return true;

  const leaf = leafOf(propertyPath);
  if (!leaf) return false;

  const targetLeaf = normalizeName(leaf);
  return passedParams.some((param) => {
    const paramLeaf = leafOf(param);
    return paramLeaf !== undefined && normalizeName(paramLeaf) === targetLeaf;
  });
}

/**
 * 破壊的変更と呼び出し箇所を突き合わせ、影響を受けうる組み合わせを列挙する。
 *
 * ここは決定的な絞り込みに徹し、最終的な影響有無の判断は LLM に委ねる。
 * この段階で候補を落としすぎると見逃しになり、残しすぎると LLM の判定コストが増える。
 */
export function correlate(changes: BreakingChange[], callSites: CallSite[]): ImpactCandidate[] {
  const sitesByOperation = new Map<string, CallSite[]>();
  for (const site of callSites) {
    if (!site.operation) continue;
    const key = operationKey(site.operation);
    const list = sitesByOperation.get(key) ?? [];
    list.push(site);
    sitesByOperation.set(key, list);
  }

  const candidates: ImpactCandidate[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    for (const operation of change.operations) {
      for (const site of sitesByOperation.get(operationKey(operation)) ?? []) {
        const dedupeKey = `${change.location}|${site.file}:${site.line}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        const direct =
          change.direction !== 'response' &&
          change.propertyPath !== undefined &&
          matchesProperty(change.propertyPath, site.passedParams);

        candidates.push({ change, callSite: site, match: direct ? 'direct' : 'operation' });
      }
    }
  }

  // 確度の高いものから処理できるよう並べ替える
  return candidates.sort((a, b) => (a.match === b.match ? 0 : a.match === 'direct' ? -1 : 1));
}
