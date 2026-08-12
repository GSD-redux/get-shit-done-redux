# STATE.md スキーマリファレンス

`STATE.md` は GSD Core のプロジェクト記憶ファイルです — プロジェクトの現在地、直近の作業内容、次に実行すべきコマンドを記録する単一の Markdown ドキュメントです。このページではそのスキーマを説明します。[ドキュメントインデックス](../../README.md) も参照してください。

---

## 概要

GSD Core で管理するプロジェクトはすべて `.planning/STATE.md` に `STATE.md` を1つ保持します。このファイルはすべてのワークフロー開始時に読み込まれ、重要なアクションのたびに書き込まれます。ファイルは以下を組み合わせた構成です：

- **YAML フロントマター** — ステータスラインフック（`parseStateMd`）および `gsd-tools state` コマンドが読み取る機械可読フィールド。
- **Markdown 本文** — 現在の進捗、蓄積されたコンテキスト、セッション継続性、パフォーマンス指標を記述する人間可読なセクション。

ファイルは意図的にコンパクトに保たれています（目標: 100行以内）。プロジェクト状態のダイジェストであり、アーカイブではありません。

---

## YAML フロントマター

フロントマターはファイルの先頭にある `---` デリミタの間に記述します。`gsd_state_version` と `status` 以外のフィールドはすべてオプションで、データが未取得の場合は省略できます。

### 注釈付きサンプル

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# フェーズライフサイクルフィールド — すべてオプション (v1.40.0, issue #2833 で追加)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# syncStateFrontmatter が書き込む追加フィールド
current_phase: "4"
current_phase_name: Observability
current_plan: "3"
last_updated: "2026-06-01T12:34:56.789Z"
state_head: 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b
last_activity: "2026-06-01"
stopped_at: "Phase 4 P3 execution complete"
paused_at: null
---
```

### フィールドリファレンス

| フィールド | 型 | 設定タイミング | 用途 |
|---|---|---|---|
| `gsd_state_version` | string (`'1.0'`) | 常時 | スキーマバージョン。`syncStateFrontmatter` が最初の `state.*` 呼び出し時に書き込む。 |
| `milestone` | string (例: `v2.0`) | マイルストーン設定時 | 現在のマイルストーンバージョン。プロジェクト設定から読み取る。 |
| `milestone_name` | string | マイルストーン設定時 | 人間可読なマイルストーンラベル (例: `Code Quality`)。 |
| `status` | string | 常時 | 現在のライフサイクルステージ。`normalizeStateStatus()` によって正規化される — [ステータス値](#ステータス値) 参照。 |
| `active_phase` | string (例: `"4.5"`) | このフェーズでオーケストレーターコマンドが実行中の場合 | 現在処理中のフェーズ番号。フェーズ間は `null` に設定。 |
| `next_action` | string | アイドル中で推奨コマンドがある場合 | 次に実行するスラッシュコマンド: `discuss-phase`、`plan-phase`、`execute-phase`、`verify-phase`。オーケストレーターが実行中または推奨なしの場合は `null` に設定。 |
| `next_phases` | YAML フロー配列 (例: `["4.5"]`) | `next_action` と対応して | `next_action` が適用されるフェーズ ID（通常1〜2件）。`next_action` と同条件で `null` に設定。 |
| `progress.total_phases` | integer | フェーズデータ取得済みの場合 | 現在のマイルストーンにおける総フェーズ数。ROADMAP.md とフェーズディレクトリから算出。 |
| `progress.completed_phases` | integer | フェーズデータ取得済みの場合 | すべてのプランサマリーがディスク上に存在するフェーズ数（すなわちすべてのプランが完了したもの）。 |
| `progress.total_plans` | integer | プランファイルが存在する場合 | 現在のマイルストーンの全フェーズにわたるプランファイルの合計数。 |
| `progress.completed_plans` | integer | サマリーファイルが存在する場合 | 完了したプランサマリーの合計数（実行済みプランごとに1つの SUMMARY.md）。 |
| `progress.percent` | integer 0–100 | 進捗データ取得済みの場合 | **フェーズ次元** でのマイルストーン進捗（`min(completed_plans/total_plans, completed_phases/total_phases)`）。このフィールドが存在するときのみステータスラインの進捗バーが描画されます — 不在の場合はバーが非表示になります。 |
| `current_phase` | string | フェーズ実行中 | 本文の `Current Phase:` フィールドから抽出したフェーズ番号。 |
| `current_phase_name` | string | フェーズに名前がある場合 | 本文の `Current Phase Name:` フィールドから抽出したフェーズ名。 |
| `current_plan` | string | プランが進行中の場合 | 本文の `Current Plan:` フィールドから抽出したプラン番号。 |
| `last_updated` | ISO-8601 タイムスタンプ | 書き込み時に常時 | 最後の `syncStateFrontmatter` 呼び出しのタイムスタンプ。`realClock.nowIso()` によって書き込まれる。 |
| `state_head` | string (40-char sha) | On write, when the project's own git repo resolves | Full commit sha STATE.md was written against (#2573). Omitted entirely outside a git repo, or when the resolved repo is not the project's own — an unverifiable stamp degrades to absent rather than asserting provenance the file does not have. Recomputed on every write and never carried forward. |
| `last_activity` | string | 本文に設定されている場合 | 本文の `Last Activity:` フィールドから抽出した最終活動日。 |
| `stopped_at` | string | 停止ポイントが記録された場合 | 最後に完了したアクションの説明。アーカイブの文章とのマッチを避けるため `## Session` 本文セクションにスコープを限定。 |
| `paused_at` | string | プロジェクトが一時停止中の場合 | 一時停止ポイントの自由形式の説明。一時停止していない場合は省略または `null`。 |

