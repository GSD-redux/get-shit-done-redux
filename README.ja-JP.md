<div align="center">

# GSD Core

**Git. Ship. Done.**

[English](README.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko-KR.md)

**Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf、Qoder などに対応した、軽量なメタプロンプティング・コンテキストエンジニアリング・仕様駆動開発システムです。**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## GSD Core とは

GSD Core は、コンテキストエンジニアリングと仕様駆動開発のフレームワークです。AI コーディングエージェント（Claude Code、Codex、Gemini CLI、Copilot、Cursor など）を規律あるフェーズループで動かします。[コンテキストの腐敗](docs/ja-JP/explanation/context-engineering.md)—AI がコンテキストウィンドウを埋めるにつれて出力品質が低下する問題—を解決するために、重いリサーチ・計画・実行作業をすべて新鮮なコンテキストのサブエージェントで実行し、メインセッションをスリムに保ちます。

---

## 動作原理

各マイルストーンは同じ 5 ステップのループを、1 フェーズずつ繰り返します。

1. **Discuss（議論）** — 計画を立てる前に実装上の決定事項を記録する
2. **Plan（計画）** — リサーチし、タスクを分解し、計画が新鮮なコンテキストウィンドウに収まることを確認する
3. **Execute（実行）** — 並列ウェーブで計画を実行する。各エグゼキューターはクリーンな 200k トークンのコンテキストから開始する
4. **Verify（検証）** — 構築されたものを確認し、完了を宣言する前に診断・修正する
5. **Ship（出荷）** — PR を作成し、フェーズをアーカイブし、次のフェーズに進む

---

## クイックスタート

```bash
npx @opengsd/gsd-core@latest
```

インストーラーはランタイム（Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf、Qoder など）とグローバルインストールかローカルインストールかを尋ねます。クロスランタイム互換性のためにインストーラーが必要です。`agents/` や `commands/` からファイルを直接コピーしないでください。

別のランタイムをお使いの場合や Node.js がない場合は [ランタイムへのインストール](docs/ja-JP/how-to/install-on-your-runtime.md) を参照してください。

インストール後、新規プロジェクトを開始するか、既存リポジトリをオンボーディングします。

```bash
/gsd-new-project   # グリーンフィールドプロジェクト
/gsd-onboard       # 既存コードベース
```

初めての方は [はじめてのプロジェクト](docs/ja-JP/tutorials/your-first-project.md) で、インストールから最初のフェーズ出荷までのガイド付きチュートリアルをご覧ください。既存リポジトリの場合は [既存コードベースのオンボーディング](docs/ja-JP/tutorials/onboarding-an-existing-codebase.md) を参照してください。

---

## ドキュメント

**チュートリアル** — 実践で学ぶ:
- [はじめてのプロジェクト](docs/ja-JP/tutorials/your-first-project.md)
- [既存コードベースのオンボーディング](docs/ja-JP/tutorials/onboarding-an-existing-codebase.md)

**ハウツーガイド** — タスク別レシピ:
- [ランタイムへのインストール](docs/ja-JP/how-to/install-on-your-runtime.md)
- [フェーズを計画する](docs/ja-JP/how-to/plan-a-phase.md)
- [検証と出荷](docs/ja-JP/how-to/verify-and-ship.md)
- … [すべてのハウツーガイドを見る](docs/ja-JP/README.md#how-to-guides)

**リファレンス** — 信頼できる情報:
- [コマンド](docs/ja-JP/COMMANDS.md)
- [設定](docs/ja-JP/CONFIGURATION.md)
- [CLI ツール](docs/ja-JP/CLI-TOOLS.md)

**解説** — コンセプトと設計上の決定:
- [コンテキストエンジニアリング](docs/ja-JP/explanation/context-engineering.md)
- [フェーズループ](docs/ja-JP/explanation/the-phase-loop.md)
- [アーキテクチャ](docs/ja-JP/ARCHITECTURE.md)

全インデックス: [docs/ja-JP/README.md](docs/ja-JP/README.md)。他の言語: [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md)。

---

## なぜ機能するのか

多くの AI コーディング環境は、コンテキストの膨張が出力品質を静かに低下させ、セッション間に共有メモリがなく、コードが実際に動作するかを検証するものがないため、大規模では失敗します。GSD Core はこの 3 つすべてを解決します。重い作業は新鮮なサブエージェントで実行され、`STATE.md` や `CONTEXT.md` などの構造化アーティファクトがセッション境界を越えて保存され、検証ステップが構築されたものを確認してフェーズを完了と宣言する前に修正計画を生成します。詳細な理由については [docs/ja-JP/explanation/context-engineering.md](docs/ja-JP/explanation/context-engineering.md) を参照してください。

トラブルシューティングは [docs/ja-JP/how-to/recover-and-troubleshoot.md](docs/ja-JP/how-to/recover-and-troubleshoot.md) を参照してください。

---

## コミュニティ

| プロジェクト | プラットフォーム |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | オリジナル OpenCode ポート |
| [Discord](https://discord.gg/mYgfVNfA2r) | コミュニティサポート |

---

## スター履歴

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## ライセンス

MIT ライセンス。詳細は [LICENSE](LICENSE) を参照してください。

---

<div align="center">

**Claude Code は強力です。GSD Core はそれを信頼できるものにします。**

</div>
