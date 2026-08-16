import type { CaseResult } from './types.js';

/** 集計結果を人が読める形にする。 */
export function formatReport(results: CaseResult[]): string {
  const lines: string[] = ['', '='.repeat(78), '再現テストの結果', '='.repeat(78), ''];

  for (const result of results) {
    lines.push(`## ${result.case.id}`);
    lines.push(`   ${result.case.description}`);
    lines.push(`   対象: ${result.case.repository.url}${result.case.repository.subdirectory ? ` (${result.case.repository.subdirectory})` : ''}`);

    if (result.error) {
      lines.push(`   ✗ 実行できませんでした: ${result.error.slice(0, 200)}`, '');
      continue;
    }

    lines.push(
      `   破壊的変更 ${result.breakingChanges} 件 / 走査 ${result.scannedFiles} ファイル / ` +
        `SDK 呼び出し ${result.callSites} 箇所 / 候補 ${result.candidates} 件（うち direct ${result.directMatches}）`,
    );

    if (result.judged) {
      lines.push(
        `   判定: 影響あり ${result.affectedFiles.length} / 影響なし ${result.notAffectedFiles.length} / 判断できず ${result.uncertainFiles.length}`,
      );
      for (const file of result.affectedFiles) lines.push(`     [影響あり] ${file}`);
      for (const file of result.uncertainFiles) lines.push(`     [要確認]   ${file}`);
    } else {
      lines.push('   判定: 静的解析のみ（LLM 未実行）');
      // 正解データを書くための手がかりとして、何が候補になったかを見せる
      for (const summary of result.candidateSummaries) lines.push(`     ${summary}`);
    }

    if (result.score) {
      const { truePositives, falsePositives, falseNegatives, trueNegatives } = result.score;
      lines.push(
        `   採点: 正解 ${truePositives} / 誤検知 ${falsePositives} / 見逃し ${falseNegatives} / 正しく除外 ${trueNegatives}`,
      );
    }

    lines.push(`   所要 ${(result.durationMs / 1000).toFixed(1)} 秒`, '');
  }

  lines.push('-'.repeat(78), '合計', '-'.repeat(78), '');

  const ran = results.filter((r) => !r.error);
  const failed = results.length - ran.length;
  lines.push(`実行: ${ran.length} / ${results.length} ケース${failed > 0 ? `（${failed} 件は実行できず）` : ''}`);
  lines.push(`SDK 呼び出しの検出: 合計 ${ran.reduce((s, r) => s + r.callSites, 0)} 箇所`);
  lines.push(`影響候補: 合計 ${ran.reduce((s, r) => s + r.candidates, 0)} 件（うち direct ${ran.reduce((s, r) => s + r.directMatches, 0)}）`);

  const scored = ran.filter((r) => r.score);
  if (scored.length > 0) {
    const tp = scored.reduce((s, r) => s + (r.score?.truePositives ?? 0), 0);
    const fp = scored.reduce((s, r) => s + (r.score?.falsePositives ?? 0), 0);
    const fn = scored.reduce((s, r) => s + (r.score?.falseNegatives ?? 0), 0);
    const tn = scored.reduce((s, r) => s + (r.score?.trueNegatives ?? 0), 0);

    lines.push('', `採点対象 ${scored.length} ケース: 正解 ${tp} / 誤検知 ${fp} / 見逃し ${fn} / 正しく除外 ${tn}`);
    if (tp + fp > 0) lines.push(`  適合率（誤検知の少なさ）: ${((tp / (tp + fp)) * 100).toFixed(1)}%`);
    if (tp + fn > 0) lines.push(`  再現率（見逃しの少なさ）: ${((tp / (tp + fn)) * 100).toFixed(1)}%`);
    if (tn + fp > 0) lines.push(`  不要な PR の回避: ${tn} / ${tn + fp}`);
  } else {
    lines.push('', '採点対象なし（ケース定義に expected を書くと精度を測れます）');
  }

  lines.push('');
  return lines.join('\n');
}
