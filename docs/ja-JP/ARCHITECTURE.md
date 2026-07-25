# GSD Core アーキテクチャ

> コントリビューターおよび上級ユーザー向けのシステムアーキテクチャ文書です。ユーザー向けドキュメントは [機能リファレンス](FEATURES.md) または [ユーザーガイド](USER-GUIDE.md) をご覧ください。

---

## 目次

- [システム概要](#system-overview)
- [設計原則](#design-principles)
- [コンポーネントアーキテクチャ](#component-architecture)
- [エージェントモデル](#agent-model)
- [データフロー](#data-flow)
- [ファイルシステムレイアウト](#file-system-layout)
- [インストーラーアーキテクチャ](#installer-architecture)
- [フックシステム](#hook-system)
- [CLI ツールレイヤー](#cli-tools-layer)
- [ランタイム抽象化](#runtime-abstraction)

---

## システム概要

GSD Core は、ユーザーと AI コーディングエージェント（Claude Code、Gemini CLI、OpenCode、Kilo、Codex、Copilot、Antigravity、Trae、Cline、Augment Code）の間に位置する **メタプロンプティングフレームワーク** です。以下の機能を提供します：

1. **コンテキストエンジニアリング** — タスクごとに AI が必要とするすべてを提供する構造化アーティファクト（[コンテキストエンジニアリング](explanation/context-engineering.md) 参照）
2. **マルチエージェントオーケストレーション** — フレッシュなコンテキストウィンドウで専門化されたエージェントを生成する薄いオーケストレーター（[マルチエージェントオーケストレーション](explanation/multi-agent-orchestration.md) 参照）
3. **仕様駆動開発** — 要件 → 調査 → 計画 → 実行 → 検証のパイプライン
4. **状態管理** — セッションやコンテキストリセットをまたいだ永続的なプロジェクトメモリ

```
┌──────────────────────────────────────────────────────┐
│                      USER                            │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              COMMAND LAYER                            │
│   commands/gsd/*.md — Prompt-based command files      │
│   (Claude Code custom commands / Codex skills)        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              WORKFLOW LAYER                           │
│   gsd-core/workflows/*.md — Orchestration logic  │
│   (Reads references, spawns agents, manages state)    │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENT      │ │  AGENT    │ │  AGENT         │
│  (fresh     │ │  (fresh   │ │  (fresh        │
│   context)  │ │   context)│ │   context)     │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CLI TOOLS LAYER                          │
│   gsd-core/bin/gsd-tools.cjs                     │
│   (State, config, phase, roadmap, verify, templates)  │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              FILE SYSTEM (.planning/)                 │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## 設計原則

### 1. エージェントごとにフレッシュなコンテキスト

オーケストレーターが起動するすべてのエージェントは、クリーンなコンテキストウィンドウ（最大200Kトークン）を取得します。これにより、AIがコンテキストウィンドウに蓄積された会話で埋め尽くされることによる品質低下（コンテキストの劣化）が排除されます。

### 2. 軽量オーケストレーター

ワークフローファイル（`gsd-core/workflows/*.md`）は重い処理を行いません。以下の役割に徹します：
- `gsd-tools.cjs init <workflow>` でコンテキストを読み込む
- 焦点を絞ったプロンプトで専門エージェントを起動する
- 結果を収集し、次のステップにルーティングする
- ステップ間で状態を更新する

### 3. ファイルベースの状態管理

すべての状態は `.planning/` 内に人間が読めるMarkdownとJSONとして保存されます。データベースもサーバーも外部依存もありません。これにより：
- コンテキストリセット（`/clear`）後も状態が維持される
- 人間とエージェントの両方が状態を確認できる
- チームでの可視性のためにgitにコミットできる

### 4. 未設定 = 有効

ワークフローの機能フラグは **未設定 = 有効** のパターンに従います。`config.json` にキーが存在しない場合、デフォルトで `true` になります。ユーザーは機能を明示的に無効化します。デフォルトを有効化する操作は不要です。

### 5. 多層防御

複数のレイヤーで一般的な障害モードを防止します：
- 実行前に計画が検証される（plan-checkerエージェント）
- 実行時にタスクごとにアトミックなコミットが生成される
- 実行後の検証でフェーズ目標との整合性を確認する
- UATが最終ゲートとして人間による検証を提供する

---

## コンポーネントアーキテクチャ

### コマンド（`commands/gsd/*.md`）

ユーザー向けのエントリーポイントです。各ファイルには YAML フロントマター（name、description、allowed-tools）とワークフローをブートストラップするプロンプト本文が含まれています。コマンドは以下の形式でインストールされます：

- **Claude Code:** カスタムスラッシュコマンド（ハイフン形式、`/gsd-command-name`）
- **OpenCode / Kilo:** スラッシュコマンド（ハイフン形式、`/gsd-command-name`）
- **Codex:** スキル（`$gsd-command-name`）
- **Copilot:** スラッシュコマンド（ハイフン形式、`/gsd-command-name`）
- **Gemini CLI:** `gsd:` 名前空間下のスラッシュコマンド（コロン形式、`/gsd:command-name`）——Gemini はすべてのカスタムコマンドをプラグイン ID の下で名前空間化するため、インストールパスがすべての本文テキスト参照をコロン形式に書き換える
- **Antigravity:** スキル

**コマンド総数:** 信頼できる数と完全なロスターについては [`docs/INVENTORY.md`](INVENTORY.md#commands) を参照。

#### 2 段階の階層的ルーティング（v1.40、[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）

eager なスキルリストのトークンコストを低く保つため、v1.40 では 6 つの名前空間 **メタスキル**（`gsd-workflow`、`gsd-project`、`gsd-quality`、`gsd-context`、`gsd-manage`、`gsd-ideate` ——`commands/gsd/ns-*.md` から取得されるが、呼び出し可能な `name:` はここに示すベア形式）を具体的なサブスキルの上にレイヤーとして導入しています。モデルは平坦な 86 スキルリスト（約 2,150 トークン）の代わりに 6 つの名前空間ルーター（約 120 トークン）を見て名前空間を選択し、名前空間ルーターの本文に埋め込まれたルーティングテーブルを通じて具体的なサブスキルにルーティングします。名前空間スキルは **付加的** です——すべての具体的なコマンドは依然として直接呼び出し可能です。

#### MCP トークンバジェットの相互作用

eager なスキルリストはターンごとの 2 つの主要コストの一つです。もう一つは `.claude/settings.json` で有効化されている各 MCP サーバーが注入する MCP ツールスキーマです。重量級の MCP サーバー（ブラウザ/playwright、Mac ツール、Windows ツール）はそれぞれターンごとに 20k+ トークンかかる場合があり、多くの場合 `model_profile` のチューニングで節約できるものをはるかに上回ります。トグルは Claude Code ハーネスにあります（`.claude/settings.json` の `enabledMcpjsonServers` / `disabledMcpjsonServers`）で、GSD の懸念事項ではありません。

### ワークフロー（`gsd-core/workflows/*.md`）

コマンドが参照するオーケストレーションロジックです。以下を含むステップバイステップのプロセスが記述されています：

- `gsd-tools.cjs init` によるコンテキスト読み込み
- モデル解決を伴うエージェント起動の指示
- ゲート/チェックポイントの定義
- 状態更新パターン
- エラーハンドリングとリカバリー

**ワークフロー総数:** 信頼できる数と完全なロスターについては [`docs/INVENTORY.md`](INVENTORY.md#workflows) を参照。

#### ワークフローのプログレッシブディスクロージャー

ワークフローファイルは、対応する `/gsd-*` コマンドが呼び出されるたびに Claude のコンテキストにそのまま読み込まれます。そのコストを制限するため、`tests/workflow-size-budget.test.cjs` で強制されるワークフローサイズバジェットはエージェントサイズバジェット規則を反映します：

| ティア | ファイルごとの行数制限 |
|-----------|--------------------|
| `XL` | 1700 — トップレベルオーケストレーター（`execute-phase`、`plan-phase`、`new-project`） |
| `LARGE` | 1500 — 複数ステップのプランナーと大きな機能ワークフロー |
| `DEFAULT` | 1000 — 集中した単一目的のワークフロー（対象ティア） |

### エージェント（`agents/*.md`）

フロントマターで以下を指定する専門化されたエージェント定義：

- `name` — エージェント識別子
- `description` — 役割と目的
- `tools` — 許可されたツールアクセス（Read、Write、Edit、Bash、Grep、Glob、WebSearch など）
- `color` — 視覚的な区別のためのターミナル出力色

**エージェント総数:** 33

### リファレンス（`gsd-core/references/*.md`）

ワークフローとエージェントが `@-reference` で参照する共有知識ドキュメント（信頼できる数と完全なロスターについては [`docs/INVENTORY.md`](INVENTORY.md#references-41-shipped) を参照）：

**コアリファレンス：**

- `checkpoints.md` — チェックポイントタイプの定義とインタラクションパターン
- `gates.md` — プランチェッカーと検証者に組み込まれた 4 つの正規ゲートタイプ（Confirm、Quality、Safety、Transition）
- `model-profiles.md` — エージェントごとのモデルティア割り当て
- `model-profile-resolution.md` — モデル解決アルゴリズムのドキュメント
- `verification-patterns.md` — 各種アーティファクトの検証方法
- `verification-overrides.md` — アーティファクトごとの検証オーバーライドルール
- `planning-config.md` — 完全な設定スキーマと動作
- `git-integration.md` — git コミット、ブランチ、履歴のパターン
- `git-planning-commit.md` — planning ディレクトリのコミット規約
- `questioning.md` — プロジェクト初期化のためのドリーム抽出フィロソフィー
- `tdd.md` — テスト駆動開発の統合パターン
- `ui-brand.md` — 視覚的な出力フォーマットパターン
- `common-bug-patterns.md` — コードレビューと検証のための一般的なバグパターン

**ワークフローリファレンス：**

- `agent-contracts.md` — オーケストレーターとエージェント間の正式インターフェース
- `context-budget.md` — コンテキストウィンドウバジェット配分ルール
- `continuation-format.md` — セッション継続/再開フォーマット
- `domain-probes.md` — discuss-phase のためのドメイン固有プローブ質問
- `gate-prompts.md` — ゲート/チェックポイントプロンプトテンプレート
- `revision-loop.md` — 計画修正の反復パターン
- `universal-anti-patterns.md` — 検出・回避すべき一般的なアンチパターン
- `artifact-types.md` — 計画アーティファクトタイプの定義
- `phase-argument-parsing.md` — フェーズ引数解析の規約
- `decimal-phase-calculation.md` — 小数サブフェーズ番号付けのルール
- `workstream-flag.md` — ワークストリームアクティブポインターの規約
- `user-profiling.md` — ユーザー行動プロファイリングの方法論
- `thinking-partner.md` — 決定ポイントでの条件付きシンキングパートナー起動

### テンプレート（`gsd-core/templates/`）

すべてのプランニングアーティファクト用のMarkdownテンプレートです。`gsd-tools.cjs template fill` および `scaffold` コマンドにより、事前構造化されたファイルを作成するために使用されます：
- `project.md`、`requirements.md`、`roadmap.md`、`state.md` — コアプロジェクトファイル
- `phase-prompt.md` — フェーズ実行プロンプトテンプレート
- `summary.md`（+ `summary-minimal.md`、`summary-standard.md`、`summary-complex.md`）— 粒度対応のサマリーテンプレート
- `DEBUG.md` — デバッグセッション追跡テンプレート
- `UI-SPEC.md`、`UAT.md`、`VALIDATION.md` — 専門検証テンプレート
- `discussion-log.md` — ディスカッション監査証跡テンプレート
- `codebase/` — ブラウンフィールドマッピングテンプレート（スタック、アーキテクチャ、規約、懸念事項、構造、テスト、統合）
- `research-project/` — リサーチ出力テンプレート（SUMMARY、STACK、FEATURES、ARCHITECTURE、PITFALLS）

### フック（`hooks/`）

ホストAIエージェントと統合するランタイムフック：

| フック | イベント | 目的 |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | モデル、タスク、ディレクトリ、コンテキスト使用量バーを表示 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | コンテキスト残量35%/25%でエージェント向け警告を注入 |
| `gsd-check-update.js` | `SessionStart` | GSDの新バージョンをバックグラウンドで確認 |
| `gsd-prompt-guard.js` | `PreToolUse` | `.planning/` への書き込みにプロンプトインジェクションパターンがないかスキャン（アドバイザリー） |
| `gsd-workflow-guard.js` | `PreToolUse` | GSDワークフローコンテキスト外でのファイル編集を検出（アドバイザリー、`hooks.workflow_guard` によるオプトイン） |

### コマンドルーティングハブ（`gsd-core/bin/lib/command-routing-hub.cjs`）

CJS コマンドファミリールーターは `CommandRoutingHub` を通じてディスパッチします。ハブはノースロー純粋結果コントラクト（`hub.dispatch()` は内部例外をキャッチして `{ ok: false, kind, ...typedPayload }` を返す）とクローズドランタイムエラー分類（`UnknownCommand`、`InvalidArgs`、`HandlerRefusal`、`HandlerFailure`）を所有します。ルーターアダプターは薄い CLI トランスレーターのままです——ハブを構築し、`dispatch` を呼び出し、結果を `output()`/`error()` 呼び出しにマッピングします。`docs/adr/0174-retire-gsd-sdk-package-boundary.md` を参照。

### CLI ツール（`gsd-core/bin/`）

`gsd-core/bin/lib/` にドメインモジュールが分割された Node.js CLI ユーティリティ（`gsd-tools.cjs`）（信頼できるロスターについては [`docs/INVENTORY.md`](INVENTORY.md#cli-modules-33-shipped) を参照）：

| モジュール | 責務 |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `core.cjs` | エラーハンドリング、出力フォーマット、共有ユーティリティ；planning ヘルパーの互換性 re-export |
| `planning-workspace.cjs` | planning シーム（`planningDir`、`planningPaths`、アクティブなワークストリームルーティング、`.planning/.lock`） |
| `state.cjs` | STATE.md の解析、更新、進行、メトリクス |
| `phase.cjs` | フェーズディレクトリ操作、小数番号付け、プランインデックス |
| `roadmap.cjs` | ROADMAP.md の解析、フェーズ抽出、プラン進捗 |
| `config.cjs` | config.json の読み書き、セクション初期化 |
| `verify.cjs` | プラン構造、フェーズ完了度、リファレンス、コミット検証 |
| `template.cjs` | テンプレート選択と変数置換による穴埋め |
| `frontmatter.cjs` | YAML フロントマターの CRUD 操作 |
| `init.cjs` | ワークフロータイプごとの複合コンテキスト読み込み |
| `milestone.cjs` | マイルストーンのアーカイブ、要件マーキング |
| `commands.cjs` | その他コマンド（slug、タイムスタンプ、todos、スキャフォールディング、統計） |
| `model-profiles.cjs` | モデルプロファイル解決テーブル |
| `security.cjs` | パストラバーサル防止、プロンプトインジェクション検出、安全な JSON 解析、シェル引数バリデーション |
| `uat.cjs` | UAT ファイル解析、検証デット追跡、audit-uat サポート |
| `docs.cjs` | ドキュメント更新ワークフロー init、Markdown スキャン、モノレポ検出 |
| `workstream.cjs` | ワークストリーム CRUD、マイグレーション、セッションスコープのアクティブポインター |
| `schema-detect.cjs` | ORM パターンのスキーマドリフト検出（Prisma、Drizzle など） |
| `profile-pipeline.cjs` | ユーザー行動プロファイリングデータパイプライン、セッションファイルスキャン |
| `profile-output.cjs` | プロファイルレンダリング、USER-PROFILE.md と dev-preferences.md の生成 |

---

## エージェントモデル

### オーケストレーター → エージェントパターン

```
Orchestrator (workflow .md)
    │
    ├── Load context: gsd-tools.cjs init <workflow> <phase>
    │   Returns JSON with: project info, config, state, phase details
    │
    ├── Resolve model: gsd-tools.cjs resolve-model <agent-name>
    │   Returns: opus | sonnet | haiku | inherit
    │
    ├── Spawn Agent (Task/SubAgent call)
    │   ├── Agent prompt (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state: gsd-tools.cjs state update/patch/advance-plan
```

### 主要エージェント生成カテゴリ

21 の主要エージェントの概念的な生成パターン分類。信頼できる 31 エージェントロスター（`gsd-pattern-mapper`、`gsd-code-reviewer`、`gsd-code-fixer`、`gsd-ai-researcher`、`gsd-domain-researcher`、`gsd-eval-planner`、`gsd-eval-auditor`、`gsd-framework-selector`、`gsd-debug-session-manager`、`gsd-intel-updater` などの 10 の高度/専門化エージェントを含む）については、[`docs/INVENTORY.md`](INVENTORY.md#agents-31-shipped) を参照。

| カテゴリ | エージェント | 並列性 |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **リサーチャー** | gsd-project-researcher、gsd-phase-researcher、gsd-ui-researcher、gsd-advisor-researcher | 4 並列（stack、features、architecture、pitfalls）；advisor は discuss-phase 中に起動 |
| **シンセサイザー** | gsd-research-synthesizer | 逐次（リサーチャー完了後） |
| **プランナー** | gsd-planner、gsd-roadmapper | 逐次 |
| **チェッカー** | gsd-plan-checker、gsd-integration-checker、gsd-ui-checker、gsd-nyquist-auditor | 逐次（検証ループ、最大 3 回反復） |
| **エグゼキューター** | gsd-executor | ウェーブ内は並列、ウェーブ間は逐次 |
| **ベリファイアー** | gsd-verifier | 逐次（全エグゼキューター完了後） |
| **マッパー** | gsd-codebase-mapper | 4 並列（tech、arch、quality、concerns） |
| **デバッガー** | gsd-debugger | 逐次（インタラクティブ） |
| **オーディター** | gsd-ui-auditor、gsd-security-auditor | 逐次 |
| **Doc ライター** | gsd-doc-writer、gsd-doc-verifier | 逐次（ライター後に検証者） |
| **プロファイラー** | gsd-user-profiler | 逐次 |
| **アナライザー** | gsd-assumptions-analyzer | 逐次（discuss-phase 中） |

### ウェーブ実行モデル

`execute-phase` では、プランが依存関係に基づいてウェーブにグループ化されます：

```
Wave Analysis:
  Plan 01 (no deps)      ─┐
  Plan 02 (no deps)      ─┤── Wave 1 (parallel)
  Plan 03 (depends: 01)  ─┤── Wave 2 (waits for Wave 1)
  Plan 04 (depends: 02)  ─┘
  Plan 05 (depends: 03,04) ── Wave 3 (waits for Wave 2)
```

各エグゼキューターには以下が与えられます：

- フレッシュな 200K コンテキストウィンドウ（または対応モデルでは最大 1M）
- 実行対象の特定の PLAN.md
- プロジェクトコンテキスト（PROJECT.md、STATE.md）
- フェーズコンテキスト（CONTEXT.md、利用可能な場合は RESEARCH.md）

### アダプティブコンテキスト拡充（1M モデル）

コンテキストウィンドウが 500K+ トークンの場合（Opus 4.6、Sonnet 4.6 などの 1M クラスモデル）、サブエージェントプロンプトは標準 200K ウィンドウには収まらない追加コンテキストで自動的に拡充されます：

- **エグゼキューターエージェント** は前のウェーブの SUMMARY.md ファイルとフェーズの CONTEXT.md/RESEARCH.md を受け取り、フェーズ内でのクロスプラン認識を可能にする
- **検証者エージェント** はすべての PLAN.md、SUMMARY.md、CONTEXT.md ファイルと REQUIREMENTS.md を受け取り、履歴を考慮した検証を可能にする

オーケストレーターは設定から `context_window` を読み取り（`gsd-tools.cjs config-get context_window`）、値が >= 500,000 の場合に条件付きでより豊富なコンテキストを含めます。標準 200K ウィンドウでは、プロンプトはコンテキスト効率を最大化するためにキャッシュフレンドリーな順序で切り詰められたバージョンを使います。

#### 並列コミットの安全性

同一ウェーブ内で複数のエグゼキューターが実行される場合、2 つの仕組みで競合を防止します：

1. **`--no-verify` コミット** — 並列エージェントはプリコミットフックをスキップします（ビルドロックの競合を引き起こす可能性があるため。例：Rust プロジェクトでの cargo lock ファイルの競合）。オーケストレーターは各ウェーブ完了後に `git hook run pre-commit` を 1 回実行します。

2. **STATE.md ファイルロック** — すべての `writeStateMd()` 呼び出しはロックファイルベースの相互排他（`STATE.md.lock`、`O_EXCL` によるアトミック作成）を使用します。これにより、2 つのエージェントが STATE.md を読み取り、異なるフィールドを変更し、最後の書き込みが他方の変更を上書きする read-modify-write 競合状態を防止します。古いロックの検出（10 秒タイムアウト）とジッター付きのスピンウェイトを含みます。

---

## データフロー

### 新規プロジェクトフロー

```
User input (idea description)
    │
    ▼
Questions (questioning.md philosophy)
    │
    ▼
4x Project Researchers (parallel)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
Research Synthesizer → SUMMARY.md
    │
    ▼
Requirements extraction → REQUIREMENTS.md
    │
    ▼
Roadmapper → ROADMAP.md
    │
    ▼
User approval → STATE.md initialized
```

### フェーズ実行フロー

```
discuss-phase → CONTEXT.md (user preferences)
    │
    ▼
ui-phase → UI-SPEC.md (design contract, optional)
    │
    ▼
plan-phase
    ├── Research gate (blocks if RESEARCH.md has unresolved open questions)
    ├── Phase Researcher → RESEARCH.md
    │       └── Package Legitimacy Gate: slopcheck on every package; [SLOP] removed,
    │           [SUS]/[ASSUMED] flagged; Audit table written to RESEARCH.md
    ├── Planner (with reachability check) → PLAN.md files
    │       └── checkpoint:human-verify injected before [ASSUMED]/[SUS] installs;
    │           T-{phase}-SC STRIDE row added for install-bearing plans
    ├── Plan Checker → Verify loop (max 3x)
    ├── Requirements coverage gate (REQ-IDs → plans)
    └── Decision coverage gate (CONTEXT.md `<decisions>` → plans, BLOCKING — #2492)
    │
    ▼
state planned-phase → STATE.md (Planned/Ready to execute)
    │
    ▼
execute-phase (context reduction: truncated prompts, cache-friendly ordering)
    ├── Wave analysis (dependency grouping)
    ├── Executor per plan → code + atomic commits
    ├── SUMMARY.md per plan
    └── Verifier → VERIFICATION.md
        └── Decision coverage gate (CONTEXT.md decisions → shipped artifacts, NON-BLOCKING — #2492)
    │
    ▼
verify-work → UAT.md (user acceptance testing)
    │
    ▼
ui-review → UI-REVIEW.md (visual audit, optional)
```

### コンテキスト伝播

各ワークフローステージは後続のステージに供給されるアーティファクトを生成します：

```
PROJECT.md ────────────────────────────────────────────► All agents
REQUIREMENTS.md ───────────────────────────────────────► Planner, Verifier, Auditor
ROADMAP.md ────────────────────────────────────────────► Orchestrators
STATE.md ──────────────────────────────────────────────► All agents (decisions, blockers)
CONTEXT.md (per phase) ────────────────────────────────► Researcher, Planner, Executor
RESEARCH.md (per phase) ───────────────────────────────► Planner, Plan Checker
PLAN.md (per plan) ────────────────────────────────────► Executor, Plan Checker
SUMMARY.md (per plan) ─────────────────────────────────► Verifier, State tracking
UI-SPEC.md (per phase) ────────────────────────────────► Executor, UI Auditor
```

---

## ファイルシステムレイアウト

### インストールファイル

```
~/.claude/                          # Claude Code (global install)
├── skills/gsd-*/SKILL.md           # Global skills (authoritative roster: docs/INVENTORY.md)
├── commands/gsd/*.md               # Local Claude installs use slash commands instead of global skills
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # CLI utility
│   ├── bin/lib/*.cjs               # Domain modules (authoritative roster: docs/INVENTORY.md)
│   ├── workflows/*.md              # Workflow definitions (authoritative roster: docs/INVENTORY.md)
│   ├── references/*.md             # Shared reference docs (authoritative roster: docs/INVENTORY.md)
│   └── templates/                  # Planning artifact templates
├── agents/*.md                     # Agent definitions (authoritative roster: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js hooks (statusline, guards, monitors, update check)
├── hooks/*.sh                      # Shell hooks (session state, commit validation, phase boundary)
├── settings.json                   # Hook registrations
└── VERSION                         # Installed version number
```

他のランタイムでの同等パス：

- **OpenCode:** `~/.config/opencode/` global または `./.opencode/` local
- **Kilo:** `~/.config/kilo/` global または `./.kilo/` local
- **Gemini CLI:** `~/.gemini/` global または `./.gemini/` local
- **Codex:** `~/.codex/` global または `./.codex/` local
- **Copilot:** `~/.copilot/` global または `./.github/` local
- **Antigravity:** auto-detected global root（`~/.gemini/antigravity/`、`~/.gemini/antigravity-ide/`、または `~/.gemini/antigravity-cli/`）または `./.agent/` local
- **Cursor:** `~/.cursor/` global または `./.cursor/` local
- **Windsurf:** `~/.codeium/windsurf/` global または `./.windsurf/` local
- **Augment Code:** `~/.augment/` global または `./.augment/` local
- **Trae:** `~/.trae/` global または `./.trae/` local
- **Qwen Code:** `~/.qwen/` global または `./.qwen/` local
- **Hermes Agent:** `~/.hermes/` global または `./.hermes/` local
- **CodeBuddy:** `~/.codebuddy/` global または `./.codebuddy/` local
- **Cline:** `~/.cline/` global または project-root `.clinerules` local

### プロジェクトファイル（`.planning/`）

```
.planning/
├── PROJECT.md              # プロジェクトビジョン、制約、決定事項、発展ルール
├── REQUIREMENTS.md         # スコープ付き要件（v1/v2/スコープ外）
├── ROADMAP.md              # ステータス追跡付きフェーズ分解
├── STATE.md                # 生きたメモリ：位置、決定事項、ブロッカー、メトリクス
├── config.json             # ワークフロー設定
├── MILESTONES.md           # 完了済みマイルストーンのアーカイブ
├── research/               # /gsd-new-project によるドメインリサーチ
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # ブラウンフィールドマッピング（/gsd-map-codebase または /gsd-onboard から）
├── onboarding/             # ブラウンフィールドオンボーディング概要（/gsd-onboard から）
│   ├── STACK.md
│   ├── ARCHITECTURE.md
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # ユーザー設定（discuss-phase から）
│       ├── XX-RESEARCH.md      # エコシステムリサーチ（plan-phase から）
│       ├── XX-YY-PLAN.md       # 実行プラン
│       ├── XX-YY-SUMMARY.md    # 実行結果
│       ├── XX-VERIFICATION.md  # 実行後の検証
│       ├── XX-VALIDATION.md    # ナイキストテストカバレッジマッピング
│       ├── XX-UI-SPEC.md       # UIデザインコントラクト（ui-phase から）
│       ├── XX-UI-REVIEW.md     # ビジュアル監査スコア（ui-review から）
│       └── XX-UAT.md           # ユーザー受け入れテスト結果
├── quick/                  # クイックタスク追跡
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # キャプチャされたアイデア
│   └── completed/          # 完了済みtodo
├── threads/               # 永続コンテキストスレッド（/gsd-thread から）
├── seeds/                 # 将来に向けたアイデア（/gsd-capture --seed から）
├── debug/                  # アクティブなデバッグセッション
│   ├── *.md                # アクティブセッション
│   ├── resolved/           # アーカイブ済みセッション
│   └── knowledge-base.md   # 永続的なデバッグ知見
├── ui-reviews/             # /gsd-ui-review からのスクリーンショット（gitignore対象）
└── continue-here.md        # コンテキスト引き継ぎ（pause-work から）
```

---

## インストーラーアーキテクチャ

インストーラー（`bin/install.js`、約 10,700 行）は以下を処理します：

1. **ランタイム検出** — インタラクティブプロンプトまたは CLI フラグ（`--claude`、`--opencode`、`--gemini`、`--kilo`、`--codex`、`--copilot`、`--antigravity`、`--cursor`、`--windsurf`、`--augment`、`--trae`、`--qwen`、`--hermes`、`--codebuddy`、`--cline`、`--all`）
2. **インストール先の選択** — グローバル（`--global`）またはローカル（`--local`）
3. **ファイルデプロイ** — コマンド、スキル、ワークフロー、リファレンス、テンプレート、エージェント、フックをコピー
4. **ランタイム適応** — ランタイムごとにファイル内容を変換：
   - Claude Code: そのまま使用
   - OpenCode: コマンド/エージェントを OpenCode 互換のフラットコマンド + サブエージェント形式に変換
   - Kilo: OpenCode 変換パイプラインを Kilo の設定パスで再利用
   - Codex: コマンドから TOML 設定 + スキルを生成
   - Copilot: ツール名をマッピング（Read→read、Bash→execute など）
   - Gemini: フックイベント名を調整（`PostToolUse` の代わりに `AfterTool`）
   - Antigravity: Google モデル同等品によるスキルファースト
   - Cursor: ルール参照付きスキルファースト
   - Windsurf: ルール参照付きスキルファースト
   - Trae: `~/.trae` / `./.trae` へのスキルファーストインストール、`settings.json` またはフック統合なし
   - Qwen Code: Qwen ブランドのパスとプロンプト書き換え付きスキルファースト
   - Hermes Agent: `skills/gsd/` 下のカテゴリベーススキル
   - CodeBuddy: CodeBuddy パスとプロンプト書き換え付きスキルファースト
   - Cline: ルールベース統合のための `.clinerules` を書き込む
   - Augment Code: スキルファースト、完全なスキル変換と設定管理
5. **パス正規化** — `~/.claude/` パスをランタイム固有のパスに置換
6. **設定統合** — ランタイムの `settings.json` にフックを登録
7. **パッチバックアップ** — v1.17 以降、ローカルで変更されたファイルを `/gsd-update --reapply` 用に `gsd-local-patches/` へバックアップ
8. **マニフェスト追跡** — クリーンアンインストールのために `gsd-file-manifest.json` を書き込み
9. **アンインストールモード** — `--uninstall` ですべての GSD ファイル、フック、設定を削除

インストール時のファイル移動、古いアーティファクトのクリーンアップ、設定の書き換え、ユーザーデータの保全は Installer Migration Module によって管理されます。[Installer Migrations](../installer-migrations.md) と [ADR 0008](../adr/0008-installer-migration-module.md) を参照してください。

### プラットフォーム対応

- **Windows:** 子プロセスでの `windowsHide`、保護ディレクトリへの EPERM/EACCES 対策、パスセパレーターの正規化
- **WSL:** Windows の Node.js が WSL 上で実行されていることを検出し、パスの不一致について警告
- **Docker/CI:** カスタム設定ディレクトリの場所に `CLAUDE_CONFIG_DIR` 環境変数をサポート

---

## フックシステム

### アーキテクチャ

```
Runtime Engine (Claude Code / Gemini CLI)
    │
    ├── statusLine event ──► gsd-statusline.js
    │   Reads: stdin (session JSON)
    │   Writes: stdout (formatted status), /tmp/claude-ctx-{session}.json (bridge)
    │
    ├── PostToolUse/AfterTool event ──► gsd-context-monitor.js
    │   Reads: stdin (tool event JSON), /tmp/claude-ctx-{session}.json (bridge)
    │   Writes: stdout (hookSpecificOutput with additionalContext warning)
    │
    └── SessionStart event ──► gsd-check-update.js
        Reads: VERSION file
        Writes: ~/.claude/cache/gsd-update-check.json (spawns background process)
```

### コンテキストモニターの閾値

| コンテキスト残量 | レベル | エージェントの動作 |
| ----------------- | -------- | --------------------------------------- |
| > 35% | Normal | 警告なし |
| ≤ 35% | WARNING | 「新しい複雑な作業の開始を避けてください」 |
| ≤ 25% | CRITICAL | 「コンテキストがほぼ枯渇、ユーザーに通知してください」 |

デバウンス：繰り返し警告の間隔は 5 回のツール使用。重大度のエスカレーション（WARNING→CRITICAL）はデバウンスをバイパスします。

### 安全性の特性

- すべてのフックは try/catch でラップされ、エラー時はサイレントに終了
- stdin タイムアウトガード（3 秒）でパイプの問題によるハングを防止
- 古いメトリクス（60 秒超）は無視される
- ブリッジファイルの欠落は適切に処理される（サブエージェント、新規セッション）
- コンテキストモニターはアドバイザリーのみ — ユーザーの設定を上書きする命令的なコマンドは発行しない

### パッケージ正当性ゲート（v1.42.1）

調査者 → プランナー → エグゼキューターパイプラインには、スロップスクワッティング（AI が幻覚した悪意のあるポストインストールスクリプト付きで事前登録されたパッケージ名）に対するサプライチェーンゲートが含まれます。

**ゲートレイヤー：**

| レイヤー | コンポーネント | アクション |
|-------|-----------|--------|
| 調査 | `gsd-phase-researcher` | `slopcheck install <pkgs> --json` を実行；`## Package Legitimacy Audit` テーブルを RESEARCH.md に書き込む；RESEARCH.md が書かれる前に `[SLOP]` パッケージを除去 |
| 計画 | `gsd-planner` | 監査テーブルを読み取る；任意の `[ASSUMED]` または `[SUS]` インストールタスクの前に `checkpoint:human-verify` を挿入；`<threat_model>` に `T-{phase}-SC` STRIDE サプライチェーン行を追加 |
| 実行 | `gsd-executor` | RULE 3 はパッケージインストールを自動修正スコープから除外；失敗したインストールはチェックポイントとして表面化し、サイレントな代替なし |

セキュリティモデルの概念的な概要については [セキュリティモデル](explanation/security-model.md) を参照。

### セキュリティフック（v1.27）

**Prompt Guard**（`gsd-prompt-guard.js`）：

- `.planning/` ファイルへの Write/Edit 時にトリガー
- プロンプトインジェクションパターン（ロールオーバーライド、指示バイパス、system タグインジェクション）をスキャン
- アドバイザリーのみ — 検出をログに記録するが、ブロックはしない
- フックの独立性のため、パターンはインライン化（`security.cjs` のサブセット）

**Workflow Guard**（`gsd-workflow-guard.js`）：

- `.planning/` 以外のファイルへの Write/Edit 時にトリガー
- GSD ワークフローコンテキスト外での編集を検出（アクティブな `/gsd-` コマンドや Task サブエージェントがない場合）
- 状態追跡される変更には `/gsd-quick` や `/gsd-fast` の使用をアドバイス
- `hooks.workflow_guard: true` によるオプトイン（デフォルト: false）

---

## ランタイム抽象化

GSD Core は統一されたコマンド/ワークフローアーキテクチャを通じて複数の AI コーディングランタイムをサポートしています：

### ランタイムインストールコントラクトマトリクス

| ランタイム | グローバルルート | ローカルルート | 呼び出し面 | エージェント面 | 設定とフック |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | グローバル `skills/gsd-*/SKILL.md`；ローカル `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` フックと statusLine エントリ |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` または `opencode.jsonc`；GSD フックなし |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` または `kilo.jsonc`；GSD フックなし |
| Gemini CLI | `~/.gemini` | `./.gemini` | `commands/gsd/*.toml` | `agents/gsd-*.md` | `settings.json` フィーチャーフラグ、フック、statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | エージェントソース markdown + エージェントごとの TOML | `config.toml` `[agents.gsd-*]`、`[features].hooks`、フックテーブル |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` と `copilot-instructions.md` | `.agent.md` ファイル | GSD フックまたは statusline なし |
| Antigravity | auto-detected：`~/.gemini/antigravity`、`~/.gemini/antigravity-ide`、または `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD がインストールした場合の Gemini スタイル `settings.json` フックエントリ |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下のルール参照；GSD フックなし |
| Windsurf | `~/.codeium/windsurf` | `./.windsurf` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下のルール参照；GSD フックなし |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD フックまたは statusline なし |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下のルール参照；GSD フックなし |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | サポートされている場合の共通 GSD 設定とフックエントリ |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/DESCRIPTION.md` と `skills/gsd/gsd-*/SKILL.md` | `agents/gsd-*.md` | サポートされている場合の共通 GSD 設定とフックエントリ |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | サポートされている場合の共通 GSD 設定とフックエントリ |
| Cline | `~/.cline` | project root | `.clinerules` | ルールのみ | GSD フックまたは statusline なし |

### 抽象化ポイント

1. **ツール名マッピング** — 各ランタイムは独自のツール名を持つ（例：Claude の `Bash` → Copilot の `execute`）
2. **フックイベント名** — Claude Code は `PostToolUse`、Gemini は `AfterTool` を使用
3. **エージェントフロントマター** — 各ランタイムは独自のエージェント定義形式を持つ
4. **パス規約** — 各ランタイムは異なるディレクトリに設定を保存
5. **モデル参照** — `inherit` プロファイルにより、GSD はランタイムのモデル選択に委譲

インストーラーはインストール時にすべての変換を処理します。ワークフローとエージェントは Claude Code のネイティブ形式で記述され、デプロイ時に変換されます。

---

## Related

- [マルチエージェントオーケストレーション](explanation/multi-agent-orchestration.md)
- [セキュリティモデル](explanation/security-model.md)
- [CLI ツール](CLI-TOOLS.md)
- [ドキュメント索引](README.md)
