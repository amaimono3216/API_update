# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# base: 全ステージ共通のランタイム
#   - ターゲットリポジトリの clone / branch 操作を行うため git は必須
#   - AST パーサ等のネイティブモジュールを見据えて alpine ではなく slim を採用
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
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
