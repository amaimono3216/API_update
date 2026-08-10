import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { ImpactJudgement } from '../analyzer/types.js';
import type { BreakingChange } from '../detector/types.js';
import { applyEdits } from './edit.js';
import { buildBranchName, runFixLoop, type EditGenerator } from './fix-loop.js';
import { detectRuntime } from './runtime.js';
import { createRunner, DockerSandboxRunner, LocalRunner } from './sandbox.js';
import { commandExists, runCommand } from './test-runner.js';
import type { CodeEdit } from './types.js';
import { Workspace } from './workspace.js';

const silentLog = { info: () => {}, warn: () => {} };

/** テスト用の使い捨てディレクトリを作る。 */
const makeTempDir = (): Promise<string> => mkdtemp(path.join(tmpdir(), 'fixer-test-'));

describe('applyEdits', () => {
  let workspace: Workspace;

  before(async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'a.ts'), 'const amount = 100;\nconst other = 200;\n');
    await writeFile(path.join(dir, 'dup.ts'), 'x();\nx();\n');
    workspace = await Workspace.create(dir, 'test-branch');
  });
  after(() => workspace.dispose());

  const edit = (o: Partial<CodeEdit>): CodeEdit => ({
    file: 'a.ts',
    oldString: 'const amount = 100;',
    newString: 'const unitAmountDecimal = "100";',
    description: 'テスト',
    ...o,
  });

  it('一意に一致する編集を適用する', async () => {
    const result = await applyEdits(workspace, [edit({})]);
    assert.equal(result.applied.length, 1);
    assert.equal(result.failures.length, 0);
    assert.match(await workspace.readFile('a.ts'), /unitAmountDecimal/);
  });

  it('見つからない oldString は理由つきで失敗させる', async () => {
    const result = await applyEdits(workspace, [edit({ oldString: '存在しない文字列' })]);
    assert.equal(result.applied.length, 0);
    assert.match(result.failures[0]!.reason, /見つかりません/);
  });

  it('複数箇所に一致する場合は適用しない', async () => {
    const result = await applyEdits(workspace, [edit({ file: 'dup.ts', oldString: 'x();', newString: 'y();' })]);
    assert.equal(result.applied.length, 0);
    assert.match(result.failures[0]!.reason, /2 箇所/);
  });

  it('置換前後が同一の編集は失敗させる', async () => {
    const result = await applyEdits(workspace, [edit({ oldString: 'same', newString: 'same' })]);
    assert.match(result.failures[0]!.reason, /同一/);
  });

  it('同一ファイルへの複数編集を順に反映する', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'b.ts'), 'const a = 1;\nconst b = 2;\n');
    const ws = await Workspace.create(dir, 'b');
    const result = await applyEdits(ws, [
      edit({ file: 'b.ts', oldString: 'const a = 1;', newString: 'const a = 10;' }),
      edit({ file: 'b.ts', oldString: 'const b = 2;', newString: 'const b = 20;' }),
    ]);
    assert.equal(result.applied.length, 2);
    assert.equal(await ws.readFile('b.ts'), 'const a = 10;\nconst b = 20;\n');
    await ws.dispose();
  });

  it('作業ディレクトリ外への書き込みを拒否する', async () => {
    await assert.rejects(
      () => applyEdits(workspace, [edit({ file: '../../etc/passwd' })]),
      /作業ディレクトリ外/,
    );
  });
});

describe('Workspace', () => {
  it('git 管理下でないディレクトリでも初期化して diff を取れる', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'x.ts'), 'const a = 1;\n');
    const ws = await Workspace.create(dir, 'api-update/stripe-2026-01-01');

    await ws.writeFile('x.ts', 'const a = 2;\n');
    const diff = await ws.diff();
    assert.match(diff, /-const a = 1;/);
    assert.match(diff, /\+const a = 2;/);
    await ws.dispose();
  });

  it('元のリポジトリを書き換えない', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'x.ts'), 'original\n');
    const ws = await Workspace.create(dir, 'b');
    await ws.writeFile('x.ts', 'modified\n');

    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(path.join(dir, 'x.ts'), 'utf8'), 'original\n');
    await ws.dispose();
  });

  it('reset で編集前の状態に戻る', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'x.ts'), 'original\n');
    const ws = await Workspace.create(dir, 'b');
    await ws.writeFile('x.ts', 'modified\n');
    await ws.reset();
    assert.equal(await ws.readFile('x.ts'), 'original\n');
    await ws.dispose();
  });
});

