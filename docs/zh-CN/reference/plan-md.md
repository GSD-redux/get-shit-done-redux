# PLAN.md 模式参考

每个计划的 `PLAN.md` 是 GSD Core 的可执行工作单元——一份结构化文档，精确告知执行器代理需要构建什么以及如何验证构建是否正确完成。本页记录其结构。参见[文档索引](../README.md)。

---

## 概述

计划存放在以下位置的阶段目录中：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

例如：`.planning/phases/03-post-feed/03-02-PLAN.md`（第 3 阶段，第 2 计划）。

计划由 `gsd-planner` 代理生成（由 `/gsd-plan-phase` 触发），并由 `execute-phase` 消费。一个阶段通常包含一到四个计划；同一阶段内的计划被分配到执行波次，以便独立工作并行运行。

---

## YAML 前置元数据

每个 PLAN.md 以位于 `---` 分隔符之间的 YAML 前置元数据块开头。

### 注释示例

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

### 前置元数据字段参考

| 字段 | 是否必填 | 类型 | 用途 |
|---|---|---|---|
| `phase` | 是 | string | 阶段标识符，例如 `03-post-feed`。 |
| `plan` | 是 | string | 阶段内的计划编号，例如 `02`。 |
| `type` | 是 | `execute` 或 `tdd` | 标准计划使用 `execute`；测试驱动计划使用 `tdd`，测试在实现之前编写。 |
| `wave` | 是 | integer | 执行波次。波次 1 中的计划并行运行（无依赖关系）。波次 2 及以上的计划等待上一波次的所有计划完成后才开始。由 `gsd-planner` 在规划时预先计算。 |
| `depends_on` | 是 | array of plan IDs | 该计划必须等待的前置计划。空数组表示波次 1。示例：`["03-01"]` 表示该计划在第 3 阶段计划 01 完成后运行。 |
| `files_modified` | 是 | array of paths | 该计划创建或修改的所有文件。被计划检查器用于检测同波次文件冲突，也被 execute-phase 用于合并跟踪。 |
| `autonomous` | 是 | boolean | 当所有任务类型均为 `auto` 时为 `true`。当计划包含任何需要人工交互的 `checkpoint:*` 任务时为 `false`。 |
| `requirements` | 是 | array of IDs | 该计划所对应的 ROADMAP.md 中的需求 ID。每个阶段需求 ID 必须出现在至少一个计划的 `requirements` 字段中。空数组是阻断项（BLOCKER）。 |
| `user_setup` | 否 | array of objects | Claude 无法自动化的外部服务设置步骤（账户创建、密钥获取、控制台配置）。存在时，execute-phase 会为开发者生成 `USER-SETUP.md` 检查清单。 |
| `must_haves` | 是 | object | 以目标为导向的验证标准。详见下文。 |

---

## `must_haves` 字段

`must_haves` 描述了阶段目标达成后必须可观测到的真实状态。该字段在规划阶段派生，并在执行后由 `gsd-verifier` 代理验证。

### 子字段

| 子字段 | 类型 | 用途 |
|---|---|---|
| `truths` | array of strings | 从用户视角可观测到的行为。每项必须可验证。示例：`"User can send a message"`，而非 `"WebSocket library installed"`。 |
| `artifacts` | array of objects | 必须存在且具有实质性实现（非桩代码）的文件。 |
| `artifacts[].path` | string | 相对于项目根目录的文件路径。 |
| `artifacts[].provides` | string | 该文件所提供的能力。 |
| `artifacts[].min_lines` | integer（可选） | 被视为非桩代码的最小行数。 |
| `artifacts[].exports` | array of strings（可选） | 需要验证的预期命名导出项。 |
| `artifacts[].contains` | string（可选） | 必须出现在文件中的正则表达式或字面量模式。 |
| `key_links` | array of objects | 制品之间的关键连接——使系统端到端运行的接线。 |
| `key_links[].from` | string | 源文件或组件。 |
| `key_links[].to` | string | 目标文件、端点或模块。 |
| `key_links[].via` | string | 连接方式描述（例如 `fetch in useEffect`、`Prisma query`、`import`）。 |
| `key_links[].pattern` | string（可选） | 用于验证源代码中连接是否存在的正则表达式。 |

---

## 正文结构

前置元数据之后，计划正文使用执行器代理读取的具名 XML 风格块。

### `<objective>`

说明计划所交付的内容及其对项目的重要性：

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

列出执行器在开始前读取的工作流文件。始终包含 execute-plan 工作流；当计划包含检查点任务时，额外添加检查点参考：

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

### `<context>`

引用执行器需要读取的源文件。包括项目级规划文档以及计划必须复用其模式或类型的源文件。仅当后续计划对其类型或决策存在真实依赖时，才引用前序计划的 `SUMMARY.md` 文件——而非无条件引用：

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

包含一个或多个 `<task>` 元素。对于 `type="auto"` 的任务，每个任务元素必须包含 `<name>`、`<files>`、`<read_first>`、`<action>`、`<verify>`、`<acceptance_criteria>` 和 `<done>`。

---

## 任务类型

