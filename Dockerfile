# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# go-extract: Go ソース解析用のバイナリをビルドする
#   Go ツールチェーンはビルド時のみ必要。実行イメージには数 MB のバイナリだけを置く。
# ---------------------------------------------------------------------------
FROM golang:1.24-bookworm AS go-extract
WORKDIR /build
COPY tools/go-extract/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/go-extract .

# ---------------------------------------------------------------------------
# base: 全ステージ共通のランタイム
#   - ターゲットリポジトリの clone / branch 操作を行うため git は必須
#   - AST パーサ等のネイティブモジュールを見据えて alpine ではなく slim を採用
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
# python3       : Python ソースの AST 解析（extract_python_calls.py）に使う
# python3-venv   : 対象リポジトリの依存を作業コピー内の仮想環境へ入れるため
# python3-pytest : 仮想環境を作らない構成の対象リポジトリ向けのフォールバック
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git ca-certificates tini python3 python3-venv python3-pip python3-pytest \
    && rm -rf /var/lib/apt/lists/*
# Go ソース解析用のバイナリ。ツールチェーン全体（約 500MB）は持ち込まない
COPY --from=go-extract /out/go-extract /usr/local/bin/go-extract
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---------------------------------------------------------------------------
# deps: 本番依存のみ
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# ---------------------------------------------------------------------------
# deps-dev: devDependencies を含む全依存
# ---------------------------------------------------------------------------
FROM base AS deps-dev
ENV NODE_ENV=development
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

# ---------------------------------------------------------------------------
# dev: docker compose up 用（tsx watch によるホットリロード）
# ---------------------------------------------------------------------------
FROM base AS dev
ENV NODE_ENV=development
COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .
USER node
EXPOSE 3000
CMD ["npm", "run", "dev"]

# ---------------------------------------------------------------------------
# build: TypeScript を dist/ へコンパイル
# ---------------------------------------------------------------------------
FROM base AS build
ENV NODE_ENV=development
COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .
RUN npm run build
# tsc は .py を出力に含めないため、Python 抽出器を明示的に配置する
RUN cp src/analyzer/*.py dist/analyzer/

# ---------------------------------------------------------------------------
# prod: 実行に必要な成果物のみの最小イメージ
# ---------------------------------------------------------------------------
FROM base AS prod
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
