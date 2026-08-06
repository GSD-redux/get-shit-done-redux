# 既存コードベースのオンボーディング

このチュートリアルでは、すでにコードが存在するリポジトリに GSD Core を導入します。コードベースをマッピングし、*追加する*内容を説明するプロジェクトを作成して、小さな変更に対して最初の議論・計画サイクルを実行します。最終的に、GSD Core の計画パイプラインがあなたのスタック、規約、懸念事項を把握し、計画するたびにその知識を活用できる状態になります。

---

## 作るもの

既存の Express アプリケーションに `GET /health` エンドポイントを1つ追加します。変更は小さく、本来のレッスン — GSD Core が計画前にコードベースを学習する仕組み — から注意がそれることはありません。

---

## 前提条件

- **Node.js 18 以降** — `node --version` が `v18.x.x` 以上を表示すること。
- **既存のプロジェクト** — コードがすでに存在する任意のリポジトリ。Express である必要はなく、手順はあらゆるスタックに適用されます。
- **Claude Code** — リポジトリのルートで開いていること。

---

## ステップ 1 — GSD Core のインストール

リポジトリのルートで以下を実行します:

```bash
npx @opengsd/gsd-core@latest
```

プロンプトが表示されたら **Claude Code** と **local** を選択してください。以下が表示されます:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## ステップ 2 — 権限フラグ付きで Claude Code を起動

```bash
claude --dangerously-skip-permissions
```

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](../explanation/security-model.md) first.


---

## ステップ 3 — Brownfield オンボーディングの開始

プロジェクトを作成する前に、GSD Core にリポジトリ状態を確認させ、安全な次のトップレベルコマンドを表示させます。これにより、コードベースコンテキストの取りこぼしや既存 planning ファイルの上書きを防げます。

```text
/gsd-onboard
```

オンボーディングがコードベースマップ不足を示したら、推奨オプションを選び、表示された `/gsd-map-codebase` ハンドオフを実行してから `/gsd-onboard` を再実行します。`/gsd-onboard --fast` は軽量な初回パスには使えますが、`/gsd-new-project` の前には完全なマップが必要です。`/gsd-map-codebase` が4つの並行マッパーサブエージェントを生成します（「Spawning 4 parallel codebase mapper agents…」という通知が表示されます。1〜5分かかりますので中断しないでください）。各エージェントはそれぞれ異なる観点に注目します:

| エージェント | 観点 |
|-------|-------|
| Tech mapper | スタック、フレームワーク、依存関係 |
| Architecture mapper | パターン、レイヤー、データフロー |
| Quality mapper | 規約、テスト慣行 |
| Concerns mapper | 技術的負債、リスクエリア |

4つすべてが完了すると、以下が表示されます:

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

`.planning/codebase/STACK.md` を開いてください。GSD Core が検出した言語、ランタイム、フレームワークのバージョン、主要な依存関係が表示されます。これは推測ではなく、実際に読み込んだファイルに基づいています。

`.planning/codebase/CONVENTIONS.md` を開いてください。ソースコードから観察した命名規則、エラーハンドリングパターン、コードスタイルのルールが表示されます。このリポジトリで GSD Core が生成するすべてのプランは、これらの規約に自動的に従います。

`.planning/codebase/CONCERNS.md` を開いてください。新機能の作業前に読む最も有用なファイルです。計画に影響しうる技術的負債や脆弱なエリアが表面化されています。

---

## ステップ 4 — オンボーディングを再実行してプロジェクトを初期化する

セッションウィンドウをクリアします:

```text
/clear
```

`/gsd-onboard` をもう一度実行します。GSD Core が ADR、PRD、spec、RFC、またはルートレベルの要件ドキュメントを検出した場合は、先に推奨される `/gsd-ingest-docs` ハンドオフを実行し、その後 `/gsd-onboard` を再実行してください。コンテキストが整うと、オンボーディングはプロジェクト初期化のハンドオフを表示します:

```text
/gsd-new-project
```

前のステップで GSD Core が既存のコードを見つけているため、`/gsd-new-project` はこれがブラウンフィールドプロジェクトだと分かっています。質問は既存のものを再説明するのではなく、*追加する*内容に焦点を当てます:

GSD Core が何を作りたいかを尋ねます。コードベース全体の説明ではなく、追加する機能で答えてください:

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

GSD Core が少数の確認質問をした後、要件とロードマップの作成に進みます。すでに `ARCHITECTURE.md` と `STACK.md` を読み込んでいるため、既存の機能を `PROJECT.md` の **Validated** セクションに自動的にマッピングします。既存の API サーフェスを説明する必要はありません。