describe('detectRuntime', () => {
  it('package.json の test スクリプトから Node ランタイムを判定する', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));

    const runtime = await detectRuntime(dir);
    assert.equal(runtime?.id, 'node');
    assert.deepEqual(runtime?.test, { command: 'npm', args: ['test', '--silent'] });
    assert.match(runtime?.image ?? '', /^node:/);
  });

  it('test スクリプトが無い package.json では判定しない', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'tsc' } }));
    assert.equal(await detectRuntime(dir), undefined);
  });

  it('壊れた package.json でも例外にしない', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), '{ 壊れている');
    assert.equal(await detectRuntime(dir), undefined);
  });

  it('ロックファイルがある場合のみインストール手順を返す', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'x' } }));
    assert.deepEqual((await detectRuntime(dir))?.install, []);

    await writeFile(path.join(dir, 'package-lock.json'), '{}');
    assert.deepEqual((await detectRuntime(dir))?.install, [{ command: 'npm', args: ['ci'] }]);
  });

  it('Python は仮想環境を作ってから依存を入れる', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'requirements.txt'), 'stripe==12.0.0\n');

    const runtime = await detectRuntime(dir);
    assert.equal(runtime?.id, 'python');
    assert.deepEqual(runtime?.install[0], { command: 'python3', args: ['-m', 'venv', '.venv'] });
    // システム Python を汚さないよう、仮想環境側の pip を使う
    assert.ok(runtime?.install[1]?.command.includes('.venv'), runtime?.install[1]?.command);
    assert.ok(runtime?.install.some((c) => c.args.includes('requirements.txt')));
  });

  it('仮想環境があればそちらの pytest を使う', async () => {
    const dir = await makeTempDir();
    await writeFile(path.join(dir, 'requirements.txt'), '');
    assert.deepEqual((await detectRuntime(dir))?.test, { command: 'pytest', args: ['-q'] });

    await mkdir(path.join(dir, '.venv', 'bin'), { recursive: true });
    await writeFile(path.join(dir, '.venv', 'bin', 'pytest'), '');
    assert.ok((await detectRuntime(dir))?.test.command.includes('.venv'));
  });

  it('Go / Rust はツールチェーンの有無に関わらず判定する', async () => {
    // 実行可否はランナー側の判断。ここでは構成ファイルだけを見る
    const go = await makeTempDir();
    await writeFile(path.join(go, 'go.mod'), 'module example\n');
    const goRuntime = await detectRuntime(go);
    assert.equal(goRuntime?.id, 'go');
    assert.match(goRuntime?.image ?? '', /^golang:/);

    const rust = await makeTempDir();
    await writeFile(path.join(rust, 'Cargo.toml'), '[package]\n');
    assert.equal((await detectRuntime(rust))?.id, 'rust');
  });
});

describe('LocalRunner', () => {
  const nodeRuntime = {
    id: 'node' as const,
    image: 'node:22-bookworm-slim',
    install: [],
    test: { command: 'npm', args: ['test'] },
  };

  it('実行環境に無いコマンドは executed=false で返す', async () => {
    const dir = await makeTempDir();
    const result = await new LocalRunner().run(
      dir,
      { ...nodeRuntime, test: { command: 'definitely-not-a-real-command-xyz', args: [] } },
      { command: 'definitely-not-a-real-command-xyz', args: [] },
      { network: false },
    );
    assert.equal(result.executed, false);
    assert.match(result.output, /実行環境にありません/);
  });

  it('存在するコマンドは実行する', async () => {
    const dir = await makeTempDir();
    const result = await new LocalRunner().run(
      dir,
      nodeRuntime,
      { command: process.execPath, args: ['-e', 'process.exit(0)'] },
      { network: false },
    );
    assert.equal(result.passed, true);
  });

  it('コマンドの有無を判定できる', async () => {
    assert.equal(await commandExists('definitely-not-a-real-command-xyz'), false);
    assert.equal(await commandExists(process.platform === 'win32' ? 'cmd' : 'sh'), true);
  });
});

