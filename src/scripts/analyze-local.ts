import 'dotenv/config';

import { analyze } from '../analyzer/analyze.js';
import { LocalRepository } from '../analyzer/repository.js';
import { closePool } from '../db/pool.js';
import { closeRedis } from '../lib/redis.js';

/**
 * ローカルディレクトリを対象に ② 影響範囲特定を実行する開発用スクリプト。
 *
 *   npm run analyze -- <diffId> <リポジトリのパス> [owner/repo]
 */
const [diffId, repositoryPath, name] = process.argv.slice(2);

if (!diffId || !repositoryPath) {
  console.error('usage: npm run analyze -- <diffId> <repository-path> [owner/repo]');
  process.exit(1);
}

const log = {
  info: (obj: object, msg: string) => console.log('INFO ', msg, JSON.stringify(obj)),
  warn: (obj: object, msg: string) => console.log('WARN ', msg, JSON.stringify(obj)),
};

const result = await analyze(diffId, new LocalRepository(repositoryPath, name ?? repositoryPath), log);

console.log('\n=== サマリ ===');
console.log(`走査ファイル : ${result.scannedFiles}`);
console.log(`SDK 呼び出し : ${result.callSites}`);
console.log(`影響候補     : ${result.candidates}`);
console.log(`LLM 判定     : ${result.judged ? '実行' : 'スキップ (ANTHROPIC_API_KEY 未設定)'}`);

console.log('\n=== 判定 ===');
for (const judgement of result.judgements) {
  console.log(`[${judgement.verdict}] ${judgement.file}:${judgement.line}  ← ${judgement.changeLocation}`);
}

await Promise.allSettled([closePool(), closeRedis()]);
