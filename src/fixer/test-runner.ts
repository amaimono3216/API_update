import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TestResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** LLM にフィードバックする出力量の上限。失敗原因は末尾に出るため末尾を残す。 */
const MAX_OUTPUT_CHARS = 8_000;

export interface TestCommand {
  command: string;
  args: string[];
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

/** Python の依存を入れる仮想環境。作業コピー内に閉じ込める。 */
const VENV_DIR = '.venv';
const VENV_BIN = path.join(VENV_DIR, 'bin');

/**
 * リポジトリ既存のテストコマンドを検出する。
 * 検出できない場合は undefined を返し、テスト検証なしで修正結果を返す。
 *
 * 依存関係のインストール後に呼ぶこと。仮想環境が作られていればそちらの
 * pytest を使う（対象リポジトリの依存が入っているのは仮想環境側のため）。
 */
export async function detectTestCommand(dir: string): Promise<TestCommand | undefined> {
  const packageJsonPath = path.join(dir, 'package.json');
  if (await exists(packageJsonPath)) {
    try {
      const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> };
      if (manifest.scripts?.test) return { command: 'npm', args: ['test', '--silent'] };
    } catch {
      // package.json が壊れている場合は他の候補にフォールバックする
    }
  }

  for (const marker of ['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt']) {
    if (!(await exists(path.join(dir, marker)))) continue;
    const venvPytest = path.join(dir, VENV_BIN, 'pytest');
    return (await exists(venvPytest))
      ? { command: path.join('.', VENV_BIN, 'pytest'), args: ['-q'] }
      : { command: 'pytest', args: ['-q'] };
  }

  // 実行環境に無いコマンドを返すと、修正ループが 3 回とも「テスト失敗」で無駄に回る
  if ((await exists(path.join(dir, 'go.mod'))) && (await commandExists('go'))) {
    return { command: 'go', args: ['test', './...'] };
  }
  if ((await exists(path.join(dir, 'Cargo.toml'))) && (await commandExists('cargo'))) {
    return { command: 'cargo', args: ['test'] };
  }

  return undefined;
}

/** 実行環境にそのコマンドがあるか。無ければテスト検証をスキップする判断に使う。 */
export function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === 'win32' ? 'where' : 'which', [command], { shell: false });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

/**
 * 依存関係のインストール手順を返す。順に実行する。
 *
 * Python は作業コピー内に仮想環境を作ってそこへ入れる。コンテナの
 * システム Python を汚さず、実行のたびに独立した状態から始められる。
 */
export async function detectInstallCommands(dir: string): Promise<TestCommand[]> {
  if (await exists(path.join(dir, 'package-lock.json'))) return [{ command: 'npm', args: ['ci'] }];
  if (await exists(path.join(dir, 'yarn.lock'))) return [{ command: 'yarn', args: ['install', '--frozen-lockfile'] }];
  if (await exists(path.join(dir, 'pnpm-lock.yaml'))) {
    return [{ command: 'pnpm', args: ['install', '--frozen-lockfile'] }];
  }

  const pip = path.join('.', VENV_BIN, 'pip');
  if (await exists(path.join(dir, 'requirements.txt'))) {
    return [
      { command: 'python3', args: ['-m', 'venv', VENV_DIR] },
      { command: pip, args: ['install', '--quiet', '-r', 'requirements.txt'] },
      // テスト実行にも仮想環境側の pytest を使うため、同じ環境に入れる
      { command: pip, args: ['install', '--quiet', 'pytest'] },
    ];
  }
  if (await exists(path.join(dir, 'pyproject.toml'))) {
    return [
      { command: 'python3', args: ['-m', 'venv', VENV_DIR] },
      { command: pip, args: ['install', '--quiet', '.'] },
      { command: pip, args: ['install', '--quiet', 'pytest'] },
    ];
  }

  return [];
}

/**
 * 対象リポジトリのコマンドを実行する。
 *
 * 注意: これは対象リポジトリのコードを実行する。信頼できないリポジトリを解析する場合、
 * 実運用ではネットワーク遮断・リソース制限つきの使い捨てサンドボックスで動かすこと。
 * ここではシェルを介さず（引数配列で spawn）、タイムアウトと出力量の上限のみ設けている。
 */
/**
 * Windows では npm 系コマンドが `.cmd` シムであり、Node 20 以降はシェル無しでの
 * 実行を拒否する。この場合のみシェル経由で起動する（本番コンテナは Linux のため通常は通らない）。
 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);
const needsShell = (command: string): boolean =>
  process.platform === 'win32' && WINDOWS_CMD_SHIMS.has(command);

/** シェル経由になる場合は引数の分離が効かないため、メタ文字を含む引数を拒否する。 */
const SHELL_METACHARACTERS = /[&|;<>`$(){}[\]!\n\r"']/;

/**
 * 自プロセスの環境変数のうち、対象リポジトリのテスト実行に漏らしてはいけないものを除く。
 *
 * - `NODE_OPTIONS`  : 自分側のローダ（tsx など）が対象リポジトリの Node に注入されてしまう
 * - `NODE_TEST_*`   : 自分がテストランナー配下にいると、対象の `node --test` が
 *                     子プロセスモードとして動作し、終了コードが正しく返らない
 * - `npm_*`         : 自パッケージの lifecycle / config が対象の npm に引き継がれる
 */
const LEAKY_ENV_PATTERN = /^(npm_|NODE_TEST_)/;
const LEAKY_ENV_KEYS = new Set(['NODE_OPTIONS']);

function buildChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (LEAKY_ENV_KEYS.has(key) || LEAKY_ENV_PATTERN.test(key)) continue;
    env[key] = value;
  }
  return { ...env, CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1' };
}

export function runCommand(
  dir: string,
  { command, args }: TestCommand,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TestResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const shell = needsShell(command);

    if (shell && args.some((arg) => SHELL_METACHARACTERS.test(arg))) {
      resolve({
        executed: false,
        passed: false,
        command: `${command} ${args.join(' ')}`,
        exitCode: null,
        output: 'シェル経由の実行では扱えない文字が引数に含まれています',
        durationMs: 0,
        timedOut: false,
      });
      return;
    }

    const child = spawn(command, args, { cwd: dir, shell, env: buildChildEnv() });

    let output = '';
    let timedOut = false;
    const capture = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > MAX_OUTPUT_CHARS * 4) output = output.slice(-MAX_OUTPUT_CHARS * 2);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      resolve({
        executed: true,
        passed: exitCode === 0 && !timedOut,
        command: `${command} ${args.join(' ')}`,
        exitCode,
        output: output.length > MAX_OUTPUT_CHARS ? `…（省略）\n${output.slice(-MAX_OUTPUT_CHARS)}` : output,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    };

    child.on('close', finish);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        executed: false,
        passed: false,
        command: `${command} ${args.join(' ')}`,
        exitCode: null,
        output: `コマンドを実行できませんでした: ${error.message}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
      });
    });
  });
}
