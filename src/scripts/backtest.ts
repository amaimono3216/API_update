import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatReport } from '../backtest/report.js';
import { runCase } from '../backtest/run-case.js';
import { CaseFileSchema, type CaseResult } from '../backtest/types.js';

/**
 * 過去の破壊的変更を実在のリポジトリに当てて、影響判定の精度を測る。
 *
 *   npm run backtest              # 静的解析のみ（課金なし）
 *   npm run backtest -- --llm     # LLM 判定まで実行（1 ケースあたり数十円）
 *   npm run backtest -- --case <id>
 *   npm run backtest -- --cases <path.json>
 *
 * 自分の本番リポジトリが無くても、実データで精度を示せるようにするための仕組み。
 */
const args = process.argv.slice(2);
const useLlm = args.includes('--llm');
const caseFilter = valueOf('--case');
const casesPath =
  valueOf('--cases') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backtest', 'cases.json');

function valueOf(flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const parsed = CaseFileSchema.safeParse(JSON.parse(await readFile(casesPath, 'utf8')));
if (!parsed.success) {
  console.error('ケース定義の形式が不正です:', parsed.error.message);
  process.exit(1);
}

const cases = caseFilter ? parsed.data.cases.filter((c) => c.id === caseFilter) : parsed.data.cases;
if (cases.length === 0) {
  console.error(caseFilter ? `ケースが見つかりません: ${caseFilter}` : 'ケースが定義されていません');
  process.exit(1);
}

if (useLlm && !process.env['ANTHROPIC_API_KEY']) {
  console.error('--llm を使うには ANTHROPIC_API_KEY が必要です');
  process.exit(1);
}

const log = {
  info: (o: object, m: string) => console.log('  INFO ', m, JSON.stringify(o)),
  warn: (o: object, m: string) => console.log('  WARN ', m, JSON.stringify(o)),
};

console.log(`${cases.length} ケースを実行します（LLM 判定: ${useLlm ? 'あり' : 'なし'}）\n`);

const results: CaseResult[] = [];
for (const [index, testCase] of cases.entries()) {
  console.log(`[${index + 1}/${cases.length}] ${testCase.id}`);
  results.push(await runCase(testCase, { useLlm }, log));
}

console.log(formatReport(results));
