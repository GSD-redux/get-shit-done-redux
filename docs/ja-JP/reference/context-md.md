# CONTEXT.md スキーマリファレンス

フェーズごとの `CONTEXT.md` は、`/gsd-discuss-phase` 中に収集された実装上の意思決定を格納する GSD Core のキャリアファイルです。リサーチエージェントとプランニングエージェントの両方にとって主要な上流インプットです。このページではそのスキーマを説明します。[ドキュメントインデックス](../../README.md) も参照してください。

---

## 概要

ディスカッションワークフローを経たすべてのフェーズは、以下のパスに `CONTEXT.md` を1つ生成します：

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

例: `.planning/phases/03-post-feed/03-CONTEXT.md`

このファイルは `gsd-core/workflows/discuss-phase.md` の `write_context`（または PRD / ADR インジェストのエクスプレスパス）によって生成されます。通常の運用中は手動で編集されません — discuss-phase ワークフローが書き込み、下流エージェントが封印された信頼できる情報源として読み取ります。

---

## フロントマター

`CONTEXT.md` は YAML フロントマターを持ちません。メタデータは本文の先頭にインラインで記述されます：

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

`Status` フィールドはファイル初回書き込み時に常に `Ready for planning` です。作成後は更新されません。

---

## ブロック構造

本文は名前付きの XML スタイルブロックに分割されています。ブロックは固定の順序で登場し、下流エージェントは行番号ではなくブロック名で読み取ります。

| ブロック | 用途 | 設定元 | 参照先 |
|---|---|---|---|
| `<domain>` | フェーズの境界を示します — このフェーズが何を提供し、何が明示的にスコープ外かを述べます。プランニングと実行を通じてスコープガードレールを固定します。 | `discuss-phase`（ROADMAP.md のフェーズゴールから） | `gsd-planner`、`gsd-plan-checker`（スコープ準拠） |
| `<spec_lock>` | `check_spec` ステップが `*-SPEC.md` を発見した場合のみ存在します。ロックされた要件数とスコープ境界をリストします。エージェントは完全な要件を得るために直接 `SPEC.md` を読むよう指示されます。 | `discuss-phase`（条件付き） | `gsd-planner`（要件をここで再読みせず SPEC.md を読む） |
| `<decisions>` | ディスカッションから収集された実装上の意思決定。`D-NN` 識別子でキー付け。カテゴリは固定の分類ではなく実際に議論された内容から生まれます。ユーザーが委任した領域のための `Claude's Discretion` サブセクションを含みます。 | `discuss-phase`（インタラクティブなディスカッション） | `gsd-planner`（ロックされた決定は必ず実装する）、`gsd-plan-checker`（ディメンション7準拠） |
| `<canonical_refs>` | このフェーズに関連するすべての仕様、ADR、機能ドキュメント、設計ドキュメントへの完全な相対パス。必須 — すべての CONTEXT.md にこのセクションが必要です。エージェントはプランニングまたは実装の前にリストされたファイルを読む必要があります。 | `discuss-phase`（ROADMAP.md の参照 + ディスカッション中のユーザー参照 + コードベーススカウトから集積） | `gsd-phase-researcher`、`gsd-planner` |
| `<code_context>` | `scout_codebase` ステップで発見された再利用可能なアセット、確立されたパターン、統合ポイント。エージェントを再実装ではなく既存コードに向けるためのガイダンス。 | `discuss-phase`（コードベーススカウト） | `gsd-planner`、`gsd-phase-researcher` |
| `<specifics>` | ディスカッション中に verbatim で収集された「こんな感じにしたい」という具体的な参照、製品比較、特定の例。 | `discuss-phase`（自由形式のユーザー入力） | `gsd-planner` |
| `<deferred>` | ディスカッション中に浮上したが別のフェーズに属するアイデア。失われないよう保存されます。Todos がレビューされたがスコープに含まれなかった場合は `Reviewed Todos` サブセクションを含みます。 | `discuss-phase`（スコープクリープのリダイレクト） | 自動化されたエージェントには使用されない; 人間の参照のみ |

---

## 意思決定識別子フォーマット

`<decisions>` 内のすべての意思決定は連番の `D-NN` 識別子を持ちます：

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

識別子はフェーズにスコープされます。フェーズ3の `D-01` はフェーズ7の `D-01` とは無関係です。プランチェッカー（ディメンション7）は、すべての `D-NN` が生成されたプランの少なくとも1つのタスクアクションによって対処されていることを検証します。

---

## Canonical references

`<canonical_refs>` ブロックは **必須** です。不在の場合、エージェントは CONTEXT.md が不完全であるとみなし警告を表示します。エントリはトピックごとにグループ化され、完全な相対パスとファイルが決定または定義する内容の簡単な説明を含みます：

```markdown
<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feed display
- `docs/features/social-feed.md` — Feed requirements, post card fields, engagement display rules
- `docs/decisions/adr-012-infinite-scroll.md` — Scroll strategy decision, virtualisation requirements

### Empty states
- `docs/design/empty-states.md` — Empty state patterns, illustration guidelines

</canonical_refs>
```

プロジェクトに外部仕様がない場合は、このセクションでそれを明示します：

```
No external specs — requirements fully captured in decisions above
```

`<decisions>` 内に散在する「ADR-019 を参照」などのインラインメンションは不十分です。エージェントには専用セクションに完全なパスが必要です。

---

## Decision Coverage Gate との関係

プランチェッカーの **ディメンション7: Context Compliance** はプランニング後にカバレッジゲートを強制します：

1. `<decisions>` 内のすべての `D-NN` 識別子は、少なくとも1つのプランタスクの `<action>` または根拠に登場する必要があります。
2. `<deferred>` にリストされているものをタスクが実装してはなりません（スコープクリープ）。
3. `Claude's Discretion` 領域はこのチェックから免除されます — プランナーは自由に選択できます。

意思決定がプランに反映されている CONTEXT.md は準拠とみなされます。意思決定が暗黙的に削除されたり部分的にしか実現されていない CONTEXT.md は **ディメンション7b: Scope Reduction Detection** をトリガーし、常に BLOCKER となります。

---

## SPEC.md との統合

フェーズをディスカッションする前に `/gsd-spec-phase` が実行された場合、`check_spec` ステップが `*-SPEC.md` ファイルを見つけ `<spec_lock>` を有効にします：

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

`<spec_lock>` が存在する場合、`<decisions>` にはディスカッションからの実装上の意思決定のみが含まれます — 「何を作るか」ではなく「どのように作るか」です。要件は2つのファイル間で重複しません。

---

## フッター

すべての CONTEXT.md はアイデンティティフッターで終わります：

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## Related

- [PLAN.md スキーマ](plan-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Discuss modes](../../workflow-discuss-mode.md)
- [docs index](../../README.md)
