import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isScannableFile } from './scan.js';

/** 走査対象から除外するディレクトリ。 */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  'vendor',
  '__pycache__',
]);

const MAX_FILE_BYTES = 1024 * 1024;

export interface SourceFile {
  /** リポジトリルートからの相対パス（POSIX 区切り） */
  path: string;
  content: string;
}

/**
 * 解析対象リポジトリのソース取得層。
 *
 * 現状はローカルディレクトリのみを実装している。GitHub App の認証情報が揃ったら
 * 同じインタフェースで clone 実装を追加し、②以降のコードは変更せずに切り替える。
 */
export interface RepositorySource {
  /** `owner/repo` 形式の識別子（ローカルの場合はディレクトリ名） */
  readonly name: string;
  listSourceFiles(): Promise<SourceFile[]>;
}

export class LocalRepository implements RepositorySource {
  constructor(
    private readonly root: string,
    readonly name: string = path.basename(root),
  ) {}

  async listSourceFiles(): Promise<SourceFile[]> {
    const files: SourceFile[] = [];
    await this.walk(this.root, files);
    return files;
  }

  private async walk(directory: string, out: SourceFile[]): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        await this.walk(absolute, out);
        continue;
      }
      if (!entry.isFile() || !isScannableFile(entry.name)) continue;

      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) continue;

      out.push({
        path: path.relative(this.root, absolute).split(path.sep).join('/'),
        content: await readFile(absolute, 'utf8'),
      });
    }
  }
}
