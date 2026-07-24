# GSD Core 架构

> 面向贡献者和高级用户的系统架构说明。如需面向用户的文档，请参阅[功能参考](FEATURES.md)或[用户指南](USER-GUIDE.md)。

---

## 目录

- [系统概述](#系统概述)
- [设计原则](#设计原则)
- [组件架构](#组件架构)
- [Agent 模型](#agent-模型)
- [数据流](#数据流)
- [文件系统布局](#文件系统布局)
- [安装程序架构](#安装程序架构)
- [Hook 系统](#hook-系统)
- [CLI 工具层](#cli-工具层)
- [运行时抽象](#运行时抽象)

---

## 系统概述

GSD Core 是一个**元提示框架**，位于用户与 AI 编码 Agent（Claude Code、Gemini CLI、OpenCode、Kilo、Codex、Copilot、Antigravity、Trae、Cline、Augment Code）之间。它提供：

1. **上下文工程** — 结构化产物，为每个任务向 AI 提供所需的全部信息（参见[上下文工程](explanation/context-engineering.md)）
2. **多 Agent 编排** — 轻量级编排器，以全新上下文窗口派生专用 Agent（参见[多 Agent 编排](explanation/multi-agent-orchestration.md)）
3. **规范驱动开发** — 需求 → 研究 → 计划 → 执行 → 验证的完整流水线
4. **状态管理** — 跨会话和上下文重置的持久化项目记忆

```
┌──────────────────────────────────────────────────────┐
│                      USER                            │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              COMMAND LAYER                            │
│   commands/gsd/*.md — Prompt-based command files      │
│   (Claude Code custom commands / Codex skills)        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              WORKFLOW LAYER                           │
│   gsd-core/workflows/*.md — Orchestration logic  │
│   (Reads references, spawns agents, manages state)    │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENT      │ │  AGENT    │ │  AGENT         │
│  (fresh     │ │  (fresh   │ │  (fresh        │
│   context)  │ │   context)│ │   context)     │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CLI TOOLS LAYER                          │
│   gsd-tools.cjs command families + domain modules      │
│   command-routing-hub + observability seams            │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              FILE SYSTEM (.planning/)                 │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## 设计原则

### 1. 每个 Agent 拥有全新上下文

编排器派生的每个 Agent 都有一个干净的上下文窗口（最多 200K token）。这消除了上下文腐化——即 AI 在其上下文窗口中积累大量对话后导致的质量下降问题。

### 2. 轻量级编排器

工作流文件（`gsd-core/workflows/*.md`）不承担繁重工作。它们：

- 通过 `gsd-tools.cjs init <workflow>` 加载上下文
- 以聚焦的提示词派生专用 Agent
- 收集结果并路由到下一步
- 在步骤之间更新状态

### 3. 基于文件的状态

所有状态以人类可读的 Markdown 和 JSON 格式存储在 `.planning/` 中。无需数据库、服务器或外部依赖。这意味着：

- 状态在上下文重置（`/clear`）后仍然保留
- 状态可由人类和 Agent 共同检查
- 状态可提交到 git 以供团队查看

### 4. 缺省即启用

工作流功能标志遵循**缺省即启用**模式。若 `config.json` 中缺少某个键，则默认为 `true`。用户需显式禁用功能；无需手动启用默认值。

### 5. 深度防御

多层保护防止常见故障模式：

- 计划在执行前经过验证（plan-checker agent）
- 执行为每个任务生成原子提交
- 执行后验证会检查是否符合阶段目标
- UAT 提供人工验证作为最终关卡

---

## 组件架构

### 命令（`commands/gsd/*.md`）

面向用户的入口点。每个文件包含 YAML 前置元数据（name、description、allowed-tools）以及引导工作流的提示词主体。命令按如下方式安装：

- **Claude Code：** 自定义斜线命令（连字符形式，`/gsd-command-name`）
- **OpenCode / Kilo：** 斜线命令（连字符形式，`/gsd-command-name`）
- **Codex：** 技能（`$gsd-command-name`）
- **Copilot：** 斜线命令（连字符形式，`/gsd-command-name`）
- **Gemini CLI：** 在 `gsd:` 命名空间下的斜线命令（冒号形式，`/gsd:command-name`）——Gemini 将所有自定义命令置于其插件 id 的命名空间下，因此安装路径会将正文中的每个引用改写为冒号形式
- **Antigravity：** 技能

**命令总数：** 请参阅 [`docs/INVENTORY.md`](INVENTORY.md#commands) 获取权威数量及完整列表。

#### 两阶段层级路由（v1.40，[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）

为控制急于列举技能的 token 开销，v1.40 引入了六个命名空间**元技能**（`gsd-workflow`、`gsd-project`、`gsd-quality`、`gsd-context`、`gsd-manage`、`gsd-ideate`——源自 `commands/gsd/ns-*.md`，但可调用的 `name:` 为此处显示的简短形式），位于具体子技能之上。模型看到的是 6 个命名空间路由器（约 120 个 token），而非扁平的 86 个技能列表（约 2,150 个 token），选择命名空间后通过嵌入在命名空间路由器主体中的路由表路由到具体子技能。命名空间技能是**可叠加的**——每个具体命令仍可直接调用。

路由器描述使用管道分隔的关键词标签（≤ 60 个字符），符合工具注意力研究的结论：关键词密集的标签在路由效果上优于散文，且 token 开销仅约 40%。

#### MCP token 预算交互

急于列举技能是每轮两种反复出现的 token 开销之一。另一种是 `.claude/settings.json` 中每个已启用 MCP 服务器注入的 MCP 工具 schema。重型 MCP 服务器（browser/playwright、Mac-tools、Windows-tools）每轮各自可消耗 20k+ token——通常远超 `model_profile` 调优所节省的量。该开关位于 Claude Code 框架中（`.claude/settings.json` 中的 `enabledMcpjsonServers` / `disabledMcpjsonServers`），**不属于** GSD 的关注范围。两阶段路由层（#2792）和严格的 MCP 启用管理是每轮最大的成本杠杆。请参阅 [`docs/USER-GUIDE.md`](USER-GUIDE.md) 和 `references/context-budget.md` 了解审计清单。

### 工作流（`gsd-core/workflows/*.md`）

命令所引用的编排逻辑，包含逐步流程：

- 通过 `gsd-tools.cjs init` 处理程序加载上下文
- 带有模型解析的 Agent 派生指令
- 关卡/检查点定义
- 状态更新模式
- 错误处理与恢复

**工作流总数：** 请参阅 [`docs/INVENTORY.md`](INVENTORY.md#workflows) 获取权威数量及完整列表。

#### 工作流的渐进式披露

工作流文件在每次调用对应的 `/gsd-*` 命令时会被完整加载到 Claude 的上下文中。为控制该成本，`tests/workflow-size-budget.test.cjs` 强制执行的工作流大小预算与 Agent 大小预算惯例保持一致：

| 层级      | 每文件行数限制 |
|-----------|--------------------|
| `XL`      | 1700 — 顶级编排器（`execute-phase`、`plan-phase`、`new-project`） |
| `LARGE`   | 1500 — 多步骤规划器和大型功能工作流 |
| `DEFAULT` | 1000 — 聚焦于单一目的的工作流（目标层级） |

根据 discuss-phase 字节预算（#717；discuss-phase/modes 分割使其保持在 ≈32000 字节），`workflows/discuss-phase.md` 须严格遵守更严格的上限。当工作流超出其层级时，应将各模式的主体提取到 `workflows/<workflow>/modes/<mode>.md`，将模板提取到 `workflows/<workflow>/templates/`，将共享知识提取到 `gsd-core/references/`。父文件成为轻量级调度器，仅读取当前调用所需的模式和模板文件。

`workflows/discuss-phase/` 是该模式的典型示例——父文件负责调度，`modes/` 存放各标志的行为（`power.md`、`all.md`、`auto.md`、`chain.md`、`text.md`、`batch.md`、`analyze.md`、`default.md`、`advisor.md`），`templates/` 存放 CONTEXT.md、DISCUSSION-LOG.md 以及仅在写入对应输出文件时才读取的 checkpoint.json schema。

### Agent（`agents/*.md`）

带有前置元数据的专用 Agent 定义，指定：

- `name` — Agent 标识符
- `description` — 角色与用途
- `tools` — 允许的工具访问（Read、Write、Edit、Bash、Grep、Glob、WebSearch 等）
- `color` — 用于视觉区分的终端输出颜色

**Agent 总数：** 33

### 参考文档（`gsd-core/references/*.md`）

工作流和 Agent 通过 `@-reference` 引用的共享知识文档（请参阅 [`docs/INVENTORY.md`](INVENTORY.md#references-41-shipped) 获取权威数量及完整列表）：

**核心参考：**

- `checkpoints.md` — 检查点类型定义和交互模式
- `gates.md` — 4 种规范关卡类型（确认、质量、安全、转换），与 plan-checker 和 verifier 连接
- `model-profiles.md` — 各 Agent 的模型层级分配
- `model-profile-resolution.md` — 模型解析算法文档
- `verification-patterns.md` — 不同产物类型的验证方式
- `verification-overrides.md` — 每种产物的验证覆盖规则
- `planning-config.md` — 完整配置 schema 和行为说明
- `git-integration.md` — Git 提交、分支及历史记录模式
- `git-planning-commit.md` — 规划目录提交约定
- `questioning.md` — 项目初始化的梦想提取理念
- `tdd.md` — 测试驱动开发集成模式
- `ui-brand.md` — 视觉输出格式化模式
- `common-bug-patterns.md` — 代码审查和验证的常见错误模式

**工作流参考：**

- `agent-contracts.md` — 编排器与 Agent 之间的正式接口
- `context-budget.md` — 上下文窗口预算分配规则
- `continuation-format.md` — 会话续接/恢复格式
- `domain-probes.md` — discuss-phase 的领域特定探测问题
- `gate-prompts.md` — 关卡/检查点提示词模板
- `revision-loop.md` — 计划修订迭代模式
- `universal-anti-patterns.md` — 需检测和避免的常见反模式
- `artifact-types.md` — 规划产物类型定义
- `phase-argument-parsing.md` — 阶段参数解析约定
- `decimal-phase-calculation.md` — 十进制子阶段编号规则
- `workstream-flag.md` — 工作流活动指针约定
- `user-profiling.md` — 用户行为分析方法
- `thinking-partner.md` — 在决策点条件性激活思考伙伴

**思考模型参考：**

将思考类模型（o3、o4-mini、Gemini 2.5 Pro）集成到 GSD 工作流的参考文档：

- `thinking-models-debug.md` — 调试工作流的思考模型模式
- `thinking-models-execution.md` — 执行 Agent 的思考模型模式
- `thinking-models-planning.md` — 规划 Agent 的思考模型模式
- `thinking-models-research.md` — 研究 Agent 的思考模型模式
- `thinking-models-verification.md` — 验证 Agent 的思考模型模式

**模块化规划器分解：**

规划器 Agent（`agents/gsd-planner.md`）已从单一整体文件分解为一个核心 Agent 加参考模块，以遵守部分运行时强加的 50K 字符限制：

- `planner-gap-closure.md` — 缺口修复模式行为（读取 VERIFICATION.md，针对性重规划）
- `planner-reviews.md` — 跨 AI 审查集成（从 `/gsd-review` 读取 REVIEWS.md）
- `planner-revision.md` — 用于迭代细化的计划修订模式

### 模板（`gsd-core/templates/`）

所有规划产物的 Markdown 模板。由 `gsd-tools.cjs template fill` / `phase.scaffold`（以及顶级 `scaffold`）使用，以创建预结构化文件：
- `project.md`、`requirements.md`、`roadmap.md`、`state.md` — 核心项目文件
- `phase-prompt.md` — 阶段执行提示词模板
- `summary.md`（及 `summary-minimal.md`、`summary-standard.md`、`summary-complex.md`）— 粒度感知摘要模板
- `DEBUG.md` — 调试会话跟踪模板
- `UI-SPEC.md`、`UAT.md`、`VALIDATION.md` — 专用验证模板
- `discussion-log.md` — 讨论审计追踪模板
- `codebase/` — 棕地映射模板（技术栈、架构、约定、关注点、结构、测试、集成）
- `research-project/` — 研究输出模板（SUMMARY、STACK、FEATURES、ARCHITECTURE、PITFALLS）

### Hook（`hooks/`）

与宿主 AI Agent 集成的运行时 hook：

| Hook | 事件 | 用途 |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | 显示模型、任务、目录及上下文使用量进度条 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 在剩余上下文为 35%/25% 时向 Agent 注入上下文警告 |
| `gsd-check-update.js` | `SessionStart` | 触发后台更新检查的前台触发器 |
| `gsd-check-update-worker.js` | （辅助程序） | 由 `gsd-check-update.js` 派生的后台工作进程；不直接注册事件 |
| `gsd-prompt-guard.js` | `PreToolUse` | 扫描 `.planning/` 写入内容中的提示词注入模式（建议性） |
| `gsd-read-injection-scanner.js` | `PostToolUse` | 扫描 Read 工具输出中不受信任内容里的注入指令 |
| `gsd-workflow-guard.js` | `PreToolUse` | 检测 GSD 工作流上下文之外的文件编辑（建议性，通过 `hooks.workflow_guard` 选择启用） |
| `gsd-read-guard.js` | `PreToolUse` | 建议性防护，防止对本会话中尚未读取的文件执行 Edit/Write |
| `gsd-session-state.sh` | `PostToolUse` | 基于 shell 的运行时的会话状态跟踪 |
| `gsd-validate-commit.sh` | `PostToolUse` | 用于规范提交格式执行的提交验证 |
| `gsd-phase-boundary.sh` | `PostToolUse` | 工作流转换的阶段边界检测 |

请参阅 [`docs/INVENTORY.md`](INVENTORY.md#hooks-11-shipped) 获取权威的 11 个 hook 列表。

### 命令路由中枢（`gsd-core/bin/lib/command-routing-hub.cjs`）

CJS 命令族路由器通过 `CommandRoutingHub` 进行调度。中枢拥有不抛出异常的纯结果契约（`hub.dispatch()` 捕获内部异常并返回 `{ ok: false, kind, ...typedPayload }`）以及封闭的运行时错误分类（`UnknownCommand`、`InvalidArgs`、`HandlerRefusal`、`HandlerFailure`）。路由器适配器保持为轻量级 CLI 转换器——它们构建中枢、调用 `dispatch`，然后将结果映射到 `output()`/`error()` 调用。运行时为单路径（无双运行时模式选择）。参见 `docs/adr/0174-retire-gsd-sdk-package-boundary.md`。

### CLI 工具（`gsd-core/bin/`）

Node.js CLI 工具（`gsd-tools.cjs`），其领域模块分布在 `gsd-core/bin/lib/` 中（请参阅 [`docs/INVENTORY.md`](INVENTORY.md#cli-modules-33-shipped) 获取权威列表）：


| 模块                   | 职责                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `core.cjs`             | 错误处理、输出格式化、共享工具；规划辅助程序的兼容性重导出 |
| `planning-workspace.cjs` | 规划接缝（`planningDir`、`planningPaths`、活动工作流路由、`.planning/.lock`）      |
| `state.cjs`            | STATE.md 解析、更新、进度跟踪、指标                                                                    |
| `phase.cjs`            | 阶段目录操作、十进制编号、计划索引                                                                        |
| `roadmap.cjs`          | ROADMAP.md 解析、阶段提取、计划进度                                                                     |
| `config.cjs`           | config.json 读写、节初始化                                                                            |
| `verify.cjs`           | 计划结构、阶段完整性、引用、提交验证                                                                      |
| `template.cjs`         | 带变量替换的模板选择与填充                                                                              |
| `frontmatter.cjs`      | YAML 前置元数据 CRUD 操作                                                                             |
| `init.cjs`             | 各工作流类型的复合上下文加载                                                                            |
| `milestone.cjs`        | 里程碑归档、需求标记                                                                                   |
| `commands.cjs`         | 杂项命令（slug、时间戳、待办事项、脚手架、统计）                                                           |
| `model-profiles.cjs`   | 模型配置文件解析表                                                                                    |
| `security.cjs`         | 路径遍历防护、提示词注入检测、安全 JSON 解析、shell 参数验证                                                |
| `uat.cjs`              | UAT 文件解析、验证债务跟踪、审计 UAT 支持                                                               |
| `docs.cjs`             | 文档更新工作流初始化、Markdown 扫描、Monorepo 检测                                                       |
| `workstream.cjs`       | 工作流 CRUD、迁移、会话范围活动指针                                                                      |
| `schema-detect.cjs`    | ORM 模式（Prisma、Drizzle 等）的 schema 漂移检测                                                        |
| `profile-pipeline.cjs` | 用户行为分析数据管道、会话文件扫描                                                                       |
| `profile-output.cjs`   | 配置文件渲染、USER-PROFILE.md 和 dev-preferences.md 生成                                               |


---

## Agent 模型

### 编排器 → Agent 模式

```
Orchestrator (workflow .md)
    │
    ├── Load context: gsd-tools.cjs init <workflow> <phase>
    │   Returns JSON with: project info, config, state, phase details
    │
    ├── Resolve model: gsd-tools.cjs resolve-model <agent-name>
    │   Returns: opus | sonnet | haiku | inherit
    │
    ├── Spawn Agent (Task/SubAgent call)
    │   ├── Agent prompt (agents/*.md)
    │   ├── Context payload (init JSON)
    │   ├── Model assignment
    │   └── Tool permissions
    │
    ├── Collect result
    │
    └── Update state: gsd-tools.cjs state update / state patch / state advance-plan
```

### 主要 Agent 派生类别

21 个主要 Agent 的概念派生模式分类。完整的 31 个 Agent 权威列表（包括 10 个高级/专用 Agent，如 `gsd-pattern-mapper`、`gsd-code-reviewer`、`gsd-code-fixer`、`gsd-ai-researcher`、`gsd-domain-researcher`、`gsd-eval-planner`、`gsd-eval-auditor`、`gsd-framework-selector`、`gsd-debug-session-manager`、`gsd-intel-updater`），请参阅 [`docs/INVENTORY.md`](INVENTORY.md#agents-31-shipped)。


| 类别             | Agent                                                                                   | 并行性                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **研究者**       | gsd-project-researcher, gsd-phase-researcher, gsd-ui-researcher, gsd-advisor-researcher | 4 路并行（技术栈、功能、架构、陷阱）；advisor 在 discuss-phase 期间派生 |
| **综合者**       | gsd-research-synthesizer                                                                | 串行（研究者完成后）                                                                       |
| **规划者**       | gsd-planner, gsd-roadmapper                                                             | 串行                                                                                      |
| **检查者**       | gsd-plan-checker, gsd-integration-checker, gsd-ui-checker, gsd-nyquist-auditor          | 串行（验证循环，最多 3 次迭代）                                                             |
| **执行者**       | gsd-executor                                                                            | 波次内并行，波次间串行                                                                     |
| **验证者**       | gsd-verifier                                                                            | 串行（所有执行者完成后）                                                                    |
| **映射者**       | gsd-codebase-mapper                                                                     | 4 路并行（技术、架构、质量、关注点）                                                         |
| **调试者**       | gsd-debugger                                                                            | 串行（交互式）                                                                             |
| **审计者**       | gsd-ui-auditor, gsd-security-auditor                                                    | 串行                                                                                      |
| **文档写作者**   | gsd-doc-writer, gsd-doc-verifier                                                        | 串行（写作者后接验证者）                                                                    |
| **分析者**       | gsd-user-profiler                                                                       | 串行                                                                                      |
| **假设分析者**   | gsd-assumptions-analyzer                                                                | 串行（discuss-phase 期间）                                                                 |


### 波次执行模型

在 `execute-phase` 期间，计划按依赖关系分组为波次：

```
Wave Analysis:
  Plan 01 (no deps)      ─┐
  Plan 02 (no deps)      ─┤── Wave 1 (parallel)
  Plan 03 (depends: 01)  ─┤── Wave 2 (waits for Wave 1)
  Plan 04 (depends: 02)  ─┘
  Plan 05 (depends: 03,04) ── Wave 3 (waits for Wave 2)
```

每个执行者获得：

- 全新的 200K 上下文窗口（支持的模型最高可达 1M）
- 待执行的具体 PLAN.md
- 项目上下文（PROJECT.md、STATE.md）
- 阶段上下文（CONTEXT.md、RESEARCH.md（如可用））

### 自适应上下文增强（1M 模型）

当上下文窗口为 500K+ token 时（1M 级模型，如 Opus 4.6、Sonnet 4.6），子 Agent 提示词会自动增强额外上下文，这些内容在标准 200K 窗口中无法容纳：

- **执行者 Agent** 接收前一波次的 SUMMARY.md 文件和阶段 CONTEXT.md/RESEARCH.md，从而实现阶段内跨计划感知
- **验证者 Agent** 接收所有 PLAN.md、SUMMARY.md、CONTEXT.md 文件及 REQUIREMENTS.md，实现历史感知验证

编排器从配置中读取 `context_window`（`gsd-tools.cjs config-get context_window`），当该值 >= 500,000 时，条件性地包含更丰富的上下文。对于标准 200K 窗口，提示词使用截断版本并以缓存友好的顺序排列，以最大化上下文效率。

#### 并行提交安全性

当多个执行者在同一波次内运行时，两种机制防止冲突：

1. `--no-verify` 提交 — 并行 Agent 跳过预提交 hook（可能导致构建锁争用，例如 Rust 项目中的 cargo lock 冲突）。编排器在每个波次完成后运行一次 `git hook run pre-commit`。
2. **STATE.md 文件锁** — 所有 `writeStateMd()` 调用使用基于锁文件的互斥（`STATE.md.lock`，采用 `O_EXCL` 原子创建）。这防止了读-改-写竞态条件，即两个 Agent 同时读取 STATE.md、修改不同字段，而后写者覆盖前者更改的问题。包含陈旧锁检测（10 秒超时）和带抖动的自旋等待。

---

## 数据流

### 新项目流程

```
User input (idea description)
    │
    ▼
Questions (questioning.md philosophy)
    │
    ▼
4x Project Researchers (parallel)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
Research Synthesizer → SUMMARY.md
    │
    ▼
Requirements extraction → REQUIREMENTS.md
    │
    ▼
Roadmapper → ROADMAP.md
    │
    ▼
User approval → STATE.md initialized
```

### 阶段执行流程

```
discuss-phase → CONTEXT.md (user preferences)
    │
    ▼
ui-phase → UI-SPEC.md (design contract, optional)
    │
    ▼
plan-phase
    ├── Research gate (blocks if RESEARCH.md has unresolved open questions)
    ├── Phase Researcher → RESEARCH.md
    │       └── Package Legitimacy Gate: slopcheck on every package; [SLOP] removed,
    │           [SUS]/[ASSUMED] flagged; Audit table written to RESEARCH.md
    ├── Planner (with reachability check) → PLAN.md files
    │       └── checkpoint:human-verify injected before [ASSUMED]/[SUS] installs;
    │           T-{phase}-SC STRIDE row added for install-bearing plans
    ├── Plan Checker → Verify loop (max 3x)
    ├── Requirements coverage gate (REQ-IDs → plans)
    └── Decision coverage gate (CONTEXT.md `<decisions>` → plans, BLOCKING — #2492)
    │
    ▼
state planned-phase → STATE.md (Planned/Ready to execute)
    │
    ▼
execute-phase (context reduction: truncated prompts, cache-friendly ordering)
    ├── Wave analysis (dependency grouping)
    ├── Executor per plan → code + atomic commits
    ├── SUMMARY.md per plan
    └── Verifier → VERIFICATION.md
        └── Decision coverage gate (CONTEXT.md decisions → shipped artifacts, NON-BLOCKING — #2492)
    │
    ▼
verify-work → UAT.md (user acceptance testing)
    │
    ▼
ui-review → UI-REVIEW.md (visual audit, optional)
```

### 上下文传播

每个工作流阶段生成的产物会传入后续阶段：

```
PROJECT.md ────────────────────────────────────────────► All agents
REQUIREMENTS.md ───────────────────────────────────────► Planner, Verifier, Auditor
ROADMAP.md ────────────────────────────────────────────► Orchestrators
STATE.md ──────────────────────────────────────────────► All agents (decisions, blockers)
CONTEXT.md (per phase) ────────────────────────────────► Researcher, Planner, Executor
RESEARCH.md (per phase) ───────────────────────────────► Planner, Plan Checker
PLAN.md (per plan) ────────────────────────────────────► Executor, Plan Checker
SUMMARY.md (per plan) ─────────────────────────────────► Verifier, State tracking
UI-SPEC.md (per phase) ────────────────────────────────► Executor, UI Auditor
```

---

## 文件系统布局

### 安装文件

```
~/.claude/                          # Claude Code (global install)
├── skills/gsd-*/SKILL.md           # Global skills (authoritative roster: docs/INVENTORY.md)
├── commands/gsd/*.md               # Local Claude installs use slash commands instead of global skills
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # CLI utility
│   ├── bin/lib/*.cjs               # Domain modules (authoritative roster: docs/INVENTORY.md)
│   ├── workflows/*.md              # Workflow definitions (authoritative roster: docs/INVENTORY.md)
│   ├── references/*.md             # Shared reference docs (authoritative roster: docs/INVENTORY.md)
│   └── templates/                  # Planning artifact templates
├── agents/*.md                     # Agent definitions (authoritative roster: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js hooks (statusline, guards, monitors, update check)
├── hooks/*.sh                      # Shell hooks (session state, commit validation, phase boundary)
├── settings.json                   # Hook registrations
└── VERSION                         # Installed version number
```

其他运行时的等效路径：

- **OpenCode：** `~/.config/opencode/` 全局或 `./.opencode/` 本地
- **Kilo：** `~/.config/kilo/` 全局或 `./.kilo/` 本地
- **Gemini CLI：** `~/.gemini/` 全局或 `./.gemini/` 本地
- **Codex：** `~/.codex/` 全局或 `./.codex/` 本地
- **Copilot：** `~/.copilot/` 全局或 `./.github/` 本地
- **Antigravity：** 自动检测全局根目录（`~/.gemini/antigravity/`、`~/.gemini/antigravity-ide/` 或 `~/.gemini/antigravity-cli/`）或 `./.agent/` 本地
- **Cursor：** `~/.cursor/` 全局或 `./.cursor/` 本地
- **Windsurf：** `~/.codeium/windsurf/` 全局或 `./.windsurf/` 本地
- **Augment Code：** `~/.augment/` 全局或 `./.augment/` 本地
- **Trae：** `~/.trae/` 全局或 `./.trae/` 本地
- **Qwen Code：** `~/.qwen/` 全局或 `./.qwen/` 本地
- **Hermes Agent：** `~/.hermes/` 全局或 `./.hermes/` 本地
- **CodeBuddy：** `~/.codebuddy/` 全局或 `./.codebuddy/` 本地
- **Cline：** `~/.cline/` 全局或项目根目录 `.clinerules` 本地

### 项目文件（`.planning/`）

```
.planning/
├── PROJECT.md              # Project vision, constraints, decisions, evolution rules
├── REQUIREMENTS.md         # Scoped requirements (v1/v2/out-of-scope)
├── ROADMAP.md              # Phase breakdown with status tracking
├── STATE.md                # Living memory: position, decisions, blockers, metrics
├── config.json             # Workflow configuration
├── MILESTONES.md           # Completed milestone archive
├── research/               # Domain research from /gsd-new-project
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # Brownfield mapping (from /gsd-map-codebase or /gsd-onboard)
├── onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
│   ├── STACK.md            # YAML frontmatter carries `last_mapped_commit`
│   ├── ARCHITECTURE.md     # for the post-execute drift gate (#2003)
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # User preferences (from discuss-phase)
│       ├── XX-RESEARCH.md      # Ecosystem research (from plan-phase)
│       ├── XX-YY-PLAN.md       # Execution plans
│       ├── XX-YY-SUMMARY.md    # Execution outcomes
│       ├── XX-VERIFICATION.md  # Post-execution verification
│       ├── XX-VALIDATION.md    # Nyquist test coverage mapping
│       ├── XX-UI-SPEC.md       # UI design contract (from ui-phase)
│       ├── XX-UI-REVIEW.md     # Visual audit scores (from ui-review)
│       └── XX-UAT.md           # User acceptance test results
├── quick/                  # Quick task tracking
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # Captured ideas
│   └── completed/          # Completed todos
├── threads/               # Persistent context threads (from /gsd-thread)
├── seeds/                 # Forward-looking ideas (from /gsd-capture --seed)
├── debug/                  # Active debug sessions
│   ├── *.md                # Active sessions
│   ├── resolved/           # Archived sessions
│   └── knowledge-base.md   # Persistent debug learnings
├── ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
└── continue-here.md        # Context handoff (from pause-work)
```

### 执行后代码库漂移关卡（#2003）

在 `/gsd-execute-phase` 最后一个波次提交后，工作流运行一个非阻塞性的 `codebase_drift_gate` 步骤（位于 `schema_drift_gate` 和 `verify_phase_goal` 之间）。它将 diff `last_mapped_commit..HEAD` 与 `.planning/codebase/STRUCTURE.md` 进行对比，并统计四类结构性元素：

1. 映射路径之外的新目录
2. `(packages|apps)/<name>/src/index.*` 处的新桶形导出
3. 新迁移文件
4. `routes/` 或 `api/` 下的新路由模块

若数量达到 `workflow.drift_threshold`（默认为 3），关卡将**警告**（默认）并显示建议的 `/gsd-map-codebase --paths …` 命令，或**自动重新映射**（`workflow.drift_action = auto-remap`），方法是派生 `gsd-codebase-mapper` 并将其范围限定为受影响的路径。检测或重新映射过程中的任何错误都会被记录，阶段继续执行——漂移检测不会导致验证失败。

`last_mapped_commit` 存储在每个 `.planning/codebase/*.md` 文件顶部的 YAML 前置元数据中；`bin/lib/drift.cjs` 提供 `readMappedCommit` 和 `writeMappedCommit` 往返辅助函数。

---

## 安装程序架构

安装程序（`bin/install.js`，约 10,700 行）处理以下事项：

1. **运行时检测** — 交互式提示或 CLI 标志（`--claude`、`--opencode`、`--gemini`、`--kilo`、`--codex`、`--copilot`、`--antigravity`、`--cursor`、`--windsurf`、`--augment`、`--trae`、`--qwen`、`--hermes`、`--codebuddy`、`--cline`、`--all`）
2. **位置选择** — 全局（`--global`）或本地（`--local`）
3. **文件部署** — 复制命令、技能、工作流、参考文档、模板、Agent 和 hook
4. **运行时适配** — 按运行时转换文件内容：
  - Claude Code：原样使用
  - OpenCode：将命令/Agent 转换为 OpenCode 兼容的扁平命令 + 子 Agent 格式
  - Kilo：复用 OpenCode 转换流水线，使用 Kilo 配置路径
  - Codex：从命令生成 TOML 配置 + 技能
  - Copilot：映射工具名称（Read→read、Bash→execute 等）
  - Gemini：调整 hook 事件名称（`AfterTool` 而非 `PostToolUse`）
  - Antigravity：以技能为主，使用 Google 模型等效项
  - Cursor：以技能为主，带 Cursor 规则引用
  - Windsurf：以技能为主，带 Windsurf 规则引用
  - Trae：以技能为主安装到 `~/.trae` / `./.trae`，不含 `settings.json` 或 hook 集成
  - Qwen Code：以技能为主，带 Qwen 品牌路径和提示词重写
  - Hermes Agent：在 `skills/gsd/` 下按类别分组的技能
  - CodeBuddy：以技能为主，带 CodeBuddy 路径和提示词重写
  - Cline：为基于规则的集成写入 `.clinerules`
  - Augment Code：以技能为主，完整技能转换和配置管理
5. **路径规范化** — 将 `~/.claude/` 路径替换为特定运行时路径
6. **设置集成** — 在运行时的 `settings.json` 中注册 hook
7. **补丁备份** — 自 v1.17 起，将本地修改的文件备份到 `gsd-local-patches/`，供 `/gsd-update --reapply` 使用
8. **清单跟踪** — 写入 `gsd-file-manifest.json` 以支持干净卸载
9. **卸载模式** — `--uninstall` 移除所有 GSD 文件、hook 和设置

安装时的文件移动、陈旧产物清理、配置重写和用户数据保留由安装程序迁移模块管理。请参阅[安装程序迁移](../installer-migrations.md)和 [ADR 0008](../adr/0008-installer-migration-module.md)。迁移模块还负责对旧版安装进行带关卡的首次基线扫描，在后续迁移移除或重写任何内容之前，对已知的运行时安装界面进行分类。

计划漂移防护（`plan_review.source_grounding`）——在执行前验证生成计划中的符号引用是否与实时源代码匹配——详见 [ADR 22](../adr/22-plan-drift-guard.md)。

### 平台处理

- **Windows：** 在子进程上设置 `windowsHide`，对受保护目录进行 EPERM/EACCES 保护，路径分隔符规范化
- **WSL：** 检测在 WSL 上运行的 Windows Node.js 并警告路径不匹配
- **Docker/CI：** 支持 `CLAUDE_CONFIG_DIR` 环境变量，用于自定义配置目录位置

---

## Hook 系统

### 架构

```
Runtime Engine (Claude Code / Gemini CLI)
    │
    ├── statusLine event ──► gsd-statusline.js
    │   Reads: stdin (session JSON)
    │   Writes: stdout (formatted status), /tmp/claude-ctx-{session}.json (bridge)
    │
    ├── PostToolUse/AfterTool event ──► gsd-context-monitor.js
    │   Reads: stdin (tool event JSON), /tmp/claude-ctx-{session}.json (bridge)
    │   Writes: stdout (hookSpecificOutput with additionalContext warning)
    │
    └── SessionStart event ──► gsd-check-update.js
        Reads: VERSION file
        Writes: ~/.claude/cache/gsd-update-check.json (spawns background process)
```

### 上下文监控阈值


| 剩余上下文 | 级别     | Agent 行为                                |
| --------- | -------- | ----------------------------------------- |
| > 35%     | 正常     | 不注入警告                                |
| ≤ 35%     | 警告     | "避免开始新的复杂工作"                     |
| ≤ 25%     | 严重     | "上下文即将耗尽，请告知用户"               |


防抖：每次重复警告之间间隔 5 次工具使用。严重性升级（WARNING→CRITICAL）绕过防抖。

### 安全属性

- 所有 hook 包裹在 try/catch 中，出错时静默退出
- stdin 超时防护（3 秒），防止管道问题导致挂起
- 忽略陈旧指标（超过 60 秒）
- 优雅处理缺失的桥接文件（子 Agent、新会话）
- 上下文监控器为建议性——不发出覆盖用户偏好的命令式指令

### 软件包合法性关卡（v1.42.1）

研究者 → 规划者 → 执行者流水线包含一个针对 slopsquatting（AI 幻觉软件包名称被预先注册并附带恶意安装后脚本）的供应链关卡。

**威胁模型：** GSD 将从"研究者命名一个软件包"到"执行者运行 `npm install`"的完整路径自动化。一个通过 `npm view`（仅证明已注册，而非合法性）的幻觉名称此前可能未被检测到而流入。约 20% 的 AI 生成软件包引用是幻觉；其中约 43% 的名称在不同提示词中反复出现，使攻击者的预先注册在经济上可行。

**关卡层次：**

| 层次 | 组件 | 操作 |
|-------|-----------|--------|
| 研究 | `gsd-phase-researcher` | 运行 `slopcheck install <pkgs> --json`；向 RESEARCH.md 写入 `## Package Legitimacy Audit` 表格；在写入 RESEARCH.md 之前剥离 `[SLOP]` 软件包 |
| 规划 | `gsd-planner` | 读取审计表；在任何 `[ASSUMED]` 或 `[SUS]` 安装任务之前插入 `checkpoint:human-verify`；向 `<threat_model>` 添加 `T-{phase}-SC` STRIDE 供应链行 |
| 执行 | `gsd-executor` | 规则 3 将软件包安装排除在自动修复范围之外；失败的安装以检查点形式呈现，而非静默替换 |

**声明溯源集成：** 通过 WebSearch 发现的软件包名称被标记为 `[ASSUMED]`（而非 `[VERIFIED]`），无论 `npm view` 结果如何。这通过在安装边界将溯源标签强制执行为硬关卡，扩展了现有的 `[ASSUMED]` / `[VERIFIED]` / `[CITED]` 溯源系统——`[ASSUMED]` 始终在 PLAN.md 中生成 `checkpoint:human-verify`。

**生态系统覆盖：** 研究者使用特定于注册表的验证命令——`npm view`（Node）、`pip index versions`（Python）、`cargo search`（Rust）——而非单一通用检查。这能捕获跨生态系统幻觉（2025 年 USENIX 研究记录的发生率约为 9%）。

**优雅降级：** 若 `slopcheck` 不可用，每个推荐软件包都被标记为 `[ASSUMED]` 并通过检查点设置关卡。研究和规划继续进行；系统不会因缺少工具依赖而硬性失败。

**外部依赖：** `slopcheck`（MIT 协议，可通过 pip 安装）。若被废弃，`[ASSUMED]` 关卡回退机制维持人工检查点覆盖。

---

### 安全 Hook（v1.27）

有关 hook 和防护层如何融入更广泛安全方法的概念概述，请参阅[安全模型](explanation/security-model.md)。

**提示词防护**（`gsd-prompt-guard.js`）：

- 触发于对 `.planning/` 文件的 Write/Edit
- 扫描内容中的提示词注入模式（角色覆盖、指令绕过、系统标签注入）
- 仅建议性——记录检测结果，不阻止操作
- 模式已内联（`security.cjs` 的子集），以实现 hook 独立性

**工作流防护**（`gsd-workflow-guard.js`）：

- 触发于对非 `.planning/` 文件的 Write/Edit
- 检测 GSD 工作流上下文之外的编辑（无活动的 `/gsd-` 命令或任务子 Agent）
- 建议使用 `/gsd-quick` 或 `/gsd-fast` 进行状态跟踪的变更
- 通过 `hooks.workflow_guard: true` 选择启用（默认：false）

---

## 运行时抽象

GSD 通过统一的命令/工作流架构支持多种 AI 编码运行时：

### 运行时安装契约矩阵

此矩阵描述安装程序当前实现的运行时界面。迁移特定的所有权和源代码快照位于[安装程序迁移](../installer-migrations.md#runtime-configuration-contract-registry)中。

| 运行时 | 全局根目录 | 本地根目录 | 调用界面 | Agent 界面 | 配置与 hook |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | 全局 `skills/gsd-*/SKILL.md`；本地 `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` hook 和 statusLine 条目 |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` 或 `opencode.jsonc`；无 GSD hook |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` 或 `kilo.jsonc`；无 GSD hook |
| Gemini CLI | `~/.gemini` | `./.gemini` | `commands/gsd/*.toml` | `agents/gsd-*.md` | `settings.json` 功能标志、hook 和 statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | `agents/` 源 markdown 加每个 Agent 的 TOML | `config.toml` `[agents.gsd-*]`、`[features].hooks`（规范；遗留别名 `codex_hooks` 在重新安装时被识别并迁移到新版本，#3566）以及 hook 表 |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` 和 `copilot-instructions.md` | `.agent.md` 文件 | 无 GSD hook 或 statusline |
| Antigravity | 自动检测：`~/.gemini/antigravity`、`~/.gemini/antigravity-ide` 或 `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD 安装时的 Gemini 风格 `settings.json` hook 条目 |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的规则引用；无 GSD hook |
| Windsurf | `~/.codeium/windsurf` | `./.windsurf` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的规则引用；无 GSD hook |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 无 GSD hook 或 statusline |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 下的规则引用；无 GSD hook |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 设置及在支持时的 hook 条目 |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/DESCRIPTION.md` 加 `skills/gsd/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 设置及在支持时的 hook 条目 |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 通用 GSD 设置及在支持时的 hook 条目 |
| Cline | `~/.cline` | 项目根目录 | `.clinerules` | 仅规则 | 无 GSD hook 或 statusline |

### 上游契约来源

运行时安装预期在可用时对照主要文档进行检查。当前源代码快照为 2026-05-11：

- Claude Code：Anthropic 斜线命令、设置、hook 和子 Agent 文档。
- OpenCode 和 Kilo：OpenCode 配置文档和 Kilo 自定义子 Agent 文档。
- Gemini CLI 和 Qwen Code：命令/配置文档；Qwen 命令文档最后更新于 2026-05-06。
- Codex：OpenAI Codex 文档和 `config-schema.json`；安装程序还支持 Codex 0.124.0 的 Agent 表格格式兼容性。
- Copilot、Cursor、Cline、Augment、Hermes 和 CodeBuddy：自定义指令、规则、技能或配置的供应商文档。
- Antigravity、Windsurf 和 Trae：来源有限的行。安装程序记录了当前的兼容性垫片，迁移前必须刷新这些来源后再重写其配置。

### 抽象点

1. **工具名称映射** — 每个运行时有其自己的工具名称（例如 Claude 的 `Bash` → Copilot 的 `execute`）
2. **Hook 事件名称** — Claude 使用 `PostToolUse`，Gemini 使用 `AfterTool`
3. **Agent 前置元数据** — 每个运行时有其自己的 Agent 定义格式
4. **路径约定** — 每个运行时将配置存储在不同的目录中
5. **模型引用** — `inherit` 配置文件让 GSD 推迟到运行时的模型选择

安装程序在安装时处理所有转换。工作流和 Agent 以 Claude Code 的原生格式编写，并在部署期间进行转换。

---

## 相关文档

- [多 Agent 编排](explanation/multi-agent-orchestration.md)
- [安全模型](explanation/security-model.md)
- [CLI 工具](CLI-TOOLS.md)
- [文档索引](README.md)