すべてのワークフロー設定は推奨デフォルトを選択してください。

ロードマッパーのサブエージェントが完了すると、提案されたロードマップが表示されます。単一の小さな変更の場合は1フェーズになります:

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

ロードマップを承認してください。

プロジェクト設定が完了したら、もう一度 `/gsd-onboard` を実行します。`PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md` がすべて存在するため、オンボーディングは `.planning/onboarding/SUMMARY.md` を作成または確認します。

**`.planning/` に作成されるファイル:**

```text
.planning/
  PROJECT.md          ← プロジェクトの説明; 「Validated」に既存機能
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← フェーズ 1、ステータス: pending
  STATE.md            ← セッションメモリ
  config.json         ← ワークフロー設定
  onboarding/SUMMARY.md ← オンボーディング状態と次のコマンド
  codebase/           ← ステップ 3 の7つのマップファイル
```

`.planning/codebase/` はすでにステップ 3 から存在しています。GSD Core は `PROJECT.md` を書く際にこれらのファイルを読み込んでいるため、あなたが説明しなくても Validated 要件を入力できたのです。

---

## ステップ 5 — コンテキストをクリアしてフェーズ 1 を議論

```text
/clear
```

```text
/gsd-discuss-phase 1
```

GSD Core があなたの `CONVENTIONS.md` と `ARCHITECTURE.md` を読み込んでいるため、質問は汎用的なアドバイスではなく、実際のコードベースに基づいています。以下のような内容が表示される場合があります:

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

議論が終了すると、GSD Core が以下のファイルを書き込みます:

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

そのファイルを開いてください。`## Implementation Decisions` セクションにあなたの回答が記録されています。プランナーはタスクを1つも書く前にこのファイルを読み込みます。ファイルの配置やレスポンス形状に関するあなたの好みがプランに反映されます。

---

## ステップ 6 — フェーズ 1 の計画

```text
/gsd-plan-phase 1
```

4つのリサーチサブエージェントが並行して実行されます（1〜5分）。完了すると、プランナーが `CONTEXT.md`、リサーチ結果、コードベースマップを読み込み、あなたの規約に合ったタスクプランを作成します。

**作成されるファイル:**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← ヘルスエンドポイントパターンに関する調査結果
  01-01-PLAN.md       ← タスク: src/routes/health.js の作成
  01-02-PLAN.md       ← タスク: src/routes/index.js へのヘルスルートの登録
```

`01-01-PLAN.md` を開いてください。`<files>` タグが `src/routes/health.js` を参照していることに注目してください。これは議論で指定した正確なパスであり、GSD Core がコードベースマップで観察したルーティングパターンと一致しています。これがコードベースマップの効果です。

---

## 次のステップ

コードベースマップ、議論の意思決定記録、検証済みタスクプランが揃ったプロジェクトができました。すべてが実際のコードに基づいています。ここからのワークフローはグリーンフィールドプロジェクトと同じです:

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

今後の機能追加ごとに、構造が大幅に変わった際は `/gsd-map-codebase` を再実行してコードベースマップを最新の状態に保ってください。

---

## 学んだこと

- `/gsd-onboard` が対話型コマンドをネストしたり既存 planning ファイルを上書きしたりせずに、ブラウンフィールド設定を安全に順序付ける仕組み。
- `/gsd-map-codebase` が4つの並行エージェントを実行して `.planning/codebase/` に `STACK.md`、`ARCHITECTURE.md`、`CONVENTIONS.md`、`CONCERNS.md`、`STRUCTURE.md`、`TESTING.md`、`INTEGRATIONS.md` を生成する仕組み。
- ブラウンフィールドリポジトリで `/gsd-new-project` を実行すると、*追加する*内容に焦点を当てた質問がされ、既存コードから Validated 要件が自動入力される仕組み。
- コードベースマップが `/gsd-discuss-phase` のすべての質問を形成する方法 — ファイルパス、パターン、規約が実際のコードから導出される。
- プランナーが `CONTEXT.md` と `CONVENTIONS.md` を読み込んでリポジトリのスタイルに合ったプランを生成する仕組み。

---

## Related

- [はじめてのプロジェクト](your-first-project.md) — インストールから PR まで完全なグリーンフィールドループ
- [コマンドによるコードベースマッピング](../COMMANDS.md) — `/gsd-map-codebase` のすべてのフラグとサブコマンド
- [ドキュメントインデックス](../README.md)
