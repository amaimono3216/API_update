import type { Notifier } from '../notify/types.js';

interface Logger {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/** GitHub Webhook のペイロードのうち、このシステムが参照する部分だけを型にする。 */
export interface GitHubPayload {
  action?: string;
  repository?: { full_name?: string };
  installation?: { id?: number };
  pull_request?: {
    html_url?: string;
    merged?: boolean;
    number?: number;
    head?: { ref?: string };
  };
  repositories_added?: { full_name?: string }[];
  repositories_removed?: { full_name?: string }[];
}

/**
 * 実行記録への読み書き。DB 実装への依存を持ち込まないよう、必要な操作だけを受け取る。
 */
export interface RunStore {
  findByPrUrl: (prUrl: string) => Promise<{ id: string; repository: string } | null>;
  setStatus: (id: string, status: 'pr_merged' | 'pr_closed') => Promise<void>;
}

export interface HandlerContext {
  log: Logger;
  notifier: Notifier;
  runs: RunStore;
}

export interface HandleResult {
  /** 何らかの状態更新を行ったか。単に受理しただけの場合は false。 */
  handled: boolean;
  detail: string;
}

export const repositoryOf = (payload: GitHubPayload): string | undefined => payload.repository?.full_name;

/**
 * GitHub Webhook のイベントを処理する。
 *
 * 対応していないイベントもエラーにはしない。GitHub 側でイベント種別を絞れない
 * 設定もあるため、未知のイベントは受理だけして無視する。
 */
export async function handleGitHubEvent(
  event: string,
  payload: GitHubPayload,
  ctx: HandlerContext,
): Promise<HandleResult> {
  switch (event) {
    case 'ping':
      return { handled: false, detail: 'ping を受信しました' };

    case 'pull_request':
      return handlePullRequest(payload, ctx);

    case 'installation':
    case 'installation_repositories':
      return handleInstallation(payload, ctx.log);

    default:
      ctx.log.info({ event, action: payload.action }, '対応していない Webhook イベントを受信しました');
      return { handled: false, detail: `未対応のイベントです: ${event}` };
  }
}

/**
 * 自動生成した PR の結末を実行記録に反映する。
 *
 * マージされたか閉じられたかは、自動修正がどれだけ受け入れられているかの指標になる。
 */
async function handlePullRequest(payload: GitHubPayload, ctx: HandlerContext): Promise<HandleResult> {
  if (payload.action !== 'closed') {
    return { handled: false, detail: `pull_request.${payload.action} は処理対象外です` };
  }

  const url = payload.pull_request?.html_url;
  if (!url) return { handled: false, detail: 'PR の URL が含まれていません' };

  const run = await ctx.runs.findByPrUrl(url);
  if (!run) {
    // このシステムが作成した PR 以外のイベントも届くため、警告ではなく情報として記録する
    ctx.log.info({ url }, 'このシステムが作成した PR ではありません');
    return { handled: false, detail: '対応する実行記録が見つかりません' };
  }

  const merged = payload.pull_request?.merged === true;
  await ctx.runs.setStatus(run.id, merged ? 'pr_merged' : 'pr_closed');
  ctx.log.info({ runId: run.id, url, merged }, 'PR の結末を記録しました');

  if (merged) {
    await ctx.notifier.notify({ type: 'pr_merged', repository: run.repository, url });
  }
  return { handled: true, detail: merged ? 'PR のマージを記録しました' : 'PR のクローズを記録しました' };
}

/** App のインストール状況。監視対象リポジトリの管理に使う（現状は記録のみ）。 */
async function handleInstallation(payload: GitHubPayload, log: Logger): Promise<HandleResult> {
  const added = payload.repositories_added?.map((r) => r.full_name).filter(Boolean) ?? [];
  const removed = payload.repositories_removed?.map((r) => r.full_name).filter(Boolean) ?? [];

  log.info(
    { action: payload.action, installationId: payload.installation?.id, added, removed },
    'インストール状況が変化しました',
  );
  return { handled: false, detail: `インストール状況を記録しました: ${payload.action}` };
}
