1. システム概要
StripeおよびOpenAIの公式APIアップデート（OpenAPI仕様書・Changelog）を常時監視し、破壊的変更（Breaking Changes）を検知した際、対象のGitHubリポジトリのコードを自動分析・修正し、テスト通過済みのPull Request（PR）を自動作成するGitHub App / バックエンドシステム。

2. システム構成・アーキテクチャ
システムは大きく4つのモジュールで構成されます。

[1. 監視・検知] ──＞ [2. 差分解析・影響特定] ──＞ [3. コード修正・テスト] ──＞ [4. PR生成・通知]

① 監視・検知モジュール (Update Detector)
対象API:

Stripe: 公式OpenAPI定義 (stripe-spec) / API Changelog

OpenAI: 公式OpenAPI定義 (openapi.yaml) / Developer Forum Release Notes

処理内容:

1日1回（またはWebhook triggering）、GitHub等で公開されている最新のOpenAPI specs (JSON/YAML) を取得。

前回のキャッシュ（過去バージョン）と openapi-diff 等のツールで比較し、破壊的変更（フィールド削除、型変更、エンドポイント廃止等）を抽出。

② 影響範囲特定モジュール (Impact Analyzer)
処理内容:

連携されたターゲットリポジトリのコード（AST: 抽象構文木 または セマンティック検索）をスキャン。

例: Stripeの stripe.checkout.sessions.create や OpenAIの openai.chat.completions.create などの呼び出し箇所を特定。

該当箇所が今回の破壊的変更の影響を受けるかLLMで判定。影響がない場合は処理を終了（無駄なPRを防止）。

③ AIコード自動修正 & テスト検証モジュール (Fix Agent)
処理内容:

影響を受けるファイルと、新旧APIの仕様差分（Prompts）をLLM（Claude 3.5 Sonnet / OpenAI o3-mini等）に渡す。

一時的な作業ブランチを作成し、コードを書き換え。

CI（自動テスト）の実行: リポジトリ既存のテストコマンド（例: npm test, pytest）を実行。

テストが失敗した場合、エラーログをLLMにフィードバックして再修正（最大3回ループ）。

④ PR自動生成 & 信頼性表示モジュール (PR Generator)
処理内容:

テスト通過後、api-update/stripe-2026-xx のようなブランチから main ブランチへPRを作成。

開発者の信頼度を上げるPR概要欄（テンプレート）を自動生成して挿入。

3. PR（Pull Request）の概要欄テンプレート要件
安全性を担保するため、PRには必ず以下の項目を記載させます。

[API Auto-Update] Stripe API 変更に伴う自動修正
破壊的変更（Breaking Change）を検知したため、自動修正PRを作成しました。

3-1. API仕様の変更概要
対象サービス: Stripe API (v2026-xx-xx)

公式情報源: Stripe Developer Changelog

変更項目,変更前 (Before),
checkout.session,line_items.amount (Integer),
変更後 (After)
line_items.unit_amount_decimal (String) に変更

3-2. 影響を受けるファイルと修正内容
src/services/stripe.ts (L45-L52)

旧パラメータ amount を新規格 unit_amount_decimal に書き換えました。

3-3. テスト実行結果
既存のユニットテスト: PASSED (実行結果: 12/12 passed)

実行コマンド: npm test

4. 技術スタック選定案（おすすめ）
言語/フレームワーク: TypeScript (Node.js) または Python

GitHub Appの開発には Octokit / Probot (Node.js) が最適。

LLM Engine: Claude

API差分解析: openapi-diff (オープンソースのCLIツール)

随所あなたが最適だと思う技術に変更していただいてもかまいません。

- 対話・出力
  - 対話は必ず日本語で行う
  - 質問には指定がない限り短い文章で回答
  - 『鋭い指摘です』などの感想や相槌を省き、結論から簡潔に回答
  - 長文のエラーは内容をそのまま出力せず重要な部分のみ出力し、エラーの原因や対処法のみ簡潔に伝える