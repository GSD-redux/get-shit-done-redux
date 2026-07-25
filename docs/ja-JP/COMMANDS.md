# GSD Core コマンドリファレンス

> GSD Core のコマンドリファレンス — すべての安定版コマンドの構文、フラグ、オプション、および使用例。機能の詳細については [機能リファレンス](../FEATURES.md) を、ワークフローの解説については [ユーザーガイド](../USER-GUIDE.md) を、ドキュメントのインデックスについては [README](../README.md) を参照してください。

---

## コマンド構文

- **Claude Code / Copilot / OpenCode / Kilo:** `/gsd-command-name [args]`（ハイフン形式）
- **Gemini CLI:** `/gsd:command-name [args]`（コロン形式 — Gemini は `gsd:` 配下にコマンドを名前空間化します）
- **Codex:** `$gsd-command-name [args]`

ハイフン形式とコロン形式は、*同じコマンドのランタイム固有の表記*です。どのランタイムを使用していても、インストーラーが正しい形式をランタイムのコマンドディレクトリに書き込みます。

---

## 名前空間メタスキル

v1.40 では、最初のステージエントリーポイントとして6つの名前空間ルーターが提供されています。これらは積極的なスキルリストのトークンコストを低く保ちます（6つのルーターで約120トークン、フラットな86スキルのリストでは約2,150トークン）。一方、フルサーフェスは直接呼び出し可能なままです。モデルは名前空間を選択し、具体的なサブスキルにルーティングします。[#2792](https://github.com/open-gsd/gsd-core/issues/2792) を参照してください。

| コマンド | ルーティング先 |
|---------|-----------|
| `/gsd-workflow` | フェーズパイプライン — discuss / plan / execute / verify / phase / progress |
| `/gsd-project` | プロジェクトライフサイクル — マイルストーン、監査、サマリー |
| `/gsd-quality` | 品質ゲート — コードレビュー、デバッグ、監査、セキュリティ、eval、UI |
| `/gsd-context` | コードベースインテリジェンス — map、graphify、docs、learnings |
| `/gsd-manage` | 管理 — config、workspace、workstreams、thread、update、ship、inbox |
| `/gsd-ideate` | 探索とキャプチャ — explore、sketch、spike、spec、capture |

名前空間スキルは**追加的**です — 既存のすべての具体的なコマンド（例: `/gsd-plan-phase`、`/gsd-code-review --fix`）は引き続き直接呼び出せます。

---

## コアワークフローコマンド

### `/gsd-new-project`

深いコンテキスト収集を伴う新規プロジェクトの初期化。

| フラグ | 説明 |
|------|-------------|
| `--auto @file.md` | ドキュメントから自動抽出し、インタラクティブな質問をスキップ |

**前提条件:** 既存の `.planning/PROJECT.md` がないこと
**生成物:** `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md`、`config.json`、`research/`、`CLAUDE.md`

```bash
/gsd-new-project                    # インタラクティブモード
/gsd-new-project --auto @prd.md     # PRD から自動抽出
```

---

### `/gsd-onboard`

既存コードベースの初回 GSD オンボーディングを案内します。リポジトリ状態を確認し、コードベースマッピング、任意のドキュメント取り込み、プロジェクト初期化へ安全にハンドオフし、計画が揃った後にオンボーディング summary を作成します。

| フラグ | 説明 |
|------|-------------|
| `--fast` | 軽量な `/gsd-map-codebase --fast` マッピングハンドオフを優先。ただし `/gsd-new-project` 前には完全なマップが必要 |
| `--text` | TUI メニューではなく番号付きプレーンテキストのゲートを使用 |

**前提条件:** 既存リポジトリまたは計画ドキュメント。空のグリーンフィールドプロジェクトには `/gsd-new-project` を使用します。
**生成物:** map-codebase による `.planning/codebase/`、new-project または ingest-docs による `.planning/`、セットアップ後の `.planning/onboarding/SUMMARY.md`。

```bash
/gsd-onboard           # ガイド付き brownfield オンボーディング
/gsd-onboard --fast    # 先に軽量マップを使い、その後プロジェクト設定前に完全マップを作成
```

---

### `/gsd-workspace`

GSD ワークスペースを管理 — リポジトリコピーと独立した `.planning/` ディレクトリを持つ隔離されたワークスペース環境を作成、一覧表示、または削除します。

| フラグ | 説明 |
|------|-------------|
| `--new` | 新しいワークスペースを作成（`--name`、`--repos` などと組み合わせて使用） |
| `--list` | アクティブな GSD ワークスペースとそのステータスを一覧表示 |
| `--remove <name>` | ワークスペースを削除し、git ワークツリーをクリーンアップ |
| `--name <name>` | ワークスペース名（`--new` と組み合わせて使用） |
| `--repos repo1,repo2` | カンマ区切りのリポジトリパスまたは名前（`--new` と組み合わせて使用） |
| `--path /target` | ターゲットディレクトリ（デフォルト: `~/gsd-workspaces/<name>`） |
| `--strategy worktree\|clone` | コピー戦略（デフォルト: `worktree`） |
| `--branch <name>` | チェックアウトするブランチ（デフォルト: `workspace/<name>`） |
| `--auto` | インタラクティブな質問をスキップ |

**ユースケース:**
- マルチリポジトリ: 隔離された GSD 状態で一部のリポジトリに取り組む
- 機能の隔離: `--repos .` で現在のリポジトリのワークツリーを作成

**生成物:** `WORKSPACE.md`、`.planning/`、リポジトリコピー（ワークツリーまたはクローン）

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
/gsd-workspace --new --name feature-b --repos . --strategy worktree  # 同一リポジトリの隔離
/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

### `/gsd-discuss-phase`

計画前にアダプティブな質問を通じてフェーズのコンテキストを収集します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号（デフォルト: 現在のフェーズ） |

| フラグ | 説明 |
|------|-------------|
| `--all` | エリア選択をスキップ — すべてのグレーエリアをインタラクティブに議論（自動進行なし） |
| `--auto` | すべての質問に対して推奨デフォルトを自動選択 |
| `--batch` | 質問を一件ずつではなくバッチ入力のためにグループ化 |
| `--analyze` | 議論中にトレードオフ分析を追加 |
| `--power` | 準備済みの回答ファイルからファイルベースの一括質問回答 |
| `--assumptions` | インタラクティブセッションなしで、フェーズに関する Claude の実装上の前提を表示 |

**前提条件:** `.planning/ROADMAP.md` が存在すること
**生成物:** `{phase}-CONTEXT.md`、`{phase}-DISCUSSION-LOG.md`（監査証跡）

```bash
/gsd-discuss-phase 1                # フェーズ1のインタラクティブな議論
/gsd-discuss-phase 1 --all          # 選択ステップなしですべてのグレーエリアを議論
/gsd-discuss-phase 3 --auto         # フェーズ3のデフォルトを自動選択
/gsd-discuss-phase --batch          # 現在のフェーズのバッチモード
/gsd-discuss-phase 2 --analyze      # トレードオフ分析付きの議論
/gsd-discuss-phase 1 --power        # ファイルからの一括回答
/gsd-discuss-phase 3 --assumptions  # 計画前に Claude の前提を表示
```

---

### `/gsd-ui-phase`

フロントエンドフェーズの UI デザインコントラクトを生成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号（デフォルト: 現在のフェーズ） |

**前提条件:** `.planning/ROADMAP.md` が存在し、フェーズにフロントエンド/UI 作業があること
**生成物:** `{phase}-UI-SPEC.md`

```bash
/gsd-ui-phase 2                     # フェーズ2のデザインコントラクト
```

---

### `/gsd-plan-phase`

フェーズのリサーチ、計画、および検証を行います。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号（デフォルト: 次の未計画フェーズ） |

| フラグ | 説明 |
|------|-------------|
| `--auto` | インタラクティブな確認をスキップ |
| `--research` | RESEARCH.md が存在する場合でも強制的に再リサーチ |
| `--skip-research` | ドメインリサーチステップをスキップ |
| `--research-phase <N>` | リサーチのみモード: フェーズ `<N>` 用にリサーチャーを起動し、RESEARCH.md を書き込んでからプランナーの前に終了。削除されたスタンドアロンリサーチコマンドを置き換えます（#3042）。 |
| `--view` | リサーチのみ修飾子: `--research-phase` と組み合わせて使用すると、既存の RESEARCH.md を標準出力に表示して終了（起動なし）。 |
| `--gaps` | ギャップクローズモード（VERIFICATION.md を読み込み、リサーチをスキップ） |
| `--skip-verify` | プランチェッカーの検証ループをスキップ |
| `--prd <file>` | コンテキストに discuss-phase の代わりに PRD ファイルを使用 |
| `--ingest <path-or-glob>` | コンテキスト統合に discuss-phase の代わりに ADR ファイルを使用 |
| `--ingest-format <auto\|nygard\|madr\|narrative>` | `--ingest` のオプション ADR パーサーフォーマットの上書き |
| `--reviews` | REVIEWS.md のクロス AI レビューフィードバックで再計画 |
| `--bounce` | 計画後に外部プランバウンス検証を実行（`workflow.plan_bounce_script` を使用） |
| `--skip-bounce` | 設定で有効になっている場合でもプランバウンスをスキップ |
| `--mvp` | 垂直 MVP モード — プランナーはタスクを水平レイヤーではなく機能スライス（UI→API→DB）として整理します。以前のフェーズサマリーがない新規プロジェクトのフェーズ1では、`SKELETON.md`（Walking Skeleton）も生成します。ROADMAP.md の `**Mode:** mvp` でフェーズごとに永続化でき、フラグなしで `--mvp` が自動適用されます。 |
| `--tdd` | TDD モード — プランナーは動作追加タスクに `type: tdd` を適用し、各タスクが失敗するテストから始まるようにします。`--mvp` と組み合わせ可能: `--mvp --tdd` は、すべての動作追加タスクが red-green から始まる垂直スライスを生成します。 |

**前提条件:** `.planning/ROADMAP.md` が存在すること
**生成物:** `{phase}-RESEARCH.md`、`{phase}-{N}-PLAN.md`、`{phase}-VALIDATION.md`; Walking Skeleton モードが発火した場合は `{phase}/SKELETON.md`

**リサーチのみモード（`--research-phase <N>`）:**
- 修飾子なし: RESEARCH.md が既に存在する場合は `update / view / skip` を促します。
- `--research` 付き: 強制更新 — 無条件にリサーチャーを再起動し、プロンプトなし。
- `--view` 付き: 既存の RESEARCH.md を標準出力に表示し、起動なし。RESEARCH.md がない場合はエラー。

**パッケージ正当性ゲート（v1.42.1）:**
リサーチャーが外部パッケージを推奨する場合、各パッケージに対して `slopcheck install <pkg> --json` を実行し、Registry、Age、Downloads、Source Repo、および slopcheck の評決を記録した `## Package Legitimacy Audit` テーブルを RESEARCH.md に書き込みます。評決:

- `[SLOP]` — パッケージは RESEARCH.md から完全に削除され、プランナーには届かない
- `[SUS]` — パッケージにフラグが付けられ、プランナーはインストールタスクの前に `checkpoint:human-verify` を挿入
- `[OK]` — パッケージが承認され、チェックポイントは追加されない

WebSearch から取得したパッケージは `[ASSUMED]`（`[VERIFIED]` ではない）とタグ付けされ、`[SUS]` と同様に扱われます — インストール前に人間によるチェックポイントが設けられます。`slopcheck` がインストールできない場合、すべての推奨パッケージは `[ASSUMED]` とタグ付けされ、ゲートが設けられます。

詳細については、[ユーザーガイドのパッケージ正当性ゲート](../USER-GUIDE.md#package-legitimacy-gate-v1421)（チェックポイント形式、評決テーブル、トラブルシューティングを含む）を参照してください。

```bash
/gsd-plan-phase 1                              # フェーズ1のリサーチ + 計画 + 検証
/gsd-plan-phase 3 --skip-research              # リサーチなしの計画（既知のドメイン）
/gsd-plan-phase --auto                         # 非インタラクティブな計画
/gsd-plan-phase 1 --bounce                     # 計画 + 外部バウンス検証
/gsd-plan-phase 2 --ingest docs/adr/0010.md   # コンテキスト統合のための ADR エクスプレスパス
/gsd-plan-phase 2 --ingest 'docs/adr/00*.md' --ingest-format auto
/gsd-plan-phase --research-phase 4             # フェーズ4のリサーチのみ（RESEARCH.md が存在する場合はプロンプト）
/gsd-plan-phase --research-phase 4 --view      # 既存の RESEARCH.md を表示し、起動なし
/gsd-plan-phase --research-phase 4 --research  # 強制更新リサーチ、プロンプトなし
/gsd-plan-phase 1 --mvp                        # フェーズ1の垂直スライス計画
/gsd-plan-phase 1 --mvp --tdd                  # 垂直スライス + 動作追加タスクごとに失敗するテスト
```

---

### `/gsd-plan-review-convergence`

クロス AI プラン収束ループ — HIGH の懸念がなくなるまでレビューフィードバックで再計画します。`plan-phase → review → replan → re-review` のサイクルを実行します（デフォルトで最大3サイクル）。計画とレビューのために隔離されたエージェントを起動し、オーケストレーターはループ制御、HIGH 懸念のカウント、ストール検出、およびエスカレーションを処理します。

| 引数 / フラグ | 必須 | 説明 |
|-----------------|----------|-------------|
| `N` | **Yes** | 計画およびレビューするフェーズ番号 |
| `--codex` / `--gemini` / `--claude` / `--opencode` | No | 単一レビュアーの選択 |
| `--all` | No | 設定済みのすべてのレビュアーを並列で実行 |
| `--max-cycles N` | No | サイクル上限を上書き（デフォルト3） |

**終了動作:** HIGH カウントがゼロになるとループが終了します。HIGH カウントがサイクル間で減少しない場合はストール検出が警告します。`--max-cycles` に達しても HIGH 懸念が残っている場合、エスカレーションゲートがユーザーに続行するか手動でレビューするかを確認します。

```bash
/gsd-plan-review-convergence 3                    # デフォルトレビュアー、3サイクル
/gsd-plan-review-convergence 3 --codex            # Codex のみのレビュー
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

---

### `/gsd-ultraplan-phase`

**[BETA]** Claude Code の ultraplan クラウドにプランフェーズをオフロードし、ブラウザでレビューして戻りのインポートを行います。計画はリモートでドラフトされるためターミナルは自由なままです。ブラウザでインラインコメントをレビューし、確定した計画を `/gsd-import` を使って `.planning/` にインポートします。

| フラグ | 必須 | 説明 |
|------|----------|-------------|
| `N` | **Yes** | リモートで計画するフェーズ番号 |

**隔離:** `/gsd-plan-phase` から意図的に分離されており、ultraplan の変更がコア計画パイプラインに影響を与えないようになっています。

```bash
/gsd-ultraplan-phase 4                  # フェーズ4の計画をオフロード
```

---

### `/gsd-execute-phase`

波ベースの並列化でフェーズ内のすべての計画を実行するか、特定の波のみを実行します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | **Yes** | 実行するフェーズ番号 |
| `--wave N` | No | フェーズ内の波 `N` のみを実行 |
| `--cross-ai` | No | 外部 AI CLI に実行を委任（`workflow.cross_ai_command` を使用） |
| `--no-cross-ai` | No | 設定でクロス AI が有効な場合でもローカル実行を強制 |

**前提条件:** フェーズに PLAN.md ファイルがあること
**生成物:** 計画ごとの `{phase}-{N}-SUMMARY.md`、git コミット、フェーズが完全に完了すると `{phase}-VERIFICATION.md`

**パッケージインストール失敗（v1.42.1）:** 計画のインストールステップが失敗した場合、エグゼキューターは `checkpoint:human-verify` を表示して停止します。類似した名前の代替パッケージを自動インストールすることはありません。これは意図的なものです — パッケージ名を暗黙的に置き換えることは、スロップスクワッティングが広がる経路だからです。レジストリページでパッケージを確認した後にチェックポイントに応答してください。

```bash
/gsd-execute-phase 1                # フェーズ1を実行
/gsd-execute-phase 1 --wave 2       # 波2のみを実行
/gsd-execute-phase 2 --cross-ai     # フェーズ2を外部 AI CLI に委任
```

---

### `/gsd-verify-work`

自動診断付きのユーザー受け入れテスト。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号（デフォルト: 最後に実行されたフェーズ） |

**前提条件:** フェーズが実行済みであること
**生成物:** `{phase}-UAT.md`、問題が見つかった場合は修正計画

ブラウザバックの UAT には、設定済みのブラウザ MCP サーバーを使用してください。現在の Open GSD コンパニオンは `gsd-browser`（`gsd-browser mcp`）で、決定論的なナビゲーション、バージョン管理された参照、アサーション、スクリーンショット、ビジュアル差分、録画、および人間への引き継ぎを提供します。既に設定済みのレガシー Playwright MCP サーバーも引き続き使用できます。

```bash
/gsd-verify-work 1                  # フェーズ1の UAT
```

---

---

### `/gsd-ship`

完了したフェーズ作業から自動生成された本文付きの PR を作成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号またはマイルストーンバージョン（例: `4` または `v1.0`） |
| `--draft` | No | ドラフト PR として作成 |

**前提条件:** フェーズが検証済み（`/gsd-verify-work` が合格）、`gh` CLI がインストールされ認証済みであること
**生成物:** 計画アーティファクトから豊富な本文を持つ GitHub PR、STATE.md が更新される

```bash
/gsd-ship 4                         # フェーズ4を ship
/gsd-ship 4 --draft                 # ドラフト PR として ship
```

**PR 本文の内容:**
- ROADMAP.md からのフェーズ目標
- SUMMARY.md ファイルからの変更サマリー
- 対応した要件（REQ-ID）
- 検証ステータス
- 主要な決定事項
- `ship.pr_body_sections` から設定されたオプションの PRD スタイルセクション

カスタム PR 本文セクションについては、[カスタム PR 本文セクション](../ship-pr-body-sections.md)（オンボーディング、例、検証ルールを含む）を参照してください。

---

### `/gsd-ui-review`

実装済みフロントエンドの事後的な6ピラービジュアル監査。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号（デフォルト: 最後に実行されたフェーズ） |

**前提条件:** プロジェクトにフロントエンドコードがあること（スタンドアロンで動作し、GSD プロジェクトは不要）
**生成物:** `{phase}-UI-REVIEW.md`、`.planning/ui-reviews/` 内のスクリーンショット

より豊富なビジュアル証拠のために、`gsd-browser` や別のブラウザ MCP サーバーと組み合わせて使用すると、監査がスクリーンショット、状態、コンソール/ネットワークコンテキスト、および再現可能なインタラクション手順をキャプチャできます。

```bash
/gsd-ui-review                      # 現在のフェーズを監査
/gsd-ui-review 3                    # フェーズ3を監査
```

---

### `/gsd-audit-uat`

すべての未解決の UAT および検証項目のクロスフェーズ監査。

**前提条件:** 少なくとも1つのフェーズが UAT または検証付きで実行済みであること
**生成物:** 人間によるテスト計画を含むカテゴリ別監査レポート

```bash
/gsd-audit-uat
```

---

### `/gsd-audit-milestone`

マイルストーンが完了の定義を満たしていることを検証します。

**前提条件:** すべてのフェーズが実行済みであること
**生成物:** ギャップ分析付き監査レポート

```bash
/gsd-audit-milestone
```

---

### `/gsd-complete-milestone`

マイルストーンをアーカイブし、リリースにタグを付けます。

**前提条件:** マイルストーン監査が完了していること（推奨）
**生成物:** `MILESTONES.md` エントリ、git タグ

```bash
/gsd-complete-milestone
```

---

### `/gsd-milestone-summary`

チームのオンボーディングとレビューのためにマイルストーンアーティファクトから包括的なプロジェクトサマリーを生成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `version` | No | マイルストーンバージョン（デフォルト: 現在の/最新のマイルストーン） |

**前提条件:** 少なくとも1つの完了済みまたは進行中のマイルストーンがあること
**生成物:** `.planning/reports/MILESTONE_SUMMARY-v{version}.md`

**サマリーの内容:**
- 概要、アーキテクチャ決定、フェーズ別の内訳
- 主要な決定とトレードオフ
- 要件カバレッジ
- 技術的負債と延期された項目
- 新しいチームメンバー向けのスタートアップガイド
- 生成後にインタラクティブな Q&A を提供

```bash
/gsd-milestone-summary                # 現在のマイルストーンのサマリー
/gsd-milestone-summary v1.0           # 特定のマイルストーンのサマリー
```

---

### `/gsd-new-milestone`

次のバージョンサイクルを開始します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `name` | No | マイルストーン名 |
| `--reset-phase-numbers` | No | 新しいマイルストーンをフェーズ1から再開し、ロードマップ作成前に古いフェーズディレクトリをアーカイブ |

**前提条件:** 以前のマイルストーンが完了していること
**生成物:** 更新された `PROJECT.md`、新しい `REQUIREMENTS.md`、新しい `ROADMAP.md`

```bash
/gsd-new-milestone                  # インタラクティブ
/gsd-new-milestone "v2.0 Mobile"    # 名前付きマイルストーン
/gsd-new-milestone --reset-phase-numbers "v2.0 Mobile"  # マイルストーン番号付けを1から再開
```

---

## フェーズ管理コマンド

### `/gsd-phase`

ROADMAP.md のフェーズの CRUD — 単一の統合コマンドでフェーズを追加、挿入、削除、または編集します。

| フラグ | 説明 |
|------|-------------|
| （なし） | 現在のマイルストーンの末尾に新しい整数フェーズを追加 |
| `--insert <N>` | 緊急作業をフェーズ N の後に小数フェーズとして挿入（例: 3.1） |
| `--remove <N>` | 将来のフェーズを削除し、後続のフェーズを番号付け直し |
| `--edit <N>` | 既存フェーズの任意のフィールドをその場で編集 |
| `--force` | 進行中または完了済みのフェーズの編集を許可（`--edit` と組み合わせて使用） |

**前提条件:** `.planning/ROADMAP.md` が存在すること
**生成物:** 更新された ROADMAP.md

```bash
/gsd-phase "Add authentication system"          # 説明付きで新しいフェーズを追加
/gsd-phase --insert 3 "Fix auth race condition" # フェーズ3と4の間に挿入 → 3.1 を作成
/gsd-phase --remove 7               # フェーズ7を削除し、8→7、9→8 などと番号付け直し
/gsd-phase --edit 5                 # フェーズ5の任意のフィールドを編集
/gsd-phase --edit 5 --force         # 進行中または完了済みの場合でもフェーズ5を編集
```

---

### `/gsd-mvp-phase`

フェーズのガイド付き MVP 計画 — ユーザーストーリーを入力するよう促し、SPIDR 分割チェックを実行し、ROADMAP.md に `**Mode:** mvp` を書き込み、次に `/gsd-plan-phase` に委任します（ロードマップフィールドを介して MVP モードを自動検出）。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | **Yes** | MVP モードに変換するフェーズ番号（整数または `2.1` のような小数） |

| フラグ | 説明 |
|------|-------------|
| `--force` | `in_progress` または `completed` のフェーズの変換を許可 |

**前提条件:** フェーズが ROADMAP.md に既に存在すること（`/gsd-new-project`、`/gsd-phase`、または `/gsd-phase --insert` で作成済み）。このコマンドは新しいフェーズを作成せず、既存のフェーズを変換します。

**動作:** 構造化されたユーザーストーリーを収集し、フォーマットを検証し、SPIDR 分割チェックを実行し、フェーズの ROADMAP.md セクションに `**Goal:**` と `**Mode:** mvp` を書き込み、次に `/gsd-plan-phase <N>` に委任します。ウォークスルーについては [MVP フェーズの計画方法](../USER-GUIDE.md#mvp-phase-planning) を参照してください。

**Walking Skeleton:** 以前のフェーズサマリーがない新規プロジェクトのフェーズ1で `--mvp`（または `mode: mvp`）が使用された場合に自動トリガーされます。プランナーは `PLAN.md` と並んで `SKELETON.md` を生成します。

**生成物:** 更新された ROADMAP.md、次に `/gsd-plan-phase` からのすべてのアーティファクト; Walking Skeleton モードが発火した場合は `SKELETON.md`。

```bash
/gsd-mvp-phase 1                    # フェーズ1の MVP 計画
/gsd-mvp-phase 2.1                  # 小数フェーズの MVP 計画
/gsd-mvp-phase 3 --force            # 進行中の場合でもフェーズ3を変換
```

---

### `/gsd-validate-phase`

Nyquist 検証ギャップを事後的に監査して埋めます。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号 |

```bash
/gsd-validate-phase 2               # フェーズ2のテストカバレッジを監査
```

---

## ナビゲーションコマンド

### `/gsd-progress`

ステータス、次のステップを表示し、次の論理的なワークフローステップに自動的に進みます。プロジェクトの状態を読み込んで適切なアクションを決定します。

| フラグ | 説明 |
|------|-------------|
| `--next` | 手動のルート選択なしに次の論理的なワークフローステップに自動的に進む |
| `--do "task description"` | 自由形式の意図を分析し、最も適切な GSD コマンドにディスパッチ |
| `--forensic` | 標準レポートの後に6チェックの整合性監査を追加（STATE 整合性、孤立したハンドオフ、延期されたスコープドリフト、メモリフラグが付いた保留中の作業、ブロッキング todo、コミットされていないコード） |

**自動ルーティング動作（`--next`）:**
- プロジェクトなし → `/gsd-new-project` を提案
- フェーズに議論が必要 → `/gsd-discuss-phase` を実行
- フェーズに計画が必要 → `/gsd-plan-phase` を実行
- フェーズに実行が必要 → `/gsd-execute-phase` を実行
- フェーズに検証が必要 → `/gsd-verify-work` を実行
- すべてのフェーズが完了 → `/gsd-complete-milestone` を提案

```bash
/gsd-progress                       # 「今どこにいる？次は何？」と自動ルーティング
/gsd-progress --next                # 次のステップに自動的に進む
/gsd-progress --do "fix the auth bug"  # 自由形式の意図を最適な GSD コマンドにディスパッチ
/gsd-progress --forensic            # 標準レポート + 整合性監査
```

### `/gsd-resume-work`

最後のセッションからフルコンテキストを復元します。

```bash
/gsd-resume-work                    # コンテキストリセットまたは新しいセッションの後
```

### `/gsd-pause-work`

フェーズの途中で停止するときにコンテキストのハンドオフを保存します。

| フラグ | 説明 |
|------|-------------|
| `--report` | コミット、ファイル変更、フェーズ進捗をキャプチャするセッション後のサマリーを `.planning/reports/` に生成 |

```bash
/gsd-pause-work                     # continue-here.md を作成
/gsd-pause-work --report            # continue-here.md + セッションレポートを作成
```

### `/gsd-manager`

1つのターミナルから複数のフェーズを管理するためのインタラクティブなコマンドセンター。

**前提条件:** `.planning/ROADMAP.md` が存在すること
**動作:**
- 視覚的なステータスインジケーター付きのすべてのフェーズのダッシュボード
- 依存関係と進捗に基づいて最適な次のアクションを推奨
- 作業をディスパッチ: discuss はインラインで実行、plan/execute はバックグラウンドエージェントとして実行
- 1つのターミナルから複数のフェーズで作業を並列化するパワーユーザー向けに設計
- `manager.flags` 設定によるステップごとのパススルーフラグをサポート（[設定](../CONFIGURATION.md#manager-passthrough-flags) を参照）

```bash
/gsd-manager                        # コマンドセンターダッシュボードを開く
/gsd-manager --analyze-deps         # 並列実行前に ROADMAP フェーズの依存関係を解析
```

**チェックポイントハートビート（#2410）:**

バックグラウンドの `execute-phase` 実行は、すべての波と計画の境界で `[checkpoint]` マーカーを出力します。これにより、Claude API の SSE ストリームが複数計画フェーズで `Stream idle timeout - partial response received` をトリガーするほど長くアイドル状態にならないようにします。フォーマットは次のとおりです:

```
[checkpoint] phase {N} wave {W}/{M} starting, {count} plan(s), {P}/{Q} plans done
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} complete ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} complete, {P}/{Q} plans done ({ok}/{count} ok)
```

バックグラウンドフェーズが途中で失敗した場合、トランスクリプトで `[checkpoint]` を grep すると最後に確認された境界を確認できます。マネージャーのバックグラウンド完了ハンドラーは、エージェントがエラーになったときにこれらのマーカーを使用して部分的な進捗を報告します。

**マネージャーパススルーフラグ:**

`.planning/config.json` の `manager.flags` 配下でステップごとのフラグを設定します。これらのフラグは各ディスパッチコマンドに追加されます:

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--cross-ai"
    }
  }
}
```

