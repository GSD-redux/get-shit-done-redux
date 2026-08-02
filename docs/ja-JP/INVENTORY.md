# GSD 出荷済みサーフェスインベントリ

> 出荷済みのすべての GSD サーフェスの正式な一覧: コマンド、エージェント、ワークフロー、リファレンス、CLI モジュール、フック。広範なドキュメント（AGENTS.md、COMMANDS.md、ARCHITECTURE.md、CLI-TOOLS.md）とファイルシステムが乖離している場合は、このファイルとリポジトリツリー自体を正式なソースとして扱ってください。

## このファイルの使い方

- ここに記載された数値は v1.36.0 時点のファイルシステムから導出されており、リリース間で変動する可能性があります。最新の数値を確認するには、チェックアウトに対して `ls commands/gsd/*.md | wc -l`、`ls agents/gsd-*.md | wc -l` などを実行してください。
- このファイルは出荷済みのすべてのサーフェスを 6 つのファミリー（エージェント、コマンド、ワークフロー、リファレンス、CLI モジュール、フック）にわたって列挙します。広範なドキュメントはナラティブや厳選されたサブセットを提示する場合があります。ファイルシステムと異なる場合は、このファイルとディレクトリ一覧が正式です。
- v1.36.0 以降に追加された新しいサーフェスはまずここに記載し、その後広範なドキュメントに伝播させてください。`tests/inventory-counts.test.cjs`、`tests/commands-doc-parity.test.cjs`、`tests/agents-doc-parity.test.cjs`、`tests/cli-modules-doc-parity.test.cjs`、`tests/hooks-doc-parity.test.cjs`、`tests/architecture-counts.test.cjs`、`tests/command-count-sync.test.cjs` のドリフト管理テストが、ファイルシステムに対して数値とロスター内容を固定します。

これは出荷済みのすべての GSD Core サーフェスの正式な一覧です。トピック別のナビゲーションは [docs インデックス](README.md) を参照してください。

---

## エージェント (33 shipped)

完全な一覧は `agents/gsd-*.md` を参照してください。"Primary doc" 列は [`docs/AGENTS.md`](../AGENTS.md) が完全なロールカードを掲載している場合（*primary*）、"Advanced and Specialized Agents" セクションに短いスタブがある場合（*advanced stub*）、または掲載がない場合（*inventory only*）を示します。

| エージェント | 役割（一行） | 起動元 | Primary doc |
|--------------|-------------|--------|-------------|
| gsd-project-researcher | ロードマップ作成前にドメインエコシステムを調査（スタック、機能、アーキテクチャ、落とし穴）。 | `/gsd-new-project`, `/gsd-new-milestone` | primary |
| gsd-phase-researcher | 計画前に特定フェーズの実装アプローチを調査。 | `/gsd-plan-phase` | primary |
| gsd-ui-researcher | フロントエンドフェーズ向けの UI デザインコントラクトを作成。 | `/gsd-ui-phase` | primary |
| gsd-assumptions-analyzer | discuss-phase（仮定モード）向けに証拠に基づく仮定を作成。 | `discuss-phase-assumptions` workflow | primary |
| gsd-advisor-researcher | discuss-phase アドバイザーモード中に単一のグレーゾーン決定を調査。 | `discuss-phase` workflow (advisor mode) | primary |
| gsd-research-synthesizer | 並列調査エージェントの出力を統合した SUMMARY.md にまとめる。 | `/gsd-new-project` | primary |
| gsd-planner | タスク分解とゴール後退型検証を含む実行可能なフェーズプランを作成。 | `/gsd-plan-phase`, `/gsd-quick` | primary |
| gsd-roadmapper | フェーズ分解と要件マッピングを含むプロジェクトロードマップを作成。 | `/gsd-new-project` | primary |
| gsd-executor | アトミックコミットと逸脱処理を伴って GSD プランを実行。 | `/gsd-execute-phase`, `/gsd-quick` | primary |
| gsd-plan-checker | プランがフェーズ目標を達成できるか検証（8 つの検証ディメンション）。 | `/gsd-plan-phase` (verification loop) | primary |
| gsd-integration-checker | クロスフェーズ統合とエンドツーエンドフローを検証。 | `/gsd-audit-milestone` | primary |
| gsd-ui-checker | UI-SPEC.md デザインコントラクトを品質ディメンションに対して検証。 | `/gsd-ui-phase` (validation loop) | primary |
| gsd-verifier | ゴール後退型分析によってフェーズ目標の達成を検証。 | `/gsd-execute-phase` | primary |
| gsd-nyquist-auditor | テストを生成して Nyquist バリデーションのギャップを埋める。 | `/gsd-validate-phase` | primary |
| gsd-ui-auditor | 実装済みフロントエンドコードの 6 本柱ビジュアル監査を遡及的に実施。 | `/gsd-ui-review` | primary |
| gsd-codebase-mapper | コードベースを探索して構造化分析ドキュメントを作成。 | `/gsd-map-codebase` | primary |
| gsd-debugger | 永続的な状態を持つ科学的手法でバグを調査。 | `/gsd-debug`, `/gsd-verify-work` | primary |
| gsd-user-profiler | 8 つのディメンションで開発者の行動をスコアリング。 | `/gsd-profile-user` | primary |
| gsd-doc-writer | プロジェクトドキュメントを作成・更新。 | `/gsd-docs-update` | primary |
| gsd-doc-verifier | 生成されたドキュメントの事実に基づくクレームを検証。 | `/gsd-docs-update` | primary |
| gsd-security-auditor | PLAN.md の脅威モデルから脅威への対策を検証。 | `/gsd-secure-phase` | primary |
| gsd-pattern-mapper | 新しいファイルを最も近い既存の類似物にマッピングし、プランナー向けの PATTERNS.md を作成。 | `/gsd-plan-phase` (between research and planning) | advanced stub |
| gsd-debug-session-manager | メインコンテキストをスリムに保つために、完全な `/gsd-debug` チェックポイントと継続ループを独立したコンテキストで実行。 | `/gsd-debug` | advanced stub |
| gsd-code-reviewer | バグ、セキュリティ問題、コード品質の問題についてソースファイルをレビューし、REVIEW.md を作成。 | `/gsd-code-review` | advanced stub |
| gsd-code-fixer | アトミックな修正コミットで REVIEW.md の指摘を適用し、REVIEW-FIX.md を作成。 | `/gsd-code-review --fix` | advanced stub |
| gsd-ai-researcher | 選択した AI フレームワークの公式ドキュメントを実装準備済みのガイダンス（AI-SPEC.md §3–§4b）に調査。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-domain-researcher | AI システムのドメイン専門家による評価基準と失敗モードを浮き上がらせる（AI-SPEC.md §1b）。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-planner | AI フェーズの構造化された評価戦略を設計（AI-SPEC.md §5–§7）。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-auditor | AI フェーズの評価カバレッジを遡及監査し、EVAL-REVIEW.md（COVERED/PARTIAL/MISSING）を作成。 | `/gsd-eval-review` | advanced stub |
| gsd-framework-selector | AI/LLM フレームワークをスコアリングして推奨する 6 問以内のインタラクティブな決定マトリクス。 | `/gsd-ai-integration-phase` | advanced stub |
| gsd-intel-updater | クエリ可能なコードベースナレッジベースとして使用される構造化インテルファイル（`.planning/intel/*.json`）を作成。 | `/gsd-map-codebase --query` | advanced stub |
| gsd-doc-classifier | 単一の計画ドキュメントを ADR、PRD、SPEC、DOC、UNKNOWN に分類し、ドキュメントコーパスを並列処理するために生成。 | `/gsd-ingest-docs` | advanced stub |
| gsd-doc-synthesizer | 分類された計画ドキュメントを優先規則、サイクル検出、3 バケット競合レポートで単一の統合コンテキストに合成。 | `/gsd-ingest-docs` | advanced stub |

**カバレッジ注記。** `docs/AGENTS.md` は 21 のプライマリエージェントに完全なロールカードを、12 の上級エージェントに簡潔なスタブを提供します。同ファイルのエージェントツール権限サマリーはプライマリ 21 エージェントのみをカバーします。上級エージェントのツール一覧は `agents/gsd-*.md` の各エージェントフロントマターに記載されています。

