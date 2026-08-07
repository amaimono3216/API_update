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
cp .env.example .env      # 必要なトークン類を記入
docker compose up -d --build
curl http://localhost:3000/health
```

`/health` は Postgres と Redis への疎通を含めて検証し、正常時は下記を返す。

```json
{"status":"ok","uptime":6,"dependencies":{"postgres":"ok","redis":"ok"}}
```

## ① 監視・検知モジュール (Update Detector)

Stripe / OpenAI の公開 OpenAPI スペックを定期取得し、前回分との差分から破壊的変更を抽出する。

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

### エンドポイント

| メソッド | パス | 用途 |
| --- | --- | --- |
| `GET` | `/health` | Postgres / Redis 込みの死活確認 |
| `GET` | `/providers` | 監視対象と最新スナップショット |
| `POST` | `/detect/:provider` | 検知の手動実行（`stripe` / `openai`） |
| `GET` | `/diffs/:provider` | 差分の履歴 |
| `GET` | `/diffs/:provider/latest` | 直近の差分（変更一覧つき） |

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
    └── detector/           # ① 監視・検知モジュール
        ├── providers.ts    #   監視対象の定義
        ├── fetch-spec.ts   #   スペック取得・パース・ハッシュ化
        ├── schema-diff.ts  #   スキーマの再帰比較
        ├── ref-index.ts    #   スキーマ → 参照元操作の逆引き
        ├── diff.ts         #   ドキュメント全体の差分と深刻度判定
        └── detect.ts       #   一連の処理のオーケストレーション
```

## 環境変数

`.env.example` を参照。環境構築時点で必須なのは `DATABASE_URL` / `REDIS_URL` のみで、
`GITHUB_APP_*`・`ANTHROPIC_API_KEY` は各モジュール実装時に必須化する。
