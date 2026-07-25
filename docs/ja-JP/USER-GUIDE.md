# GSD ユーザーガイド

GSD Core のナラティブ形式の補足ガイドです。まずここで全体像を把握し、各専用ドキュメントへのリンクをたどってください。

> **GSD Core のドキュメントは [Diataxis](https://diataxis.fr) の体系で整理されています。**
> 目的別にブラウズ: [チュートリアル](README.md#tutorials) · [ハウツーガイド](README.md#how-to-guides) · [リファレンス](README.md#reference) · [解説](README.md#explanation) · [ドキュメント索引](README.md)

---

## 目次

- [スラッシュコマンドの形式](#slash-command-forms-hyphen-vs-colon)
- [名前空間ルーティング入門](#namespace-routing-primer-gsdnamespace-v140)
- [プロジェクトライフサイクル概要](#project-lifecycle-overview)
- [ワークフロー図](#workflow-diagrams)
- [UI デザインコントラクト](#ui-design-contract)
- [スパイクとスケッチ](#spiking--sketching)
- [バックログとスレッド](#backlog--threads)
- [ワークストリームとワークスペース](#workstreams--workspaces)
- [セキュリティ](#security)
- [使用例](#usage-examples)
- [トラブルシューティング](#troubleshooting)
- [リカバリークイックリファレンス](#recovery-quick-reference)
- [プロジェクトファイル構造](#project-file-structure)
- [関連](#related)

GitHub / Linear / Jira のイシューから GSD を直接操作する方法については、
[Issue-driven orchestration](issue-driven-orchestration.md) ガイドを参照してください。
トラッカーのイシューを、既存の GSD プリミティブを用いた workspace → discuss → plan →
execute → verify → review → ship ループにマッピングするレシピです。

---

## スラッシュコマンドの形式（ハイフン形式 vs コロン形式） {#slash-command-forms-hyphen-vs-colon}

GSD はサポートされているすべてのランタイムに **同一のスキルセット** を提供しますが、スラッシュ形式には 2 種類の表記が存在します。

- **ハイフン形式** — `/gsd-command-name` — Claude Code、Copilot、OpenCode、Kilo、Cursor、Windsurf、Augment、Antigravity、Trae で使用されます。
- **コロン形式** — `/gsd:command-name` — **Gemini CLI 専用**。Gemini はすべてのプラグインコマンドをプラグイン ID 配下に名前空間分けするため、インストール時に `--gemini` フラグを指定するとコマンドディレクトリ内の本文参照とコマンドファイルがすべてコロン形式に書き換えられます。

どちらを選ぶ必要はありません — インストーラーが対象の各ランタイムのコマンドディレクトリに正しい形式を書き込みます。Gemini 端末でウォークスルーを実行する場合は、スラッシュコマンドを読む際に `gsd` 後のハイフンをコロンに置き換えてください。

## 名前空間ルーティング入門（`gsd:<namespace>`、v1.40） {#namespace-routing-primer-gsdnamespace-v140}

v1.40 では、階層的ルーティングへのファーストステージエントリーポイントとして **6 つの名前空間メタスキル** が追加されました。これにより、スキル一覧のトークンコストを低く抑えながら（86 スキルのフラットな列挙の約 2,150 トークンに対し、6 つのルーターで約 120 トークン）、各具体的なサブスキルは直接呼び出し可能なままです。各名前空間ルーターの本文には、ユーザーの意図を正しい具体的サブスキルにマッピングするルーティングテーブルが含まれています。

| 名前空間 | ルーター | ルーティング先 |
|-----------|--------|-----------|
| フェーズパイプライン | `/gsd-workflow` | discuss / plan / execute / verify / phase / progress |
| プロジェクトライフサイクル | `/gsd-project` | マイルストーン、監査、サマリー |
| 品質ゲート | `/gsd-quality` | コードレビュー、デバッグ、監査、セキュリティ、評価、UI |
| コードベースインテリジェンス | `/gsd-context` | マップ、グラフ化、ドキュメント、学習内容 |
| 管理 | `/gsd-manage` | 設定、ワークスペース、ワークストリーム、スレッド、更新、ship、受信トレイ |
| 探索とキャプチャ | `/gsd-ideate` | 探索、スケッチ、スパイク、仕様、キャプチャ |

名前空間ルーターを自分でタイプする必要はほぼありません。その価値はモデルが適切なサブスキルを見つけるために使うルーティングレイヤーにあります — システムプロンプトが 86 エントリではなく 6 エントリを列挙できるようにするために存在しています。具体的なコマンドがわかっている場合（例: `/gsd-plan-phase`）は、直接呼び出してください。

---

## プロジェクトライフサイクル概要 {#project-lifecycle-overview}

GSD のコアループは **discuss → plan → execute → verify → ship** であり、フェーズごとに繰り返されます。例示出力、作成されるファイル、使用されるフラグを含むステップバイステップのウォークスルーは専用チュートリアルに記載されています。

[最初のプロジェクト](tutorials/your-first-project.md) を参照してください。

新しいマイルストーンを開始する前に既存のコードベースをオンボーディングする方法については、[既存のコードベースのオンボーディング](tutorials/onboarding-an-existing-codebase.md) を参照してください。

**主要フラグ一覧:**

| フラグ | コマンド | 使用場面 |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | インタラクティブな質問をスキップし、PRD ファイルから取り込む |
| `--research` | `/gsd-quick` | アドホックタスクにリサーチエージェントを追加する |
| `--validate` | `/gsd-quick` | プランチェックと実行後の検証を追加する |
| `--chain` | `/gsd-discuss-phase` | discuss → plan → execute を停止なしで自動チェーンする |
| `--skip-research` | `/gsd-plan-phase` | ドメインが既知の場合にリサーチエージェントをスキップする |
| `--draft` | `/gsd-ship` | レビュー準備完了ではなくドラフト PR を作成する |

すべてのフラグを含む完全なコマンドリファレンスは [`docs/COMMANDS.md`](COMMANDS.md) を、設定オプション（モデルプロファイル、ワークフローエージェント、git ブランチ戦略）は [`docs/CONFIGURATION.md`](CONFIGURATION.md) を参照してください。

---

## ワークフロー図 {#workflow-diagrams}

### プロジェクト全体のライフサイクル

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### プランニングエージェントの協調

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### バリデーションアーキテクチャ（Nyquist レイヤー）

プランフェーズのリサーチ中、GSD はコードが書かれる前に各フェーズ要件に対して自動テストカバレッジをマッピングします。リサーチャーは既存のテストインフラを検出し、各要件を特定のテストコマンドにマッピングし、実装開始前に作成しなければならないテスト足場（Wave 0 タスク）を識別します。プランチェッカーはこれを 8 番目の検証ディメンションとして強制します: 自動検証コマンドが不足しているタスクを含むプランは承認されません。

**出力:** `{phase}-VALIDATION.md` — フェーズのフィードバックコントラクト。

**無効化:** テストインフラが焦点でないラピッドプロトタイピングフェーズでは、`/gsd-settings` で `workflow.nyquist_validation: false` を設定してください。

### 遡及バリデーション（`/gsd-validate-phase`）

Nyquist バリデーションが存在する前に実行されたフェーズ、またはテストスイートのみを持つ既存のコードベースに対し、カバレッジのギャップを遡及的に監査して補完します。

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

オーディターは実装コードを変更しません — テストファイルと VALIDATION.md のみです。テストが実装バグを検出した場合、対応すべきエスカレーションとして報告されます。

### 前提条件ディスカッションモード

デフォルトでは、`/gsd-discuss-phase` は実装の好みに関するオープンエンドな質問をします。前提条件モードではこれが逆転します: GSD がまずコードベースを読み込み、フェーズをどのように構築するかについての構造化された前提条件を提示し、修正点のみを尋ねます。

**有効化:** `/gsd-settings` 経由で `workflow.discuss_mode` を `'assumptions'` に設定してください。

詳細なディスカッションモードのリファレンスは [docs/workflow-discuss-mode.md](workflow-discuss-mode.md) を参照してください。

### 意思決定カバレッジゲート

ディスカッションフェーズは実装上の意思決定を CONTEXT.md の `<decisions>` ブロック内に番号付き箇条書き（`- **D-01:** …`）として記録します。2 つのゲートによりこれらの意思決定がプランおよびシップされたコードに確実に反映されます。

**プランフェーズ変換ゲート（ブロッキング）。** プランニング後、GSD はすべての追跡可能な意思決定が少なくとも 1 つのプランの `must_haves`、`truths`、または本文に含まれるまでフェーズ計画済みのマークを拒否します。

**検証フェーズバリデーションゲート（非ブロッキング）。** 検証中、GSD はプラン、SUMMARY.md、変更されたファイル、および直近のコミットメッセージで各追跡可能な意思決定を検索します。見落としは警告セクションとして VERIFICATION.md に記録されますが、検証ステータスは変更されません。

**意思決定のオプトアウト。** `<decisions>` 内の `### Claude's Discretion` 見出し配下に移動するか、タグを付けてください: `- **D-08 [informational]:** …`、`- **D-09 [folded]:** …`、`- **D-10 [deferred]:** …`。

**ゲートの無効化。** `.planning/config.json`（または `/gsd-settings` 経由）で `workflow.context_coverage_gate: false` を設定してください。デフォルトは `true` です。

### 実行ウェーブの協調

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

---

## UI デザインコントラクト {#ui-design-contract}

AI が生成するフロントエンドが視覚的に一貫しないのは、Claude Code の UI 能力の問題ではなく、実行前にデザインコントラクトが存在しなかったためです。`/gsd-ui-phase` はプランニング前にデザインコントラクトをロックし、`/gsd-ui-review` は実行後に結果を監査します。

完全なワークフロー、設定、shadcn の初期化、レジストリ安全ゲートについては [UI フェーズのデザイン](how-to/design-a-ui-phase.md) を参照してください。

**クイックリファレンス:**

| コマンド              | 説明                                              |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | フロントエンドフェーズ用の UI-SPEC.md デザインコントラクトを生成する |
| `/gsd-ui-review [N]` | 実装済み UI の 6 柱ビジュアル監査を遡及的に実行する      |

| 設定                   | デフォルト | 説明                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | フロントエンドフェーズ用の UI デザインコントラクトを生成する            |
| `workflow.ui_safety_gate` | `true`  | プランフェーズでフロントエンドフェーズに対し /gsd-ui-phase の実行を促す |

---

## スパイクとスケッチ {#spiking--sketching}

プランニング前に技術的な実現可能性を検証するには `/gsd-spike` を、デザイン前にビジュアルの方向性を探るには `/gsd-sketch` を使用してください。どちらもアーティファクトを `.planning/` に保存し、ラップアップコンパニオンを介してプロジェクトスキルシステムと統合されます。

完全なワークフローとフロー図は [スパイクとスケッチ](how-to/spike-and-sketch.md) を参照してください。

**典型的なフロー:**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## バックログとスレッド {#backlog--threads}

### バックログ駐車場

まだアクティブなプランニングの準備ができていないアイデアは、999.x 番号付けを使用してバックログに追加し、アクティブなフェーズシーケンスの外に置きます。

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

バックログアイテムは完全なフェーズディレクトリを持つため、`/gsd-discuss-phase 999.1` でアイデアをさらに探索したり、準備ができたら `/gsd-plan-phase 999.1` を使用できます。

**レビューとプロモーション** は `/gsd-review-backlog` で行います — すべてのバックログアイテムが表示され、プロモート（アクティブシーケンスに移動）、保持（バックログに残す）、または削除（削除）を選択できます。

### シード

シードはトリガー条件を持つ将来志向のアイデアです。バックログアイテムと異なり、適切なマイルストーンが来ると自動的に浮上します。

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone` はすべてのシードをスキャンしてマッチを提示します。**保存場所:** `.planning/seeds/SEED-NNN-slug.md`

### 永続コンテキストスレッド

スレッドは、複数のセッションにまたがるが特定のフェーズに属さない作業のための軽量なクロスセッション知識ストアです。

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

スレッドが成熟したら、フェーズ（`/gsd-phase`）またはバックログアイテム（`/gsd-capture --backlog`）に昇格できます。**保存場所:** `.planning/threads/{slug}.md`

---

## ワークストリームとワークスペース {#workstreams--workspaces}

ワークストリームとワークスペースはどちらも分離を提供しますが、異なるレベルで動作します。

**ワークストリーム** は同じコードベースと git 履歴を共有しながら、プランニングアーティファクトを分離します — より軽量で、複数のマイルストーン領域を並行して作業するのに適しています。[ワークストリームで並行作業する](how-to/work-in-parallel-with-workstreams.md) を参照してください。

**ワークスペース** は独自の `.planning/` を持つ独立したリポジトリのワークツリーを作成します — より重量があり、フィーチャーブランチまたはマルチリポジトリの分離に適しています。[ワークスペースで作業を分離する](how-to/isolate-work-with-workspaces.md) を参照してください。

| コマンド                            | 目的                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | 分離されたプランニング状態を持つ新しいワークストリームを作成する |
| `/gsd-workstreams switch <name>`   | アクティブコンテキストを別のワークストリームに切り替える      |
| `/gsd-workstreams list`            | すべてのワークストリームとアクティブなものを表示する           |
| `/gsd-workstreams complete <name>` | ワークストリームを完了としてマークし状態をアーカイブする      |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## セキュリティ {#security}

### 多層防御（v1.27）

GSD は LLM のシステムプロンプトになるマークダウンファイルを生成します。これは、プランニングアーティファクトに流れ込むユーザー制御のテキストが、間接的なプロンプトインジェクションベクターになり得ることを意味します。v1.27 では集中的なセキュリティ強化が導入されました。

**パストラバーサル防止:** ユーザーが指定したファイルパス（`--text-file`、`--prd`）はすべてプロジェクトディレクトリ内で解決されるよう検証されます。macOS の `/var` → `/private/var` シンボリックリンク解決も処理されます。

**プロンプトインジェクション検出:** `security.cjs` モジュールは、ユーザーが指定したテキストがプランニングアーティファクトに入力される前に既知のインジェクションパターンをスキャンします。

**ランタイムフック:**

- `gsd-prompt-guard.js` — `.planning/` への Write/Edit 呼び出しでインジェクションパターンをスキャンする（常時有効、アドバイザリーのみ）
- `gsd-workflow-guard.js` — GSD ワークフローコンテキスト外でのファイル編集を警告する（`hooks.workflow_guard` 経由でオプトイン）

**CI スキャナー:** `prompt-injection-scan.security.test.cjs` はすべてのエージェント、ワークフロー、コマンドファイルに埋め込まれたインジェクションベクターをスキャンします。

---

### パッケージ正当性ゲート（v1.42.1）

AI コーディングツールはパッケージ名を幻覚することがあります。攻撃者はそれらの名前を npm、PyPI、crates.io に悪意のあるインストール後スクリプトとともにあらかじめ登録します — これは *スロップスクワッティング* と呼ばれる手法です。v1.42.1 では、これがシェルに到達する前に停止させる 3 層ゲートが追加されました。

**RESEARCH.md 内** — 外部パッケージを推奨する各フェーズには `## Package Legitimacy Audit` テーブルが含まれます:

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

`[SLOP]` パッケージは RESEARCH.md から完全に削除され、プランナーに到達することはありません。

**PLAN.md 内** — `[SUS]` または `[ASSUMED]` パッケージはインストール前に `checkpoint:human-verify` タスクをトリガーします。

**実行中** — インストールが失敗した場合、エグゼキューターはチェックポイントを提示して停止し、代替案をサイレントに試みません。

**スロップチェックの判定:**

| 判定 | 意味 | GSD のアクション |
|---------|---------|------------|
| `[OK]` | すべての正当性チェックに合格 | 進行 — チェックポイントは追加されない |
| `[SUS]` | 疑わしいシグナル | フラグ付き; プランナーが `checkpoint:human-verify` を追加 |
| `[SLOP]` | 高確信度の幻覚 | RESEARCH.md から削除; プランナーに到達しない |

slopcheck を手動でインストールするには:

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## コードレビューワークフロー

フェーズを実行した後、UAT の前に構造化されたコードレビューを実行してください。完全なワークフローは [クロス AI レビューのセットアップ](how-to/set-up-cross-ai-review.md) を参照してください。

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

レビューステップは実行後、UAT 前に位置します:

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## コマンドおよび設定リファレンス

- **コマンドリファレンス:** すべての安定版コマンドのフラグ、サブコマンド、例については [`docs/COMMANDS.md`](COMMANDS.md) を参照してください。
- **設定リファレンス:** 完全な `config.json` スキーマ、モデルプロファイルテーブル、git ブランチ戦略、セキュリティ設定については [`docs/CONFIGURATION.md`](CONFIGURATION.md) を参照してください。
- **ディスカッションモード:** インタビューモードと前提条件モードについては [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md) を参照してください。

---

## 使用例 {#usage-examples}

### 新規プロジェクト（フルサイクル）

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### 既存ドキュメントからの新規プロジェクト

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### 既存のコードベース

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow printed handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

**実行後のドリフト検出（#2003）。** `/gsd-execute-phase` を実行するたびに、GSD はフェーズが `.planning/codebase/STRUCTURE.md` を古くするほどの構造的変更を導入したかどうかを確認します。次のコマンドで動作を切り替えられます:

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### プランドリフトガード

**デフォルトオン。** プランドリフトガード（`plan_review.source_grounding: true`）はプランレビュー中に実行され、プランが引用するすべてのシンボル（デコレーター、クラス、関数、CLI フラグ）がレビュー時にソースツリーに実際に存在するかを検証します。これにより、実行エージェントが実行される前に幻覚された名前を検出します。

**検出内容:**

- PLAN.md のステップで参照されているが、ソースに存在しない関数
- プランが書かれた後にリネームまたは削除されたクラスまたはデコレーター名
- プランに記述されているが引数パーサーに定義されていない CLI フラグ
- 実装ステップで引用されているがファイルに解決されないモジュールパス

**needs-acknowledgement の動作。** ガードが欠損シンボルを発見すると、ハードブロックではなく `needs-acknowledgement` 通知をプランレビュー出力に出力します。承認して続行（シンボルが意図的に新規の場合）するか、プランの修正を要求できます。ガードはプランを自動拒否しません — 人間の判断のためのシグナルを提示します。

**intel なしでも動作。** デフォルトではガードは `grep`/`ripgrep` を使用してソースファイルを検索します — 事前インデックスは不要です。`intel.enabled: true` で `/gsd:map-codebase` を実行済みの場合、`plan_review.source_grounding_authority: intel` を設定すると、より高速な事前構築済みの `api-map.json` インデックスを使用できます。

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

プロジェクト設定時（`/gsd:new-project` がワークフロー設定中に尋ねます）または `/gsd:settings`（Planning セクション → Drift Guard）経由でいつでも切り替えられます。

### クイックバグ修正

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### 休憩後の再開

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### リリース準備

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### スピードと品質のプリセット

| シナリオ    | モード          | 粒度 | プロファイル    | リサーチ | プランチェック | ベリファイア |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| プロトタイピング | `yolo`        | `coarse`    | `budget`   | off      | off        | off      |
| 通常の開発  | `interactive` | `standard`  | `balanced` | on       | on         | on       |
| 本番環境  | `interactive` | `fine`      | `quality`  | on       | on         | on       |

**自律モードでのディスカッションフェーズのスキップ:** `yolo` モードで実行する場合、`/gsd-settings` で `workflow.skip_discuss: true` を設定してください。

### マイルストーン途中でのスコープ変更

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## トラブルシューティング {#troubleshooting}

包括的なトラブルシューティングガイドは [リカバリーとトラブルシューティング](how-to/recover-and-troubleshoot.md) を参照してください。最も一般的な問題を以下に要約します。

### プログラマティック CLI（`gsd-tools query` vs `gsd-tools.cjs`）

自動化には、登録済みサブコマンドを使用する **`gsd-tools query`** を推奨します（[CLI-TOOLS.md — SDK とプログラマティックアクセス](CLI-TOOLS.md#sdk-and-programmatic-access) と QUERY-HANDLERS.md を参照）。レガシーの `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` CLI は引き続きサポートされています。

### STATE.md の同期ずれ

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### 「Spawning...」の後にコマンドがフリーズしているように見える

GSD サブエージェントは独立したコンテキストウィンドウで実行されます — その作業は進行中は親セッションからは見えません。セッションを中断しないでください。リサーチおよびプランニングエージェントは通常 1〜5 分かかります。結果を待ってください。

### 長いセッション中のコンテキスト劣化

主要なコマンド間でコンテキストウィンドウをクリアしてください: Claude Code では `/clear`。GSD はフレッシュなコンテキストを前提に設計されています — すべてのサブエージェントはクリーンな 200K ウィンドウを取得します。クリア後に状態を復元するには `/gsd-resume-work` または `/gsd-progress` を使用してください。

### プランが間違っているまたは方向性がずれている

プランニング前に `/gsd-discuss-phase [N]` を実行してください。プランの品質問題のほとんどは、`CONTEXT.md` があれば防げた前提をモデルが立てることから来ています。

### 実行が失敗するかスタブを生成する

プランが野心的すぎなかったか確認してください。プランは最大 2〜3 タスクであるべきです。より小さなスコープで再プランしてください。

### どこにいるかわからなくなった

`/gsd-progress` を実行してください。すべての状態ファイルを読み込み、現在地と次にすべきことを正確に伝えます。

### モデルコストが高すぎる

budget プロファイルに切り替えてください: `/gsd-config --profile budget`。ドメインが既知の場合は `/gsd-settings` でリサーチおよびプランチェックエージェントを無効化してください。

### フェーズ別のモデルコスト調整（`models`）— v1.40 追加

`.planning/config.json` に `models` ブロックを追加してください:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  }
}
```

エージェント単位の例外が必要な場合は、`model_overrides` を併記してください — これが `models` より優先されます:

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

完全なマッピングテーブルと解決優先順位のルールは [フェーズタイプ別モデル](CONFIGURATION.md#per-phase-type-models-models--added-in-v140) を参照してください。

### `dynamic_routing` によるデフォルトで低コスト — v1.40 追加

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

完全なエージェント → ティアマッピングは [ダイナミックルーティング](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140) を参照してください。

### MCP サーバーのトリミングによるターンあたりのコスト削減

`model_profile` や `models.<phase_type>` を調整する前に、ハーネスで有効になっている **MCP サーバー** を監査してください。有効になっている各 MCP サーバーはすべてのターンにそのツールスキーマを注入します — 重量級のサーバーはそれぞれ 20k+ トークンかかることがあります。

これは **ハーネスの設定** であり、GSD の設定ではありません。トグルは `.claude/settings.json` にあります:

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

長いフェーズの前のクイック監査:

- このフェーズに UI 作業がないのに、ブラウザ / playwright ツールが有効になっていますか？
- 不要なプラットフォーム固有ツールが有効になっていますか？
- 別のプロジェクトのプロジェクト固有 MCP がここでまだ有効になっていますか？

サーバーを無効にすると、以降のすべてのターンからそのスキーマが削除されます。MCP のトリミングは `model_profile` の調整と**複合効果があります** — 両方のレバーは相加的であり、MCP の節約はオーケストレーターが生成するすべてのサブエージェントにわたってすぐに現れます。

完全な監査、ハーネスリファレンス、`model_profile` との組み合わせに関するノートは、バンドルされた `context-budget.md` リファレンスの [MCP ツールスキーマコスト](../../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern) を参照してください。

### 非 Claude ランタイムの使用（Codex、OpenCode、Gemini CLI、Kilo）

> **Codex CLI の最小サポートバージョン: `0.130.0`**（イシュー [#3562](https://github.com/open-gsd/gsd-core/issues/3562)）。

非 Claude ランタイム向けに GSD をインストールした場合、インストーラーがすでにモデル解決を設定しています。手動設定は不要です — `resolve_model_ids: "omit"` が自動的に設定され、GSD に Anthropic モデル ID の解決をスキップしてランタイムが独自のデフォルトモデルを選ぶよう指示します。

非 Claude ランタイムで異なるモデルを割り当てるには:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### 設定変更 1 つで Claude から Codex へ切り替え（#2517）

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

[ランタイム対応プロファイル](CONFIGURATION.md#runtime-aware-profiles-2517) を参照してください。

### 手動インストール / Node.js なしのセットアップ

GSD インストーラーを実行できない場合、`agents/` のソースファイルを直接使用することはできません — これらは Claude Code のネイティブフロントマター形式です。OpenCode では 2 つの変換が必要です:

| フィールド | GSD ソース形式 | OpenCode 対応形式 | アクション |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep`（カンマ区切り文字列） | フロントマターフィールドではない | `tools:` 行を完全に削除する |
| `color:` | プレーン CSS カラー名 | 16 進数または OpenCode セマンティック名 | 16 進数に変換するか削除する |

**代替案:** Node.js がある任意のマシンでインストーラーを実行します:

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### Cline へのインストール

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### CodeBuddy へのインストール

```bash
npx @opengsd/gsd-core --codebuddy --global
```

### Qwen Code へのインストール

```bash
npx @opengsd/gsd-core --qwen --global
```

### プレリリースエディションへのインストール

インストーラーを実行する前に、ランタイムの `*_CONFIG_DIR` 環境変数をプレリリースディレクトリに設定してください:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**サポートされているランタイムの環境変数リファレンス:**

| ランタイム | 安定版デフォルト | オーバーライド環境変数 |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `~/.gemini` | `GEMINI_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | （Codex CLI による） | `--config-dir` フラグ |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | 自動検出 | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### 非 Anthropic プロバイダーでの Claude Code の使用

`inherit` プロファイルに切り替えてください: `/gsd-config --profile inherit`。これにより、すべてのエージェントが現在のセッションモデルを使用します。

### 機密 / プライベートプロジェクトの作業

`/gsd-new-project` 中または `/gsd-settings` 経由で `commit_docs: false` を設定してください。`.planning/` を `.gitignore` に追加してください。

### GSD の更新でローカル変更が上書きされた

v1.17 以降、インストーラーはローカルで変更されたファイルを `gsd-local-patches/` にバックアップします。変更を元に戻すには `/gsd-update --reapply` を実行してください。

### npm 経由で更新できない

手順ごとの手動更新手順は [docs/manual-update.md](../manual-update.md) を参照してください。

### ワークフロー診断（`/gsd-forensics`）

ワークフローが明らかでない方法で失敗した場合、`/gsd-forensics` を実行して git 履歴の異常、アーティファクトの整合性、状態の不整合を網羅する診断レポートを生成してください。出力は `.planning/forensics/` に保存されます。

### エグゼキューターサブエージェントが Bash コマンドで「Permission denied」になる

必要なパターンを `~/.claude/settings.json` に追加してください。すべてのスタックに必要なコアパターン:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**プロジェクト単位の権限:** `~/.claude/settings.json` の代わりに、プロジェクトルートの `.claude/settings.local.json` に同じ `permissions.allow` ブロックを追加してください。

### 並列実行でビルドロックエラーが発生する

GSD は v1.26 以降これを自動的に処理します。古いバージョンを使用している場合は、プロジェクトの `CLAUDE.md` に追加してください:

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

並列実行を完全に無効にするには: `/gsd-settings` → `parallelization.enabled` を `false` に設定してください。

---

## リカバリークイックリファレンス {#recovery-quick-reference}

| 問題                              | 解決策                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| コンテキスト喪失 / 新しいセッション           | `/gsd-resume-work` または `/gsd-progress`                                    |
| フェーズが失敗した                     | フェーズのコミットを `git revert` してから再プランする                             |
| スコープを変更する必要がある                 | `/gsd-phase`（デフォルト）、`/gsd-phase --insert`、または `/gsd-phase --remove`  |
| 何かが壊れた                      | `/gsd-debug "description"`（分析のみで修正なしは `--diagnose` を追加） |
| STATE.md の同期ずれ                 | `state validate` してから `state sync`                                       |
| ワークフロー状態が破損しているように見える       | `/gsd-forensics`                                                         |
| クイックなターゲット修正                   | `/gsd-quick`                                                             |
| プランがビジョンと一致しない       | `/gsd-discuss-phase [N]` してから再プランする                                    |
| コストが高騰している                   | `/gsd-config --profile budget` と `/gsd-settings` でエージェントをオフに  |
| 更新でローカル変更が壊れた           | `/gsd-update --reapply`                                                  |
| ステークホルダー向けセッションサマリーが欲しい | `/gsd-pause-work --report`                                               |
| 次のステップがわからない         | `/gsd-progress --next`                                                   |
| 並列実行でビルドエラーが発生する      | GSD を更新するか `parallelization.enabled: false` を設定する                       |

---

## プロジェクトファイル構造 {#project-file-structure}

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    completed/             # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase or /gsd-onboard)
  onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## 関連 {#related}

- [ドキュメント索引](README.md)
- [コマンド](COMMANDS.md)
- [設定](CONFIGURATION.md)
- [フェーズループ](explanation/the-phase-loop.md)
