import type { BreakingChange, OperationRef } from '../detector/types.js';
import type { CallSite, ImpactCandidate } from './types.js';

const operationKey = (op: OperationRef): string => `${op.method} ${op.path}`;

/**
 * プロパティパスが一致するかを判定する。
 *
 * 呼び出し側は必ずしも全階層を書くとは限らない（`line_items` の配列要素を
 * 変数経由で組み立てるなど）ため、末尾セグメントの一致も許容する。
 */
function matchesProperty(propertyPath: string, passedParams: string[]): boolean {
  if (passedParams.includes(propertyPath)) return true;
  const leaf = propertyPath.split('.').filter((s) => s !== '[]').pop();
  if (!leaf) return false;
  return passedParams.some((param) => {
    const paramLeaf = param.split('.').filter((s) => s !== '[]').pop();
    return paramLeaf === leaf;
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
