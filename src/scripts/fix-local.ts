import 'dotenv/config';

import { analyze } from '../analyzer/analyze.js';
import { LocalRepository } from '../analyzer/repository.js';
import { closePool } from '../db/pool.js';
import { listRuns } from '../db/runs.js';
import { fix } from '../fixer/fix.js';
import { closeRedis } from '../lib/redis.js';

/**
 * ② 影響範囲特定 → ③ 自動修正 を通しで実行する開発用スクリプト。
 *
 *   npm run fix -- <diffId> <リポジトリのパス> [owner/repo]
 */
const [diffId, repositoryPath, name] = process.argv.slice(2);

if (!diffId || !repositoryPath) {
  console.error('usage: npm run fix -- <diffId> <repository-path> [owner/repo]');
  process.exit(1);
}

const log = {
  info: (obj: object, msg: string) => console.log('INFO ', msg, JSON.stringify(obj)),
  warn: (obj: object, msg: string) => console.log('WARN ', msg, JSON.stringify(obj)),
};

const repository = new LocalRepository(repositoryPath, name ?? repositoryPath);
const analysis = await analyze(diffId, repository, log);

if (analysis.affected.length === 0) {
  console.log('\n影響を受ける箇所はありませんでした。修正は不要です。');
} else {
  const run = (await listRuns(repository.name, 1))[0];
  if (!run) throw new Error('実行記録が見つかりません');

  const result = await fix(run.id, analysis, repositoryPath, log, { keepWorkdir: true });

  console.log('\n=== 修正結果 ===');
  console.log(`ブランチ  : ${result.branch}`);
  console.log(`結果      : ${result.succeeded ? '成功' : '失敗（テスト未通過）'}`);
  console.log(`試行回数  : ${result.attempts.length}`);
  console.log(`作業ディレクトリ: ${result.workdir}`);

  if (result.test) {
    console.log(`\nテスト    : ${result.test.command} → ${result.test.passed ? 'PASSED' : 'FAILED'}`);
  } else {
    console.log('\nテスト    : コマンド未検出のため未実行');
  }

  console.log('\n=== 適用した編集 ===');
  for (const edit of result.edits) console.log(`- ${edit.file}: ${edit.description}`);

  console.log('\n=== diff ===');
  console.log(result.diff);
}

await Promise.allSettled([closePool(), closeRedis()]);