---

### `/gsd-help`

要求したティアで GSD コマンドを表示します。デフォルトは1画面に収まります; `--full` は完全なリファレンス; `<topic>` は1つのセクションに直接ジャンプします。

```bash
/gsd-help                           # 1ページのツアー（デフォルト）
/gsd-help --brief                   # トップコマンドの ~10 行の1ライナーリフレッシャー
/gsd-help --full                    # 完全なリファレンス（すべてのコマンド、すべてのフラグ）
/gsd-help <topic>                   # 1つのセクションのみ（例: /gsd-help debug）
/gsd-help --brief <topic>           # コンパクトなスコープ付きルックアップ — シグネチャ + 1行サマリー
```

完全なエイリアステーブルについては `gsd-core/workflows/help/modes/topic.md` を参照してください。不明なトピックは認識されたリストを表示します。

---

## ユーティリティコマンド

### `/gsd-explore`

ソクラテス式のアイデア発想セッション — 探索的な質問を通じてアイデアをガイドし、オプションでリサーチを起動し、出力を適切な GSD アーティファクト（メモ、todo、シード、リサーチ質問、要件、または新しいフェーズ）にルーティングします。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `topic` | No | 探索するトピック（例: `/gsd-explore authentication strategy`） |

```bash
/gsd-explore                        # オープンエンドのアイデア発想セッション
/gsd-explore authentication strategy  # 特定のトピックを探索
```

