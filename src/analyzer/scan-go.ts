import { spawn } from 'node:child_process';

import type { OperationIndex, SdkConvention } from './sdk-map.js';
import { SDK_CONVENTIONS } from './sdk-map.js';
import type { CallSite } from './types.js';

/** ビルド時に用意した解析用バイナリ。Go ツールチェーン本体は実行時に不要。 */
const EXTRACTOR = process.env['GO_EXTRACT_BIN'] ?? 'go-extract';
const TIMEOUT_MS = 120_000;
const MAX_SNIPPET_LENGTH = 600;

export const isGoFile = (filePath: string): boolean => filePath.endsWith('.go');

/** 抽出器（Go 側）が返す構文上の事実。SDK の知識は含まない。 */
interface ExtractedFile {
  path: string;
  error: string | null;
  imports: { module: string; name: string }[];
  clients: Record<string, string>;
  calls: { root: string; chain: string[]; line: number; endLine: number; params: string[] }[];
}

export interface GoScanInput {
  path: string;
  content: string;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
}

let unavailableReported = false;

/**
 * Go ソースを走査し、SDK 呼び出し箇所を抽出する。
 *
 * 構文解析は Go 本体の go/ast を使ったバイナリに任せる。
 * 解析器が無い環境では警告を 1 度出して空を返し、他言語の走査は止めない。
 */
export async function scanGoFiles(
  files: GoScanInput[],
  index: OperationIndex,
  log: Logger,
): Promise<CallSite[]> {
  if (files.length === 0) return [];

  let extracted: ExtractedFile[];
  try {
    extracted = await runExtractor(files);
  } catch (error) {
    if (!unavailableReported) {
      unavailableReported = true;
      log.warn({ err: String(error) }, 'Go の解析を実行できませんでした。.go ファイルはスキップします');
    }
    return [];
  }

  const contentByPath = new Map(files.map((f) => [f.path, f.content]));
  const callSites: CallSite[] = [];

  for (const file of extracted) {
    if (file.error) {
      log.warn({ file: file.path, err: file.error }, 'Go ファイルの解析に失敗しました');
      continue;
    }

    const candidatesByRoot = resolveConventions(file);
    const lines = (contentByPath.get(file.path) ?? '').split('\n');

    for (const call of file.calls) {
      const candidates = candidatesByRoot.get(call.root) ?? heuristicConventions(call.root);

      // Go のパッケージ名は import パスから確定できないため、候補を順に試し、
      // 実スペックのパスに解決できたものを採用する
      for (const convention of candidates) {
        const operation = convention.resolve(call.chain, index);
        if (!operation) continue;

        callSites.push({
          file: file.path,
          line: call.line,
          endLine: call.endLine,
          provider: convention.provider,
          chain: [call.root, ...call.chain],
          operation,
          passedParams: call.params,
          snippet: extractSnippet(lines, call.line, call.endLine),
        });
        break;
      }
    }
  }

  return callSites;
}

/**
 * import から、その呼び出し起点で試すべき SDK の候補を作る。
 *
 * Go のパッケージ名は import パスから確定できない（`github.com/stripe/stripe-go/v86`
 * の実際のパッケージ名は `stripe`）ため、1 つに絞らず候補として返し、
 * 実スペックに解決できたものを採用する。
 */
function resolveConventions(file: ExtractedFile): Map<string, SdkConvention[]> {
  const imported = SDK_CONVENTIONS.filter(
    (c) =>
      c.language === 'go' &&
      file.imports.some((entry) =>
        c.modules.some((m) => entry.module === m || entry.module.startsWith(`${m}/`)),
      ),
  );
  if (imported.length === 0) return new Map();

  const result = new Map<string, SdkConvention[]>();
  // `sc := stripe.NewClient(key)` のようなクライアント変数
  for (const variable of Object.keys(file.clients)) result.set(variable, imported);
  // パッケージ名を直接使う形にも備える
  for (const entry of file.imports) {
    if (imported.some((c) => c.modules.some((m) => entry.module.startsWith(m)))) {
      result.set(entry.name, imported);
    }
  }
  return result;
}

/** クライアントが別パッケージで生成されている場合に、変数名から推定する。 */
const heuristicConventions = (root: string): SdkConvention[] =>
  SDK_CONVENTIONS.filter((c) => c.language === 'go' && c.clientNames.includes(root.toLowerCase()));

/** 呼び出しの前後を含めた抜粋。 */
function extractSnippet(lines: string[], line: number, endLine: number): string {
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, endLine + 6);
  const text = lines.slice(from, to).join('\n').replace(/^\s*\n/, '');
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text;
}

function runExtractor(files: GoScanInput[]): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(EXTRACTOR, [], { shell: false });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`抽出器が終了コード ${code} で終了しました: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve((JSON.parse(stdout) as { files: ExtractedFile[] }).files);
      } catch (error) {
        reject(new Error(`抽出器の出力を解釈できませんでした: ${String(error)}`));
      }
    });

    child.stdin.end(JSON.stringify({ files }), 'utf8');
  });
}
