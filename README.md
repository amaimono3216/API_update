# API_update

Stripe / OpenAI の公式 API アップデート（OpenAPI 仕様・Changelog）を監視し、破壊的変更を検知したら
対象リポジトリのコードを自動修正して、テスト通過済みの Pull Request を作成する GitHub App。

設計の詳細は [.claude/CLAUDE.md](.claude/CLAUDE.md) を参照。

## 技術スタック

| 領域 | 採用技術 |
| --- | --- |
| 言語 / ランタイム | TypeScript / Node.js 22 (ESM) |
| HTTP サーバ | Fastify 5（GitHub Webhook 受信口） |
| 永続化 | PostgreSQL 17（スペックのスナップショット・実行ログ） |
| キュー / キャッシュ | Redis 7 |
| 実行環境 | Docker / Docker Compose |

## セットアップ

```bash
# .env を用意する（下記「環境変数」を参照）
docker compose up -d --build
curl http://localhost:3000/health
```

`/health` は Postgres と Redis への疎通を含めて検証し、正常時は下記を返す。

```json
{"status":"ok","uptime":6,"dependencies":{"postgres":"ok","redis":"ok"}}
```

## ① 監視・検知モジュール (Update Detector)

各サービスの公開 OpenAPI スペックを定期取得し、前回分との差分から破壊的変更を抽出する。

### 監視対象

| プロバイダ | 仕様 | SDK 呼び出し → パスの対応 |
| --- | --- | --- |
| Stripe | OpenAPI 3 | `stripe.checkout.sessions.create` → `/v1/checkout/sessions` |
| OpenAI | OpenAPI 3 (YAML) | `openai.chat.completions.create` → `/chat/completions` |
| Twilio | OpenAPI 3 | `client.messages.create` → `/2010-04-01/Accounts/{AccountSid}/Messages.json` |
| Slack | **Swagger 2.0** | `client.chat.postMessage` → `/chat.postMessage` |

対応づけの規則は SDK ごとに根本的に異なるため、[src/analyzer/sdk-map.ts](src/analyzer/sdk-map.ts) で
プロバイダごとに解決関数を持たせている。いずれも推測を含むため、生成した候補は
**必ず実スペックのパスと突き合わせて検証**する。

Slack は Swagger 2.0 のため、取得時に [src/detector/normalize.ts](src/detector/normalize.ts) で
OpenAPI 3 相当へ正規化する（`definitions` → `components.schemas`、`in: formData` → `requestBody` など）。
差分エンジン側は OpenAPI 3 だけを前提にできる。

> **対象外**: AWS は OpenAPI ではなく Smithy/botocore 形式（`operations` / `shapes`）のため別エンジンが必要。
> Shopify は REST が 2024/10 にレガシー化し GraphQL 移行中のため、追随対象としての価値が薄い。

```
fetchSpec ──> saveSnapshot ──> diffOpenApi ──> saveDiff ──> (破壊的変更あれば ② へ)
   取得         SHA-256 で        新旧比較        永続化
              同一なら再保存せず
```

- スケジュール: `DETECT_CRON`（既定 毎日 03:00 JST）。`DETECT_ENABLED=false` で無効化。
- 二重起動は Redis の分散ロックで防止する（cron と手動実行が重なった場合など）。
- 取得結果は `api_spec_snapshots`、差分は `api_spec_diffs` に保存される。

### 差分エンジン

仕様書にある `openapi-diff` CLI は使わず、[src/detector/](src/detector/) に自前実装している。
②③ の LLM プロンプトへそのまま渡せる構造化 JSON が必要なことと、
「変更されたスキーマ → それを参照している API 操作」の逆引きが CLI の出力からは作れないため。

判定の要点は **方向（request / response）によって結論が逆転する** こと。

| 変更 | リクエスト側 | レスポンス側 |
| --- | --- | --- |
| プロパティ削除 / 型変更 | breaking | breaking |
| 必須プロパティの追加 | breaking | 互換 |
| 必須の解除 | 互換 | breaking |
| enum 値の削除 | breaking | warning |
| enum 値の追加 | 互換 | warning |