---

### `/gsd-undo`

安全な git リバート — フェーズマニフェストを使用して依存関係チェックと確認ゲートで GSD フェーズまたは計画コミットをロールバックします。

| フラグ | 必須 | 説明 |
|------|----------|-------------|
| `--last N` | （3つのうち1つが必須） | インタラクティブな選択のための最近の GSD コミットを表示 |
| `--phase NN` | （3つのうち1つが必須） | フェーズのすべてのコミットをリバート |
| `--plan NN-MM` | （3つのうち1つが必須） | 特定の計画のすべてのコミットをリバート |

**安全性:** リバートする前に依存するフェーズ/計画をチェック; 常に確認ゲートを表示します。

```bash
/gsd-undo --last 5                  # 最近の5つの GSD コミットから選択
/gsd-undo --phase 03                # フェーズ3のすべてのコミットをリバート
/gsd-undo --plan 03-02              # フェーズ3の計画02のコミットをリバート
```

---

### `/gsd-import`

外部計画ファイルを GSD 計画システムに取り込み、何かを書き込む前に `PROJECT.md` の決定に対して競合を検出します。

| フラグ | 必須 | 説明 |
|------|----------|--------------|
| `--from <filepath>` | Yes（または `--from-gsd2`） | インポートする外部計画ファイルへのパス |
| `--from-gsd2` | Yes（または `--from`） | GSD-2（`.gsd/`）プロジェクトを GSD v1（`.planning/`）フォーマットに逆移行 |
| `--path <dir>` | No | `--from-gsd2` と組み合わせて使用: GSD-2 プロジェクトディレクトリへのパス（デフォルト: 現在のディレクトリ） |

