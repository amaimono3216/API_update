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

ホスト側で型チェック / ビルドを行う場合:

```bash
npm run typecheck
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
├── docker/postgres/init/   # DB 初期化 SQL（初回起動時のみ実行）
└── src/
    ├── index.ts            # Fastify エントリポイント・ヘルスチェック
    └── config/env.ts       # 環境変数の zod バリデーション
```

## 環境変数

`.env.example` を参照。環境構築時点で必須なのは `DATABASE_URL` / `REDIS_URL` のみで、
`GITHUB_APP_*`・`ANTHROPIC_API_KEY` は各モジュール実装時に必須化する。