`$ref` は展開せず、同一参照なら等価とみなして打ち切る（循環参照とスキーマ爆発の回避）。
参照先の変更は `components.schemas` の差分として検出し、
[RefIndex](src/detector/ref-index.ts) が参照グラフを遡って影響する操作を特定する。

`POST /detect/:provider` の応答 `status` は次のいずれか。

| status | 意味 |
| --- | --- |
| `baseline` | 初回取得。比較対象がないため差分は取らない |
| `unchanged` | ハッシュ一致。API 側に変更なし |
| `compatible` | 差分はあるが後方互換。② 以降は起動しない |
| `breaking` | 破壊的変更を検知。② へ引き渡す |
| `locked` | 他プロセスが実行中（HTTP 409） |

### 動作確認

実際の API 変更を待たずに検証する場合は、過去バージョンをベースラインとして取り込む。

```bash
docker compose exec app npm run seed:baseline -- \
  stripe https://raw.githubusercontent.com/stripe/openapi/<sha>/openapi/spec3.json
curl -X POST http://localhost:3000/detect/stripe
```

## ② 影響範囲特定モジュール (Impact Analyzer)

検知した破壊的変更が、対象リポジトリのコードに実際の影響を与えるかを判定する。
影響がなければここで終了し、③ 以降を起動しない（無駄な PR を防ぐ）。

```
リポジトリ走査 ──> AST スキャン ──> 破壊的変更と突合 ──> LLM 判定 ──> 実行記録
                  SDK 呼び出し抽出   操作 / パラメータ    影響有無の確定
```

### コード解析

[src/analyzer/scan-typescript.ts](src/analyzer/scan-typescript.ts) が TypeScript / JavaScript を
AST で走査し、Stripe・OpenAI SDK の呼び出し箇所と**渡しているパラメータ名**を抽出する。

型チェッカは使わず単一ファイルのパースのみで完結させている。tsconfig や node_modules の解決が
不要になり、任意のリポジトリをそのまま走査できるため。精度は「解決したパスが実スペックに
存在するか」で担保している。

検出できるクライアント定義:

```ts
const stripe = new Stripe(key);              // import + new
const stripe = require('stripe')(key);       // CommonJS
this.stripe = new Stripe(key);               // クラスのプロパティ
import { stripe } from './lib/stripe';       // 別ファイル生成（名前から推定）
```

呼び出しチェーンは [src/analyzer/sdk-map.ts](src/analyzer/sdk-map.ts) が OpenAPI 操作に対応づける。
両 SDK とも名前空間がリソースパスと 1:1 に対応するため規則ベースで解決し、
実スペックのパスと突き合わせて検証する。

| SDK 呼び出し | 解決される操作 |
| --- | --- |
| `stripe.checkout.sessions.create` | `POST /v1/checkout/sessions` |
| `stripe.charges.retrieve` | `GET /v1/charges/{charge}` |
| `stripe.paymentIntents.create` | `POST /v1/payment_intents` |
| `stripe.charges.capture` | `POST /v1/charges/{charge}/capture` |
| `openai.chat.completions.create` | `POST /chat/completions` |
| `openai.beta.threads.messages.create` | `POST /threads/{thread_id}/messages` |

### 突合と LLM 判定

[correlate](src/analyzer/correlate.ts) は決定的な絞り込みに徹し、影響の有無は LLM が判断する。

| 分類 | 意味 |
| --- | --- |
| `direct` | 変更されたプロパティを実際に渡している（ほぼ確実に影響あり） |
| `operation` | 同じ操作を呼んでいるが、当該プロパティは静的解析では見えていない |

[llm-judge](src/analyzer/llm-judge.ts) は Claude Opus 5 に候補を渡し、
`affected` / `not_affected` / `uncertain` と理由・修正方針を構造化出力で返させる。
確信が持てない場合は `affected` ではなく `uncertain` を選ばせ、不要な PR を抑制している。
`ANTHROPIC_API_KEY` 未設定時は判定をスキップし、全件 `uncertain` として記録する。