describe('DockerSandboxRunner', () => {
  const runtime = {
    id: 'python' as const,
    image: 'python:3.12-slim-bookworm',
    install: [],
    test: { command: 'pytest', args: ['-q'] },
  };

  it('共有ボリューム外の作業ディレクトリを拒否する', async () => {
    // ボリューム外のパスはサンドボックスから見えないため、黙って動かすと誤った結果になる
    const runner = new DockerSandboxRunner('api_update_workspaces', '/workspaces');
    await assert.rejects(
      () => runner.run('/tmp/somewhere-else', runtime, runtime.test, { network: false }),
      /共有ボリュームの外/,
    );
  });
});

describe('createRunner', () => {
  const log = { info: () => {}, warn: () => {} };

  /** 環境変数を退避して差し替える。 */
  async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('明示的に無効化されていればローカル実行になる', async () => {
    const runner = await withEnv({ SANDBOX_ENABLED: 'false' }, () => createRunner(log));
    assert.equal(runner.kind, 'local');
  });

  it('ボリューム設定が無ければローカル実行にフォールバックする', async () => {
    const runner = await withEnv(
      { SANDBOX_ENABLED: 'true', SANDBOX_WORKSPACE_VOLUME: undefined, WORKSPACE_ROOT: undefined },
      () => createRunner(log),
    );
    assert.equal(runner.kind, 'local');
  });
});

describe('runCommand', () => {
  it('終了コードから成否を判定する', async () => {
    const dir = await makeTempDir();
    const ok = await runCommand(dir, { command: process.execPath, args: ['-e', 'process.exit(0)'] });
    assert.equal(ok.passed, true);

    const ng = await runCommand(dir, { command: process.execPath, args: ['-e', 'process.exit(1)'] });
    assert.equal(ng.passed, false);
    assert.equal(ng.exitCode, 1);
  });

  it('標準出力と標準エラーを両方取り込む', async () => {
    const dir = await makeTempDir();
    const result = await runCommand(dir, {
      command: process.execPath,
      args: ['-e', 'console.log("out"); console.error("err"); process.exit(1)'],
    });
    assert.match(result.output, /out/);
    assert.match(result.output, /err/);
  });

  it('タイムアウトした場合は失敗として扱う', async () => {
    const dir = await makeTempDir();
    const result = await runCommand(dir, { command: process.execPath, args: ['-e', 'setTimeout(()=>{}, 60000)'] }, 300);
    assert.equal(result.timedOut, true);
    assert.equal(result.passed, false);
  });

  it('自プロセスの環境を対象リポジトリに漏らさない', async () => {
    const dir = await makeTempDir();
    process.env.NODE_TEST_CONTEXT = 'leak-check';
    process.env.npm_lifecycle_event = 'leak-check';
    try {
      const result = await runCommand(dir, {
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify({t: process.env.NODE_TEST_CONTEXT, n: process.env.npm_lifecycle_event, o: process.env.NODE_OPTIONS}))'],
      });
      // これらが漏れると対象の `node --test` が子プロセスモードになり終了コードが正しく返らない
      assert.deepEqual(JSON.parse(result.output.trim()), {});
    } finally {
      delete process.env.NODE_TEST_CONTEXT;
      delete process.env.npm_lifecycle_event;
    }
  });

  it('存在しないコマンドは executed=false で返す', async () => {
    const dir = await makeTempDir();
    const result = await runCommand(dir, { command: 'definitely-not-a-real-command-xyz', args: [] });
    assert.equal(result.executed, false);
    assert.equal(result.passed, false);
  });
});

