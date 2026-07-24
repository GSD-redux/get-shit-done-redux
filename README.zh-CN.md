<div align="center">

# GSD Core

**Git. Ship. Done.**

[English](README.md) · [Português](README.pt-BR.md) · **简体中文** · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**一套轻量级的元提示、上下文工程与规范驱动开发系统，适用于 Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf、Qoder 等 AI 编程工具。**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## 什么是 GSD Core

GSD Core 是一套上下文工程与规范驱动开发框架，能够引导 AI 编程智能体（Claude Code、Codex、Gemini CLI、Copilot、Cursor 等）按照严格的阶段循环推进工作。它解决了[上下文腐化](docs/zh-CN/explanation/context-engineering.md)问题——即随着 AI 填满上下文窗口而逐渐累积的质量下降——通过在全新上下文的子智能体中运行所有繁重的研究、规划和执行工作，同时保持主会话的精简。

---

## 工作原理

每个里程碑重复相同的五步循环，每次推进一个阶段：

1. **讨论（Discuss）** — 在规划任何内容之前，先捕获实现决策
2. **规划（Plan）** — 研究、分解，并验证计划能够适配全新的上下文窗口
3. **执行（Execute）** — 以并行波次运行计划；每个执行器以干净的 20 万 token 上下文启动
4. **验证（Verify）** — 检查已构建的内容；在宣告完成前诊断并修复问题
5. **交付（Ship）** — 创建 PR，归档阶段，对下一个阶段重复上述流程

---

## 快速开始

```bash
npx @opengsd/gsd-core@latest
```

安装程序会提示选择运行时（Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Cursor、Windsurf、Qoder 等）以及是全局安装还是本地安装。跨运行时兼容性需要使用安装程序——请勿直接从 `agents/` 或 `commands/` 目录复制文件。

使用其他运行时或没有 Node.js？请参阅[在你的运行时上安装](docs/zh-CN/how-to/install-on-your-runtime.md)。

安装完成后，启动一个新项目或接入现有仓库：

```bash
/gsd-new-project   # 新建项目
/gsd-onboard       # 现有代码库
```

初次使用？请按照[你的第一个项目](docs/zh-CN/tutorials/your-first-project.md)进行引导式操作，从安装到完成第一个交付阶段。对于现有仓库，请参阅[接入现有代码库](docs/zh-CN/tutorials/onboarding-an-existing-codebase.md)。

---

## 文档

**教程** — 边做边学：
- [你的第一个项目](docs/zh-CN/tutorials/your-first-project.md)
- [接入现有代码库](docs/zh-CN/tutorials/onboarding-an-existing-codebase.md)

**操作指南** — 面向任务的实用方法：
- [在你的运行时上安装](docs/zh-CN/how-to/install-on-your-runtime.md)
- [规划一个阶段](docs/zh-CN/how-to/plan-a-phase.md)
- [验证与交付](docs/zh-CN/how-to/verify-and-ship.md)
- … [查看所有操作指南](docs/zh-CN/README.md#how-to-guides)

**参考文档** — 权威信息：
- [命令](docs/zh-CN/COMMANDS.md)
- [配置](docs/zh-CN/CONFIGURATION.md)
- [CLI 工具](docs/zh-CN/CLI-TOOLS.md)

**概念说明** — 设计理念与决策：
- [上下文工程](docs/zh-CN/explanation/context-engineering.md)
- [阶段循环](docs/zh-CN/explanation/the-phase-loop.md)
- [架构](docs/zh-CN/ARCHITECTURE.md)

完整索引：[docs/zh-CN/README.md](docs/zh-CN/README.md)。其他语言：[日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [English](README.md)。

---

## 为什么有效

大多数 AI 编程方案在规模化时都会失败，原因在于上下文膨胀会悄无声息地降低输出质量，各会话之间没有共享记忆，也没有任何机制来验证代码是否真正可用。GSD Core 解决了这三个问题：繁重的工作在全新的子智能体中运行，`STATE.md` 和 `CONTEXT.md` 等结构化工件能够跨越会话边界保持存续，验证步骤会检查已构建的内容并在宣告阶段完成前生成修复计划。完整的设计思路请参阅 [docs/zh-CN/explanation/context-engineering.md](docs/zh-CN/explanation/context-engineering.md)。

遇到问题？请参阅 [docs/zh-CN/how-to/recover-and-troubleshoot.md](docs/zh-CN/how-to/recover-and-troubleshoot.md)。

---

## 社区

| 项目 | 平台 |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | 原始 OpenCode 移植版 |
| [Discord](https://discord.gg/mYgfVNfA2r) | 社区支持 |

---

## Star History

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## 许可证

MIT 许可证。详情请参阅 [LICENSE](LICENSE)。

---

<div align="center">

**Claude Code 功能强大。GSD Core 让它更可靠。**

</div>