### 動作確認

```bash
docker compose cp ./path/to/target-repo app:/tmp/target
docker compose exec app npm run analyze -- <diffId> /tmp/target owner/repo
```

## ③ AI コード自動修正 & テスト検証モジュール (Fix Agent)

② が「影響あり」と判定した箇所を、作業ブランチ上で修正しテストで検証する。

```
作業ブランチ作成 ──> 修正案生成 ──> 編集を適用 ──> テスト実行 ──┬─ 成功 ─> コミット・diff
   （git clone）      （LLM）      （完全一致置換）              │
                          ↑                                     └─ 失敗 ─> フィードバックして再修正
                          └──────── エラーログ ────────────────────  （最大 3 回）
```

### 作業コピー

[src/fixer/workspace.ts](src/fixer/workspace.ts) が対象リポジトリを clone し、
`api-update/stripe-2026-07-29.dahlia` 形式のブランチを切る。**元のリポジトリは書き換えない**ため、
修正が失敗しても影響が残らず、成功時はそのまま diff を取り出せる（④ PR 生成モジュールが利用する）。
git 管理下でないディレクトリはコピーして初期化する。

LLM の編集は文字列の完全一致に依存するため、`core.autocrlf=false` を設定して改行コードを保持する。

### 編集の適用

[src/fixer/edit.ts](src/fixer/edit.ts) は LLM が生成した `oldString` / `newString` を
完全一致置換として適用する。ファイル全体を書き換えさせるより安全で、

- 一致しない
- 複数箇所に一致する（置換対象が曖昧）

といった失敗が検出可能な形で返るため、そのまま次の試行へのフィードバックになる。
作業ディレクトリ外へのパスは即座にエラーとする。

### テスト検証と再修正ループ

[src/fixer/test-runner.ts](src/fixer/test-runner.ts) がリポジトリ既存のテストコマンドを検出する。

| 検出条件 | コマンド |
| --- | --- |
| `package.json` に `scripts.test` | `npm test` |
| `pyproject.toml` / `pytest.ini` 等 | `pytest -q` |
| `go.mod` | `go test ./...` |
| `Cargo.toml` | `cargo test` |

テストが失敗した場合、出力の末尾を LLM にフィードバックして再修正する（**最大 3 回**）。
ファイル内容は毎回作業コピーから読み直すため、LLM は常に前回の編集が反映された状態を見て判断する。

> **セキュリティ上の注意**: このモジュールは対象リポジトリのコードを実行する。
> シェルを介さない起動（引数配列で `spawn`）、タイムアウト、出力量の上限、
> 自プロセスの環境変数（`NODE_OPTIONS` / `npm_*` 等）の遮断は行っているが、
> 信頼できないリポジトリを扱う場合は、ネットワーク遮断とリソース制限つきの
> 使い捨てサンドボックスで動かすこと。

### 動作確認

```bash
docker compose cp ./path/to/target-repo app:/tmp/target
docker compose exec app npm run fix -- <diffId> /tmp/target owner/repo
```

## ④ PR 自動生成 & 信頼性表示モジュール (PR Generator)

①〜③ の結果を突き合わせて PR の内容を組み立て、GitHub に送信する。

### PR 概要欄

[src/pr/template.ts](src/pr/template.ts) が生成する概要欄には、レビュアーが
「**何を根拠に、何を変えたのか**」を追跡できるよう次の 4 節を必ず含める。

| 節 | 内容 |
| --- | --- |
| 1. API 仕様の変更概要 | 対象サービス・バージョン差分・公式 Changelog へのリンク・変更前後の表 |
| 2. 影響を受けるファイルと修正内容 | ファイルと行番号・適用した編集・②の判定理由（折りたたみ） |
| 3. テスト実行結果 | PASSED / FAILED・件数（`12/12 passed`）・実行コマンド・失敗時は出力 |
| 4. この修正の信頼性について | 修正試行回数・判定件数・**手動確認が必要な箇所** |

