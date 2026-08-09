# 将现有代码库纳入工作流

在本教程中，您将把 GSD Core 引入一个已有代码的仓库。您将对代码库进行映射，创建一个描述您所*新增*内容的项目，并针对一个小型聚焦变更运行首次讨论与规划循环。完成后，GSD Core 的规划流水线将了解您的技术栈、规范和关注点——并在每次规划时运用这些知识。

---

## 您将构建的内容

我们将向一个现有的 Express 应用程序添加一个 `GET /health` 端点。该变更足够小，不会分散您对真正核心内容的注意力：GSD Core 在规划任何内容之前如何学习您的代码库。

---

## 前提条件

- **Node.js 18 或更高版本** — `node --version` 应输出 `v18.x.x` 或更高版本。
- **一个现有项目** — 任何已有代码的仓库。不必须是 Express；这些步骤适用于任何技术栈。
- **Claude Code** — 在您的仓库根目录中打开。

---

## 第 1 步 — 安装 GSD Core

在您的仓库根目录执行：

```bash
npx @opengsd/gsd-core@latest
```

在提示时选择 **Claude Code** 和 **local**。您将看到：

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## 第 2 步 — 使用权限启动 Claude Code

```bash
claude --dangerously-skip-permissions
```

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](../explanation/security-model.md) first.


---

## 第 3 步 — 开始 brownfield onboarding

在创建项目之前，让 GSD Core 检查仓库状态并告诉您安全的下一个顶层命令。这一步可避免跳过代码库上下文或覆盖现有 planning 文件。

```text
/gsd-onboard
```

如果 onboarding 报告缺少代码库映射，请选择推荐选项并运行打印出的 `/gsd-map-codebase` 交接命令，然后重新运行 `/gsd-onboard`。`/gsd-onboard --fast` 只适合轻量首次通过；在 `/gsd-new-project` 前仍需要完整映射。`/gsd-map-codebase` 会派生四个并行映射子代理（您将看到"Spawning 4 parallel codebase mapper agents…"——这需要 1–5 分钟；请勿中断）。每个代理专注于不同的关注点：

| 代理 | 关注点 |
|-------|-------|
| 技术映射器 | 技术栈、框架、依赖项 |
| 架构映射器 | 模式、层次、数据流 |
| 质量映射器 | 规范、测试实践 |
| 关注点映射器 | 技术债务、风险领域 |

当所有四个代理返回后，您将看到：

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

打开 `.planning/codebase/STACK.md`。您将看到 GSD Core 检测到的语言、运行时、框架版本和关键依赖项——这些内容基于实际读取的文件，而非猜测。

打开 `.planning/codebase/CONVENTIONS.md`。您将看到它从您的源代码中观察到的命名规范、错误处理模式和代码风格规则。GSD Core 为该仓库生成的每个计划都将自动遵循这些规范。

打开 `.planning/codebase/CONCERNS.md`。在进行任何新功能开发之前，这是最值得阅读的文件——它会展现可能影响您计划的技术债务和脆弱区域。

---

## 第 4 步 — 重新运行 onboarding 并初始化项目

清除会话窗口：

```text
/clear
```

现在再次运行 `/gsd-onboard`。如果 GSD Core 检测到 ADR、PRD、spec、RFC 或根级需求文档，请先接受推荐的 `/gsd-ingest-docs` 交接，然后再运行 `/gsd-onboard`。上下文准备好后，onboarding 会打印项目初始化交接命令：

```text
/gsd-new-project
```

由于 GSD Core 在上一步中发现了现有代码，`/gsd-new-project` 知道这是一个棕地项目。问题将聚焦于您所*新增*的内容，而非重新描述已有的内容：

GSD Core 会询问您想构建什么。请用您正在添加的功能来回答，而不是描述整个代码库：

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

GSD Core 会进一步提出少量澄清问题，然后继续创建需求和路线图。由于它已读取 `ARCHITECTURE.md` 和 `STACK.md`，它会自动将现有能力映射到 `PROJECT.md` 的 **Validated** 部分——您无需描述现有的 API 接口。

