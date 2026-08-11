import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * slack-go のソースから「Go のメソッド名 → Slack Web API のメソッド名」の対応表を生成する。
 *
 *   npm run generate:slack-go-map
 *
 * Slack の Go SDK はメソッド名が API のパスから導けない
 * （`GetUserByEmail` → `users.lookupByEmail`）ため、規則では対応づけられない。
 * ただし各メソッドには公式ドキュメントへの URL がコメントで付いており、
 * そこにエンドポイント名が含まれるので、それを根拠に生成する。
 *
 *   // PostMessageContext sends a message to a channel with a custom context.
 *   // Slack API docs: https://api.slack.com/methods/chat.postMessage
 *   func (api *Client) PostMessageContext(...)
 *
 * 本体に埋まった文字列リテラルではなく URL を使うのは、`PostMessage` のように
 * 内部で共通処理へ委譲する関数だと本体にエンドポイントが現れず、
 * 近くの無関係なリテラルを誤って拾ってしまうため。
 *
 * SDK 更新時はこのスクリプトを再実行する。
 */

const OWNER = 'slack-go';
const REPO = 'slack';

/** `// ... https://api.slack.com/methods/chat.postMessage` */
const DOC_URL_PATTERN = /api\.slack\.com\/methods\/([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)/;
/** `func (api *Client) Name(` */
const FUNC_PATTERN = /^func \(api \*Client\) ([A-Za-z0-9_]+)\(/;

/**
 * 呼び先が実行時のオプションで決まる関数。1 つのエンドポイントに対応づけられない。
 *
 * `SendMessage(ch, MsgOptionUpdate(ts))` は `chat.update` を呼ぶが、
 * `MsgOptionPost()` なら `chat.postMessage` になる。コメントの URL は
 * 代表例を指しているだけなので、そのまま対応表に入れると誤った判定を生む。
 */
const RUNTIME_DISPATCHED = new Set(['SendMessage', 'SendMessageContext']);

interface Entry {
  func: string;
  endpoint: string;
}

async function listGoFiles(): Promise<string[]> {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`ファイル一覧を取得できませんでした: ${response.status}`);

  const entries = (await response.json()) as { name: string; type: string }[];
  return entries
    .filter((e) => e.type === 'file' && e.name.endsWith('.go') && !e.name.endsWith('_test.go'))
    .map((e) => e.name);
}

/**
 * 直前のコメント行にある公式ドキュメント URL を、その関数のエンドポイントとみなす。
 * 判断材料が無い関数は含めない（誤った対応は誤検知 PR を生むため）。
 */
function extract(source: string): Entry[] {
  const lines = source.split('\n');
  const entries: Entry[] = [];
  let pendingEndpoint: string | undefined;

  for (const line of lines) {
    if (line.startsWith('//')) {
      const doc = DOC_URL_PATTERN.exec(line);
      if (doc?.[1]) pendingEndpoint = doc[1];
      continue;
    }

    const func = FUNC_PATTERN.exec(line);
    if (func?.[1]) {
      if (pendingEndpoint) entries.push({ func: func[1], endpoint: pendingEndpoint });
      pendingEndpoint = undefined;
      continue;
    }

    // コメントでも関数宣言でもない行が来たら、直前の URL は別の対象のものとみなす
    if (line.trim() !== '') pendingEndpoint = undefined;
  }
  return entries;
}

const files = await listGoFiles();
console.log(`slack-go のソースから対応表を生成します（${files.length} ファイル）\n`);

const mapping = new Map<string, string>();
let scanned = 0;

for (const file of files) {
  const response = await fetch(`https://raw.githubusercontent.com/${OWNER}/${REPO}/master/${file}`);
  if (!response.ok) continue;

  const entries = extract(await response.text());
  scanned += 1;
  if (entries.length > 0) console.log(`  ${file.padEnd(24)} ${entries.length} 件`);

  for (const { func, endpoint } of entries) {
    if (RUNTIME_DISPATCHED.has(func)) continue;
    mapping.set(func, endpoint);
    // `XxxContext` は同じ操作の context 付き版。素の名前でも引けるようにする
    const base = func.replace(/Context$/, '');
    if (!RUNTIME_DISPATCHED.has(base) && !mapping.has(base)) mapping.set(base, endpoint);
  }
}

const sorted = Object.fromEntries([...mapping.entries()].sort(([a], [b]) => a.localeCompare(b)));
const outputPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'analyzer', 'slack-go-map.json');
await writeFile(outputPath, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');

console.log(`\n${scanned} ファイルを走査し、${Object.keys(sorted).length} 件を書き出しました`);
for (const name of ['PostMessage', 'UpdateMessage', 'DeleteMessage', 'GetUserInfo', 'GetConversations', 'SendMessage']) {
  console.log(`  ${name.padEnd(18)} → ${sorted[name] ?? '(対応なし)'}`);
}