4 節目が「信頼性表示」にあたる。自動修正の限界を隠さないことを重視し、

- テストが通っていない場合の警告
- LLM 判定が未実行の場合の警告
- `uncertain`（影響の有無を自動で判断できなかった）箇所の一覧

を明示する。件数は [src/pr/test-summary.ts](src/pr/test-summary.ts) が
node:test / Jest / Vitest / pytest / Mocha の出力から抽出する。

### 送信

[src/pr/publisher.ts](src/pr/publisher.ts) は送信先を差し替え可能にしている。
テンプレート生成と送信を分離しているため、**認証情報が無くても内容を検証できる**。

| 実装 | 選択条件 | 動作 |
| --- | --- | --- |
| `DryRunPublisher` | `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` のいずれかが未設定 | 内容の生成のみ。送信しない |
| `GitHubPublisher` | 両方が設定済み | インストールトークンで push し、PR を作成 |

push はトークンを埋めた URL 経由で行い、作業ディレクトリの git 設定にトークンを残さない。

**適用できた修正が 1 件も無い場合、PR は作成しない。** 空の PR はノイズにしかならないため。

### ブランチ名と再実行

ブランチ名は `api-update/{provider}-{version}-{diffId}` 形式。末尾の差分 ID が無いと、
API バージョンが変わらないまま仕様だけ更新されるプロバイダ（Twilio の `2010-04-01` など）で
別の破壊的変更が同じブランチ名になってしまう。

| 状況 | 挙動 |
| --- | --- |
| 異なる差分 | 必ず別ブランチ |
| 同じ差分の再実行 | 同じブランチを **force push で上書き**し、既存 PR を更新する |

再実行では作業コピーをベースから作り直すため、リモートに残った前回のブランチとは
履歴が繋がらない。そのため force push が必要になる。ただし
[`shouldForcePush()`](src/pr/publisher.ts) で **`api-update/` 配下のブランチに限定**しており、
`main` や利用者のブランチには決して force push しない。

> **未検証**: `GitHubPublisher` は認証情報が未設定のため、実際の GitHub API に対する
> 動作確認ができていない。型チェックとビルドのみ通した状態。

### 動作確認

```bash
docker compose cp ./path/to/target-repo app:/tmp/target
docker compose exec app npm run pipeline -- <diffId> /tmp/target owner/repo
```

## Webhook 受信

GitHub App からの Webhook を `POST /webhooks/github` で受ける。

```
署名検証 ──> 配信 ID で重複排除 ──> イベント処理 ──> 通知
（HMAC）      （再送対策）
```

### 署名検証

[src/webhook/verify.ts](src/webhook/verify.ts) が `X-Hub-Signature-256` を検証する。
署名は**生のリクエストボディ**に対する HMAC-SHA256 のため、JSON へパースする前の
バイト列で検証する必要がある（[src/app.ts](src/app.ts) の content type parser で元のバッファを保持している）。
比較はタイミング攻撃を避けるため `timingSafeEqual` で定数時間で行う。

`GITHUB_WEBHOOK_SECRET` が未設定の場合、このエンドポイントは 503 を返す。

### 重複排除

GitHub は配信失敗時に**同じ `X-GitHub-Delivery` で再送する**ため、`webhook_deliveries`
テーブルの一意制約で冪等性を担保する。再送は `{"status":"duplicate"}` を返して処理しない。

### 処理するイベント

| イベント | 動作 |
| --- | --- |
| `pull_request` (closed) | 自動生成 PR の結末を実行記録に反映（`pr_merged` / `pr_closed`）。マージ時は通知 |
| `installation` / `installation_repositories` | インストール状況を記録 |
| `ping` | 受理のみ |
| その他 | 受理して無視（GitHub 側でイベント種別を絞れない設定に備える） |

## 通知

[src/notify/](src/notify/) が節目ごとに通知する。**通知の失敗で本流は止めない**
（検知や修正の結果は DB に残るため）。