describe('runFixLoop', () => {
  /** 旧仕様 `amount` を使うコードと、新仕様を前提にしたテストを持つ最小リポジトリ。 */
  async function createFixtureRepo(): Promise<string> {
    const dir = await makeTempDir();
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test' } }, null, 2),
    );
    await writeFile(
      path.join(dir, 'src', 'refund.js'),
      ['export function buildRefund(chargeId, amount) {', '  return { charge: chargeId, amount };', '}', ''].join('\n'),
    );
    // 新仕様（amount → unit_amount_decimal 文字列）を前提にしたテスト
    await writeFile(
      path.join(dir, 'refund.test.js'),
      [
        "import assert from 'node:assert/strict';",
        "import { test } from 'node:test';",
        "import { buildRefund } from './src/refund.js';",
        '',
        "test('新仕様のフィールドを返す', () => {",
        "  const payload = buildRefund('ch_1', 2000);",
        "  assert.equal(payload.unit_amount_decimal, '2000');",
        "  assert.equal('amount' in payload, false);",
        '});',
        '',
      ].join('\n'),
    );
    return dir;
  }

  const judgement: ImpactJudgement = {
    file: 'src/refund.js',
    line: 2,
    changeLocation: 'POST /v1/refunds requestBody.amount',
    verdict: 'affected',
    reason: 'amount を渡しているため影響を受けます。',
    suggestedFix: 'unit_amount_decimal へ置き換える。',
  };

  const change: BreakingChange = {
    kind: 'property_removed',
    severity: 'breaking',
    direction: 'request',
    location: 'POST /v1/refunds requestBody.amount',
    propertyPath: 'amount',
    operations: [{ method: 'post', path: '/v1/refunds' }],
    before: 'integer',
    after: undefined,
    message: 'amount が削除されました',
  };

  const params = {
    provider: 'stripe',
    fromVersion: '2026-03-25',
    toVersion: '2026-07-30',
    affected: [judgement],
    changesByLocation: new Map([[change.location, change]]),
    runtime: {
      id: 'node' as const,
      image: 'node:22-bookworm-slim',
      install: [],
      test: { command: 'npm', args: ['test', '--silent'] },
    },
    runner: new LocalRunner(),
  };

  it('1 回で修正が通ればそこで終了する', async () => {
    const ws = await Workspace.create(await createFixtureRepo(), 'b');
    const generate: EditGenerator = async () => ({
      summary: '修正しました',
      edits: [
        {
          file: 'src/refund.js',
          oldString: '  return { charge: chargeId, amount };',
          newString: '  return { charge: chargeId, unit_amount_decimal: String(amount) };',
          description: 'amount を unit_amount_decimal に置き換え',
        },
      ],
    });

    const result = await runFixLoop(ws, { ...params, generateEdits: generate }, silentLog);
    assert.equal(result.succeeded, true);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.test?.passed, true);
    await ws.dispose();
  });

  it('テストが落ちたらエラーログを渡して再修正する', async () => {
    const ws = await Workspace.create(await createFixtureRepo(), 'b');
    const receivedFeedback: string[] = [];

    // 1 回目はフィールド名を間違え、2 回目でテスト出力を見て直す想定
    const generate: EditGenerator = async (request) => {
      if (request.feedback?.test) receivedFeedback.push(request.feedback.test.output);

      if (receivedFeedback.length === 0) {
        return {
          summary: '1 回目',
          edits: [
            {
              file: 'src/refund.js',
              oldString: '  return { charge: chargeId, amount };',
              newString: '  return { charge: chargeId, unitAmountDecimal: String(amount) };',
              description: '誤ったフィールド名',
            },
          ],
        };
      }
      return {
        summary: '2 回目',
        edits: [
          {
            file: 'src/refund.js',
            oldString: 'unitAmountDecimal: String(amount)',
            newString: 'unit_amount_decimal: String(amount)',
            description: 'フィールド名を修正',
          },
        ],
      };
    };

    const result = await runFixLoop(ws, { ...params, generateEdits: generate }, silentLog);
    assert.equal(result.succeeded, true);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0]?.test?.passed, false);
    assert.equal(result.attempts[1]?.test?.passed, true);
    // テストの失敗内容が次の試行にフィードバックされていること
    assert.equal(receivedFeedback.length, 1);
    assert.match(receivedFeedback[0]!, /unit_amount_decimal|fail/i);
    await ws.dispose();
  });

  it('直らない場合は最大 3 回で打ち切る', async () => {
    const ws = await Workspace.create(await createFixtureRepo(), 'b');
    let calls = 0;
    const generate: EditGenerator = async () => {
      calls += 1;
      return {
        summary: `試行 ${calls}`,
        edits: [
          {
            file: 'src/refund.js',
            oldString: `export function buildRefund(chargeId, amount) {`,
            newString: `export function buildRefund(chargeId, amount) { // ${calls}`,
            description: '効果のない編集',
          },
        ],
      };
    };

    const result = await runFixLoop(ws, { ...params, generateEdits: generate }, silentLog);
    assert.equal(result.succeeded, false);
    assert.equal(calls, 3);
    assert.equal(result.attempts.length, 3);
    await ws.dispose();
  });

  it('適用失敗も次の試行にフィードバックする', async () => {
    const ws = await Workspace.create(await createFixtureRepo(), 'b');
    const failureReasons: string[] = [];
    let call = 0;

    const generate: EditGenerator = async (request) => {
      for (const f of request.feedback?.applyResult.failures ?? []) failureReasons.push(f.reason);
      call += 1;
      return call === 1
        ? {
            summary: '一致しない編集',
            edits: [
              { file: 'src/refund.js', oldString: '存在しない行', newString: 'x', description: '失敗する編集' },
            ],
          }
        : {
            summary: '正しい編集',
            edits: [
              {
                file: 'src/refund.js',
                oldString: '  return { charge: chargeId, amount };',
                newString: '  return { charge: chargeId, unit_amount_decimal: String(amount) };',
                description: '修正',
              },
            ],
          };
    };

    const result = await runFixLoop(ws, { ...params, generateEdits: generate }, silentLog);
    assert.equal(result.succeeded, true);
    assert.equal(failureReasons.length, 1);
    assert.match(failureReasons[0]!, /見つかりません/);
    await ws.dispose();
  });

  it('テストコマンドが無い場合は編集のみで完了する', async () => {
    const ws = await Workspace.create(await createFixtureRepo(), 'b');
    const generate: EditGenerator = async () => ({
      summary: '修正',
      edits: [
        {
          file: 'src/refund.js',
          oldString: '  return { charge: chargeId, amount };',
          newString: '  return { charge: chargeId, unit_amount_decimal: String(amount) };',
          description: '修正',
        },
      ],
    });

    const result = await runFixLoop(ws, { ...params, runtime: undefined, generateEdits: generate }, silentLog);
    assert.equal(result.succeeded, true);
    assert.equal(result.test, null);
    await ws.dispose();
  });
});

