import { isPythonFile, scanPythonFiles } from './scan-python.js';
import { isTypeScriptFile, scanSource } from './scan-typescript.js';
import type { OperationIndex } from './sdk-map.js';
import type { CallSite } from './types.js';

export interface ScannableFile {
  path: string;
  content: string;
}

interface Logger {
  warn: (obj: object, msg: string) => void;
}

/** 走査対象の拡張子か。リポジトリの列挙時にも使う。 */
export const isScannableFile = (filePath: string): boolean => isTypeScriptFile(filePath) || isPythonFile(filePath);

/**
 * 言語ごとの走査を振り分ける。
 *
 * TypeScript / JavaScript は同一プロセス内で解析できるが、Python は
 * 外部プロセス（Python の ast モジュール）を使うためまとめて処理する。
 */
export async function scanFiles(
  files: ScannableFile[],
  index: OperationIndex,
  log: Logger,
): Promise<CallSite[]> {
  const callSites: CallSite[] = [];
  const pythonFiles: ScannableFile[] = [];

  for (const file of files) {
    if (isPythonFile(file.path)) {
      pythonFiles.push(file);
      continue;
    }
    if (!isTypeScriptFile(file.path)) continue;

    try {
      callSites.push(...scanSource(file.path, file.content, index));
    } catch (error) {
      // 構文エラーのあるファイルで全体を止めない
      log.warn({ file: file.path, err: String(error) }, 'ファイルの解析に失敗しました');
    }
  }

  callSites.push(...(await scanPythonFiles(pythonFiles, index, log)));
  return callSites;
}