| 実装 | 選択条件 |
| --- | --- |
| `SlackNotifier` | `SLACK_WEBHOOK_URL` が設定済み |
| `LogNotifier` | 未設定（ログ出力にフォールバック） |

通知する出来事:

| 種別 | タイミング |
| --- | --- |
| `breaking_detected` | ① が破壊的変更を検知したとき |
| `no_impact` | ② が「影響なし」と判定したとき |
| `pr_opened` | ④ が PR を作成したとき（テスト未通過なら警告つき） |
| `pr_prepared` | ④ が内容生成のみで送信をスキップしたとき |
| `pr_merged` | Webhook で PR のマージを受信したとき |

変更なし・後方互換の変更は通知しない。通知が多いと読まれなくなり、
肝心の破壊的変更を見落とすため。

### エンドポイント

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/health` | Postgres / Redis 込みの死活確認 |
| `GET` | `/providers` | 監視対象と最新スナップショット |
| `POST` | `/detect/:provider` | ① 検知の手動実行（`stripe` / `openai`） |
| `GET` | `/diffs/:provider` | 差分の履歴 |
| `GET` | `/diffs/:provider/latest` | 直近の差分（変更一覧つき） |
| `POST` | `/analyze` | ② 影響範囲の特定（`{diffId, path, name}`） |
| `POST` | `/fix` | ②→③ を通しで実行 |
| `POST` | `/run` | ②→③→④ を通しで実行（本流の入口） |
| `GET` | `/runs` | 実行記録の一覧（`?repository=owner/repo`） |
| `POST` | `/webhooks/github` | GitHub Webhook の受信口 |
| `GET` | `/webhooks/deliveries` | 受信した Webhook の履歴 |

## 開発

`src/` はバインドマウントされており、`tsx watch` によりコンテナ内で自動リロードされる。

```bash
docker compose logs -f app        # ログ追従
docker compose exec app sh        # コンテナに入る
docker compose down -v            # DB/Redis のデータごと破棄
```

依存パッケージを追加した場合は、ホストで `npm install` した後にイメージを再ビルドする。

```bash
npm install <pkg>
docker compose up -d --build
```

ホスト側で型チェック / テスト / ビルドを行う場合:

```bash
npm run typecheck
npm test          # 差分エンジンのユニットテスト
npm run build
```

## 本番イメージ

`Dockerfile` はマルチステージ構成で、`prod` ターゲットが本番用（devDependencies を含まず `dist/` のみ）。

```bash
docker build --target prod -t api-update:prod .
```

## ディレクトリ構成

```
.
├── Dockerfile              # base / deps / dev / build / prod のマルチステージ
├── docker-compose.yml      # app + postgres + redis
├── migrations/             # 起動時に適用される SQL（schema_migrations で管理）
└── src/
    ├── index.ts            # 起動処理（マイグレーション → スケジューラ → listen）
    ├── app.ts              # Fastify ルーティング
    ├── config/env.ts       # 環境変数の zod バリデーション
    ├── db/                 # 接続プール・マイグレーション・各テーブルのアクセサ
    ├── lib/redis.ts        # Redis 接続と分散ロック
    ├── scheduler/cron.ts   # 定期実行
    ├── scripts/            # 開発用スクリプト
    ├── detector/           # ① 監視・検知モジュール
    │   ├── providers.ts    #   監視対象の定義
    │   ├── normalize.ts    #   Swagger 2.0 → OpenAPI 3 の正規化
    │   ├── fetch-spec.ts   #   スペック取得・パース・ハッシュ化
    │   ├── schema-diff.ts  #   スキーマの再帰比較
    │   ├── ref-index.ts    #   スキーマ → 参照元操作の逆引き
    │   ├── diff.ts         #   ドキュメント全体の差分と深刻度判定
    │   └── detect.ts       #   一連の処理のオーケストレーション
    ├── analyzer/           # ② 影響範囲特定モジュール
    │   ├── repository.ts   #   解析対象リポジトリのソース取得層
    │   ├── scan-typescript.ts # AST による SDK 呼び出しの抽出
    │   ├── sdk-map.ts      #   呼び出しチェーン → OpenAPI 操作の対応づけ
    │   ├── correlate.ts    #   破壊的変更と呼び出し箇所の突合
    │   ├── llm-judge.ts    #   Claude による影響有無の判定
    │   └── analyze.ts      #   一連の処理のオーケストレーション
    ├── fixer/              # ③ AI コード自動修正 & テスト検証モジュール
    │   ├── workspace.ts    #   作業コピーとブランチ管理
    │   ├── edit.ts         #   完全一致置換による編集の適用
    │   ├── test-runner.ts  #   テストコマンドの検出と実行
    │   ├── fix-agent.ts    #   Claude による修正案の生成
    │   ├── fix-loop.ts     #   修正 → テスト → 再修正のループ
    │   └── fix.ts          #   一連の処理のオーケストレーション
    ├── pr/                 # ④ PR 自動生成 & 信頼性表示モジュール
    │   ├── template.ts     #   PR タイトル・概要欄の生成
    │   ├── test-summary.ts #   テスト出力からの件数抽出
    │   ├── publisher.ts    #   送信先（dry-run / GitHub App）
    │   └── publish.ts      #   一連の処理のオーケストレーション
    ├── webhook/            # GitHub Webhook の受信
    │   ├── verify.ts       #   HMAC-SHA256 による署名検証
    │   ├── github.ts       #   イベントごとの処理
    │   └── run-store.ts    #   実行記録ストアの DB 実装
    └── notify/             # 通知
        ├── messages.ts     #   Slack メッセージの組み立て
        ├── notifier.ts     #   送信先（Slack / ログ）
        └── dispatch.ts     #   通知すべき出来事の判定
