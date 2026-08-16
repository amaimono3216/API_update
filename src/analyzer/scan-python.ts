import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { OperationIndex, SdkConvention } from './sdk-map.js';
import { SDK_CONVENTIONS, findConvention } from './sdk-map.js';
import type { CallSite } from './types.js';

const EXTRACTOR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'extract_python_calls.py');
const TIMEOUT_MS = 120_000;
const MAX_SNIPPET_LENGTH = 600;

export const isPythonFile = (filePath: string): boolean => filePath.endsWith('.py');

/** 抽出器（Python 側）が返す構文上の事実。SDK の知識は含まない。 */
interface ExtractedFile {
  path: string;
  error: string | null;
  imports: { module: string; name: string; imported?: string }[];
  clients: Record<string, string>;
  calls: { root: string; chain: string[]; line: number; endLine: number; params: string[] }[];
}

export interface PythonScanInput {
  path: string;
  content: string;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
}

let unavailableReported = false;

/**
 * Python ソースを走査し、SDK 呼び出し箇所を抽出する。
 *
 * 構文解析は Python 自身の `ast` モジュールに任せる（文法の再実装を避けるため）。
 * 1 ファイルごとにプロセスを起動すると遅いので、まとめて 1 回で処理する。
 *
 * Python が使えない環境では警告を 1 度出して空を返す。TypeScript の走査は止めない。
 */
export async function scanPythonFiles(
  files: PythonScanInput[],
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
      log.warn({ err: String(error) }, 'Python の解析を実行できませんでした。.py ファイルはスキップします');
    }
    return [];
  }

  const contentByPath = new Map(files.map((f) => [f.path, f.content]));
  const callSites: CallSite[] = [];

  for (const file of extracted) {
    if (file.error) {
      log.warn({ file: file.path, err: file.error }, 'Python ファイルの解析に失敗しました');
      continue;
    }

    const conventions = resolveConventions(file);
    const lines = (contentByPath.get(file.path) ?? '').split('\n');

    for (const call of file.calls) {
      const convention = conventions.get(call.root) ?? heuristicConvention(call.root);
      if (!convention) continue;

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
    }
  }

  return callSites;
}

/** import とクライアント代入から、変数名 → SDK の対応を作る。 */
function resolveConventions(file: ExtractedFile): Map<string, SdkConvention> {
  // import 元モジュールから、その SDK のコンストラクタ名を集める
  const constructorToConvention = new Map<string, SdkConvention>();
  const moduleAliasToConvention = new Map<string, SdkConvention>();

  for (const entry of file.imports) {
    // `from twilio.rest import Client` の `twilio.rest` も `twilio` として扱う
    const convention = findConvention(entry.module, 'python') ?? findConvention(rootModule(entry.module), 'python');
    if (!convention) continue;

    if (entry.imported) constructorToConvention.set(entry.name, convention);
    else moduleAliasToConvention.set(entry.name, convention);
  }

  const result = new Map<string, SdkConvention>();
  // `import stripe` のように、モジュール自体を呼び出しの起点にする形
  for (const [alias, convention] of moduleAliasToConvention) result.set(alias, convention);
  // `client = WebClient(token)` のように、生成したクライアント変数
  for (const [variable, constructorName] of Object.entries(file.clients)) {
    const convention = constructorToConvention.get(constructorName);
    if (convention) result.set(variable, convention);
  }
  return result;
}

const rootModule = (module: string): string => module.split('.')[0] ?? module;

/** クライアントが別モジュールで生成されている場合に、変数名から推定する。 */
function heuristicConvention(root: string): SdkConvention | undefined {
  const bare = root.includes('.') ? (root.split('.').pop() as string) : root;
  return SDK_CONVENTIONS.find((c) => c.language === 'python' && c.clientNames.includes(bare.toLowerCase()));
}

/** 呼び出しの前後を含めた抜粋。レスポンスの使われ方も判定材料になるため後続行も含める。 */
function extractSnippet(lines: string[], line: number, endLine: number): string {
  const from = Math.max(0, line - 2);
  const to = Math.min(lines.length, endLine + 6);
  const text = lines.slice(from, to).join('\n').replace(/^\s*\n/, '');
  return text.length > MAX_SNIPPET_LENGTH ? `${text.slice(0, MAX_SNIPPET_LENGTH)}…` : text;
}

/**
 * インタプリタの実行ファイル名は環境で異なる（Windows には `python3` の名前で
 * 「未インストール」を案内するだけのスタブが置かれていることがある）ため、
 * 実際に動いたものを採用する。
 */
const PYTHON_CANDIDATES = [process.env['PYTHON_BIN'], 'python3', 'python'].filter(
  (value): value is string => Boolean(value),
);

async function runExtractor(files: PythonScanInput[]): Promise<ExtractedFile[]> {
  const payload = JSON.stringify({ files });
  let firstError: unknown;

  for (const bin of PYTHON_CANDIDATES) {
    try {
      return await runWith(bin, payload);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError ?? new Error('Python インタプリタが見つかりませんでした');
}

function runWith(bin: string, payload: string): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [EXTRACTOR], { shell: false });

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
        reject(new Error(`${bin} が終了コード ${code} で終了しました: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        resolve((JSON.parse(stdout) as { files: ExtractedFile[] }).files);
      } catch (error) {
        reject(new Error(`抽出器の出力を解釈できませんでした: ${String(error)}`));
      }
    });

    child.stdin.end(payload, 'utf8');
  });
}