---

## コマンド (67 shipped)

完全な一覧は `commands/gsd/*.md` を参照してください。以下のグループ分けは `docs/COMMANDS.md` のセクション順に対応しています。各行にはコマンド名、コマンドのフロントマター `description:` から導出された一行の役割、ソースファイルへのリンクが含まれます。`tests/command-count-sync.test.cjs` がこの数値をファイルシステムに対して固定します。

### 名前空間メタスキル

これら 6 つのルーターは記述子専用のエントリーで、モデルが最初に選択します。各エントリーの本体には正しい具体的なサブスキルを指すルーティングテーブルが含まれています。積極的なスキル列挙のトークンコストを低く抑えながら、完全なサーフェスに到達可能にするために存在します。根拠は [#2792](https://github.com/open-gsd/gsd-core/issues/2792) を参照してください。ルーティングテーブルは [#2790](https://github.com/open-gsd/gsd-core/issues/2790) 以降の統合サーフェスを対象とします。

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-workflow` | フェーズパイプラインルーター — discuss / plan / execute / verify / phase / progress。 | [commands/gsd/ns-workflow.md](../../commands/gsd/ns-workflow.md) |
| `/gsd-project` | プロジェクトライフサイクルルーター — マイルストーン、監査、サマリー。 | [commands/gsd/ns-project.md](../../commands/gsd/ns-project.md) |
| `/gsd-quality` | 品質ゲートルーター — コードレビュー、デバッグ、監査、セキュリティ、eval、UI。 | [commands/gsd/ns-review.md](../../commands/gsd/ns-review.md) |
| `/gsd-context` | コードベースインテリジェンスルーター — map、graphify、docs、learnings。 | [commands/gsd/ns-context.md](../../commands/gsd/ns-context.md) |
| `/gsd-manage` | 管理ルーター — config、workspace、workstreams、thread、update、ship、inbox。 | [commands/gsd/ns-manage.md](../../commands/gsd/ns-manage.md) |
| `/gsd-ideate` | 探索・キャプチャルーター — explore、sketch、spike、spec、capture。 | [commands/gsd/ns-ideate.md](../../commands/gsd/ns-ideate.md) |

### コアワークフロー

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-new-project` | 深いコンテキスト収集と PROJECT.md で新しいプロジェクトを初期化。 | [commands/gsd/new-project.md](../../commands/gsd/new-project.md) |
| `/gsd-onboard` | 既存コードベースをマッピング、ドキュメント取り込み、プロジェクト設定、onboarding summary へ案内。 | [commands/gsd/onboard.md](../../commands/gsd/onboard.md) |
| `/gsd-workspace` | GSD ワークスペースを管理 — 独立したワークスペース環境を作成（`--new`）、一覧表示（`--list`）、削除（`--remove`）。 | [commands/gsd/workspace.md](../../commands/gsd/workspace.md) |
| `/gsd-discuss-phase` | 計画前にアダプティブな質問でフェーズコンテキストを収集。 | [commands/gsd/discuss-phase.md](../../commands/gsd/discuss-phase.md) |
| `/gsd-mvp-phase` | フェーズを垂直 MVP スライスとして計画 — ユーザーストーリー、SPIDR 分割、その後 plan-phase。 | [commands/gsd/mvp-phase.md](../../commands/gsd/mvp-phase.md) |
| `/gsd-spec-phase` | 反証可能な要件を持つ SPEC.md を生成するソクラテス的仕様精緻化。 | [commands/gsd/spec-phase.md](../../commands/gsd/spec-phase.md) |
| `/gsd-ui-phase` | フロントエンドフェーズ向けの UI デザインコントラクト（UI-SPEC.md）を生成。 | [commands/gsd/ui-phase.md](../../commands/gsd/ui-phase.md) |
| `/gsd-ai-integration-phase` | フレームワーク選択、調査、eval 計画を経て AI デザインコントラクト（AI-SPEC.md）を生成。 | [commands/gsd/ai-integration-phase.md](../../commands/gsd/ai-integration-phase.md) |
| `/gsd-plan-phase` | 検証ループ付きの詳細なフェーズプラン（PLAN.md）を作成。 | [commands/gsd/plan-phase.md](../../commands/gsd/plan-phase.md) |
| `/gsd-plan-review-convergence` | クロス AI プラン収束ループ — HIGH の懸念がなくなるまでレビューフィードバックで再計画（最大 3 サイクル）。 | [commands/gsd/plan-review-convergence.md](../../commands/gsd/plan-review-convergence.md) |
| `/gsd-ultraplan-phase` | [BETA] フェーズ計画を Claude Code の ultraplan クラウドにオフロード — リモートで下書きし、ブラウザでレビューし、`/gsd-import` 経由でインポート。Claude Code のみ。 | [commands/gsd/ultraplan-phase.md](../../commands/gsd/ultraplan-phase.md) |
| `/gsd-spike` | 使い捨ての実験でアイデアを素早くスパイク。`--wrap-up` で調査結果を永続的なスキルとしてパッケージ化。 | [commands/gsd/spike.md](../../commands/gsd/spike.md) |
| `/gsd-sketch` | 使い捨ての HTML モックアップで UI/デザインアイデアを素早くスケッチ。`--wrap-up` で調査結果をパッケージ化。 | [commands/gsd/sketch.md](../../commands/gsd/sketch.md) |
| `/gsd-execute-phase` | ウェーブベースの並列化でフェーズのすべてのプランを実行。 | [commands/gsd/execute-phase.md](../../commands/gsd/execute-phase.md) |
| `/gsd-verify-work` | 自動診断付きの会話型 UAT で構築した機能を検証。 | [commands/gsd/verify-work.md](../../commands/gsd/verify-work.md) |
| `/gsd-ship` | 検証後に PR を作成し、レビューを実行してマージ準備を行う。 | [commands/gsd/ship.md](../../commands/gsd/ship.md) |
| `/gsd-fast` | サブエージェントや計画オーバーヘッドなしに些細なタスクをインラインで実行。 | [commands/gsd/fast.md](../../commands/gsd/fast.md) |
| `/gsd-quick` | GSD の保証（アトミックコミット、状態追跡）付きでクイックタスクを実行し、オプションのエージェントをスキップ。 | [commands/gsd/quick.md](../../commands/gsd/quick.md) |
| `/gsd-ui-review` | 実装済みフロントエンドコードの 6 本柱ビジュアル監査を遡及的に実施。 | [commands/gsd/ui-review.md](../../commands/gsd/ui-review.md) |
| `/gsd-code-review` | フェーズ中に変更されたソースファイルをバグ、セキュリティ、コード品質の問題についてレビュー。`--fix` で指摘を自動適用。 | [commands/gsd/code-review.md](../../commands/gsd/code-review.md) |
| `/gsd-eval-review` | 実行済み AI フェーズの評価カバレッジを遡及監査し、EVAL-REVIEW.md を作成。 | [commands/gsd/eval-review.md](../../commands/gsd/eval-review.md) |

### フェーズ & マイルストーン管理

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-phase` | フェーズの CRUD — ROADMAP.md でフェーズを追加（デフォルト）、挿入（`--insert`）、削除（`--remove`）、編集（`--edit`）。 | [commands/gsd/phase.md](../../commands/gsd/phase.md) |
| `/gsd-add-tests` | UAT 基準と実装に基づいて完了したフェーズのテストを生成。 | [commands/gsd/add-tests.md](../../commands/gsd/add-tests.md) |
| `/gsd-validate-phase` | 完了したフェーズの Nyquist バリデーションのギャップを遡及監査して埋める。 | [commands/gsd/validate-phase.md](../../commands/gsd/validate-phase.md) |
| `/gsd-secure-phase` | 完了したフェーズの脅威への対策を遡及検証。 | [commands/gsd/secure-phase.md](../../commands/gsd/secure-phase.md) |
| `/gsd-audit-milestone` | アーカイブ前に元の意図に対してマイルストーン完了を監査。 | [commands/gsd/audit-milestone.md](../../commands/gsd/audit-milestone.md) |
| `/gsd-audit-uat` | 全未解決 UAT および検証項目のクロスフェーズ監査。 | [commands/gsd/audit-uat.md](../../commands/gsd/audit-uat.md) |
| `/gsd-audit-fix` | 自律監査-修正パイプライン — 問題の発見、分類、修正、テスト、コミット。 | [commands/gsd/audit-fix.md](../../commands/gsd/audit-fix.md) |
| `/gsd-complete-milestone` | 完了したマイルストーンをアーカイブし、次のバージョンに向けて準備。 | [commands/gsd/complete-milestone.md](../../commands/gsd/complete-milestone.md) |
| `/gsd-new-milestone` | 新しいマイルストーンサイクルを開始 — PROJECT.md を更新して要件にルーティング。 | [commands/gsd/new-milestone.md](../../commands/gsd/new-milestone.md) |
| `/gsd-milestone-summary` | マイルストーンアーティファクトから包括的なプロジェクトサマリーを生成。 | [commands/gsd/milestone-summary.md](../../commands/gsd/milestone-summary.md) |
| `/gsd-cleanup` | 完了したマイルストーンから蓄積されたフェーズディレクトリをアーカイブ。 | [commands/gsd/cleanup.md](../../commands/gsd/cleanup.md) |
| `/gsd-manager` | 1 つのターミナルから複数のフェーズを管理するインタラクティブなコマンドセンター。 | [commands/gsd/manager.md](../../commands/gsd/manager.md) |
| `/gsd-workstreams` | 並列ワークストリームを管理 — list、create、switch、status、progress、complete、resume。 | [commands/gsd/workstreams.md](../../commands/gsd/workstreams.md) |
| `/gsd-autonomous` | 残りのすべてのフェーズを自律的に実行 — フェーズごとに discuss → plan → execute。 | [commands/gsd/autonomous.md](../../commands/gsd/autonomous.md) |
| `/gsd-undo` | 安全な git リバート — フェーズマニフェストを使ってフェーズまたはプランのコミットをロールバック。 | [commands/gsd/undo.md](../../commands/gsd/undo.md) |

### セッション & ナビゲーション

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-progress` | プロジェクトの進捗を確認し、コンテキストを表示して次のアクションにルーティング。`--next` で自動進行、`--do` で自由形式タスクを実行。 | [commands/gsd/progress.md](../../commands/gsd/progress.md) |
| `/gsd-capture` | アイデア、タスク、メモ、シードをキャプチャ — todo（デフォルト）、`--note`、`--backlog`、`--seed`、または `--list` で保留中の TODO を一覧表示。 | [commands/gsd/capture.md](../../commands/gsd/capture.md) |
| `/gsd-stats` | プロジェクト統計を表示 — フェーズ、プラン、要件、git メトリクス、タイムライン。 | [commands/gsd/stats.md](../../commands/gsd/stats.md) |
| `/gsd-pause-work` | フェーズ途中で作業を一時停止する際にコンテキスト引き継ぎを作成。 | [commands/gsd/pause-work.md](../../commands/gsd/pause-work.md) |
| `/gsd-resume-work` | 完全なコンテキスト復元で前のセッションから作業を再開。 | [commands/gsd/resume-work.md](../../commands/gsd/resume-work.md) |
| `/gsd-explore` | コミットする前にアイデアを考え抜くためのソクラテス的アイデア創出とアイデアルーティング。 | [commands/gsd/explore.md](../../commands/gsd/explore.md) |
| `/gsd-review-backlog` | バックログアイテムをレビューしてアクティブなマイルストーンに昇格。 | [commands/gsd/review-backlog.md](../../commands/gsd/review-backlog.md) |
| `/gsd-thread` | クロスセッション作業のための永続的なコンテキストスレッドを管理。 | [commands/gsd/thread.md](../../commands/gsd/thread.md) |

### コードベースインテリジェンス

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-map-codebase` | 並列マッパーエージェントでコードベースを分析。`--fast` で軽量スキャン、`--query` でインテルクエリ。 | [commands/gsd/map-codebase.md](../../commands/gsd/map-codebase.md) |
| `/gsd-graphify` | `.planning/graphs/` 内のプロジェクトナレッジグラフをビルド、クエリ、検査。 | [commands/gsd/graphify.md](../../commands/gsd/graphify.md) |
| `/gsd-extract-learnings` | 完了したフェーズのアーティファクトから決定事項、教訓、パターン、驚きを抽出。 | [commands/gsd/extract-learnings.md](../../commands/gsd/extract-learnings.md) |

### レビュー、デバッグ & リカバリー

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-review` | 外部 AI CLI からフェーズプランのクロス AI ピアレビューをリクエスト。 | [commands/gsd/review.md](../../commands/gsd/review.md) |
| `/gsd-debug` | コンテキストリセット全体で永続的な状態を持つ体系的なデバッグ。 | [commands/gsd/debug.md](../../commands/gsd/debug.md) |
| `/gsd-forensics` | 失敗した GSD ワークフローのポストモーテム調査 — git、アーティファクト、状態を分析。 | [commands/gsd/forensics.md](../../commands/gsd/forensics.md) |
| `/gsd-health` | 計画ディレクトリの健全性を診断し、任意で問題を修復。 | [commands/gsd/health.md](../../commands/gsd/health.md) |
| `/gsd-import` | プロジェクト決定に対する競合検出付きで外部プランをインジェスト。 | [commands/gsd/import.md](../../commands/gsd/import.md) |
| `/gsd-inbox` | プロジェクトテンプレートに対してすべてのオープンな GitHub イシューと PR をトリアージおよびレビュー。 | [commands/gsd/inbox.md](../../commands/gsd/inbox.md) |

### ドキュメント、プロファイル & ユーティリティ

| コマンド | 役割 | ソース |
|----------|------|--------|
| `/gsd-docs-update` | コードベースに対して検証されたプロジェクトドキュメントを生成または更新。 | [commands/gsd/docs-update.md](../../commands/gsd/docs-update.md) |
| `/gsd-ingest-docs` | リポジトリで混在した ADR/PRD/SPEC/DOC をスキャンし、分類・合成・競合レポートで `.planning/` セットアップをブートストラップまたはマージ。 | [commands/gsd/ingest-docs.md](../../commands/gsd/ingest-docs.md) |
| `/gsd-profile-user` | 開発者の行動プロファイルと Claude が検出可能なアーティファクトを生成。 | [commands/gsd/profile-user.md](../../commands/gsd/profile-user.md) |
| `/gsd-settings` | GSD ワークフロートグルとモデルプロファイルを設定。 | [commands/gsd/settings.md](../../commands/gsd/settings.md) |
| `/gsd-config` | GSD 設定を構成 — ワークフロートグル（デフォルト）、高度なノブ（`--advanced`）、インテグレーション（`--integrations`）、またはモデルプロファイル（`--profile`）。 | [commands/gsd/config.md](../../commands/gsd/config.md) |
| `/gsd-pr-branch` | `.planning/` コミットをフィルタリングしてクリーンな PR ブランチを作成。 | [commands/gsd/pr-branch.md](../../commands/gsd/pr-branch.md) |
| `/gsd-surface` | サーフェスに出るスキルを切り替え — 再インストールなしでプロファイルを適用、一覧表示、またはクラスターを無効化。 | [commands/gsd/surface.md](../../commands/gsd/surface.md) |
| `/gsd-update` | GSD を最新バージョンに更新。`--sync` でランタイム間でスキルを同期、`--reapply` でローカルパッチを再適用。 | [commands/gsd/update.md](../../commands/gsd/update.md) |
| `/gsd-help` | 利用可能な GSD コマンドと使い方ガイドを表示。 | [commands/gsd/help.md](../../commands/gsd/help.md) |

---

## ワークフロー (88 shipped)

完全な一覧は `gsd-core/workflows/*.md` を参照してください。ワークフローはコマンドが内部で参照する薄いオーケストレーターです。ほとんどはエンドユーザーが直接読むものではありません。以下の行は各ワークフローファイルをその役割（`<purpose>` ブロックから導出）と、該当する場合はそれを呼び出すコマンドにマッピングします。

| ワークフロー | 役割 | 呼び出し元 |
|-------------|------|-----------|
| `add-backlog.md` | 999.x 番号付けを使って ROADMAP.md にバックログアイテムを追加。 | `/gsd-capture --backlog` |
| `add-phase.md` | ロードマップの現在のマイルストーン末尾に新しい整数フェーズを追加。 | `/gsd-phase` (default) |
| `add-tests.md` | フェーズのアーティファクトに基づいて完了したフェーズのユニットテストと E2E テストを生成。 | `/gsd-add-tests` |
| `add-todo.md` | セッション中に浮上したアイデアやタスクを構造化された todo としてキャプチャ。 | `/gsd-capture` (default) |
| `ai-integration-phase.md` | フレームワーク選択 → AI 調査 → ドメイン調査 → eval 計画を AI-SPEC.md に統合してオーケストレーション。 | `/gsd-ai-integration-phase` |
| `analyze-dependencies.md` | ROADMAP.md のフェーズをファイル重複とセマンティックな依存関係について分析し、`Depends on` エッジを提案。 | `/gsd-manager --analyze-deps` |
| `audit-fix.md` | 自律監査-修正パイプライン — 監査実行、解析、分類、修正、テスト、コミット。 | `/gsd-audit-fix` |
| `audit-milestone.md` | フェーズ検証を集約してマイルストーンが完了の定義を満たしているか検証。 | `/gsd-audit-milestone` |
| `audit-uat.md` | UAT と検証ファイルのクロスフェーズ監査。優先順位付けされた未解決項目リストを作成。 | `/gsd-audit-uat` |
| `autonomous.md` | マイルストーンのフェーズを自律的に進行 — 残り全部、範囲指定、または単一フェーズ。 | `/gsd-autonomous` |
| `check-todos.md` | 保留中の TODO を一覧表示し、選択を許可してコンテキストを読み込み、適切なアクションにルーティング。 | `/gsd-capture --list` |
| `cleanup.md` | 完了したマイルストーンから蓄積されたフェーズディレクトリをアーカイブ。 | `/gsd-cleanup` |
| `code-review-fix.md` | gsd-code-fixer を使って REVIEW.md の問題を修正ごとのアトミックコミットで自動修正。 | `/gsd-code-review --fix` |
| `code-review.md` | gsd-code-reviewer でフェーズのソース変更をレビュー。REVIEW.md を作成。 | `/gsd-code-review` |
| `complete-milestone.md` | 出荷されたバージョンを完了としてマーク — MILESTONES.md エントリー、PROJECT.md の進化、タグ。 | `/gsd-complete-milestone` |
| `diagnose-issues.md` | 並列デバッグエージェントをオーケストレーションして UAT のギャップを調査し、根本原因を特定。 | `/gsd-verify-work` (auto-diagnosis) |
| `discovery-phase.md` | 適切な深さレベルでディスカバリーを実行。 | `/gsd-new-project` (discovery path) |
| `discuss-phase-assumptions.md` | 仮定モードの discuss — コードベースファーストの分析で実装決定を抽出。 | `/gsd-discuss-phase` (when `discuss_mode=assumptions`) |
| `discuss-phase-power.md` | パワーユーザー discuss — すべての質問を JSON 状態ファイル + HTML UI に事前生成。 | `/gsd-discuss-phase --power` |
| `discuss-phase.md` | 反復的なグレーゾーンの議論を通じて実装決定を抽出。 | `/gsd-discuss-phase` |
| `mvp-phase.md` | フェーズを垂直 MVP スライスとして計画 — ユーザーストーリー、SPIDR 分割、その後 plan-phase。 | `/gsd-mvp-phase` |
| `do.md` | ユーザーからの自由形式テキストを最も適合する GSD コマンドにルーティング。 | `/gsd-progress --do` |
| `docs-update.md` | 正規のおよび手書きのプロジェクトドキュメントを生成、更新、検証。 | `/gsd-docs-update` |
| `edit-phase.md` | ROADMAP.md の既存フェーズの任意フィールドを番号と位置を保ちながら編集。 | `/gsd-phase --edit` |
| `eval-review.md` | 実装済み AI フェーズの評価カバレッジの遡及監査。 | `/gsd-eval-review` |
| `execute-phase.md` | ウェーブベースの並列実行でフェーズのすべてのプランを実行。 | `/gsd-execute-phase` |
| `execute-plan.md` | フェーズプロンプト（PLAN.md）を実行して成果サマリー（SUMMARY.md）を作成。 | `execute-phase.md` (per-plan subagent) |
| `explore.md` | ソクラテス的アイデア創出 — 開発者を探索的な質問を通じてガイド。 | `/gsd-explore` |
| `debug.md` | 体系的なデバッグ — サブコマンドルーティング、セッション作成、gsd-debug-session-manager への委任。 | `/gsd-debug` |
| `extract-learnings.md` | 完了したフェーズのアーティファクトから決定事項、教訓、パターン、驚きを抽出。 | `/gsd-extract-learnings` |
| `fast.md` | サブエージェントのオーバーヘッドなしに些細なタスクをインラインで実行。 | `/gsd-fast` |
| `forensics.md` | 失敗したワークフローのフォレンジクス調査 — git、アーティファクト、状態分析。 | `/gsd-forensics` |
| `graduation.md` | フェーズ横断で繰り返し出現する LEARNINGS.md アイテムをクラスタリングして HITL 昇格候補を浮き上がらせる。 | `transition.md` (graduation_scan step) |
| `health.md` | `.planning/` ディレクトリの整合性を検証し、対処可能な問題を報告。 | `/gsd-health` |
| `help.md` | 完全な GSD Core コマンドリファレンスを表示。 | `/gsd-help` |
| `import.md` | 既存のプロジェクト決定に対する競合検出付きで外部プランをインジェスト。 | `/gsd-import` |
| `inbox.md` | プロジェクトのコントリビューションテンプレートに対してオープンな GitHub イシューと PR をトリアージ。 | `/gsd-inbox` |
| `ingest-docs.md` | リポジトリで混在した計画ドキュメントをスキャンし、分類・合成して `.planning/` に競合レポート付きでブートストラップまたはマージ。 | `/gsd-ingest-docs` |
| `insert-phase.md` | マイルストーン途中で発見された緊急作業のために小数フェーズを挿入。 | `/gsd-phase --insert` |
| `list-phase-assumptions.md` | 計画前にフェーズに関する Claude の仮定を浮き上がらせる。 | `/gsd-discuss-phase --assumptions` |
| `list-workspaces.md` | `~/gsd-workspaces/` 内のすべての GSD ワークスペースをステータスとともに一覧表示。 | `/gsd-workspace --list` |
| `manager.md` | インタラクティブなマイルストーンコマンドセンター — ダッシュボード、インライン discuss、バックグラウンド plan/execute。 | `/gsd-manager` |
| `map-codebase.md` | 並列コードベースマッパーエージェントをオーケストレーションして `.planning/codebase/` ドキュメントを作成。 | `/gsd-map-codebase` |
| `milestone-summary.md` | マイルストーンサマリー合成 — マイルストーンアーティファクトからオンボーディングとレビューアーティファクトを作成。 | `/gsd-milestone-summary` |
| `new-milestone.md` | 新しいマイルストーンサイクルを開始 — プロジェクトコンテキストを読み込み、目標を収集して PROJECT.md/STATE.md を更新。 | `/gsd-new-milestone` |
| `new-project.md` | 統合新プロジェクトフロー — 質問、調査（任意）、要件、ロードマップ。 | `/gsd-new-project` |
| `onboard.md` | Brownfield onboarding orchestration — コードベースをマップし、docs を取り込み、planning を初期化し、次のステップを要約。 | `/gsd-onboard` |
| `new-workspace.md` | リポジトリのワークツリー/クローンと独立した `.planning/` を持つ独立したワークスペースを作成。 | `/gsd-workspace --new` |
| `next.md` | 現在のプロジェクト状態を検出して次の論理的なステップに自動的に進む。 | `/gsd-progress --next` |
| `node-repair.md` | タスク検証が失敗した場合の自律修復オペレーター。`execute-plan` から呼び出し。 | `execute-plan.md` (recovery) |
| `note.md` | ゼロフリクションのアイデアキャプチャ — 1 回の Write 呼び出しと 1 行の確認。 | `/gsd-capture --note` |
| `pause-work.md` | 構造化された `.planning/HANDOFF.json` と `.continue-here.md` 引き継ぎファイルを作成。 | `/gsd-pause-work` |
| `plan-phase.md` | 統合された調査と検証ループを含む実行可能な PLAN.md ファイルを作成。 | `/gsd-plan-phase`, `/gsd-quick` |
| `plan-review-convergence.md` | クロス AI プラン収束ループ — HIGH の懸念がなくなるまでレビューフィードバックで再計画。 | `/gsd-plan-review-convergence` |
| `plant-seed.md` | 先見的なアイデアをトリガー条件付きの構造化されたシードファイルとしてキャプチャ。 | `/gsd-capture --seed` |
| `pr-branch.md` | `.planning/` コミットをフィルタリングしてプルリクエスト用のクリーンなブランチを作成。 | `/gsd-pr-branch` |
| `profile-user.md` | 完全な開発者プロファイリングフローをオーケストレーション — 同意、セッションスキャン、プロファイル生成。 | `/gsd-profile-user` |
| `progress.md` | 進捗レンダリング — プロジェクトコンテキスト、位置、次のアクションルーティング。 | `/gsd-progress` |
| `quick.md` | GSD の保証付きのクイックタスク実行（アトミックコミット、状態追跡）。 | `/gsd-quick` |
| `reapply-patches.md` | GSD 更新後にローカルの変更を再適用。 | `/gsd-update --reapply` |
| `remove-phase.md` | ロードマップから将来のフェーズを削除し、後続フェーズを振り直し。 | `/gsd-phase --remove` |
| `remove-workspace.md` | GSD ワークスペースを削除してワークツリーをクリーンアップ。 | `/gsd-workspace --remove` |
| `resume-project.md` | 作業を再開 — STATE.md、HANDOFF.json、アーティファクトから完全なコンテキストを復元。 | `/gsd-resume-work` |
| `review.md` | 外部 CLI 経由のクロス AI プランレビュー。REVIEWS.md を作成。 | `/gsd-review` |
| `scan.md` | 迅速な単一フォーカスのコードベーススキャン — map-codebase の軽量代替。 | `/gsd-map-codebase --fast` |
| `secure-phase.md` | 完了したフェーズの遡及的な脅威対策監査。 | `/gsd-secure-phase` |
| `session-report.md` | セッションレポート — トークン使用量、作業サマリー、成果。 | `/gsd-pause-work --report` |
| `settings.md` | GSD ワークフロートグルとモデルプロファイルを設定。 | `/gsd-settings`, `/gsd-config --profile` |
| `settings-advanced.md` | GSD パワーユーザーノブを設定 — プランバウンス、タイムアウト、ブランチテンプレート、クロス AI 実行、ランタイムノブ。 | `/gsd-config --advanced` |
| `settings-integrations.md` | サードパーティ API キー（Brave/Firecrawl/Exa）、`review.models.<cli>` CLI ルーティング、`agent_skills.<agent-type>` インジェクションをマスク済み（`****<last-4>`）表示で設定。 | `/gsd-config --integrations` |
| `ship.md` | 検証後に PR を作成し、レビューを実行してマージ準備を行う。 | `/gsd-ship` |
| `sketch.md` | 1 スケッチにつき 2〜3 バリアントの使い捨て HTML モックアップでデザインの方向性を探索。 | `/gsd-sketch` |
| `sketch-wrap-up.md` | スケッチの調査結果を厳選して永続的な `sketch-findings-[project]` スキルとしてパッケージ化。 | `/gsd-sketch --wrap-up` |
| `spec-phase.md` | 曖昧さスコアリング付きのソクラテス的仕様精緻化。SPEC.md を作成。 | `/gsd-spec-phase` |
| `spike.md` | 集中した使い捨ての実験によって迅速に実現可能性を検証。 | `/gsd-spike` |
| `spike-wrap-up.md` | スパイクの調査結果を厳選して永続的な `spike-findings-[project]` スキルとしてパッケージ化。 | `/gsd-spike --wrap-up` |
| `stats.md` | プロジェクト統計レンダリング — フェーズ、プラン、要件、git メトリクス。 | `/gsd-stats` |
| `sync-skills.md` | クロスランタイム GSD スキル同期 — ランタイムルート間で `gsd-*` スキルディレクトリを差分して適用。 | `/gsd-update --sync` |
| `transition.md` | フェーズ境界遷移ワークフロー — ワークストリームチェック、状態進行。 | `execute-phase.md`, `/gsd-progress --next` |
| `ui-phase.md` | gsd-ui-researcher で UI-SPEC.md デザインコントラクトを生成。 | `/gsd-ui-phase` |
| `ui-review.md` | gsd-ui-auditor による遡及的な 6 本柱ビジュアル監査。 | `/gsd-ui-review` |
| `ultraplan-phase.md` | [BETA] 計画を Claude Code の ultraplan クラウドにオフロードし、リモートで下書きして `/gsd-import` 経由でインポート。 | `/gsd-ultraplan-phase` |
| `undo.md` | 安全な git リバート — フェーズマニフェストを使ってフェーズまたはプランのコミットをロールバック。 | `/gsd-undo` |
| `thread.md` | クロスセッション作業のための永続的なコンテキストスレッドを作成、一覧表示、クローズ、または再開。 | `/gsd-thread` |
| `update.md` | 変更履歴の表示付きで GSD を最新バージョンに更新。 | `/gsd-update` |
| `validate-phase.md` | 完了したフェーズの Nyquist バリデーションのギャップを遡及監査して埋める。 | `/gsd-validate-phase` |
| `verify-phase.md` | ゴール後退型分析によってフェーズ目標の達成を検証。 | `execute-phase.md` (post-execution) |
| `verify-work.md` | 自動診断付きの会話型 UAT — UAT.md と修正プランを作成。 | `/gsd-verify-work` |

> **注記:** 一部のワークフローには直接ユーザー向けのコマンドがありません（例: `execute-plan.md`、`verify-phase.md`、`transition.md`、`node-repair.md`、`diagnose-issues.md`）— これらはオーケストレーターワークフローによって内部的に呼び出されます。`discovery-phase.md` は `/gsd-new-project` の代替エントリーポイントです。

---

## リファレンス (62 shipped)

完全な一覧は `gsd-core/references/*.md` を参照してください。リファレンスはワークフローとエージェントが `@-reference` として参照する共有ナレッジドキュメントです。以下のグループ分けは [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md#references-gsd-corereferencesmd) に対応します — コア、ワークフロー、思考モデルクラスター、モジュラープランナー分解。

### コアリファレンス

| リファレンス | 役割 |
|-------------|------|
| `checkpoints.md` | チェックポイントタイプの定義とインタラクションパターン。 |
| `gates.md` | plan-checker と verifier に組み込まれた 4 つの標準ゲートタイプ（Confirm、Quality、Safety、Transition）。 |
| `model-profiles.md` | エージェントごとのモデルティア割り当て。 |
| `model-profile-resolution.md` | モデル解決アルゴリズムのドキュメント。 |
| `verification-patterns.md` | 異なるアーティファクトタイプの検証方法。 |
| `verification-overrides.md` | アーティファクトごとの検証オーバーライドルール。 |
| `planning-config.md` | 完全な設定スキーマと動作。 |
| `git-integration.md` | git コミット、ブランチ、履歴パターン。 |
| `git-planning-commit.md` | 計画ディレクトリのコミット規約。 |
| `questioning.md` | プロジェクト初期化のためのドリーム抽出哲学。 |
| `tdd.md` | テスト駆動開発の統合パターン。 |
| `ui-brand.md` | ビジュアル出力フォーマットパターン。 |
| `common-bug-patterns.md` | コードレビューと検証のための一般的なバグパターン。 |
| `debugger-philosophy.md` | `gsd-debugger` が読み込む常緑のデバッグ規律。 |
| `mandatory-initial-read.md` | エージェントプロンプトに注入される共有の必読ボイラープレート。 |
| `project-skills-discovery.md` | エージェントプロンプトに注入される共有のプロジェクトスキル検出ボイラープレート。 |

### ワークフローリファレンス

| リファレンス | 役割 |
|-------------|------|
| `agent-contracts.md` | オーケストレーターとエージェント間の正式なインターフェース。 |
| `context-budget.md` | コンテキストウィンドウバジェット割り当てルール。 |
| `continuation-format.md` | セッション継続/再開フォーマット。 |
| `domain-probes.md` | discuss-phase 向けのドメイン固有のプロービング質問。 |
| `gate-prompts.md` | ゲート/チェックポイントのプロンプトテンプレート。 |
| `scout-codebase.md` | discuss-phase スカウトステップ向けのフェーズタイプ→コードベースマップ選択テーブル（discuss-phase/modes プログレッシブディスクロージャー分割により抽出、#717）。 |
| `revision-loop.md` | プラン修正の反復パターン。 |
| `universal-anti-patterns.md` | 検出して避けるべきユニバーサルアンチパターン。 |
| `worktree-path-safety.md` | ワークツリーガードスイート: HEAD アサーション、cwd ドリフトセンチネル（ステップ 0a、#3097）、絶対パスガード（ステップ 0b、#3099）— `<execution_context>` 経由でエグゼキュータースポーンプロンプトに読み込まれる。 |
| `artifact-types.md` | 計画アーティファクトタイプの定義。 |
| `phase-argument-parsing.md` | フェーズ引数の解析規約。 |
| `decimal-phase-calculation.md` | 小数サブフェーズの番号付けルール。 |
| `workstream-flag.md` | ワークストリームアクティブポインター規約（`--ws`）。 |
| `user-profiling.md` | ユーザー行動プロファイリングの検出ヒューリスティック。 |
| `thinking-partner.md` | 意思決定ポイントでの条件付き思考パートナー起動。 |
| `autonomous-smart-discuss.md` | 自律モード向けのスマート discuss ロジック。 |
| `ios-scaffold.md` | iOS アプリケーションスキャフォールディングパターン。 |
| `ai-evals.md` | `/gsd-ai-integration-phase` 向けの AI 評価設計リファレンス。 |
| `ai-frameworks.md` | `gsd-framework-selector` 向けの AI フレームワーク決定マトリクスリファレンス。 |
| `executor-examples.md` | gsd-executor エージェントの実例。 |
| `doc-conflict-engine.md` | ingest/import ワークフロー向けの共有競合検出コントラクト。 |
| `execute-mvp-tdd.md` | MVP+TDD での execute-phase のランタイムゲートセマンティクス — タスク前の失敗テスト検証、フェーズ末尾のブロッキングレビュー。 |
| `mvp-concepts.md` | 6 つの MVP 関連リファレンスファイルのクロスリファレンスインデックス。各ファイルの目的とどのワークフローが読み込むかをマッピング。 |
| `verify-mvp-mode.md` | MVP モードフェーズの UAT フレーミングルール — ユーザーフローファーストの順序、延期された技術チェック、ユーザーストーリーフォーマットガード。 |

### スケッチリファレンス

`/gsd-sketch` ワークフローとその wrap-up コンパニオンが使用するリファレンス。

| リファレンス | 役割 |
|-------------|------|
| `sketch-interactivity.md` | HTML スケッチをインタラクティブで生き生きとさせるためのルール。 |
| `sketch-theme-system.md` | クロススケッチの一貫性のための共有 CSS テーマ変数システム。 |
| `sketch-tooling.md` | すべてのスケッチに含まれるフローティングツールバーユーティリティ。 |
| `sketch-variant-patterns.md` | マルチバリアント HTML パターン（タブ、並排表示、オーバーレイ）。 |

### 思考モデルリファレンス

思考クラスモデル（o3、o4-mini、Gemini 2.5 Pro）を GSD ワークフローに統合するためのリファレンス。

| リファレンス | 役割 |
|-------------|------|
| `thinking-models-debug.md` | デバッグワークフロー向けの思考モデルパターン。 |
| `thinking-models-execution.md` | 実行エージェント向けの思考モデルパターン。 |
| `thinking-models-planning.md` | 計画エージェント向けの思考モデルパターン。 |
| `thinking-models-research.md` | 調査エージェント向けの思考モデルパターン。 |
| `thinking-models-verification.md` | 検証エージェント向けの思考モデルパターン。 |

### モジュラープランナー分解

`gsd-planner` エージェントは、ランタイムの文字数制限に収めるためにコアエージェントとリファレンスモジュールに分解されます。

| リファレンス | 役割 |
|-------------|------|
| `planner-antipatterns.md` | プランナーのアンチパターンと具体性の例。 |
| `planner-chunked.md` | チャンクモードの戻り形式（`## OUTLINE COMPLETE`、`## PLAN COMPLETE`）— Windows stdio ハングの緩和策。 |
| `planner-gap-closure.md` | ギャップクロージャーモードの動作（VERIFICATION.md を読み込み、ターゲットを絞った再計画）。 |
| `planner-reviews.md` | クロス AI レビュー統合（`/gsd-review` からの REVIEWS.md を読み込み）。 |
| `planner-revision.md` | 反復的な精緻化のためのプラン修正パターン。 |
| `planner-source-audit.md` | プランナーのソース監査と権威制限ルール。 |
| `planner-mvp-mode.md` | MVP モード向けの垂直スライス計画ルール。 |
| `planner-human-verify-mode.md` | `workflow.human_verify_mode = end-of-phase` のルール: `checkpoint:human-verify` タスク発行を抑制し、延期された項目を `<verify><human-check>` 経由でルーティング。 |
| `planner-graphify-auto-update.md` | `load_graph_context` が既存の鮮度アノテーションに加えて `.last-build-status.json` の自動更新状態（running / failed / stale head）をどのように表示するか。`graphify.auto_update` でオプトイン（#3347）。 |
| `planner-interface-context.md` | エグゼキューター向けのインターフェースコンテキストルール — 既存コードから主要なインターフェース/型/エクスポートを抽出する方法と、下流のプランが使用する新しいインターフェースのドキュメント化方法。 |
| `skeleton-template.md` | 新プロジェクトのウォーキングスケルトン（フェーズ 1 + `--mvp`）用に出力される SKELETON.md テンプレート。 |
| `user-story-template.md` | MVP 計画向けのユーザーストーリーフォーマット — "As a / I want to / So that" の構造化フィールド。 |
| `spidr-splitting.md` | MVP モードで大きなユーザーストーリーを処理するための SPIDR 分割ルール。 |

> **サブディレクトリ:** `gsd-core/references/few-shot-examples/` には、特定のエージェントから参照される追加のフューショット例（`plan-checker.md`、`verifier.md`）が含まれます。これらは 62 のトップレベルリファレンスにはカウントされません。

---

## CLI モジュール (81 shipped)

完全な一覧: `gsd-core/bin/lib/*.cjs`。

| モジュール | 責務 |
|-----------|------|
| `active-workstream-store.cjs` | ワークストリームソースの優先度と選択（CLI `--ws` > `GSD_WORKSTREAM` 環境変数 > 保存済みポインター）、名前のバリデーションと環境への伝播 |
| `adr-parser.cjs` | plan-phase インジェストエクスプレスパス向けの ADR 決定パーサー。セクションの同義語を正規化し、ステータス/決定/スコープフェンスを解析して、ステータス拒否ゲートを適用 |
| `agent-command-router.cjs` | `gsd-tools agent` 向けの薄い CJS サブコマンドルーターアダプター |
| `artifacts.cjs` | 標準的なアーティファクトレジストリ — 既知の `.planning/` ルートファイル名。`gsd-health` W019 リントで使用 |
| `audit.cjs` | 監査ディスパッチ、監査オープンセッション、監査ストレージヘルパー |
| `check-command-router.cjs` | `gsd-tools check` 向けの薄い CJS サブコマンドルーターアダプター |
| `cjs-command-router-adapter.cjs` | マニフェストバックの CJS コマンドファミリールーター向けの共有互換アダプター |
| `clock.cjs` | 決定論的なロックテスト向けの注入可能なクロックシーム（now/sleep） |
| `clusters.cjs` | ランタイムサーフェスモジュール向けのスキルクラスター定義（ADR-0011 フェーズ 2） |
| `code-review-flags.cjs` | `/gsd:code-review` 向けの型付きフラグパーサー。`parseCodeReviewFlags(argv)`（→ `{ fix, all, auto, depth, files }`）と `resolveCodeReviewWorkflow(flags)`（→ `'code-review.md' \| 'code-review-fix.md'`）をエクスポート。`--fix`/`--all`/`--auto` ルーティングの標準ディスパッチシーム |
| `command-aliases.cjs` | マニフェストバックのファミリールーター向けのエイリアス/サブコマンドメタデータ |
| `command-arg-projection.cjs` | コマンドファミリールーター間で共有される型付きフラグと位置引数のプロジェクションヘルパー |
| `command-routing-hub.cjs` | すべてのコマンドファミリールーターのモード決定（SDK vs CJS）、エラー分類、ノースロー契約を一元化する純粋結果ディスパッチハブ（#3788） |
| `commands.cjs` | その他の CLI コマンド（slug、タイムスタンプ、TODO、スキャフォールディング、統計） |
| `config-schema.cjs` | `VALID_CONFIG_KEYS` と動的キーパターンの単一ソース。バリデーターと config-schema-docs パリティテストの両方でインポートされる |
| `config.cjs` | `config.json` の読み書き、セクション初期化。`config-schema.cjs` からバリデーターをインポート |
| `config-types.cjs` | `model_policy` 設定ブロックの TypeScript 型定義 — `ModelPolicyConfig`、`TierEntry`、`RuntimeTiers`。発行時に `src/config-types.cts` からコンパイル（ADR-457） |
| `configuration.cjs` | 設定モジュール — 標準的な設定読み込み、レガシーキー正規化、デフォルトマージ、明示的なディスク上のマイグレーション。SDK と CJS 両方のコンシューマーの信頼できるソース |
| `context-utilization.cjs` | `gsd-health --context` 向けの純粋なクラシファイアー — （tokensUsed, contextWindow）を 60%/70% の骨折点閾値に対する `{ percent, state }` トリアージ結果に変換（#2792） |
| `core.cjs` | エラー処理、出力フォーマット、共通ユーティリティ、ランタイムフォールバック。planning-workspace ヘルパーの互換性再エクスポート |
| `decisions.cjs` | CONTEXT.md の `<decisions>` ブロックを解析。数値（D-42）と英数字（D-INFRA-01）の ID を受け付け。`{id, text, category, tags, trackable}` を返す |
| `docs.cjs` | docs-update ワークフロー初期化、Markdown スキャン、モノリポ検出 |
| `drift.cjs` | 実行後のコードベース構造ドリフト検出器（#2003）: ファイル変更を new-dir/barrel/migration/route カテゴリに分類し、`last_mapped_commit` フロントマターをラウンドトリップ |
| `fallow-runner.cjs` | `/gsd-code-review` 向けのファロー監査アダプター: バイナリ解決（`PATH` 次に `node_modules/.bin`）、アクション可能なバイナリ欠落エラー、構造的な調査結果の正規化 |
| `frontmatter.cjs` | YAML フロントマター CRUD 操作 |
| `gap-checker.cjs` | 計画後のギャップ分析（#2493）: REQUIREMENTS.md + CONTEXT.md 決定事項 vs PLAN.md カバレッジレポート（`gsd-tools gap-analysis`）の統合 |
| `graphify.cjs` | `/gsd-graphify` 向けのナレッジグラフビルド/クエリ/ステータス/差分 |
| `gsd2-import.cjs` | `/gsd-import --from-gsd2` 向けの外部プランインジェスト |
| `init-command-router.cjs` | `gsd-tools init` 向けの薄い CJS サブコマンドルーターアダプター |
| `init.cjs` | 各ワークフロータイプの複合コンテキスト読み込み |
| `install-profiles.cjs` | `--minimal` インストール向けのインストールプロファイル許可リスト + スキルステージング（#2762）。どの `gsd-*` スキル/エージェントがランタイム設定ディレクトリに配置されるかの単一ソース |
| `installer-migration-authoring.cjs` | レコードメタデータ、明示的スコープ、所有権の証拠、ランタイムコントラクト引用のインストーラーマイグレーション作成ガードレール |
| `installer-migration-report.cjs` | インストール/更新統合向けのインストーラーマイグレーションレポートプロジェクションとブロックアクションガード |
| `installer-migrations.cjs` | インストーラーマイグレーション計画、アーティファクト分類、インストール状態の永続化、ジャーナル化された適用、ロールバックヘルパー |
| `intel.cjs` | `/gsd-map-codebase --query` と `gsd-intel-updater` を支えるコードベースインテルストア |
| `learnings.cjs` | `/gsd-extract-learnings` 向けのクロスフェーズ学習抽出 |
| `milestone.cjs` | マイルストーンアーカイブ、要件マーキング |
| `model-catalog.cjs` | 共有モデルカタログ JSON の CJS アダプター。すべての CLI コンシューマーの標準ランタイムティアデフォルト、エージェントプロファイルマップ、エイリアスマップ、ルーティングメタデータをエクスポート |
| `model-profiles.cjs` | `model-catalog.cjs` から派生した後方互換プロファイルヘルパー。独自のモデルテーブルは持たない |
| `package-identity.cjs` | GSD の公開パッケージ座標（npm 名、bin 名、リポジトリスラッグ、変更履歴 URL、手動インストールコマンド）の生成された単一ソース。package.json から導出。更新ワーカー、`check-latest-version`、インストーラーが読み込む（#498） |
| `phase-command-router.cjs` | `gsd-tools phase` 向けの薄い CJS サブコマンドルーターアダプター |
| `phase-lifecycle.cjs` | フェーズライフサイクル SDK ハンドラーから抽出された純粋計算フェーズライフサイクルヘルパー |
| `phase.cjs` | フェーズディレクトリ操作、小数番号付け、プランインデックス化 |
| `phases-command-router.cjs` | `gsd-tools phases` 向けの薄い CJS サブコマンドルーターアダプター |
| `plan-scan.cjs` | フラットおよびネストされたレイアウトでプランとサマリーファイルを検出するための標準フェーズプランスキャナー（k014） |
| `planning-workspace.cjs` | 計画パス/ワークストリームシーム（`planningDir`、`planningPaths`、アクティブワークストリームルーティング、`.planning/.lock` オーケストレーション） |
| `project-root.cjs` | 4 つのヒューリスティック（独自の `.planning/` ガード、`sub_repos` 設定、`multiRepo` フラグ、`.git` ヒューリスティック）を使って開始ディレクトリからプロジェクトルートを解決 |
| `profile-output.cjs` | プロファイルレンダリング、USER-PROFILE.md と dev-preferences.md の生成 |
| `profile-pipeline.cjs` | ユーザー行動プロファイリングデータパイプライン、セッションファイルスキャン |
| `prompt-budget.cjs` | レビュープロンプト向けの純粋なトークンバジェット計算 — トークンを見積もり、決定論的なトリム優先度を適用（PROJECT.md の head 縮小、比例プラン切り捨て、コンテキスト/調査/要件の削除、ハードフェイルガード）。`review.max_prompt_tokens` 向けの構造化メタデータを返す（#3081） |
| `review-reviewer-selection.cjs` | `/gsd-review` デフォルトレビュアーポリシーと優先度向けのレビュアー選択/正規化ヘルパー |
| `roadmap-command-router.cjs` | `gsd-tools roadmap` 向けの薄い CJS サブコマンドルーターアダプター |
| `roadmap-upgrade.cjs` | レガシーの `Phase N` エントリーをマイルストーンプレフィックス付きの `Phase M-NN` 規約に変換するマイグレーションツール。`computeMigrationPlan` + `applyMigration`（デフォルトのドライランとアトミックロールバック付き） |
| `roadmap.cjs` | ROADMAP.md 解析、フェーズ抽出、プラン進捗 |
| `runtime-artifact-layout.cjs` | ランタイムアーティファクトレイアウトモジュール — サポートされている各ランタイムのアーティファクトディレクトリ形状（コマンド、エージェント、スキル）を解決。ランタイムごとのアーティファクト配置の単一ソース（#3663） |
| `runtime-name-policy.cjs` | ランタイム名正規化ポリシー — パス構築と表示に使用されるランタイム識別子の標準トークンサニタイゼーション |
| `runtime-homes.cjs` | 標準ランタイム → グローバル設定/スキルディレクトリマッピング。Hermes ネストレイアウトと Cline ルールベース除外を含む全 15 ランタイムの一流サポート（#3126） |
| `runtime-slash.cjs` | ランタイム対応スラッシュコマンドフォーマッター — ユーザー向け出力と永続化されたアーティファクトで `/gsd-<cmd>`（スキルベースのランタイム）と `$gsd-<cmd>`（codex）を出力する単一ソース（#3584） |
| `schema-detect.cjs` | ORM パターンのスキーマドリフト検出（Prisma、Drizzle、Supabase、TypeORM、Payload）。`detectSchemaFiles`、`detectSchemaOrm`、`checkSchemaDrift`、`SCHEMA_PATTERNS`、`ORM_INFO` をエクスポート |
| `secrets.cjs` | インテグレーションキー向けのシークレット設定マスキング規約（`****<last-4>`）。`SECRET_CONFIG_KEYS`、`isSecretKey`、`maskSecret`、`maskIfSecret` をエクスポート |
| `semver-compare.cjs` | 共有 semver 比較ポリシーヘルパー（`compareSemverCore`、stable-triplet バリデーション、正規化タプル解析）。更新チェックフック、statusline dev-install 検出、changeset 抽出範囲ロジックで使用（#10） |
| `security.cjs` | パストラバーサル防止、プロンプトインジェクション検出、安全な JSON/シェルヘルパー |
| `shell-command-projection.cjs` | マネージドフック直列化のためのランタイム対応シェルコマンドプロジェクション: ランタイム/プラットフォームによる PowerShell コールオペレーターの使用を決定し、Windows スクリプトパストークンを正規化 |
| `state-command-router.cjs` | `gsd-tools state` 向けの薄い CJS サブコマンドルーターアダプター |
| `state.cjs` | STATE.md 解析、更新、進行、メトリクス |
| `state-document.cjs` | 純粋な STATE.md フィールド抽出、置換、ステータス正規化、進捗計算トランスフォーム |
| `surface.cjs` | ランタイムサーフェスモジュール — インストール時プロファイルマーカーとは独立してランタイムの有効/無効サーフェス状態を管理（ADR-0011 フェーズ 2） |
| `task-command-router.cjs` | `gsd-tools task` 向けの薄い CJS サブコマンドルーターアダプター |
| `template.cjs` | 変数置換によるテンプレート選択と穴埋め |
| `uat.cjs` | UAT ファイル解析、検証負債追跡、audit-uat サポート |
| `ui-safety-gate.cjs` | シェルフリーのワード境界 UI トークン検出器（#3706、#3718）。フェーズセクションテキストを標準入力から読み込み、0（UI 発見）または 1（UI なし）で終了。GSD インストーラーが `$RUNTIME_DIR` に配布するために `gsd-core/bin/lib/` にもデプロイ（#448） |
| `update-context.cjs` | `/gsd:update` 向けの純粋なインストールコンテキストリゾルバー — ランタイム/スコープ/設定ディレクトリ/バージョン検出（LOCAL/GLOBAL/UNKNOWN）。update.md bash からポート。`gsd-tools update-context` を支える（#498） |
| `validate-command-router.cjs` | `gsd-tools validate` 向けの薄い CJS サブコマンドルーターアダプター |
| `validate.cjs` | 純粋なフェーズバリアント正規化ヘルパー（`phaseVariants`、`buildRoadmapPhaseVariants`、`buildNotStartedPhaseVariants`）。`verify.cjs` の W006/W007 チェックで使用。I/O なし、非同期なし |
| `verify-command-router.cjs` | `gsd-tools verify` 向けの薄い CJS サブコマンドルーターアダプター |
| `verify.cjs` | プラン構造、フェーズ完全性、参照、コミットバリデーション |
| `workstream-inventory-builder.cjs` | 純粋なワークストリームインベントリプロジェクションビルダー |
| `workstream-inventory.cjs` | 共有ワークストリームインベントリプロジェクション: 状態フィールド、フェーズ/プラン/サマリーカウント、ロードマップフェーズカウント、アクティブマーカー — 純粋なプロジェクションを `workstream-inventory-builder.cjs` に委任する薄いオーケストレーター |
| `workstream-name-policy.cjs` | 標準ワークストリーム名バリデーション（`isValidActiveWorkstreamName`、`hasInvalidPathSegment`、`validateWorkstreamName`）とスラッグ正規化（`toWorkstreamSlug`） |
| `workstream.cjs` | ワークストリーム CRUD、マイグレーション、セッションスコープのアクティブポインター |
| `worktree-safety.cjs` | ワークツリールート解決と非破壊的プルーンポリシー決定。W017 ヘルスチェックロジックを所有 |

[`docs/CLI-TOOLS.md`](../CLI-TOOLS.md) はこれらのモジュールのサブセットを説明している場合があります。ファイルシステムと異なる場合は、このテーブルとディレクトリ一覧が正式です。

---

## フック (14 shipped)

完全な一覧: `hooks/`。

| フック | イベント | 目的 |
|--------|---------|------|
| `gsd-statusline.js` | `statusLine` | モデル、タスク、ディレクトリ、コンテキスト使用率を表示 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 残量 35%/25% でエージェント向けコンテキスト警告を注入 |
| `gsd-check-update.js` | `SessionStart` | 新しい GSD バージョンのバックグラウンドチェック |
| `gsd-check-update-worker.js` | (worker) | check-update のバックグラウンドワーカーヘルパー |
| `gsd-update-banner.js` | `SessionStart` | GSD statusline を使用していない場合に更新の可用性を表示するオプトインバナー（PR #2795） |
| `gsd-prompt-guard.js` | `PreToolUse` | `.planning/` への書き込みのプロンプトインジェクションパターンをスキャン（アドバイザリー） |
| `gsd-workflow-guard.js` | `PreToolUse` | GSD ワークフローコンテキスト外のファイル編集を検出（アドバイザリー、オプトイン） |
| `gsd-read-guard.js` | `PreToolUse` | 未読ファイルへの Edit/Write を防ぐアドバイザリーガード |
| `gsd-read-injection-scanner.js` | `PostToolUse` | ツール Read 結果のプロンプトインジェクションパターンをスキャン（v1.36+、PR #2201） |
| `gsd-worktree-path-guard.js` | `PreToolUse` | ワークツリールート外の絶対パスを持つ Edit/Write/MultiEdit をハードブロック（PR #579、#260） |
| `gsd-write-guard.js` | `PreToolUse` | キュレーションされた `.planning/` アーティファクト（ROADMAP.md、マイルストーンロードマップ、STATE.md）を大幅に縮小するファイル全体の `Write` をハードブロック。使い捨てセンチネル `.planning/.gsd-allow-shrink`（ワークフローステップ）または `GSD_ALLOW_PLANNING_SHRINK=1`（対話時）でオーバーライド（#2255、#973 の修正 3） |
| `gsd-session-state.sh` | `PostToolUse` | シェルベースランタイム向けのセッション状態追跡 |
| `gsd-validate-commit.sh` | `PostToolUse` | Conventional Commit 適用のためのコミットバリデーション |
| `gsd-phase-boundary.sh` | `PostToolUse` | ワークフロー遷移のためのフェーズ境界検出 |
| `gsd-graphify-update.sh` | `PostToolUse` | メイン HEAD が進んだ後にナレッジグラフを自動再ビルド（オプトイン、デフォルトオフ — #3347） |

---

## メンテナンス

- 新しいコマンド、エージェント、ワークフロー、リファレンス、CLI モジュール、またはフックが出荷される際は、リリース前に対応するセクションをここで更新してください。
- `tests/` 配下のドリフトガードテスト（上記「このファイルの使い方」を参照）は、出荷されたすべてのファイルがこのインベントリに列挙されていることをアサートします。対応する行のない新しいファイルは CI で失敗します。
- ファイルシステムが `docs/ARCHITECTURE.md` の数値や厳選されたサブセットドキュメント（例: `docs/AGENTS.md` のプライマリロスター）と乖離した場合は、このファイルが正式なソースです。

## Related

- [Commands](COMMANDS.md) — ユーザー向けコマンドリファレンス
- [Architecture](ARCHITECTURE.md) — サーフェスがどのように組み合わさるか
- [docs index](README.md)