```

## 環境変数

プロジェクト直下の `.env` に記述する（`.gitignore` 済み）。

### 必須

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://api_update:api_update@db:5432/api_update` | PostgreSQL 接続先 |
| `REDIS_URL` | `redis://redis:6379` | Redis 接続先 |

### 任意（未設定でも動作するが、該当機能が制限される）

| 変数 | 未設定時の挙動 |
| --- | --- |
| `ANTHROPIC_API_KEY` | ② の影響判定をスキップし全件 `uncertain`。③ の自動修正は実行不可 |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` | ④ は PR 内容の生成のみ。GitHub への送信をスキップ |
| `GITHUB_WEBHOOK_SECRET` | `POST /webhooks/github` が 503 を返す |
| `SLACK_WEBHOOK_URL` | 通知をログ出力にフォールバック |

### 動作設定

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development` ではログを整形出力する |
| `PORT` | `3000` | HTTP ポート |
| `LOG_LEVEL` | `info` | `fatal` / `error` / `warn` / `info` / `debug` / `trace` |
| `DETECT_ENABLED` | `true` | ① の定期実行の有効化 |
| `DETECT_CRON` | `0 3 * * *` | 検知スケジュール |
| `DETECT_TIMEZONE` | `Asia/Tokyo` | スケジュールのタイムゾーン |
| `STRIPE_OPENAPI_URL` | Stripe 公式 spec3.json | 監視対象スペックの上書き |
| `OPENAI_OPENAPI_URL` | OpenAI 公式 openapi.yaml | 監視対象スペックの上書き |
| `TWILIO_OPENAPI_URL` | twilio-oai の v2010 | 監視対象スペックの上書き |
| `SLACK_OPENAPI_URL` | slack-api-specs の web-api | 監視対象スペックの上書き |
| `DB_PORT` / `REDIS_PORT` | `5432` / `6379` | ホスト側に公開するポート（衝突時のみ変更） |

### 最小構成の例

```bash
cat > .env <<'EOF'
DATABASE_URL=postgres://api_update:api_update@db:5432/api_update
REDIS_URL=redis://redis:6379
NODE_ENV=development
LOG_LEVEL=debug
EOF
```

`GITHUB_APP_PRIVATE_KEY` は複数行の PEM のため、改行を `\n` に置き換えて 1 行で記述するか、
ダブルクォートで囲んで実際の改行を含める。