describe('buildBranchName', () => {
  it('プロバイダ・バージョン・差分 ID を含む形式にする', () => {
    assert.equal(buildBranchName('stripe', '2026-07-30.clover', '12'), 'api-update/stripe-2026-07-30.clover-12');
  });

  it('バージョンが同じでも差分が違えば別のブランチになる', () => {
    // Twilio のように API バージョンが固定のプロバイダで衝突しないこと
    const first = buildBranchName('twilio', '2010-04-01', '7');
    const second = buildBranchName('twilio', '2010-04-01', '8');
    assert.notEqual(first, second);
    assert.equal(first, 'api-update/twilio-2010-04-01-7');
  });

  it('同じ差分の再実行では同じブランチ名になる', () => {
    assert.equal(buildBranchName('stripe', '2026-07-30.clover', '12'), buildBranchName('stripe', '2026-07-30.clover', '12'));
  });

  it('ブランチ名に使えない文字をまとめて置き換える', () => {
    assert.equal(buildBranchName('openai', 'v2 (beta)/x', '3'), 'api-update/openai-v2-beta-x-3');
  });

  it('git が拒否する形（連続ドット・前後の記号・.lock 終わり）を避ける', () => {
    assert.equal(buildBranchName('p', 'a..b', '1'), 'api-update/p-a.b-1');
    assert.equal(buildBranchName('p', '-.v1.-', '1'), 'api-update/p-v1-1');
    assert.equal(buildBranchName('p', 'v1.lock', '1'), 'api-update/p-v1lock-1');
  });

  it('バージョンが記号だけでも成立するブランチ名にする', () => {
    assert.equal(buildBranchName('p', '///', '1'), 'api-update/p-unknown-1');
  });
});
