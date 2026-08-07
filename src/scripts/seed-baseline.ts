import 'dotenv/config';

import { closePool } from '../db/pool.js';
import { saveSnapshot } from '../db/snapshots.js';
import { fetchSpec } from '../detector/fetch-spec.js';
import { PROVIDERS, isProviderId } from '../detector/providers.js';
import { closeRedis } from '../lib/redis.js';

/**
 * 任意の URL のスペックを比較基準（ベースライン）として取り込む開発用スクリプト。
 * 実際の API 変更を待たずに検知フローを検証したいときに使う。
 *
 *   npm run seed:baseline -- stripe https://raw.githubusercontent.com/stripe/openapi/<sha>/openapi/spec3.json
 */
const [providerId, url] = process.argv.slice(2);

if (!providerId || !isProviderId(providerId) || !url) {
  console.error('usage: npm run seed:baseline -- <stripe|openai> <spec-url>');
  process.exit(1);
}

const spec = await fetchSpec({ ...PROVIDERS[providerId], specUrl: url });
const { snapshot, created } = await saveSnapshot(spec, url);

console.log(
  created
    ? `ベースラインを保存しました: id=${snapshot.id} provider=${providerId} version=${spec.version}`
    : `同一内容のスナップショットが既に存在します: id=${snapshot.id} version=${spec.version}`,
);

await Promise.allSettled([closePool(), closeRedis()]);