**プロセス:** 競合を検出 → 解決を促す → GSD PLAN.md として書き込む → `gsd-plan-checker` で検証

```bash
/gsd-import --from /tmp/team-plan.md    # 外部計画をインポートして検証
/gsd-import --from-gsd2                # GSD-2 から v1 に移行（現在のディレクトリ）
/gsd-import --from-gsd2 --path ~/old-project  # 別のパスから移行
```

---

### `/gsd-ingest-docs`

リポジトリ内の既存の ADR、PRD、SPEC、およびドキュメントから `.planning/` セットアップをブートストラップまたはマージします。並列分類（`gsd-doc-classifier`）と優先順位ルールおよびサイクル検出による統合（`gsd-doc-synthesizer`）を実行します。3バケットの競合レポート（`INGEST-CONFLICTS.md`: 自動解決済み、競合バリアント、未解決ブロッカー）を生成し、LOCKED vs LOCKED の ADR 矛盾でハードブロックします。

| 引数 / フラグ | 必須 | 説明 |
|-----------------|----------|-------------|
| `path` | No | スキャンするターゲットディレクトリ（デフォルト: リポジトリルート） |
| `--mode new\|merge` | No | 自動検出を上書き（デフォルト: `.planning/` がなければ `new`、あれば `merge`） |
| `--manifest <file>` | No | ドキュメントごとに `{path, type, precedence?}` を列挙する YAML ファイル; ヒューリスティック分類を上書き |
| `--resolve auto` | No | 競合解決モード（v1: `auto` のみ; `interactive` は予約済み） |

**制限:** v1 は呼び出しごとに最大50ドキュメント。共有の競合検出コントラクトを `references/doc-conflict-engine.md` に抽出し、`/gsd-import` も消費します。

```bash
/gsd-ingest-docs                            # リポジトリルートをスキャン、モードを自動検出
/gsd-ingest-docs docs/                      # docs/ 配下のみを取り込む
/gsd-ingest-docs --manifest ingest.yaml     # 明示的な優先順位マニフェスト
```

---

### `/gsd-quick`

GSD の保証付きでアドホックタスクを実行します。

| フラグ | 説明 |
|------|-------------|
| `--full` | 完全な品質パイプラインを有効化 — 議論 + リサーチ + プランチェック + 検証 |
| `--validate` | プランチェック（最大2回繰り返し）+ 実行後検証のみ; 議論やリサーチなし |
| `--discuss` | 軽量な事前計画議論 |
| `--research` | 計画前にフォーカスされたリサーチャーを起動 |

細粒度のフラグは組み合わせ可能: `--discuss --research --validate` は `--full` と同等です。

| サブコマンド | 説明 |
|------------|-------------|
| `list` | ステータス付きですべてのクイックタスクを一覧表示 |
| `status <slug>` | 特定のクイックタスクのステータスを表示 |
| `resume <slug>` | スラッグで特定のクイックタスクを再開 |

```bash
/gsd-quick                          # 基本的なクイックタスク
/gsd-quick --discuss --research     # 議論 + リサーチ + 計画
/gsd-quick --validate               # プランチェック + 検証のみ
/gsd-quick --full                   # 完全な品質パイプライン
/gsd-quick list                     # すべてのクイックタスクを一覧表示
/gsd-quick status my-task-slug      # クイックタスクのステータスを表示
/gsd-quick resume my-task-slug      # クイックタスクを再開
```

### `/gsd-autonomous`

残りのすべてのフェーズを自律的に実行します。

| フラグ | 説明 |
|------|-------------|
| `--from N` | 特定のフェーズ番号から開始 |
| `--to N` | 特定のフェーズ番号を完了した後に停止 |
| `--interactive` | ユーザー入力付きのリーンコンテキスト |

```bash
/gsd-autonomous                     # 残りのすべてのフェーズを実行
/gsd-autonomous --from 3            # フェーズ3から開始
/gsd-autonomous --to 5              # フェーズ5を含めて実行
/gsd-autonomous --from 3 --to 5     # フェーズ3から5を実行
```

