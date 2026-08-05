# ランタイムへの GSD Core インストール方法

GSD Core（`@opengsd/gsd-core`）を普段使いの AI コーディングランタイムにインストールします。このガイドでは、サポートされている各ランタイム向けの標準インストール手順と、Node.js がない環境向けの手動手順を説明します。

**必要なもの:** Node.js 18 以上と npm（または npx）。Node.js がない場合は [Node.js なしでのインストール](#nodejs-なしでのインストール) へ進んでください。

---

## インストーラーが必要な理由

GSD Core は Claude Code のネイティブ frontmatter 形式でエージェントファイルとコマンドファイルを提供しています。サポートされている各ランタイムは、異なるスキーマ、ディレクトリ構成、コマンド呼び出し構文を要求します。インストーラーは必要な変換を実行します。たとえば OpenCode 向けのツールリストとカラー値の変換、Codex 向けの TOML エージェントエントリの書き込み、Gemini CLI 向けのすべてのコマンド本文をハイフン形式（`/gsd-update`）からコロン形式（`/gsd-update`）への書き換えなどです。

**`agents/` や `commands/` からファイルを直接コピーしないでください。** そうするとこれらの変換がスキップされ、スキーマ検証エラーやコマンドの欠落が発生します。

---

## 標準インストール

任意のディレクトリからインストーラーを実行します。ランタイムの選択と、グローバル（全プロジェクト）またはローカル（このプロジェクトのみ）のどちらでインストールするかを確認するプロンプトが表示されます。

```bash
npx @opengsd/gsd-core@latest
```

新規インストールやランタイムの切り替え後にインストーラーを再実行する場合も、このコマンド 1 つだけで完結します。

---

## ランタイム別のインストール手順

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

スキルは `~/.claude/` に配置されます。次回の Claude Code セッションからコマンドが `/gsd-*` スラッシュコマンドとして表示されます。反映するには Claude Code を再起動してください。

**インストールディレクトリの上書き:**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

スキルは `~/.gemini/` に配置されます。インストーラーはすべてのコマンド本文を Gemini のコロン名前空間（`/gsd-update`、`/gsd-config` など）に書き換えます。インストール後は Gemini CLI を再起動してください。

**インストールディレクトリの上書き:**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

スキルは `~/.config/opencode/`（XDG）または `~/.opencode/` に配置されます。インストーラーはエージェントの frontmatter を OpenCode のスキーマに変換します（`tools:` フィールドの削除、カラー値の hex 変換）。変更内容の詳細は [Node.js なしでのインストール — OpenCode の変換内容](#opencode--必要な変換) を参照してください。

**インストールディレクトリの上書き:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

スキルは `~/.config/kilo/`（XDG）または `~/.kilo/` に配置されます。OpenCode と同じフラットな Markdown コマンド形式を使用します。

**インストールディレクトリの上書き:**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

スキルは `~/.codex/skills/gsd-*/SKILL.md` に配置されます。エージェントは `config.toml` にエージェントごとの TOML エントリとして書き込まれます。インストール後は Codex を再起動（または `codex --reload` を実行）してください。

**最低サポートバージョン:** Codex CLI 0.130.0。それより古いバージョンにはスキルルートの追加スキャン処理があり、重複リストが生じることがあります。

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

スキルは `~/.copilot/` に配置されます。GSD はエージェント `.md` ファイルとリポジトリ instruction ファイルとしてインストールされます。

**インストールディレクトリの上書き:**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

スキルは `~/.cursor/` に配置されます。GSD はスキル、エージェント、ルールの参照をインストールします。

**インストールディレクトリの上書き:**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

スキルは `~/.codeium/windsurf/` に配置されます。GSD はスキル、エージェント、ワークスペースルールをインストールします。

**インストールディレクトリの上書き:**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

Cline はルールベースの統合方式を使用します。GSD はスラッシュコマンドではなく `.clinerules` としてインストールされます。

```bash
# グローバルインストール（全プロジェクト）
npx @opengsd/gsd-core@latest --cline --global

# ローカルインストール（このプロジェクトのみ）
npx @opengsd/gsd-core@latest --cline --local
```

グローバルインストールは `~/.cline/` に書き込みます。ローカルインストールは `./.cline/` に書き込みます。ルールは Cline によって自動的に読み込まれます。カスタムのスラッシュコマンドは登録されません。

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

スキルは `~/.codebuddy/skills/gsd-*/SKILL.md` に配置されます。

---

### Qwen Code

Qwen Code は Claude Code 2.1.88 以降と同じオープンスキル標準を使用します。

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

スキルは `~/.qwen/skills/gsd-*/SKILL.md` に配置されます。

**インストールディレクトリの上書き:**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

スキルは `~/.augment/` に配置されます。GSD はスキルとエージェントをインストールします。フックや statusline の管理は行いません。

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

インストーラーは Antigravity の設定ディレクトリ（`~/.gemini/antigravity`、`~/.gemini/antigravity-ide`、または `~/.gemini/antigravity-cli`）を自動検出します。Gemini 互換の設定ポリシーを使用します。

**インストールディレクトリの上書き:**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

スキルは `~/.trae/` に配置されます。GSD はスキル、エージェント、ルールの参照をインストールします。

---

## ローカルインストールとグローバルインストール

上記の例はすべて `--global` を使用しており、ユーザーアカウント全体に GSD を一度インストールします。インストールを単一プロジェクトに限定するには、`--global` を `--local` に置き換えます。

```bash
npx @opengsd/gsd-core@latest --claude --local
```

ローカルインストールはプロジェクトルートの `.claude/` ディレクトリに書き込みます。両方が存在する場合、ローカルインストールの設定がグローバルの設定より優先されます。

---

## プレリリースエディション（Next / Nightly / Insiders / Preview）のインストール

ランタイムのプレリリースエディション（Windsurf Next、Cursor Nightly、VS Code Insiders、Codex preview チャンネルなど）は、隣接する設定ディレクトリから読み込みます。インストーラーを実行する前に対応する `*_CONFIG_DIR` 環境変数を設定してください。

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

インストーラーのプロンプトでは対応する安定版ランタイムを選択してください。GSD はプレリリースエディションを独立した名前付きランタイムとしては列挙していません。これらは環境変数によるベストエフォートの対応であり、リリース CI では個別にテストされていません。

---

## Node.js なしでのインストール

`npx` が実行できない場合（例：Node.js がない Windows マシン）、2 つの選択肢があります。

**選択肢 A — Node.js がある別のマシンを使用する。** WSL、Linux VM、CI ランナー、Docker コンテナなど、Node.js があるマシンであれば何でも使えます。そのマシンでインストーラーを実行し、出力ディレクトリをターゲットマシンにコピーします。OpenCode の場合:

```bash
npx @opengsd/gsd-core@latest --opencode --global
# その後 ~/.config/opencode/agents/ を Windows マシンにコピー
```

**選択肢 B — ソースファイルを手動で変換する。** エージェントのソースファイルは GSD Core リポジトリの `agents/` に存在し、Claude Code のネイティブ frontmatter 形式になっています。各ランタイムは異なる形式を要求します。ランタイムごとの正確なフィールド変換については、ユーザーガイドの [Manual install / no-Node.js setup](../USER-GUIDE.md#manual-install--no-nodejs-setup) を参照してください。OpenCode の変換内容が詳しく説明されており、他のランタイム向けのインストーラーの `convert*Frontmatter` 関数も案内されています。

---

## インストール後の作業

新しいコマンドとエージェントを反映するためにランタイムを再起動してください。その後、新規プロジェクトを開始するか既存リポジトリをオンボーディングします。

```bash
/gsd-new-project   # グリーンフィールドプロジェクト
/gsd-onboard       # 既存コードベース
```

再起動後もコマンドが見つからない場合は、インストールディレクトリがランタイムの期待する設定パスと一致しているか確認してください。最もよくある不一致については上記のプレリリースエディションのセクションを参照してください。

---

## Related

- [最初のプロジェクト](../tutorials/your-first-project.md)
- [GSD Core の更新](update-gsd.md)
- [設定](../CONFIGURATION.md)
- [ドキュメント索引](../README.md)