### ステータス値

`gsd-core/bin/lib/state-document.cjs` の `normalizeStateStatus()` が本文の生テキストを以下の正規値にマッピングします：

| 正規値 | マッチするテキスト（大文字小文字不問） |
|---|---|
| `discussing` | `discussing` を含む |
| `planning` | `planning` または `ready to plan` を含む |
| `executing` | `executing`、`in progress`、または `ready to execute` を含む |
| `verifying` | `verif` を含む |
| `completed` | `complete` または `done` を含む |
| `paused` | `paused` または `stopped` を含む、または `paused_at` が存在する |
| `unknown` | 上記のいずれにも該当しない |

オーケストレーターコマンドが実行中の場合、慣例（issue #2833）として `status` にライフサイクルステージを直接書き込みます：

| コマンド | 実行中の `status` |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

---

## ステータスライン描画シーン

`hooks/gsd-statusline.js` の `formatGsdState()` がパース済みフロントマターを読み取り、**最初にマッチしたシーン** を出力します。新しいライフサイクルフィールドが適用されない場合は、v1.38.x から一切変更なくオリジナルのフォーマットにフォールスルーします。

| シーン | トリガー | 表示例 |
|---|---|---|
| **1. フェーズアクティブ** | `active_phase` が設定されている | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. アイドル・次のアクション推奨** | `active_phase` が null かつ `next_action` と `next_phases` の両方が設定されている | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. マイルストーン完了** | `percent` が `100` または `completed_phases == total_phases` | `v2.0 [██████████] 100% · milestone complete` |
| **4. デフォルトフォールバック** | 上記のいずれにも該当しない | `v1.9 Code Quality · executing · ph 1/5`（既存フォーマット） |

**シーン優先度:** `active_phase` と `next_action` が両方設定されている場合、シーン1が優先されます — オーケストレーターが実行中であるため「次の推奨」は誤解を招くためです。この優先度は `formatGsdState()` のチェック順序によって強制され、`tests/gsd-statusline.test.cjs` の `"scene priority"` スイートでカバーされています。

進捗バー（`[██░░░░░░░░] 20%`）はフロントマターに `progress.percent` が存在する場合のみマイルストーンセグメントに追加されます。不在の場合はバーは表示されません。

---

## フロントマターパースの制約

ステータスラインフックは正規表現ベースのパース（完全な YAML ライブラリを使用しない）を使用するため、以下の制約が適用されます。これらは `tests/gsd-statusline.test.cjs` でテストされています。

1. **フロントマターはファイルの先頭文字から始まる必要があります。** コメントを含む何かが開始 `---` の前にあると、マッチが無効になります。開始 `---` 行は末尾のスペースなしで正確にそれだけである必要があります。

