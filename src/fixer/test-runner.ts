import { spawn } from 'node:child_process';

import type { TestResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** LLM にフィードバックする出力量の上限。失敗原因は末尾に出るため末尾を残す。 */
const MAX_OUTPUT_CHARS = 8_000;

export interface TestCommand {
  command: string;
  args: string[];
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
 * Windows では npm 系コマンドが `.cmd` シムであり、Node 20 以降はシェル無しでの
 * 実行を拒否する。この場合のみシェル経由で起動する（本番コンテナは Linux のため通常は通らない）。
 */
const WINDOWS_CMD_SHIMS = new Set(['npm', 'npx', 'yarn', 'pnpm']);
const needsShell = (command: string): boolean =>
  process.platform === 'win32' && WINDOWS_CMD_SHIMS.has(command);

/** シェル経由になる場合は引数の分離が効かないため、メタ文字を含む引数を拒否する。 */
const SHELL_METACHARACTERS = /[&|;<>`$(){}[\]!\n\r"']/;

/**
 * 自プロセスの環境変数のうち、対象リポジトリのコマンドに漏らしてはいけないものを除く。
 *
 * - `NODE_OPTIONS`  : 自分側のローダ（tsx など）が対象リポジトリの Node に注入されてしまう
 * - `NODE_TEST_*`   : 自分がテストランナー配下にいると、対象の `node --test` が
 *                     子プロセスモードとして動作し、終了コードが正しく返らない
 * - `npm_*`         : 自パッケージの lifecycle / config が対象の npm に引き継がれる
 *
 * サンドボックス実行では、そもそも環境変数はコンテナへ引き継がれない。
 * これはローカル実行時の保険。
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

/**
 * コマンドを実行して結果を返す低レベル関数。
 *
 * 対象リポジトリのコードを直接ここで実行するかどうかは呼び出し側（sandbox.ts）が決める。
 * シェルを介さず（引数配列で spawn）、タイムアウトと出力量の上限を設けている。
 */
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
