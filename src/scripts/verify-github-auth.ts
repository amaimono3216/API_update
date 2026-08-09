import 'dotenv/config';

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

/**
 * GitHub App の認証情報が正しいかを確認する（読み取りのみ）。
 *
 *   npm run verify:github
 */
const appId = process.env.GITHUB_APP_ID;
const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;

if (!appId || !privateKeyRaw) {
  console.error('GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY が未設定です');
  process.exit(1);
}

// .env に 1 行で書く場合、改行は \n として埋め込まれる
const privateKey = privateKeyRaw.replace(/\\n/g, '\n');

console.log('--- 認証情報の形式 ---');
console.log(`App ID           : ${appId}`);
console.log(`秘密鍵の長さ     : ${privateKey.length}`);
console.log(`PEM ヘッダ       : ${privateKey.includes('-----BEGIN') ? 'あり' : '★ なし（PEM 形式ではありません）'}`);

if (!privateKey.includes('-----BEGIN')) {
  console.error('\n秘密鍵が PEM 形式ではありません。');
  console.error('GitHub App の設定画面で「Generate a private key」から .pem をダウンロードし、');
  console.error('その中身（-----BEGIN で始まるテキスト全体）を設定してください。');
  console.error('Client secret や Webhook secret とは別物です。');
  process.exit(1);
}

const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });

try {
  const { data: app } = await appOctokit.rest.apps.getAuthenticated();
  console.log('\n--- App 認証に成功しました ---');
  console.log(`App 名           : ${app?.name}`);
  // owner は user / enterprise の union のため、login を持つ場合のみ表示する
  const owner = app?.owner;
  console.log(`所有者           : ${owner && 'login' in owner ? owner.login : (owner?.name ?? '?')}`);
  console.log(`権限             : ${JSON.stringify(app?.permissions ?? {})}`);
  console.log(`購読イベント     : ${(app?.events ?? []).join(', ') || '(なし)'}`);

  const { data: installations } = await appOctokit.rest.apps.listInstallations();
  console.log(`\n--- インストール済み: ${installations.length} 件 ---`);

  for (const installation of installations) {
    console.log(`\n[${installation.account && 'login' in installation.account ? installation.account.login : '?'}] installation_id=${installation.id}`);
    console.log(`  対象: ${installation.repository_selection}`);

    const auth = createAppAuth({ appId, privateKey, installationId: installation.id });
    const { token } = await auth({ type: 'installation' });
    const scoped = new Octokit({ auth: token });
    const { data: repos } = await scoped.rest.apps.listReposAccessibleToInstallation();

    for (const repo of repos.repositories) {
      console.log(`  - ${repo.full_name} (default: ${repo.default_branch}, private: ${repo.private})`);
    }
  }
} catch (error) {
  console.error('\n--- 認証に失敗しました ---');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
