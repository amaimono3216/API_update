import 'dotenv/config';

import { analyze } from '../analyzer/analyze.js';
import { LocalRepository } from '../analyzer/repository.js';
import { closePool } from '../db/pool.js';
import { listRuns } from '../db/runs.js';
import { fix } from '../fixer/fix.js';
import { closeRedis } from '../lib/redis.js';
import { publishPullRequest } from '../pr/publish.js';

/**
 * ② 影響範囲特定 → ③ 自動修正 → ④ PR 生成 を通しで実行する開発用スクリプト。
 *
 *   npm run pipeline -- <diffId> <リポジトリのパス> [owner/repo]
 */
const [diffId, repositoryPath, name] = process.argv.slice(2);

if (!diffId || !repositoryPath) {
  console.error('usage: npm run pipeline -- <diffId> <repository-path> [owner/repo]');
  process.exit(1);
}

const log = {
  info: (obj: object, msg: string) => console.log('INFO ', msg, JSON.stringify(obj)),
  warn: (obj: object, msg: string) => console.log('WARN ', msg, JSON.stringify(obj)),
};

const repository = new LocalRepository(repositoryPath, name ?? repositoryPath);
const analysis = await analyze(diffId, repository, log);

if (analysis.affected.length === 0) {
  console.log('\n影響を受ける箇所はありませんでした。PR は作成しません。');
} else {
  const run = (await listRuns(repository.name, 1))[0];
  if (!run) throw new Error('実行記録が見つかりません');

  const fixResult = await fix(run.id, analysis, repositoryPath, log, { keepWorkdir: true });
  const { plan, result } = await publishPullRequest(run.id, analysis, fixResult, log);

  console.log(`\n${'='.repeat(72)}`);
  console.log(`タイトル: ${plan.title}`);
  console.log(`ブランチ: ${plan.branch} → ${plan.baseBranch}`);
  console.log(`送信    : ${result.published ? result.url : `未送信（${result.reason}）`}`);
  console.log(`${'='.repeat(72)}\n`);
  console.log(plan.body);
}

await Promise.allSettled([closePool(), closeRedis()]);
