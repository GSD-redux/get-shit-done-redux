# STATE.md 架构参考

`STATE.md` 是 GSD Core 的动态项目记忆文件——一个记录项目当前状态、最近发生的事情以及下一步操作的单一 Markdown 文档。本页面记录其结构。参见[文档索引](../README.md)。

---

## 概述

由 GSD Core 管理的每个项目在 `.planning/STATE.md` 处保存一个 `STATE.md`。该文件在每次工作流开始时被读取，并在每次重要操作后被写入。该文件包含：

- **YAML 前置数据** — 机器可读字段，由状态行钩子（`parseStateMd`）和 `gsd-tools state` 命令使用。
- **Markdown 正文** — 人类可读的章节，涵盖当前位置、累积的上下文、会话连续性以及性能指标。

该文件有意保持较小（目标：不超过 100 行）。它是项目状态的摘要，而非存档。

---

## YAML 前置数据

前置数据出现在文件最开头的 `---` 分隔符之间。除 `gsd_state_version` 和 `status` 外，所有字段均为可选；当相关数据尚不可用时，字段可以缺失。

### 注释示例

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# Phase-lifecycle fields — all optional (added in v1.40.0, issue #2833)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# Additional fields written by syncStateFrontmatter
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

### 字段参考

| 字段 | 类型 | 填充时机 | 用途 |
|---|---|---|---|
| `gsd_state_version` | 字符串（`'1.0'`） | 始终 | 架构版本；在第一次 `state.*` 调用时由 `syncStateFrontmatter` 写入。 |
| `milestone` | 字符串（如 `v2.0`） | 配置了里程碑时 | 当前里程碑版本，从项目配置中读取。 |
| `milestone_name` | 字符串 | 配置了里程碑时 | 里程碑的人类可读标签（如 `Code Quality`）。 |
| `status` | 字符串 | 始终 | 当前生命周期阶段。由 `normalizeStateStatus()` 规范化——参见[状态值](#状态值)。 |
| `active_phase` | 字符串（如 `"4.5"`） | 编排器命令正在处理该阶段时 | 当前正在处理的阶段编号。阶段之间时设为 `null`。 |
| `next_action` | 字符串 | 空闲且有推荐命令时 | 下一步要运行的斜线命令：`discuss-phase`、`plan-phase`、`execute-phase` 或 `verify-phase`。当编排器正在运行或无可用推荐时设为 `null`。 |
| `next_phases` | YAML 流数组（如 `["4.5"]`） | 与 `next_action` 配合使用 | `next_action` 适用的阶段 ID（通常 1–2 项）。与 `next_action` 相同条件下设为 `null`。 |
| `progress.total_phases` | 整数 | 阶段数据可用时 | 当前里程碑中的阶段总数，从 ROADMAP.md 和阶段目录派生。 |
| `progress.completed_phases` | 整数 | 阶段数据可用时 | 磁盘上所有计划摘要均已存在的阶段数量（即每个计划均已完成）。 |
| `progress.total_plans` | 整数 | 计划文件存在时 | 当前里程碑中所有阶段的计划文件总数。 |
| `progress.completed_plans` | 整数 | 摘要文件存在时 | 已完成的计划摘要总数（每个已执行计划一个 SUMMARY.md）。 |
| `progress.percent` | 整数 0–100 | 进度数据可用时 | 里程碑在**阶段维度**的进度（`min(completed_plans/total_plans, completed_phases/total_phases)`）。状态行进度条仅在该字段存在时渲染——缺失时进度条不显示。 |
| `current_phase` | 字符串 | 阶段正在执行时 | 从正文 `Current Phase:` 字段提取的阶段编号。 |
| `current_phase_name` | 字符串 | 阶段有名称时 | 从正文 `Current Phase Name:` 字段提取的阶段名称。 |
| `current_plan` | 字符串 | 计划进行中时 | 从正文 `Current Plan:` 字段提取的计划编号。 |
| `last_updated` | ISO-8601 时间戳 | 始终（写入时） | 最后一次 `syncStateFrontmatter` 调用的时间戳；由 `realClock.nowIso()` 写入。 |
| `state_head` | string (40-char sha) | On write, when the project's own git repo resolves | Full commit sha STATE.md was written against (#2573). Omitted entirely outside a git repo, or when the resolved repo is not the project's own — an unverifiable stamp degrades to absent rather than asserting provenance the file does not have. Recomputed on every write and never carried forward. |
| `last_activity` | 字符串 | 正文中设置时 | 最后活动日期，从正文 `Last Activity:` 字段提取。 |
| `stopped_at` | 字符串 | 记录了停止点时 | 最后完成操作的描述；限定在 `## Session` 正文章节内，以避免匹配存档文本。 |
| `paused_at` | 字符串 | 项目已暂停时 | 暂停点的自由描述；未暂停时缺失或为 `null`。 |

### 状态值

`gsd-core/bin/lib/state-document.cjs` 中的 `normalizeStateStatus()` 将原始正文文本映射到以下规范值：

| 规范值 | 匹配文本（不区分大小写） |
|---|---|
| `discussing` | 包含 `discussing` |
| `planning` | 包含 `planning` 或 `ready to plan` |
| `executing` | 包含 `executing`、`in progress` 或 `ready to execute` |
| `verifying` | 包含 `verif` |
| `completed` | 包含 `complete` 或 `done` |
| `paused` | 包含 `paused` 或 `stopped`，或 `paused_at` 有值 |
| `unknown` | 以上均不符合 |

当编排器命令正在运行时，惯例（issue #2833）是直接将生命周期阶段写入 `status`：

| 命令 | 运行期间的 `status` |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

---

## 状态行渲染场景

`hooks/gsd-statusline.js` 中的 `formatGsdState()` 读取已解析的前置数据并输出**第一个匹配的场景**。如果没有新的生命周期字段适用，渲染将回退到与 v1.38.x 完全一致的原始格式。

| 场景 | 触发条件 | 显示示例 |
|---|---|---|
| **1. 阶段活跃** | `active_phase` 已填充 | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. 空闲，有下一步推荐** | `active_phase` 为 null 且 `next_action` 和 `next_phases` 均已填充 | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. 里程碑完成** | `percent` 为 `100` 或 `completed_phases == total_phases` | `v2.0 [██████████] 100% · milestone complete` |
| **4. 默认回退** | 以上均不匹配 | `v1.9 Code Quality · executing · ph 1/5`（现有格式） |

**场景优先级：** 当 `active_phase` 和 `next_action` 均已填充时，场景 1 优先——编排器正在运行，显示"下一步推荐"会造成误导。此优先级由 `formatGsdState()` 中的检查顺序强制执行，并由 `tests/gsd-statusline.test.cjs` 中的 `"scene priority"` 测试套件覆盖。

进度条（`[██░░░░░░░░] 20%`）仅在前置数据中存在 `progress.percent` 时才追加到里程碑段；缺失则不显示进度条。

---

## 前置数据解析约束

状态行钩子使用基于正则表达式的解析（无完整 YAML 库），因此以下约束适用。这些约束在 `tests/gsd-statusline.test.cjs` 中经过测试。

1. **前置数据必须从文件的第一个字符开始。** 任何内容——包括注释——出现在开头 `---` 之前都会使匹配失效。开头的 `---` 行必须恰好如此，不能有尾随空格。

2. **不支持嵌套块内的注释。** `progress:` 块解析器要求下一行为 `[ \t]+\w+:`。在 `progress:` 和其第一个键之间插入 `# comment` 会破坏匹配，进度条将消失。任何说明文档应放在 `STATE.md` 正文中，而不是放在前置数据块内。

3. **`next_phases` 首选格式为单行流式。** 解析器首先尝试 `next_phases: ["4.5", "4.6"]`。块序列（`- 4.5\n- 4.6`）也可解析，但对状态行渲染的可靠性较低。优先使用单行流式格式的 `next_phases` 以保持基于正则表达式的解析器的可预测性。如果需要记录大量候选阶段以供文档说明，请将其存储在 `STATE.md` 正文中。

如果未来的变更将正则表达式解析器替换为完整的 YAML 库，则这些约束可以放宽，并相应更新测试。

---

## Markdown 正文章节

正文（结束 `---` 之后的所有内容）遵循 `gsd-core/templates/state.md` 中的模板。标准章节为：

### 项目参考

指向 `.planning/PROJECT.md`。包含：
- **核心价值** — 来自 `PROJECT.md` 核心价值章节的一句话说明。
- **当前焦点** — 哪个阶段处于活跃状态。

### 当前位置

项目当前所处的状态：

| 字段 | 格式 |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | 自由文本，如 `Ready to execute`、`Executing Phase 4`、`Phase complete — ready for verification` |
| `Last activity:` | 处理器写入时为 ISO 日期（`YYYY-MM-DD`）；执行器编写时为叙述性文本 |
| `Progress:` | 可视化进度条，如 `[████░░░░░░] 40%` |

当现有值为已知模板默认值时，该章节中的 `Status:` 和 `Last activity:` 字段由 GSD 处理器更新（Knuth 不变式：执行器编写的值被保留）。已知处理器默认值的完整列表位于 `gsd-core/bin/lib/state-document.cjs` 中的 `KNOWN_TEMPLATE_DEFAULTS`。

### 性能指标

执行速度跟踪：
- 已完成计划总数，每个计划的平均耗时。
- 每阶段明细表（`Phase | Plans | Total | Avg/Plan`）。
- 近期趋势：改善中 / 稳定 / 下降中。

每次计划完成后更新。

### 累积的上下文

**决策** — 影响当前工作的近期决策摘要（完整日志在 `PROJECT.md` 中）。通过 `gsd-tools state add-decision` 添加。

**待处理的待办事项** — 数量及对 `.planning/todos/pending/` 的引用。通过 `/gsd-capture` 捕获。

**阻碍/关切** — 影响未来工作的问题，以发起阶段为前缀。通过 `gsd-tools state add-blocker` 添加；通过 `gsd-tools state resolve-blocker` 解决。

### 会话连续性

实现即时会话恢复：
- `Last session:` — 上次会话的 ISO-8601 时间戳。
- `Stopped at:` — 最后完成操作的描述。
- `Resume file:` — 指向 `.continue-here*.md` 文件的路径（若存在），否则为 `None`。

---

## 向后兼容性

阶段生命周期字段（`active_phase`、`next_action`、`next_phases` 以及用于进度条的 `progress.percent`）是**按项目可选添加**的：

- 未填充任何生命周期字段的 `STATE.md` 渲染结果与 v1.38.x 及更早版本**逐字节完全相同**。
- 添加任何生命周期字段是可选的——当字段缺失时，渲染器会优雅降级。
- 即使 `progress` 块存在，进度条也是可选的：只有 `progress.percent` 触发进度条；单独的 `total_phases` 和 `completed_phases` 不会触发。

`tests/gsd-statusline.test.cjs` 中的 `formatGsdState #2833 backward compatibility` 测试套件锁定了此保证；任何破坏旧版 `STATE.md` 渲染的变更都将导致该套件失败。

---

## 相关内容

- [规划产物](planning-artifacts.md)
- [配置](../CONFIGURATION.md)
- [阶段循环](../explanation/the-phase-loop.md)
- [文档索引](../README.md)
