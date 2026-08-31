# モデルプロファイルの設定方法

プロジェクトに適したモデルティア戦略を選び、大規模なオーバーライドブロックを書かずに個々のエージェントやフェーズタイプを調整します。このガイドは最もシンプルなレバーから始め、動的ルーティングまで段階的に説明します。

---

## 4 つのプロファイル（`adaptive` と `inherit` も含む）

`.planning/config.json` または `/gsd-config --profile <name>` で `model_profile` を設定します:

| プロファイル | プランナー | エグゼキュータ | リサーチャー | ベリファイア | 使用場面 |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | コストは二の次で本番品質の作業 |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | 通常の開発 — デフォルト |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | 高速プロトタイピング、コスト重視の環境 |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | ランタイム対応プロファイルで他のティアと同様に解決。ランタイムを頻繁に切り替える場合に使用 |
| `inherit` | （セッションモデル） | （セッションモデル） | （セッションモデル） | （セッションモデル） | Anthropic 以外のプロバイダー（OpenRouter、ローカルモデル）— すべてのエージェントが現在のセッションモデルに従う |

上の表は代表的なサブセットを示しています。出荷済みの全 33 エージェントは `gsd-core/bin/shared/model-catalog.json` にプロファイルごとの明示的なティア割り当てを持っています。完全なテーブルは設定リファレンスの [モデルプロファイル](../CONFIGURATION.md#model-profiles) を参照してください。

**コマンドによるクイック切り替え:**

```bash
/gsd-config --profile balanced   # 通常の開発
/gsd-config --profile budget     # プロトタイピングまたはコストの高いフェーズ
/gsd-config --profile quality    # 本番リリース
/gsd-config --profile inherit    # OpenRouter、ローカルモデル
```

**または `.planning/config.json` を直接編集:**

```json
{
  "model_profile": "balanced"
}
```

---

## エージェントごとのオーバーライド（`model_overrides`）

プロファイル全体を変えずに単一エージェントのティアを変更したい場合は `model_overrides` を使用します:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

有効な値: `opus`、`sonnet`、`haiku`、`inherit`、または完全修飾のモデル ID（例: `"openai/o3"`、`"google/gemini-2.5-pro"`）。

`model_overrides` はプロジェクト単位で `.planning/config.json` に、またはグローバルに `~/.gsd/defaults.json` に設定できます。競合する場合はプロジェクト単位のエントリが優先されます。競合しないグローバルエントリは保持されます。

**Codex と OpenCode に関する重要事項:** これらのランタイムはインストール時に解決済みのモデルを各エージェントの静的設定に埋め込みます。`model_overrides` を編集した後は、変更を反映させるためにインストーラーを再実行してください:

```bash
npx @opengsd/gsd-core@latest --codex --global   # または --opencode、--kilo など
```

---

## フェーズタイプごとのモデル（`models`）

33 のエージェント名をすべて覚えずに「プランニングは Opus、それ以外は Sonnet」と指定したい場合は `models` ブロックを使用します。6 つのフェーズタイプをティアエイリアスにマッピングします:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

フェーズタイプとそのエージェント:

| フェーズタイプ | 対象エージェント |
|---|---|
| `planning` | `gsd-planner`、`gsd-roadmapper`、`gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-codebase-mapper`、`gsd-ui-researcher` |
| `execution` | `gsd-executor`、`gsd-debugger`、`gsd-doc-writer` |
| `verification` | `gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-nyquist-auditor`、`gsd-ui-checker`、`gsd-ui-auditor`、`gsd-doc-verifier`、`gsd-code-reviewer` |
| `discuss` | `gsd-assumptions-analyzer` |
| `completion` | 予約済み — 現在はサブエージェントなし。スキーマの前方互換性のために受け入れられます |

`models` ブロックはティアエイリアス（`opus`、`sonnet`、`haiku`、`inherit`）のみを受け入れます。特定のエージェントに完全修飾のモデル ID を指定するには `model_overrides` を使用してください。

**`models` とエージェントごとの例外を組み合わせる:**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

`gsd-codebase-mapper` が `haiku` に固定されている*以外の*すべてのリサーチエージェントは `sonnet` に解決されます。

---

## 動的ルーティング — 安いものから始めて失敗時にエスカレート

デフォルトでは安価なティアを使い、エージェントが品質ゲートで失敗した場合のみエスカレートしたい場合は `dynamic_routing` を有効にします:

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

各エージェントはデフォルトのティア（`light`、`standard`、または `heavy`）を持っています。最初の試行では GSD が `tier_models[default_tier]` を選びます。オーケストレータがソフト失敗（検証が不確定、プランチェックがフラグを立てた、など）を検出した場合、エージェントを 1 ティア上で再起動します。`max_escalations` は合計リトライ数の上限です。

すでに `heavy` のエージェントはこれ以上エスカレートできません。

**エスカレーションを無効にして動的解決を維持する:**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

結果に関係なく、すべての試行で `tier_models[default_tier]` が使用されます — エスカレーション動作なしに明示的なティアとモデルのマッピングが必要な場合に役立ちます。

`dynamic_routing` は**デフォルトで無効**です。ブロックを省略するか `enabled: false` を設定すると静的解決が維持されます。

---

## Anthropic 以外のランタイムでの GSD 使用

Codex、OpenCode、Gemini CLI、または Kilo 向けに GSD をインストールした場合、インストーラーはすでに設定に `resolve_model_ids: "omit"` を設定しています。これにより GSD は Anthropic のモデル ID 解決をスキップし、ランタイムが独自のデフォルトモデルを選択できるようにします。基本的なケースでは手動設定は不要です。

**Codex でティアードモデルを使用したい場合:**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

GSD はランタイムのティアマップで定義された Codex ネイティブのモデルと推論エフォートに各ティアエイリアスを解決します。

**Anthropic 以外のランタイムでエージェントごとのモデル ID を使用したい場合:**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

ランタイム対応プロファイルの完全なリファレンスと `model_policy` サーフェス（v1.42 で追加されたプロバイダー中立プリセット）については [設定リファレンス — モデルプロファイル](../CONFIGURATION.md#model-profiles) を参照してください。

---

## 解決の優先順位（高いものから低いものへ）

複数のレイヤーが適用される場合、リゾルバーは最も優先度の高いエントリを選択します:

```text
1. model_overrides[<agent>]           — エージェントごと; 完全 ID; 対象を絞った例外
2. dynamic_routing.tier_models[<tier>] — 有効時; ソフト失敗でエスカレート
3. models[<phase_type>]               — 粗いフェーズレベルのティア
4. model_profile（エージェントごとの列） — グローバルティア戦略
5. ランタイムのデフォルト              — それ以外が適用されない場合
```

---

## 適切なレバーを選ぶ

| やりたいこと | 使うもの |
|---|---|
| すべてのエージェントに 1 つのティア戦略を適用する | `model_profile` |
| 粗いフェーズレベルの調整（「プランニングは Opus」） | `models.<phase_type>` |
| エージェントごとの細かい設定（「コードベースマッパーを強制的に Haiku に」） | `model_overrides[<agent>]` |
| 特定のエージェントに完全修飾のモデル ID を設定する | `model_overrides[<agent>]: "openai/gpt-5"` |
| 安価から始めて失敗時のみエスカレートする | `dynamic_routing` |
| すべてのエージェントがセッションモデルに従う（Anthropic 以外のプロバイダー） | `model_profile: "inherit"` |

---

## Related

- [設定リファレンス](../CONFIGURATION.md)
- [マルチエージェントオーケストレーション](../explanation/multi-agent-orchestration.md)
- [コマンドリファレンス](../COMMANDS.md)
- [ドキュメント索引](../README.md)