### `/gsd-debug`

永続的な状態を持つ体系的なデバッグ。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `description` | No | バグの説明 |

| フラグ | 説明 |
|------|-------------|
| `--diagnose` | 診断のみモード — 修正を試みずに調査 |

**サブコマンド:**
- `/gsd-debug list` — ステータス、仮説、次のアクション付きですべてのアクティブなデバッグセッションを一覧表示
- `/gsd-debug status <slug>` — エージェントを起動せずにセッションの完全なサマリーを表示（証拠数、排除数、解決策、TDD チェックポイント）
- `/gsd-debug continue <slug>` — スラッグで特定のセッションを再開（現在のフォーカスを表示してから継続エージェントを起動）
- `/gsd-debug [--diagnose] <description>` — 新しいデバッグセッションを開始（既存の動作; `--diagnose` は修正を適用せずに根本原因で停止）

**TDD モード:** `.planning/config.json` に `tdd_mode: true` がある場合、デバッグセッションでは修正を適用する前に失敗するテストを書いて検証する必要があります（red → green → done）。

```bash
/gsd-debug "Login button not responding on mobile Safari"
/gsd-debug --diagnose "Intermittent 500 errors on /api/users"
/gsd-debug list
/gsd-debug status auth-token-null
/gsd-debug continue form-submit-500
```

### `/gsd-add-tests`

完了したフェーズのテストを生成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | No | フェーズ番号 |

```bash
/gsd-add-tests 2                    # フェーズ2のテストを生成
```

### `/gsd-stats`

プロジェクト統計を表示します。

```bash
/gsd-stats                          # プロジェクトメトリクスダッシュボード
```

### `/gsd-profile-user`

8つの次元（コミュニケーションスタイル、意思決定パターン、デバッグアプローチ、UX 設定、ベンダー選択、フラストレーショントリガー、学習スタイル、説明の深さ）で Claude Code セッション分析から開発者の行動プロファイルを生成します。Claude の応答をパーソナライズするアーティファクトを生成します。

| フラグ | 説明 |
|------|-------------|
| `--questionnaire` | セッション分析の代わりにインタラクティブなアンケートを使用 |
| `--refresh` | セッションを再分析してプロファイルを再生成 |

**生成されるアーティファクト:**
- `USER-PROFILE.md` — 完全な行動プロファイル
- `CLAUDE.md` プロファイルセクション — Claude Code によって自動検出される

```bash
/gsd-profile-user                   # セッションを分析してプロファイルを構築
/gsd-profile-user --questionnaire   # インタラクティブなアンケートのフォールバック
/gsd-profile-user --refresh         # 新鮮な分析から再生成
```

### `/gsd-health`