对所有工作流设置选择推荐默认值。

当路线图子代理返回后，您将看到一个建议的路线图。对于单个小型变更，它将只有一个阶段：

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

批准路线图。

项目设置完成后，再运行一次 `/gsd-onboard`。现在 `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md` 和 `STATE.md` 都已存在，onboarding 会创建或确认 `.planning/onboarding/SUMMARY.md`。

**在 `.planning/` 中创建的内容：**

```text
.planning/
  PROJECT.md          ← project description; existing capabilities in "Validated"
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← Phase 1, status: pending
  STATE.md            ← session memory
  config.json         ← workflow settings
  onboarding/SUMMARY.md ← onboarding 状态和下一个命令
  codebase/           ← 第 3 步生成的七个映射文件
```

注意 `.planning/codebase/` 已经从第 3 步存在。GSD Core 在编写 `PROJECT.md` 时读取了这些文件，这就是为什么它无需您描述即可填充已验证的需求。

---

## 第 5 步 — 清除上下文并讨论第 1 阶段

```text
/clear
```

```text
/gsd-discuss-phase 1
```

由于 GSD Core 已读取您的 `CONVENTIONS.md` 和 `ARCHITECTURE.md`，其问题基于您的实际代码库——而非通用建议。您可能会看到：

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

讨论结束后，GSD Core 将写入：

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

打开该文件。`## Implementation Decisions` 部分记录了您的回答。规划器将在编写任何任务之前读取此文件——因此您关于文件位置和响应格式的偏好将出现在计划中，而不仅仅停留在讨论里。

---

## 第 6 步 — 规划第 1 阶段

```text
/gsd-plan-phase 1
```

四个研究子代理并行运行（1–5 分钟）。当它们返回后，规划器读取 `CONTEXT.md`、研究结果和您的代码库映射，创建符合您规范的任务计划。

**创建的内容：**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← findings on health endpoint patterns
  01-01-PLAN.md       ← Task: create src/routes/health.js
  01-02-PLAN.md       ← Task: register health route in src/routes/index.js
```

打开 `01-01-PLAN.md`。注意 `<files>` 标签引用了 `src/routes/health.js`——正是您在讨论中指定的路径，与 GSD Core 在代码库映射中观察到的路由模式一致。这正是代码库映射发挥作用的体现。

---

## 下一步

您现在拥有一个带有代码库映射、讨论决策记录和经过验证的任务计划的项目——所有内容均基于您的实际代码。从这里开始，工作流与绿地项目完全相同：

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

对于每个未来的功能，当结构发生重大变化时，再次运行 `/gsd-map-codebase`，以保持代码库映射的时效性。

---

## 您学到了什么

- `/gsd-onboard` 如何安全编排 brownfield 设置，不嵌套交互式命令，也不覆盖现有 planning 文件。
- `/gsd-map-codebase` 如何运行四个并行代理，在 `.planning/codebase/` 中生成 `STACK.md`、`ARCHITECTURE.md`、`CONVENTIONS.md`、`CONCERNS.md`、`STRUCTURE.md`、`TESTING.md` 和 `INTEGRATIONS.md`。
- 在棕地仓库中运行 `/gsd-new-project` 如何将问题聚焦于您所*新增*的内容，并从现有代码中填充已验证的需求。
- 代码库映射如何塑造 `/gsd-discuss-phase` 中的每个问题——文件路径、模式和规范均来自您的实际代码。
- 规划器如何读取 `CONTEXT.md` 和 `CONVENTIONS.md` 来生成符合您仓库风格的计划。

---

## 相关内容

- [您的第一个项目](your-first-project.md) — 从安装到 PR 的完整绿地循环
- [通过命令使用映射代码库](../COMMANDS.md) — 所有 `/gsd-map-codebase` 标志和子命令
- [文档索引](../README.md)