2. **ネストされたブロック内のコメントはサポートされていません。** `progress:` ブロックパーサーは次の行が `[ \t]+\w+:` であることを要求します。`progress:` と最初のキーの間に `# comment` を挿入するとマッチが壊れてバーが消えます。ドキュメントはフロントマターブロック内ではなく `STATE.md` 本文に記載してください。

3. **`next_phases` の主形式は単一行フローです。** パーサーは最初に `next_phases: ["4.5", "4.6"]` を試みます。ブロックシーケンス（`- 4.5\n- 4.6`）もパースされますが、ステータスライン描画の信頼性は低下します。正規表現ベースのパーサーを予測可能に保つため、`next_phases` には単一行フローを使用してください。多数の候補フェーズをドキュメント目的で記録する必要がある場合は `STATE.md` 本文に格納してください。

将来的に正規表現パーサーを完全な YAML ライブラリに置き換えた場合は、これらの制約を緩和しテストを更新できます。

---

## Markdown 本文セクション

本文（末尾の `---` 以降のすべて）は `gsd-core/templates/state.md` のテンプレートに従います。標準セクションは以下の通りです：

### Project Reference

`.planning/PROJECT.md` へのポインタです。以下を含みます：
- **Core value** — `PROJECT.md` の Core Value セクションの一行説明。
- **Current focus** — アクティブなフェーズ。

### Current Position

プロジェクトの現在の状況：

| フィールド | フォーマット |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | 自由テキスト。例: `Ready to execute`、`Executing Phase 4`、`Phase complete — ready for verification` |
| `Last activity:` | ハンドラー書き込み時は ISO 日付（`YYYY-MM-DD`）; エグゼキューター作成時はナラティブ文章 |
| `Progress:` | ビジュアルバー。例: `[████░░░░░░] 40%` |

このセクションの `Status:` および `Last activity:` フィールドは、既存の値が既知のテンプレートデフォルト値の場合に GSD ハンドラーによって更新されます（クヌース不変式: エグゼキューター作成値は保存されます）。既知のハンドラーデフォルト値の完全なリストは `gsd-core/bin/lib/state-document.cjs` の `KNOWN_TEMPLATE_DEFAULTS` に記載されています。

### Performance Metrics

実行速度の追跡：
- 完了した総プラン数、プランあたりの平均所要時間。
- フェーズごとの内訳テーブル（`Phase | Plans | Total | Avg/Plan`）。
- 最近のトレンド: Improving / Stable / Degrading。

各プラン完了後に更新されます。

### Accumulated Context

**Decisions** — 現在の作業に影響する最近の意思決定のサマリー（完全なログは `PROJECT.md` に保存）。`gsd-tools state add-decision` で追加。

**Pending Todos** — 件数と `.planning/todos/pending/` への参照。`/gsd-capture` で取得。

**Blockers/Concerns** — 今後の作業に影響する課題。起点フェーズのプレフィックス付き。`gsd-tools state add-blocker` で追加し、`gsd-tools state resolve-blocker` で解決。

### Session Continuity

即座のセッション再開を可能にします：
- `Last session:` — 最後のセッションの ISO-8601 タイムスタンプ。
- `Stopped at:` — 最後に完了したアクションの説明。
- `Resume file:` — `.continue-here*.md` ファイルが存在する場合はそのパス、存在しない場合は `None`。

---

## 後方互換性

フェーズライフサイクルフィールド（`active_phase`、`next_action`、`next_phases`、バー用の `progress.percent`）は **追加式でプロジェクトごとにオプトイン** です：

- ライフサイクルフィールドが一切設定されていない `STATE.md` は v1.38.x 以前と **バイト単位で同一** に描画されます。
- ライフサイクルフィールドの追加はオプトインです — フィールドが不在の場合レンダラーはグレースフルに縮退します。
- 進捗バーは `progress` ブロックが存在する場合でもオプトインです: バーをトリガーするのは `progress.percent` のみで、`total_phases` と `completed_phases` だけではトリガーされません。

`tests/gsd-statusline.test.cjs` の `formatGsdState #2833 backward compatibility` テストスイートがこの保証を固定しています。レガシー `STATE.md` 描画を壊す変更があればスイートが失敗します。

---

## Related

- [Planning artifacts](planning-artifacts.md)
- [Configuration](../../CONFIGURATION.md)
- [The phase loop](../../explanation/the-phase-loop.md)
- [docs index](../../README.md)
