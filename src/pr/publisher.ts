import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/** このシステムが自動生成するブランチの接頭辞。 */
export const MANAGED_BRANCH_PREFIX = 'api-update/';

/**
 * force push してよいブランチかを判定する。
 *
 * 同じ差分を再実行すると、作業コピーはベースから作り直されるためリモートに残った
 * 前回のブランチとは履歴が繋がらず、通常の push は non-fast-forward で拒否される。
 * 自動生成ブランチは「やり直し＝上書き」で問題ないため force push を許すが、
 * **それ以外のブランチには絶対に使わない**。
 */
export function shouldForcePush(branch: string): boolean {
  if (!branch.startsWith(MANAGED_BRANCH_PREFIX)) return false;
  // パス操作で接頭辞の外に出られないことを確かめる
  if (branch.includes('..')) return false;
  return branch.length > MANAGED_BRANCH_PREFIX.length;
}

export interface PullRequestPlan {
  /** `owner/repo` 形式 */
  repository: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  /** 修正済みの作業ディレクトリ。push 元になる。 */
  workdir: string;
}

export interface PublishResult {
  published: boolean;
  url: string | null;
  /** 送信しなかった場合の理由 */
  reason?: string;
}

/**
 * PR の送信先。GitHub 認証情報の有無で実装を差し替える。
 * テンプレート生成と送信を分離しておくことで、認証情報が無くても内容を検証できる。
 */
export interface PullRequestPublisher {
  publish(plan: PullRequestPlan): Promise<PublishResult>;
}

/** 認証情報が無い場合の既定実装。内容を組み立てるところまでで止める。 */
export class DryRunPublisher implements PullRequestPublisher {
  async publish(): Promise<PublishResult> {
    return {
      published: false,
      url: null,
      reason: 'GitHub App の認証情報が未設定のため、PR は作成していません（内容の生成のみ実行）',
    };
  }
}

export interface GitHubCredentials {
  appId: string;
  privateKey: string;
}

/**
 * GitHub App として作業ブランチを push し、PR を作成する。
 *
 * 注意: 認証情報が未設定のため実際の GitHub API に対する動作確認は未実施。
 * push はインストールトークンを埋めた URL 経由で行い、トークンをリポジトリ設定に残さない。
 */
export class GitHubPublisher implements PullRequestPublisher {
  constructor(private readonly credentials: GitHubCredentials) {}

  async publish(plan: PullRequestPlan): Promise<PublishResult> {
    const [owner, repo] = plan.repository.split('/');
    if (!owner || !repo) throw new Error(`リポジトリ名は owner/repo 形式で指定してください: ${plan.repository}`);

    const appOctokit = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId: this.credentials.appId, privateKey: this.credentials.privateKey },
    });

    // 対象リポジトリに対する App インストールを解決し、そのトークンで操作する
    const { data: installation } = await appOctokit.rest.apps.getRepoInstallation({ owner, repo });
    const auth = createAppAuth({
      appId: this.credentials.appId,
      privateKey: this.credentials.privateKey,
      installationId: installation.id,
    });
    const { token } = await auth({ type: 'installation' });
    const octokit = new Octokit({ auth: token });

    await this.pushBranch(plan, owner, repo, token);

    // 同じ差分の再実行では既に PR が開いている。二重に作らず内容を更新する
    const { data: existing } = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${plan.branch}`,
      state: 'open',
    });

    const open = existing[0];
    if (open) {
      const { data: updated } = await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: open.number,
        title: plan.title,
        body: plan.body,
      });
      return { published: true, url: updated.html_url };
    }

    const { data: pullRequest } = await octokit.rest.pulls.create({
      owner,
      repo,
      head: plan.branch,
      base: plan.baseBranch,
      title: plan.title,
      body: plan.body,
    });

    return { published: true, url: pullRequest.html_url };
  }

  /** トークンは引数として渡すだけにして、作業ディレクトリの git 設定には残さない。 */
  private async pushBranch(plan: PullRequestPlan, owner: string, repo: string, token: string): Promise<void> {
    const remote = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
    const args = ['-C', plan.workdir, 'push', '--quiet'];
    if (shouldForcePush(plan.branch)) args.push('--force');
    args.push(remote, `HEAD:refs/heads/${plan.branch}`);

    await exec('git', args, { timeout: GIT_TIMEOUT_MS });
  }
}

/** 認証情報が揃っていれば GitHub 実装を、無ければ dry-run を返す。 */
export function createPublisher(credentials: Partial<GitHubCredentials>): PullRequestPublisher {
  return credentials.appId && credentials.privateKey
    ? new GitHubPublisher({ appId: credentials.appId, privateKey: credentials.privateKey })
    : new DryRunPublisher();
}
