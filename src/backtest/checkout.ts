import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 300_000;

export interface Checkout {
  dir: string;
  /** 実際に取得したコミット。 */
  sha: string;
  dispose: () => Promise<void>;
}

/**
 * 対象リポジトリを、指定した時点の状態で取得する。
 *
 * 履歴全体は要らないので、必要なコミットだけを浅く取得する
 * （再現テストは多数のリポジトリを回すため、転送量を抑える）。
 */
export async function checkoutRepository(url: string, ref?: string): Promise<Checkout> {
  const dir = await mkdtemp(path.join(tmpdir(), 'backtest-'));

  try {
    await exec('git', ['-C', dir, 'init', '--quiet'], { timeout: GIT_TIMEOUT_MS });
    await exec('git', ['-C', dir, 'remote', 'add', 'origin', url], { timeout: GIT_TIMEOUT_MS });

    // ref を省略した場合は既定ブランチの先端を取る
    const target = ref ?? 'HEAD';
    await exec('git', ['-C', dir, 'fetch', '--depth', '1', '--quiet', 'origin', target], {
      timeout: GIT_TIMEOUT_MS,
    });
    await exec('git', ['-C', dir, 'checkout', '--quiet', 'FETCH_HEAD'], { timeout: GIT_TIMEOUT_MS });

    const { stdout } = await exec('git', ['-C', dir, 'rev-parse', 'HEAD'], { timeout: GIT_TIMEOUT_MS });

    return {
      dir,
      sha: stdout.trim(),
      dispose: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
