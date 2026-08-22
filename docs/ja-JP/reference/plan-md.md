# PLAN.md スキーマリファレンス

フェーズごとの `PLAN.md` は GSD Core の実行可能な作業単位です — エグゼキューターエージェントに何を構築し、正しく構築されたことをどのように検証するかを正確に伝える構造化ドキュメントです。このページではそのスキーマを説明します。[ドキュメントインデックス](../../README.md) も参照してください。

---

## 概要

プランはフェーズディレクトリ内の以下のパスに保存されます：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

例: `.planning/phases/03-post-feed/03-02-PLAN.md`（フェーズ3、プラン2）。

プランは `gsd-planner` エージェント（`/gsd-plan-phase` によって起動）が生成し、`execute-phase` が使用します。通常、フェーズには1〜4つのプランが含まれます。フェーズ内のプランは実行ウェーブに割り当てられ、独立した作業が並行して実行されます。

---

## YAML フロントマター

すべての PLAN.md は `---` デリミタの間にある YAML フロントマターブロックで始まります。

### 注釈付きサンプル

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "/api/feed"
      via: "fetch in useEffect"
      pattern: "fetch.*api/feed"
---
```

### フロントマターフィールドリファレンス

| フィールド | 必須 | 型 | 用途 |
|---|---|---|---|
| `phase` | はい | string | フェーズ識別子。例: `03-post-feed`。 |
| `plan` | はい | string | フェーズ内のプラン番号。例: `02`。 |
| `type` | はい | `execute` または `tdd` | 標準プランは `execute`; テスト駆動プラン（実装前にテストを書く）は `tdd`。 |
| `wave` | はい | integer | 実行ウェーブ。ウェーブ1のプランは並行実行されます（依存なし）。ウェーブ2以降のプランは前のウェーブのすべてのプランが完了するまで待機します。`gsd-planner` がプランニング時に事前計算します。 |
| `depends_on` | はい | プラン ID の配列 | このプランが待機する必要があるプランの一覧。空配列 = ウェーブ1。例: `["03-01"]` はこのプランがフェーズ3のプラン01の後に実行されることを意味します。 |
| `files_modified` | はい | パスの配列 | このプランが作成または変更するすべてのファイル。プランチェッカーが同一ウェーブのファイル競合を検出するため、および execute-phase がマージ追跡のために使用します。 |
| `autonomous` | はい | boolean | すべてのタスクが `auto` タイプの場合に `true`。プランに人間の操作が必要な `checkpoint:*` タスクが含まれる場合は `false`。 |
| `requirements` | はい | ID の配列 | このプランが対処する ROADMAP.md の要件 ID。すべてのフェーズ要件 ID は少なくとも1つのプランの `requirements` フィールドに登場する必要があります。空配列は BLOCKER です。 |
| `user_setup` | いいえ | オブジェクトの配列 | Claude が自動化できない外部サービスのセットアップ手順（アカウント作成、シークレット取得、ダッシュボード設定など）。存在する場合、execute-phase は開発者向けに `USER-SETUP.md` チェックリストを生成します。 |
| `must_haves` | はい | object | ゴール逆引き型の検証基準。以下を参照。 |

---

## `must_haves` フィールド

`must_haves` はフェーズゴールを達成するために観察可能に真でなければならないことを記録します。プランニング中に導出され、実行後に `gsd-verifier` エージェントによって検証されます。

### サブフィールド

| サブフィールド | 型 | 用途 |
|---|---|---|
| `truths` | 文字列の配列 | ユーザーの視点からの観察可能な動作。それぞれが検証可能でなければなりません。例: `"User can send a message"`（`"WebSocket library installed"` は不可）。 |
| `artifacts` | オブジェクトの配列 | 実質的な実装（スタブではなく）で存在しなければならないファイル。 |
| `artifacts[].path` | string | プロジェクトルートからの相対ファイルパス。 |
| `artifacts[].provides` | string | このファイルが提供する機能。 |
| `artifacts[].min_lines` | integer（オプション） | スタブではないとみなす最小行数。 |
| `artifacts[].exports` | 文字列の配列（オプション） | 検証すべき期待される名前付きエクスポート。 |
| `artifacts[].contains` | string（オプション） | ファイルに存在しなければならない正規表現またはリテラルパターン。 |
| `key_links` | オブジェクトの配列 | アーティファクト間の重要な接続 — システムをエンドツーエンドで機能させる配線。 |
| `key_links[].from` | string | ソースファイルまたはコンポーネント。 |
| `key_links[].to` | string | ターゲットファイル、エンドポイント、またはモジュール。 |
| `key_links[].via` | string | 接続方法の説明（例: `fetch in useEffect`、`Prisma query`、`import`）。 |
| `key_links[].pattern` | string（オプション） | ソース内に接続が存在することを検証する正規表現。 |

---

## 本文構造

フロントマターの後、プラン本文はエグゼキューターエージェントが読み取る名前付き XML スタイルブロックを使用します。

### `<objective>`

プランが提供するものとプロジェクトにとっての重要性を述べます：

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

エグゼキューターが開始前に読むワークフローファイルの一覧。常に execute-plan ワークフローを含み、プランにチェックポイントタスクがある場合はチェックポイントリファレンスを追加します：

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

### `<context>`

エグゼキューターが読む必要があるソースファイルの参照。プロジェクトレベルのプランニングドキュメントと、プランが複製しなければならないパターンや型を持つすべてのソースファイルを含みます。同じフェーズの以前のプランの `SUMMARY.md` は、型や共有された意思決定への真の依存がある場合のみ含めます — 反射的には含めません：

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

1つ以上の `<task>` 要素を含みます。`type="auto"` タスクのすべてのタスク要素には `<name>`、`<files>`、`<read_first>`、`<action>`、`<verify>`、`<acceptance_criteria>`、`<done>` が必要です。

---

## タスクタイプ

| タイプ | 用途 | 自律性 |
|---|---|---|
| `auto` | エグゼキューターが独立して実行できるすべて。 | 完全自律。 |
| `checkpoint:human-verify` | 人間が実行中の UI やサービスを確認する必要があるビジュアルまたは機能的な検証。 | 実行を一時停止して開発者に提示; 承認後に再開。 |
| `checkpoint:decision` | 実行中に浮上し開発者の入力が必要な実装上の選択。 | 実行を一時停止してオプションを提示; 選択後に再開。 |
| `checkpoint:human-action` | 真に避けられない手動ステップ（アカウント作成、ハードウェア操作）。控えめに使用。 | 実行を一時停止して確認後に再開。 |

チェックポイントタスクが含まれるプランはフロントマターに `autonomous: false` を設定する必要があります。

---

## `auto` タスク構造

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### `auto` タスクの必須フィールド

| フィールド | ルール |
|---|---|
| `<files>` | タスクが作成または変更するすべてのファイル。エグゼキューターはこれらのファイルのみを書き込みます。 |
| `<read_first>` | エグゼキューターが何かに触れる前に読まなければならないファイル — 変更するファイル、信頼できる参照パターンファイル、型や規則を複製しなければならないすべてのファイル。 |
| `<action>` | 正確な識別子、ファイルパス、関数シグネチャ、期待される値を含む具体的な指示。ターゲット状態を指定せずに「X を Y に合わせる」とは言いません。フェンスされたコードブロックや完全な実装を含みません。 |
| `<verify>` | タスクが成功したことを証明する実行可能なコマンドまたはチェック。合格と不合格を区別できなければなりません — `echo "done"` は無効です。 |
| `<acceptance_criteria>` | 検証可能な条件: grep で検証可能な文字列、コマンドの終了コード、観察可能な動作。主観的な言語（「正しく見える」、「適切に設定されている」）は使用しません。 |
| `<done>` | 完了した成果の短い測定可能な説明。 |

---

## プラン品質ディメンション

`gsd-plan-checker` エージェントは実行開始前に12のディメンションにわたってすべての PLAN.md をレビューします。BLOCKER 深刻度のチェックに失敗したプランは `gsd-planner` に差し戻されます（最大3回のイテレーション）：

| ディメンション | チェック内容 |
|---|---|
| **1 — Requirement Coverage** | ROADMAP.md からのすべてのフェーズ要件 ID が少なくとも1つのプランの `requirements` フロントマターフィールドに登場し、対応するタスクがある。 |
| **2 — Task Completeness** | すべての `auto` タスクが必須フィールド（`<files>`、`<action>`、`<verify>`、`<acceptance_criteria>`、`<done>`）を持つ。曖昧なフィールドや空のフィールドがない。 |
| **3 — Dependency Correctness** | `depends_on` の参照が有効で非循環かつウェーブ番号と整合している。ウェーブ N のプランはウェーブ < N のプランのみに依存する。 |
| **4 — Key Links Planned** | `must_haves.key_links` のアーティファクトに、アーティファクトの作成だけでなく配線を実装する対応するタスクがある。 |
| **5 — Scope Sanity** | プランはコンテキスト予算内に収まる: プランあたり2〜3タスク（4 = 警告、5以上 = BLOCKER）、プランあたり8〜10ファイル以下（15以上 = BLOCKER）。 |
| **6 — Verification Derivation** | `must_haves.truths` は実装の詳細ではなくユーザー観察可能な動作。アーティファクトが truths にマッピングされる。key links が重要な配線をカバーする。 |
| **7 — Context Compliance** | CONTEXT.md のすべての `D-NN` 決定が少なくとも1つのタスクによって対処されている。`<deferred>` にあるものをタスクが実装していない。 |
| **7b — Scope Reduction Detection** | タスクアクションが、完全な決定スコープを提供せずにロックされた決定を暗黙的に「v1」、「スタブ」、または「将来の強化」に縮小していない。発見された場合は常に BLOCKER。 |
| **7c — Architectural Tier Compliance** | タスクが RESEARCH.md の Architectural Responsibility Map（存在する場合）に従って正しいティアに機能を割り当てている。誤ったティアのセキュリティ機密機能は BLOCKER。 |
| **8 — Nyquist Compliance** | `workflow.nyquist_validation` が有効で RESEARCH.md が存在する場合、すべてのタスクに `<automated>` 検証コマンドがあり、連続する3タスクのウィンドウにカバレッジがなく、VALIDATION.md が存在する。 |
| **9 — Cross-Plan Data Contracts** | プランがデータパイプラインを共有する場合、それらの変換が互換性を持つ — 別のプランが元の形式で必要とするデータをプランが削除しない。 |
| **10 — CLAUDE.md Compliance** | プランが `./CLAUDE.md` のプロジェクト固有の規則、禁止パターン、必須ツール、セキュリティ要件を遵守している。 |
| **11 — Research Resolution** | RESEARCH.md が存在する場合、プランニングを進める前にその `## Open Questions` セクションが `(RESOLVED)` とマークされている。 |
| **12 — Pattern Compliance** | PATTERNS.md が存在する場合、タスクが新規または変更される各ファイルに対して正しいアナログパターンを参照している。 |

---

## ウェーブ実行モデル

ウェーブ番号はプランニング中に事前計算されます。Execute-phase はウェーブ番号でプランをグループ化し、各ウェーブのプランを並行して実行します：

```
Wave 1: Plan 01, Plan 02, Plan 03  (すべて同時実行 — 依存なし)
Wave 2: Plan 04                    (Wave 1 完了を待機)
Wave 3: Plan 05                    (Wave 2 完了を待機)
```

同一ウェーブ内で重複するファイルを変更するプランは同じウェーブに入れてはなりません — プランチェッカーのディメンション3がこれを BLOCKER としてフラグします。

---

## プラン出力

プランが正常に実行された後、エグゼキューターは以下のパスに SUMMARY.md を書き込みます：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

SUMMARY.md は何が構築されたかの正規の記録です。同じフェーズの後続プランは、型や意思決定への真の依存がある場合にのみそれを参照できます。

---

## Related

- [CONTEXT.md スキーマ](context-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Features](../../FEATURES.md)
- [docs index](../../README.md)