`.planning/` ディレクトリの整合性を検証します。`--context` を使用すると、60% / 70% のしきい値に対してコンテキストウィンドウ使用率ガードを検査します（v1.40.0 で追加、[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）。

| フラグ | 説明 |
|------|-------------|
| `--repair` | 回復可能な問題を自動修正 |
| `--context` | コンテキストウィンドウ使用率を検査; 60% で警告、70% でクリティカル |

```bash
/gsd-health                         # 整合性チェック
/gsd-health --repair                # チェックと修正
/gsd-health --context               # コンテキスト使用率のトリアージ
```

### `/gsd-cleanup`

完了したマイルストーンからの累積フェーズディレクトリをアーカイブし、アップストリームが削除されたローカルブランチを削除します。

**動作:** アーカイブするフェーズディレクトリ（`.planning/phases/` から `.planning/milestones/v{X.Y}-phases/` に移動）とアップストリームが消えたローカルブランチ（`git fetch --prune` で削除）のドライランサマリーを表示します。変更を書き込む前に確認が必要です。現在チェックアウトされているブランチは削除されません。

```bash
/gsd-cleanup
```

---

## スパイキングとスケッチコマンド

### `/gsd-spike`

実装アプローチを確定する前に、2〜5つのフォーカスされた実現可能性実験を実行します。各実験は Given/When/Then のフレーミングを使用し、実行可能なコードを生成し、VALIDATED / INVALIDATED / PARTIAL の評決を返します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `idea` | No | 調査する技術的な質問またはアプローチ |
| `--quick` | No | 入力会話をスキップ; `idea` テキストを直接使用 |
| `--wrap-up` | No | 完了したスパイクの知見を再利用可能なプロジェクトローカルスキルにパッケージ化 |

**生成物:** `.planning/spikes/NNN-experiment-name/` にコード、結果、README; `.planning/spikes/MANIFEST.md`
**`--wrap-up` の生成物:** `.claude/skills/spike-findings-[project]/` スキルファイル

```bash
/gsd-spike                              # インタラクティブな入力
/gsd-spike "can we stream LLM tokens through SSE"
/gsd-spike --quick websocket-vs-polling
/gsd-spike --wrap-up                    # 知見を再利用可能なスキルにパッケージ化
```

---

### `/gsd-sketch`

実装を確定する前に使い捨ての HTML モックアップを通じてデザインの方向性を探索します。直接ブラウザで比較するためにデザイン質問ごとに2〜3つのバリアントを生成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `idea` | No | 探索する UI デザインの質問または方向性 |
| `--quick` | No | ムード入力をスキップ; `idea` テキストを直接使用 |
| `--text` | No | テキストモードのフォールバック — インタラクティブなプロンプトを番号付きリストに置き換え（Claude 以外のランタイム向け） |
| `--wrap-up` | No | 採用されたスケッチの決定を再利用可能なプロジェクトローカルスキルにパッケージ化 |

**生成物:** `.planning/sketches/NNN-descriptive-name/index.html`（2〜3つのインタラクティブなバリアント）、`README.md`、共有 `themes/default.css`; `.planning/sketches/MANIFEST.md`
**`--wrap-up` の生成物:** `.claude/skills/sketch-findings-[project]/` スキルファイル

```bash
/gsd-sketch                             # インタラクティブなムード入力
/gsd-sketch "dashboard layout"
/gsd-sketch --quick "sidebar navigation"
/gsd-sketch --text "onboarding flow"    # Claude 以外のランタイム
/gsd-sketch --wrap-up                   # 採用されたスケッチをスキルにパッケージ化
```

---

## 診断コマンド

### `/gsd-forensics`

失敗した GSD ワークフローのポストモーテム調査 — 何が問題だったかを診断します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `description` | No | 問題の説明（省略した場合はプロンプト） |

**前提条件:** `.planning/` ディレクトリが存在すること
**生成物:** `.planning/forensics/report-{timestamp}.md`

**調査対象:**
- Git 履歴分析（最近のコミット、スタックパターン、時間的ギャップ）
- アーティファクトの整合性（完了済みフェーズに期待されるファイル）
- STATE.md の異常とセッション履歴
- コミットされていない作業、競合、放棄された変更
- 少なくとも4種類の異常をチェック（スタックループ、欠落アーティファクト、放棄された作業、クラッシュ/中断）
- アクション可能な発見があれば GitHub Issue の作成を提案

```bash
/gsd-forensics                              # インタラクティブ — 問題のプロンプト
/gsd-forensics "Phase 3 execution stalled"  # 問題の説明付き
```

---

### `/gsd-extract-learnings`

完了したフェーズ作業から再利用可能なパターン、アンチパターン、およびアーキテクチャ上の決定を抽出します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | **Yes** | 学習を抽出するフェーズ番号 |

| フラグ | 説明 |
|------|-------------|
| `--all` | 完了したすべてのフェーズから学習を抽出 |
| `--format` | 出力フォーマット: `markdown`（デフォルト）、`json` |

**前提条件:** フェーズが実行済みであること（SUMMARY.md ファイルが存在すること）
**生成物:** `.planning/learnings/{phase}-LEARNINGS.md`

**抽出内容:**
- アーキテクチャ上の決定とその根拠
- うまくいったパターン（将来のフェーズで再利用可能）
- 遭遇したアンチパターンとその解決方法
- 技術固有の洞察
- パフォーマンスとテストの観察

```bash
/gsd-extract-learnings 3                    # フェーズ3から学習を抽出
/gsd-extract-learnings --all                # 完了したすべてのフェーズから抽出
```

---

## ワークストリーム管理

### `/gsd-workstreams`

異なるマイルストーン領域での並行作業のための並列ワークストリームを管理します。

**サブコマンド:**

| サブコマンド | 説明 |
|------------|-------------|
| `list` | ステータス付きですべてのワークストリームを一覧表示（サブコマンドなしの場合のデフォルト） |
| `create <name>` | 新しいワークストリームを作成 |
| `status <name>` | 1つのワークストリームの詳細なステータス |
| `switch <name>` | アクティブなワークストリームを設定 |
| `progress` | すべてのワークストリームの進捗サマリー |
| `complete <name>` | 完了したワークストリームをアーカイブ |
| `resume <name>` | ワークストリームの作業を再開 |

**前提条件:** アクティブな GSD プロジェクト
**生成物:** `.planning/` 配下のワークストリームディレクトリ、ワークストリームごとの状態追跡

```bash
/gsd-workstreams                    # すべてのワークストリームを一覧表示
/gsd-workstreams create backend-api # 新しいワークストリームを作成
/gsd-workstreams switch backend-api # アクティブなワークストリームを設定
/gsd-workstreams status backend-api # 詳細なステータス
/gsd-workstreams progress           # クロスワークストリームの進捗概要
/gsd-workstreams complete backend-api  # 完了したワークストリームをアーカイブ
/gsd-workstreams resume backend-api    # ワークストリームの作業を再開
```

---

## 設定コマンド

### `/gsd-settings`

ワークフローのトグルとモデルプロファイルのインタラクティブな設定。質問は6つの視覚的なセクションにグループ化されています:

- **計画** — リサーチ、プランチェッカー、パターンマッパー、Nyquist、UI フェーズ、UI ゲート、AI フェーズ
- **実行** — 検証者、TDD モード、コードレビュー、コードレビューの深さ _（条件付き — コードレビューがオンの場合のみ）_、UI レビュー
- **ドキュメントと出力** — コミットドキュメント、議論スキップ、ワークツリー
- **機能** — インテル、Graphify
- **モデルとパイプライン** — モデルプロファイル、自動進行、ブランチング
- **その他** — コンテキスト警告、リサーチ Q

すべての回答は `gsd-tools query config-set` を介して解決されたプロジェクト設定パス（標準インストールでは `.planning/config.json`、ワークストリームがアクティブな場合は `.planning/workstreams/<active>/config.json`）にマージされ、関係のないキーを保持します。確認後、ユーザーは完全な設定オブジェクトを `~/.gsd/defaults.json` に保存でき、将来の `/gsd-new-project` 実行が同じベースラインから開始されます。

```bash
/gsd-settings                       # インタラクティブな設定
```

### `/gsd-config`

単一の統合コマンドで GSD 設定をインタラクティブに設定 — ワークフロートグル、高度なノブ、インテグレーション、モデルプロファイル。

| フラグ | 説明 |
|------|-------------|
| （なし） | 一般的なトグル: model、research、plan_check、verifier、branching |
| `--advanced` | パワーユーザーノブ: 計画チューニング、タイムアウト、ブランチテンプレート、クロス AI 実行、ランタイム/出力 |
| `--integrations` | サードパーティ API キー、コードレビュー CLI ルーティング、エージェントスキルインジェクション |
| `--profile <name>` | クイックプロファイル切り替え: `quality`、`balanced`、`budget`、または `inherit` |

**`--advanced` セクション:**

| セクション | キー |
|---------|------|
| 計画チューニング | `workflow.plan_bounce`、`workflow.plan_bounce_passes`、`workflow.plan_bounce_script`、`workflow.subagent_timeout`、`workflow.inline_plan_threshold` |
| 実行チューニング | `workflow.node_repair`、`workflow.node_repair_budget`、`workflow.auto_prune_state` |
| 議論チューニング | `workflow.max_discuss_passes` |
| クロス AI 実行 | `workflow.cross_ai_execution`、`workflow.cross_ai_command`、`workflow.cross_ai_timeout` |
| Git カスタマイズ | `git.base_branch`、`git.phase_branch_template`、`git.milestone_branch_template` |
| ランタイム / 出力 | `response_language`、`context_window`、`search_gitignored`、`graphify.build_timeout` |

すべての回答は `gsd-tools query config-set` を介してマージされ、関係のないキーを保持します。API キーはすべての出力でマスクされます（`****<last-4>`）。

```bash
/gsd-config                         # 一般的なインタラクティブ設定
/gsd-config --advanced              # パワーユーザーノブ（6セクションプロンプト）
/gsd-config --integrations          # API キー、レビュー CLI ルーティング、エージェントスキル
/gsd-config --profile budget        # バジェットプロファイルに切り替え
/gsd-config --profile quality       # 品質プロファイルに切り替え
```

完全なスキーマとデフォルトについては [CONFIGURATION.md](../CONFIGURATION.md) を参照してください。

### `/gsd-surface`

再インストールなしにどのスキルを表示するかを切り替え — プロファイルを適用したり、クラスターを一覧表示または無効化したりします。

| サブコマンド | 説明 |
|------------|-------------|
| `list` | 有効および無効なクラスターとスキルを表示 |
| `status` | `list` のエイリアスにトークンコストサマリーを加えたもの |
| `profile <name>` | `baseProfile` を書き込んでスキルを再ステージング |
| `disable <cluster>` | クラスターを無効化リストに追加して再ステージング |
| `enable <cluster>` | クラスターを無効化リストから削除して再ステージング |
| `reset` | サーフェスデルタを削除; インストール時のプロファイルに戻す |

```bash
/gsd-surface list                   # 現在のサーフェスを表示
/gsd-surface profile standard       # スタンダードプロファイルに切り替え
/gsd-surface disable utility        # ユーティリティクラスターを無効化
/gsd-surface reset                  # インストール時のプロファイルを復元
```

---

## ブラウンフィールドコマンド

### `/gsd-map-codebase`

並列マッパーエージェントで既存のコードベースを分析します。クイックな単一エージェントスキャンには `--fast` を、既存のインテルを検索するには `--query` を使用します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `area` | No | マッピングを特定のエリアにスコープ |
| `--fast` | No | 高速な単一フォーカス評価 — 4つの並列エージェントの代わりに1つのマッパーエージェントを起動（軽量な代替手段） |
| `--query <term>` | No | `.planning/intel/` 内のクエリ可能なコードベースインテルファイルを検索（`intel.enabled: true` が必要） |

| フラグ | 説明 |
|------|-------------|
| `--focus tech\|arch\|quality\|concerns\|tech+arch` | `--fast` モードのフォーカスエリア（デフォルト: `tech+arch`） |

**生成物:** `.planning/codebase/` の分析ドキュメント（フルモード）; `.planning/codebase/` 内のターゲットドキュメント（`--fast`）; インテルクエリ結果（`--query`）

```bash
/gsd-map-codebase                   # 完全なコードベース分析（4つの並列エージェント）
/gsd-map-codebase auth              # 認証エリアにフォーカス
/gsd-map-codebase --fast            # クイックな tech + arch 概要（1エージェント）
/gsd-map-codebase --fast --focus quality  # 品質とコードヘルスのみ
/gsd-map-codebase --query authentication  # 認証のインテルを検索
```

### `/gsd-graphify`

`.planning/graphs/` に保存されたプロジェクトナレッジグラフを構築、クエリ、検査します。`config.json` の `graphify.enabled: true` でオプトイン（[設定リファレンス](../CONFIGURATION.md#graphify-settings) を参照）; 無効な場合、コマンドはアクティベーションヒントを表示して停止します。

| サブコマンド | 説明 |
|------------|-------------|
| `build` | ナレッジグラフを構築または再構築（`graphify update .` をインラインで実行し、`.planning/graphs/` を更新） |
| `query <term>` | グラフでキーワードを検索 |
| `status` | グラフの鮮度と統計を表示 |
| `diff` | 最後のビルド以降の変更を表示 |

**生成物:** `.planning/graphs/` のグラフアーティファクト（ノード、エッジ、スナップショット）

```bash
/gsd-graphify build                 # ナレッジグラフを構築または再構築
/gsd-graphify query authentication  # グラフで認証を検索
/gsd-graphify status                # 鮮度と統計を表示
/gsd-graphify diff                  # 最後のビルド以降の変更を表示
```

**プログラムアクセス:** `node gsd-tools.cjs graphify <build|query|status|diff|snapshot>` — [CLI ツールリファレンス](../CLI-TOOLS.md) を参照してください。

### `gsd-tools intel api-surface`

`/gsd-map-codebase` が構築した `.planning/intel/api-map.json` インデックスを `.planning/intel/` の人間が読めるフォーマットの `API-SURFACE.md` にレンダリングします。`config.json` の `intel.enabled: true` でゲート; インテルが無効な場合、コマンドはアクティベーションヒントを表示して終了します。出力パスは常に `.planning/intel/API-SURFACE.md` です — `--out` や `--format` フラグはありません。`api-map.json` が存在しないか空の場合でも、コマンドは明示的な「incomplete」バナー付きのファイルを書き込むため、コンシューマーが「何も存在しない」と勘違いすることはありません。

**生成物:** `.planning/intel/API-SURFACE.md`

```bash
node gsd-tools.cjs intel api-surface              # api-map.json → API-SURFACE.md にレンダリング
```

`API-SURFACE.md` の出力は、シグネチャと検出された可視性付きでソースファイルごとにグループ化された公開シンボル（関数、クラス、デコレーター、定数）を一覧表示します。`plan_review.source_grounding_authority` が `intel` に設定されている場合、プランドリフトガードは `api-surface` レンダラーを呼び出すのではなく、`api-map.json` を直接読み込みます。

---

## AI インテグレーションコマンド

### `/gsd-ai-integration-phase`

AI システムの構築を含むフェーズの AI-SPEC.md デザインコントラクトを生成します。インタラクティブな意思決定マトリクスを提示し、ドメイン固有の失敗モードと評価基準を表示し、フレームワークの推奨事項、実装ガイダンス、および評価戦略を含む `AI-SPEC.md` を生成します。

**生成物:** フェーズディレクトリ内の `{phase}-AI-SPEC.md`

**起動:** 3つの並列スペシャリストエージェント: domain-researcher、framework-selector、ai-researcher、および eval-planner

```bash
/gsd-ai-integration-phase              # 現在のフェーズのウィザード
/gsd-ai-integration-phase 3           # 特定のフェーズのウィザード
```

---

### `/gsd-eval-review`

実行済み AI フェーズの評価カバレッジを監査し、EVAL-REVIEW.md の改善計画を作成します。`/gsd-ai-integration-phase` が生成した `AI-SPEC.md` 評価計画に対して実装をチェックします。各評価次元を COVERED/PARTIAL/MISSING でスコアリングします。

**前提条件:** フェーズが実行済みで `AI-SPEC.md` があること
**生成物:** 発見事項、ギャップ、改善ガイダンスを含む `{phase}-EVAL-REVIEW.md`

```bash
/gsd-eval-review                       # 現在のフェーズを監査
/gsd-eval-review 3                     # 特定のフェーズを監査
```

---

## 更新コマンド

### `/gsd-update`

変更ログのプレビュー付きで GSD を更新し、オプションでスキルを同期したりローカルパッチを再適用したりします。

| フラグ | 説明 |
|------|-------------|
| `--sync` | 更新後に GSD レジストリからスキルを同期 |
| `--reapply` | 更新後にローカルの変更（パッチ）を復元 |

```bash
/gsd-update                         # 更新を確認してインストール
/gsd-update --sync                  # 更新してスキルを同期
/gsd-update --reapply               # 更新してローカルパッチを再適用
```

---

## コード品質コマンド

### `/gsd-code-review`

バグ、セキュリティの脆弱性、コード品質の問題についてフェーズ中に変更されたソースファイルをレビューします。レビュー後に発見事項を自動修正するには `--fix` を使用します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `N` | **Yes** | レビューする変更のフェーズ番号（例: `2` または `02`） |
| `--depth=quick\|standard\|deep` | No | レビューの深さレベル（`workflow.code_review_depth` 設定を上書き）。`quick`: パターンマッチングのみ（約2分）。`standard`: 言語固有のチェックを含むファイルごとの分析（約5〜15分、デフォルト）。`deep`: インポートグラフとコールチェーンを含むクロスファイル分析（約15〜30分） |
| `--files file1,file2,...` | No | 明示的なカンマ区切りのファイルリスト; SUMMARY/git スコーピングを完全にスキップ |
| `--fix` | No | レビュー後に問題を自動修正 — REVIEW.md を読み込み、修正エージェントを起動し、各修正をアトミックにコミット |
| `--fix --all` | No | 修正スコープに Info の発見事項を含める（デフォルト: Critical + Warning のみ） |
| `--fix --auto` | No | 修正 + 再レビューの繰り返しループ、最大3回の繰り返しで上限 |

**前提条件:** フェーズが実行済みで SUMMARY.md または git 履歴があること
**生成物:** 重大度分類された発見事項を含む `{phase}-REVIEW.md`; `--fix` 使用時は `{phase}-REVIEW-FIX.md`
**起動:** `gsd-code-reviewer` エージェント; `--fix` 使用時は `gsd-code-fixer` エージェント

**オプションの構造的プレパス:** `code_quality.fallow.enabled` を `true` に設定すると、エージェントレビューの前に fallow を実行します。GSD は `{phase}/FALLOW.json` を書き込み、`REVIEW.md` に `Structural Findings (fallow)` セクションを埋め込みます。`code_quality.fallow.scope` と `code_quality.fallow.profile` でスコープとプロファイルを設定します。

```bash
/gsd-code-review 3                          # フェーズ3の標準レビュー
/gsd-code-review 2 --depth=deep             # ディープなクロスファイルレビュー
/gsd-code-review 4 --files src/auth.ts,src/token.ts  # 明示的なファイルリスト
/gsd-code-review 3 --fix                    # レビューして Critical + Warning の発見事項を修正
/gsd-code-review 3 --fix --all             # レビューして Info を含むすべての発見事項を修正
/gsd-code-review 3 --fix --auto            # レビュー、修正、クリーンになるまで再レビュー（最大3回の繰り返し）
```

---

### `/gsd-audit-fix`

自律的な監査から修正へのパイプライン — 監査を実行し、発見事項を分類し、テスト検証付きで自動修正可能な問題を修正し、各修正をアトミックにコミットします。

| フラグ | 説明 |
|------|-------------|
| `--source <audit>` | 実行する監査（デフォルト: `audit-uat`） |
| `--severity high\|medium\|all` | 処理する最小重大度（デフォルト: `medium`） |
| `--max N` | 修正する最大発見事項数（デフォルト: 5） |
| `--dry-run` | 修正せずに発見事項を分類（分類テーブルを表示） |

**前提条件:** 少なくとも1つのフェーズが UAT または検証付きで実行済みであること
**生成物:** テスト検証付きの修正コミット; 分類レポート

```bash
/gsd-audit-fix                              # audit-uat を実行し、medium 以上の問題を修正（最大5件）
/gsd-audit-fix --severity high             # 高重大度の問題のみ修正
/gsd-audit-fix --dry-run                   # 修正せずに分類をプレビュー
/gsd-audit-fix --max 10 --severity all     # 任意の重大度の問題を最大10件修正
```

---

## 高速・インラインコマンド

### `/gsd-fast`

サブエージェントなし、計画のオーバーヘッドなしでインラインで些細なタスクを実行します。タイポ修正、設定変更、小さなリファクタリング、忘れたコミット向け。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `task description` | No | 何をするか（省略した場合はプロンプト） |

**`/gsd-quick` の代替ではありません** — リサーチ、マルチステップ計画、または検証が必要なものには `/gsd-quick` を使用してください。

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to gitignore"
```

---

### `/gsd-review`

外部 AI CLI からのフェーズ計画のクロス AI ピアレビュー。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `--phase N` | **Yes** | レビューするフェーズ番号 |

| フラグ | 説明 |
|------|-------------|
| `--gemini` | Gemini CLI レビューを含める |
| `--claude` | Claude CLI レビューを含める（別のセッション） |
| `--codex` | Codex CLI レビューを含める |
| `--coderabbit` | CodeRabbit レビューを含める |
| `--opencode` | OpenCode レビューを含める（GitHub Copilot 経由） |
| `--qwen` | Qwen Code レビューを含める（Alibaba Qwen モデル） |
| `--cursor` | Cursor エージェントレビューを含める |
| `--agy` / `--antigravity` | Antigravity CLI レビューを含める（Google 認証情報で無料） |
| `--ollama` | Ollama サーバーレビューを含める |
| `--lm-studio` | LM Studio サーバーレビューを含める |
| `--llama-cpp` | llama.cpp サーバーレビューを含める |
| `--all` | 利用可能なすべてのレビュアーを含める（CLI + ローカルモデルサーバー） |

**デフォルトレビュアーの動作（フラグなし）:**
- `review.default_reviewers` が**未設定**の場合、`/gsd-review` は検出されたすべてのレビュアーを実行します（現在のデフォルト動作）。
- `review.default_reviewers` が**設定済み**の場合、`/gsd-review` はそのサブセットのみを実行します（例: `["gemini","codex"]`）。
- `--all` は常に設定を上書きし、完全な検出セットを実行します。
- 明示的なフラグ（例: `--cursor`）は、そのランの `--all` と設定デフォルトの両方を上書きします。

**生成物:** `{phase}-REVIEWS.md` — `/gsd-plan-phase --reviews` が消費可能

```bash
# フラグなしの /gsd-review 実行用のプロジェクトデフォルトレビュアーを設定
gsd config-set review.default_reviewers '["gemini","codex"]'

/gsd-review --phase 2             # 設定から gemini+codex を実行
/gsd-review --phase 3 --all
/gsd-review --phase 2 --gemini
/gsd-review --phase 2 --cursor    # ワンオフの上書き
```

---

### `/gsd-pr-branch`

`.planning/` コミットをフィルタリングしてクリーンな PR ブランチを作成します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `target branch` | No | ベースブランチ（デフォルト: `main`） |

**目的:** レビュアーにはコード変更のみが表示され、GSD 計画アーティファクトは表示されません。

```bash
/gsd-pr-branch                     # main に対してフィルタリング
/gsd-pr-branch develop             # develop に対してフィルタリング
```

---

### `/gsd-secure-phase`

完了したフェーズの脅威緩和を遡及的に検証します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `phase number` | No | 監査するフェーズ（デフォルト: 最後に完了したフェーズ） |

**前提条件:** フェーズが実行済みであること。既存の SECURITY.md があってもなくても動作。
**生成物:** 脅威検証結果を含む `{phase}-SECURITY.md`
**起動:** `gsd-security-auditor` エージェント

3つの動作モード:
1. SECURITY.md が存在する — 既存の緩和策を監査して検証
2. SECURITY.md はないが PLAN.md に脅威モデルがある — アーティファクトから生成
3. フェーズが実行されていない — ガイダンスと共に終了

```bash
/gsd-secure-phase                   # 最後に完了したフェーズを監査
/gsd-secure-phase 5                 # 特定のフェーズを監査
```

---

### `/gsd-docs-update`

コードベースに対して検証されたプロジェクトドキュメントを生成または更新します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| `--force` | No | 保存プロンプトをスキップし、すべてのドキュメントを再生成 |
| `--verify-only` | No | 既存のドキュメントの正確性を確認し、生成は行わない |

**生成物:** 最大9つのドキュメントファイル（README、アーキテクチャ、API、スタートガイド、開発、テスト、設定、デプロイメント、コントリビューティング）
**起動:** `gsd-doc-writer` エージェント（ドキュメントタイプごとに1つ）、次に `gsd-doc-verifier` エージェント（事実確認）

各ドキュメントライターはコードベースを直接探索します — 幻覚されたパスや古いシグネチャはありません。ドキュメント検証者はライブファイルシステムに対してクレームを確認します。

```bash
/gsd-docs-update                    # インタラクティブにドキュメントを生成/更新
/gsd-docs-update --force            # すべてのドキュメントを再生成
/gsd-docs-update --verify-only      # 既存のドキュメントのみを検証
```

---

## タスクキャプチャとバックログコマンド

### `/gsd-capture`

アイデア、タスク、メモ、シードを適切な宛先にキャプチャします。デフォルトモードは後の作業用に構造化された todo を追加します; フラグは特化したキャプチャワークフローにルーティングします。

| フラグ | 説明 |
|------|-------------|
| （なし） | 後の作業のための構造化された todo としてキャプチャ |
| `--note [text]` | ゼロフリクションノート — 追加、一覧表示（`--note list`）、またはプロモート（`--note promote N`） |
| `--backlog <description>` | 999.x 番号付けを使用してバックログパーキングロットに追加 |
| `--seed [idea summary]` | トリガー条件付きで前向きなアイデアをキャプチャ |
| `--list` | 保留中の todo を一覧表示して作業するものを選択 |
| `--global` | グローバルスコープを使用（ノート操作に対して） |

**バックログ:** 999.x 番号付けはアクティブなフェーズシーケンスの外にアイテムを保持します; フェーズディレクトリはすぐに作成されるため、`/gsd-discuss-phase` と `/gsd-plan-phase` がそれらに対して動作します。
**シード:** 完全な WHY、WHEN（表示するタイミング）、およびパンくずを保持 — `/gsd-new-milestone` によって消費されます。

**生成物:** `.planning/todos/`（デフォルト）、ノートファイル（--note）、ROADMAP.md バックログセクション（--backlog）、`.planning/seeds/SEED-NNN-slug.md`（--seed）

```bash
/gsd-capture "Consider adding dark mode support"   # todo を追加
/gsd-capture --note "Caching strategy idea"        # クイックノート
/gsd-capture --note list                           # すべてのノートを一覧表示
/gsd-capture --note promote 3                      # ノート3を todo にプロモート
/gsd-capture --backlog "GraphQL API layer"         # バックログに追加
/gsd-capture --seed "Add real-time collaboration when WebSocket infra is in place"
/gsd-capture --list                                # todo を参照してアクション
```

---

### `/gsd-review-backlog`

バックログアイテムをレビューしてアクティブなマイルストーンにプロモートします。

**アイテムごとのアクション:** プロモート（アクティブシーケンスに移動）、保持（バックログに残す）、削除。

```bash
/gsd-review-backlog
```

---

### `/gsd-thread`

クロスセッション作業のための永続的なコンテキストスレッドを管理します。

| 引数 | 必須 | 説明 |
|----------|----------|-------------|
| （なし） / `list` | — | すべてのスレッドを一覧表示 |
| `list --open` | — | ステータスが `open` または `in_progress` のスレッドのみを一覧表示 |
| `list --resolved` | — | ステータスが `resolved` のスレッドのみを一覧表示 |
| `status <slug>` | — | 特定のスレッドのステータスを表示 |
| `close <slug>` | — | スレッドを解決済みとしてマーク |
| `name` | — | 名前で既存のスレッドを再開 |
| `description` | — | 新しいスレッドを作成 |

スレッドは、複数のセッションにまたがるが特定のフェーズに属さない作業のための軽量なクロスセッションナレッジストアです。`/gsd-pause-work` よりも軽量です。

```bash
/gsd-thread                         # すべてのスレッドを一覧表示
/gsd-thread list --open             # オープン/進行中のスレッドのみを一覧表示
/gsd-thread list --resolved         # 解決済みのスレッドのみを一覧表示
/gsd-thread status fix-deploy-key   # スレッドのステータスを表示
/gsd-thread close fix-deploy-key    # スレッドを解決済みとしてマーク
/gsd-thread fix-deploy-key-auth     # スレッドを再開
/gsd-thread "Investigate TCP timeout in pasta service"  # 新規作成
```

---

## ロードマップ管理コマンド

### `roadmap validate`

マイルストーンプレフィックスの一貫性を含む構造的整合性のために ROADMAP.md を検証します。

**前提条件:** `.planning/ROADMAP.md` が存在すること
**生成物:** 検証レポート; エラーまたは警告がある場合は非ゼロで終了

```bash
node gsd-tools.cjs roadmap validate
```

---

### `roadmap upgrade --convention milestone-prefixed`

レガシーの `Phase N` ID をマイルストーンプレフィックス付きの `Phase M-NN` 規則に移行します。

| フラグ | 必須 | 説明 |
|------|----------|-------------|
| `--convention milestone-prefixed` | Yes | 移行先のターゲット規則 |
| `--apply` | No | 変更をディスクに書き込む（デフォルト: ドライランのみ） |

**前提条件:** `.planning/ROADMAP.md` が存在すること
**生成物:** ドライラン差分（デフォルト）または ROADMAP.md のインプレース書き換え（`--apply`）

```bash
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed         # ドライラン
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed --apply  # 適用
```

---

## 状態管理コマンド

### `state validate`

STATE.md と実際のファイルシステム間のドリフトを検出します。

**前提条件:** `.planning/STATE.md` が存在すること
**生成物:** STATE.md フィールドとファイルシステムの実態の間のドリフトを示す検証レポート

```bash
node gsd-tools.cjs state validate
```

---

### `state sync [--verify]`

ディスク上の実際のプロジェクト状態から STATE.md を再構築します。

| フラグ | 説明 |
|------|-------------|
| `--verify` | ドライランモード — 書き込みなしで提案された変更を表示 |

**前提条件:** `.planning/` ディレクトリが存在すること
**生成物:** ファイルシステムの実態を反映した更新された `STATE.md`

```bash
node gsd-tools.cjs state sync             # ディスクから STATE.md を再構築
node gsd-tools.cjs state sync --verify    # ドライラン: 書き込みなしで変更を表示
```

---

### `state planned-phase`

plan-phase 完了後に状態遷移を記録します（Planned/Ready to execute）。

| フラグ | 説明 |
|------|-------------|
| `--phase N` | 計画されたフェーズ番号 |
| `--plans N` | 生成された計画の数 |

**前提条件:** フェーズが計画済みであること
**生成物:** 計画後の状態を含む更新された `STATE.md`

```bash
node gsd-tools.cjs state planned-phase --phase 3 --plans 2
```

---

## コミュニティコマンド

### コミュニティフック

`.planning/config.json` の `hooks.community: true` でゲートされたオプションの git およびセッションフック。明示的に有効にしない限りすべてノーオプです。

| フック | 目的 |
|------|---------|
| `gsd-validate-commit.sh` | git コミットメッセージに Conventional Commits フォーマットを適用 |
| `gsd-session-state.sh` | セッション状態の遷移を追跡 |
| `gsd-phase-boundary.sh` | フェーズ境界チェックを適用 |

有効にするには:
```json
{ "hooks": { "community": true } }
```

---

### コミュニティへの参加

GSD Discord コミュニティに参加するには、GSD README 内のリンクを訪問するか、`/gsd-help` を実行して表示される Discord リンクに従ってください。

---

## 貢献: スキル説明の標準

スキル説明（各 `commands/gsd/*.md` フロントマターの `description:` フィールド）は、すべてのセッションのシステムプロンプトに注入されます。セッションごとのオーバーヘッドを低く保つために、説明は ≤ 100 文字でなければならず、`argument-hint:` に既に含まれるフラグのドキュメントを複製してはなりません。

リントゲートで予算を適用します:

```bash
npm run lint:descriptions
```

このチェックは `tests/skill-frontmatter-contract.test.cjs` を介して `npm test` の一部としても実行されます。

---

## Related

- [Configuration Reference](../CONFIGURATION.md)
- [CLI Tools Reference](../CLI-TOOLS.md)
- [Feature Reference](../FEATURES.md)
- [Docs index](../README.md)
