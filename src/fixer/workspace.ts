import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 120_000;
/** 自動修正のコミット主体。実運用では GitHub App の identity に差し替える。 */
const COMMIT_AUTHOR = { name: 'api-update-bot', email: 'api-update-bot@users.noreply.github.com' };

/**
 * 修正作業用の一時的な作業コピー。
 *
 * 対象リポジトリを直接書き換えず、clone した作業ブランチ上で編集・テストする。
 * 失敗しても元のリポジトリに影響が残らず、成功時はそのまま diff を取り出せる。
 */
export class Workspace {
  private constructor(
    readonly dir: string,
    readonly branch: string,
    private readonly baseRef: string,
  ) {}

  /**
   * 対象リポジトリから作業コピーを作り、作業ブランチを切る。
   * git 管理下でない場合はコピーしたうえで初期化し、diff を取れる状態にする。
   */
  static async create(sourcePath: string, branch: string): Promise<Workspace> {
    const dir = await mkdtemp(path.join(tmpdir(), 'api-update-'));

    if (await isGitRepository(sourcePath)) {
      await exec('git', ['clone', '--no-hardlinks', '--quiet', sourcePath, dir], { timeout: GIT_TIMEOUT_MS });
    } else {
      await cp(sourcePath, dir, { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
      await git(dir, ['init', '--quiet']);
      await git(dir, ['add', '-A']);
      await commit(dir, 'chore: 作業コピーの初期状態');
    }

    // LLM の編集は文字列の完全一致に依存するため、改行コードを変換させない
    await git(dir, ['config', 'core.autocrlf', 'false']);
    await git(dir, ['config', 'core.eol', 'lf']);
    await excludeBuildArtifacts(dir);

    const baseRef = (await git(dir, ['rev-parse', 'HEAD'])).trim();
    await git(dir, ['checkout', '-b', branch]);
    return new Workspace(dir, branch, baseRef);
  }

  resolve(relativePath: string): string {
    const absolute = path.resolve(this.dir, relativePath);
    // LLM が生成したパスをそのまま使うため、作業ディレクトリ外への脱出を防ぐ
    if (absolute !== this.dir && !absolute.startsWith(this.dir + path.sep)) {
      throw new Error(`作業ディレクトリ外のパスは操作できません: ${relativePath}`);
    }
    return absolute;
  }

  readFile(relativePath: string): Promise<string> {
    return readFile(this.resolve(relativePath), 'utf8');
  }

  writeFile(relativePath: string, content: string): Promise<void> {
    return writeFile(this.resolve(relativePath), content, 'utf8');
  }

  /** 作業ブランチの変更内容を diff として取り出す（④ PR 生成モジュール向け）。 */
  async diff(): Promise<string> {
    await git(this.dir, ['add', '-A']);
    return git(this.dir, ['diff', '--cached', this.baseRef]);
  }

  async commitAll(message: string): Promise<void> {
    await git(this.dir, ['add', '-A']);
    await commit(this.dir, message);
  }

  /** 直近の編集を破棄してベースの状態に戻す（再試行時に使う）。 */
  async reset(): Promise<void> {
    await git(this.dir, ['reset', '--hard', this.baseRef, '--quiet']);
    await git(this.dir, ['clean', '-fd', '--quiet']);
  }

  async dispose(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}

/**
 * 依存関係のインストールやテスト実行で生成される成果物を、コミット対象から外す。
 *
 * これが無いと `node_modules` や `__pycache__` が PR に混入する。
 * 対象リポジトリの `.gitignore` は書き換えたくないので、
 * 作業コピー内でのみ有効な `.git/info/exclude` を使う。
 */
async function excludeBuildArtifacts(dir: string): Promise<void> {
  const patterns = [
    '# api-update が作業コピー内でのみ適用する除外設定',
    'node_modules/',
    '.venv/',
    'venv/',
    '__pycache__/',
    '*.pyc',
    '.pytest_cache/',
    '.mypy_cache/',
    '.ruff_cache/',
    '.tox/',
    '*.egg-info/',
    '.coverage',
    'htmlcov/',
    '',
  ];
  const excludePath = path.join(dir, '.git', 'info', 'exclude');
  const existing = await readFile(excludePath, 'utf8').catch(() => '');
  await writeFile(excludePath, `${existing}\n${patterns.join('\n')}`, 'utf8');
}

async function isGitRepository(dir: string): Promise<boolean> {
  try {
    await exec('git', ['-C', dir, 'rev-parse', '--git-dir'], { timeout: GIT_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

/** コミット主体はローカル設定に依存させない（CI コンテナには user.name が無いため）。 */
const commit = (dir: string, message: string): Promise<string> =>
  git(dir, [
    '-c',
    `user.name=${COMMIT_AUTHOR.name}`,
    '-c',
    `user.email=${COMMIT_AUTHOR.email}`,
    'commit',
    '--quiet',
    '--allow-empty',
    '-m',
    message,
  ]);