| 类型 | 使用场景 | 自主程度 |
|---|---|---|
| `auto` | 执行器可独立完成的所有内容。 | 完全自主。 |
| `checkpoint:human-verify` | 需要人工查看运行中的界面或服务进行视觉或功能验证。 | 暂停执行；呈现给开发者；批准后恢复。 |
| `checkpoint:decision` | 执行过程中出现的需要开发者输入的实现选择。 | 暂停执行；呈现选项；选择后恢复。 |
| `checkpoint:human-action` | 真正不可避免的手动步骤（账户创建、硬件交互）。谨慎使用。 | 暂停执行；确认后恢复。 |

包含任何检查点任务的计划必须在前置元数据中设置 `autonomous: false`。

---

## `auto` 任务结构

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

### `auto` 任务必填字段

| 字段 | 规则 |
|---|---|
| `<files>` | 任务创建或修改的所有文件。执行器只写入这些文件。 |
| `<read_first>` | 执行器在修改任何内容之前必须读取的文件——包括待修改文件、任何真实来源的模式文件以及必须复用其类型或约定的文件。 |
| `<action>` | 包含精确标识符、文件路径、函数签名和预期值的具体指令。不能在未指定目标状态的情况下说"将 X 与 Y 对齐"。不包含代码围栏块或完整实现。 |
| `<verify>` | 可运行的命令或检查，用于证明任务已成功完成。必须能区分通过与失败——`echo "done"` 无效。 |
| `<acceptance_criteria>` | 可验证的条件：可通过 grep 验证的字符串、命令退出码、可观测行为。不含主观性语言（"看起来正确"、"配置正确"）。 |
| `<done>` | 已完成结果的简短可量化陈述。 |

---

## 计划质量维度

`gsd-plan-checker` 代理在执行开始前对每个 PLAN.md 进行 12 个维度的审查。任何未通过 BLOCKER 级别检查的计划将被退回给 `gsd-planner` 修订（最多 3 次迭代）：

| 维度 | 检查内容 |
|---|---|
| **1 — 需求覆盖率** | ROADMAP.md 中每个阶段需求 ID 出现在至少一个计划的 `requirements` 前置元数据字段中，并有相应的覆盖任务。 |
| **2 — 任务完整性** | 每个 `auto` 任务携带所有必填字段（`<files>`、`<action>`、`<verify>`、`<acceptance_criteria>`、`<done>`）。无模糊或空字段。 |
| **3 — 依赖正确性** | `depends_on` 引用有效、无循环，并与波次编号一致。第 N 波次计划仅依赖波次 < N 的计划。 |
| **4 — 关键链接规划** | `must_haves.key_links` 中的制品有对应的实现接线任务——而非仅创建制品。 |
| **5 — 范围合理性** | 计划保持在上下文预算内：每个计划 2–3 个任务（4 个 = 警告，5 个及以上 = BLOCKER），每个计划 ≤ 8–10 个文件（15 个及以上 = BLOCKER）。 |
| **6 — 验证推导** | `must_haves.truths` 是用户可观测行为，而非实现细节。制品映射到真实状态。关键链接覆盖关键接线。 |
| **7 — 上下文合规性** | CONTEXT.md 中每个 `D-NN` 决策至少由一个任务处理。没有任务实现 `<deferred>` 中的内容。 |
| **7b — 范围缩减检测** | 任务操作不会在未交付完整决策范围的情况下，悄悄将已锁定决策降级为"v1"、"桩代码"或"未来增强"。发现时始终为 BLOCKER。 |
| **7c — 架构层级合规性** | 任务按照 RESEARCH.md 架构责任映射（如存在）将能力分配到正确层级。安全敏感能力分配到错误层级时为 BLOCKER。 |
| **8 — 奈奎斯特合规性** | 当 `workflow.nyquist_validation` 已启用且 RESEARCH.md 存在时，每个任务有 `<automated>` 验证命令，连续 3 个任务的窗口内不缺少覆盖，且 VALIDATION.md 存在。 |
| **9 — 跨计划数据契约** | 当计划共享数据管道时，其转换相互兼容——没有计划删除另一个计划需要原始形式的数据。 |
| **10 — CLAUDE.md 合规性** | 计划遵守 `./CLAUDE.md` 中的项目特定约定、禁止模式、必需工具和安全要求。 |
| **11 — 研究解决** | 当 RESEARCH.md 存在时，其 `## Open Questions` 部分在规划继续之前标记为 `(RESOLVED)`。 |
| **12 — 模式合规性** | 当 PATTERNS.md 存在时，任务为每个新建或修改的文件引用正确的类比模式。 |

---

## 波次执行模型

波次编号在规划阶段预先计算。Execute-phase 按波次编号对计划进行分组，并行运行每个波次的计划：

```
Wave 1: Plan 01, Plan 02, Plan 03  (all run simultaneously — no dependencies)
Wave 2: Plan 04                    (waits for Wave 1 to complete)
Wave 3: Plan 05                    (waits for Wave 2 to complete)
```

同一波次中修改重叠文件的计划不得处于同一波次——计划检查器的维度 3 会将此标记为 BLOCKER。

---

## 计划输出

计划成功执行后，执行器在以下路径写入 SUMMARY.md：

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

SUMMARY.md 是所构建内容的权威记录。同一阶段内的后续计划，仅当对其类型或决策存在真实依赖时，才可引用该文件。

---

## 相关内容

- [CONTEXT.md 模式](context-md.md)
- [规划制品](planning-artifacts.md)
- [功能特性](../FEATURES.md)
- [文档索引](../README.md)
