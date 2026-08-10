import path from 'node:path';

import type { Runtime } from './runtime.js';
import { commandExists, runCommand, type TestCommand } from './test-runner.js';
import type { TestResult } from './types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface RunOptions {
  /** ネットワークを許可するか。依存関係の取得時のみ true にする。 */
  network: boolean;
  timeoutMs?: number;
}

/**
 * 対象リポジトリのコマンドを実行する主体。
 *
 * 対象リポジトリのコードは信頼できないため、可能なら使い捨てコンテナで隔離する。
 */
export interface CommandRunner {
  readonly kind: 'sandbox' | 'local';
  run(workdir: string, runtime: Runtime, command: TestCommand, options: RunOptions): Promise<TestResult>;
}

/**
 * アプリコンテナ内で直接実行する。
 *
 * Docker が使えない環境向けのフォールバック。**対象リポジトリのコードが
 * アプリと同じプロセス空間・同じ環境変数で動く**ため、信頼できるリポジトリにのみ使うこと。
 */
export class LocalRunner implements CommandRunner {
  readonly kind = 'local';

  async run(workdir: string, runtime: Runtime, command: TestCommand, options: RunOptions): Promise<TestResult> {
    // パス指定のコマンド（`./.venv/bin/pytest` など）は PATH 検索の対象外
    const needsLookup = !command.command.includes('/') && !command.command.includes('\\');
    if (needsLookup && !(await commandExists(command.command))) {
      return {
        executed: false,
        passed: false,
        command: `${command.command} ${command.args.join(' ')}`,
        exitCode: null,
        output: `このコマンドは実行環境にありません: ${command.command}（${runtime.id} のランタイムが必要）`,
        durationMs: 0,
        timedOut: false,
      };
    }
    return runCommand(workdir, command, options.timeoutMs);
  }
}

/** 1 コンテナあたりの上限。暴走したテストでホストを巻き込まないため。 */
const LIMITS = ['--memory', '2g', '--memory-swap', '2g', '--cpus', '2', '--pids-limit', '512'];

/**
 * 使い捨てコンテナで実行する。
 *
 * アプリコンテナの Docker ソケット経由で、ホスト上に兄弟コンテナを立てる。
 * 作業コピーは共有ボリュームに置き、コンテナにはボリューム名でマウントする
 * （アプリコンテナ内のパスはホストから見えないため）。
 *
 * - テスト実行時はネットワークを遮断する（依存取得時のみ許可）
 * - 環境変数を引き継がないので、DB 認証情報や GitHub トークンは渡らない
 * - Docker ソケット自体はサンドボックスへマウントしない
 */
export class DockerSandboxRunner implements CommandRunner {
  readonly kind = 'sandbox';

  constructor(
    private readonly workspaceVolume: string,
    private readonly workspaceRoot: string,
  ) {}

  async run(workdir: string, runtime: Runtime, command: TestCommand, options: RunOptions): Promise<TestResult> {
    const relative = path.relative(this.workspaceRoot, workdir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`作業ディレクトリが共有ボリュームの外にあります: ${workdir}`);
    }
    const containerWorkdir = path.posix.join(this.workspaceRoot, relative.split(path.sep).join('/'));

    const args = [
      'run',
      '--rm',
      ...LIMITS,
      '--network',
      options.network ? 'bridge' : 'none',
      // ボリューム内のファイルがアプリ側から扱えるよう、実行ユーザを揃える
      ...(process.getuid ? ['--user', `${process.getuid()}:${process.getgid?.() ?? 0}`] : []),
      '--volume',
      `${this.workspaceVolume}:${this.workspaceRoot}`,
      '--workdir',
      containerWorkdir,
      '--env',
      'CI=true',
      '--env',
      'HOME=/tmp',
      '--env',
      'NO_COLOR=1',
      runtime.image,
      command.command,
      ...command.args,
    ];

    const result = await runCommand(process.cwd(), { command: 'docker', args }, options.timeoutMs);
    return { ...result, command: `${command.command} ${command.args.join(' ')}` };
  }
}

/**
 * 実行環境に応じて隔離実行かローカル実行かを選ぶ。
 *
 * Docker を使えない場合でも処理は止めず、隔離されていないことを警告する。
 */
export async function createRunner(log: Logger): Promise<CommandRunner> {
  // 値の検証は config/env.ts が起動時に行う。ここで env を import すると
  // このモジュールが DB 設定に依存してしまうため、直接読む。
  const sandboxEnabled = process.env['SANDBOX_ENABLED'] !== 'false';
  const volume = process.env['SANDBOX_WORKSPACE_VOLUME'];
  const root = process.env['WORKSPACE_ROOT'];

  if (!sandboxEnabled) {
    log.warn({}, 'サンドボックスが無効化されています。対象リポジトリのコードをアプリコンテナ内で実行します');
    return new LocalRunner();
  }

  if (!volume || !root) {
    log.warn(
      {},
      'SANDBOX_WORKSPACE_VOLUME / WORKSPACE_ROOT が未設定のため、隔離せずに実行します',
    );
    return new LocalRunner();
  }

  if (!(await dockerAvailable())) {
    log.warn({}, 'Docker を利用できないため、隔離せずに実行します');
    return new LocalRunner();
  }

  log.info({ volume, root }, '使い捨てコンテナで対象リポジトリのコマンドを実行します');
  return new DockerSandboxRunner(volume, root);
}

async function dockerAvailable(): Promise<boolean> {
  if (!(await commandExists('docker'))) return false;
  const result = await runCommand(process.cwd(), { command: 'docker', args: ['info', '--format', '{{.ServerVersion}}'] }, 15_000);
  return result.passed;
}
