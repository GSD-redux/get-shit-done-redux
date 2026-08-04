# CONTEXT.md 结构参考

每个阶段的 `CONTEXT.md` 是 GSD Core 用于保存 `/gsd-discuss-phase` 阶段所收集的实现决策的载体。它是研究代理和规划代理的主要上游输入。本页面记录其结构。参见[文档索引](../README.md)。

---

## 概述

每个经过讨论工作流处理的阶段，均会在以下路径生成一份 `CONTEXT.md`：

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

示例：`.planning/phases/03-post-feed/03-CONTEXT.md`。

该文件由 `gsd-core/workflows/discuss-phase.md` 中的 `write_context` 步骤生成（或通过 PRD/ADR 摄入快速路径生成）。在正常操作中，该文件不会被手动编辑——讨论阶段工作流负责写入，下游代理将其作为封闭的可信来源读取。

---

## 前言（Frontmatter）

`CONTEXT.md` 不包含 YAML 前言。元数据以内联形式写在正文顶部：

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

`Status` 字段在文件首次写入时始终为 `Ready for planning`，创建后不再更新。

---

## 块结构

正文由若干具名 XML 风格的块组成，以固定顺序出现。下游代理通过块名而非行号来读取各块内容。

| 块名 | 用途 | 由谁填充 | 由谁消费 |
|---|---|---|---|
| `<domain>` | 声明阶段边界——本阶段交付内容及明确排除在范围之外的内容。在规划和执行过程中为范围护栏提供锚点。 | `discuss-phase`（来自 ROADMAP.md 阶段目标） | `gsd-planner`、`gsd-plan-checker`（范围合规性） |
| `<spec_lock>` | 仅在 `check_spec` 步骤发现 `*-SPEC.md` 时才存在。列出锁定的需求数量和范围边界；代理被指示直接读取 `SPEC.md` 以获取完整需求。 | `discuss-phase`（条件性） | `gsd-planner`（直接读取 SPEC.md，而非在此重读需求） |
| `<decisions>` | 从讨论中收集的实现决策，使用 `D-NN` 标识符标注。分类由实际讨论内容产生，而非固定分类体系。包含 `Claude's Discretion` 子节，用于用户委托代理自行决定的领域。 | `discuss-phase`（交互式讨论） | `gsd-planner`（锁定的决策必须实现）、`gsd-plan-checker`（维度 7 合规性） |
| `<canonical_refs>` | 与本阶段相关的所有规格文档、ADR、功能文档或设计文档的完整相对路径。必填——每份 CONTEXT.md 必须包含此节。代理在规划或实现之前必须读取列出的文件。 | `discuss-phase`（从 ROADMAP.md 引用 + 讨论中的用户引用 + 代码库侦查积累） | `gsd-phase-researcher`、`gsd-planner` |
| `<code_context>` | 在 `scout_codebase` 步骤中发现的可复用资产、已建立的模式和集成点。引导代理使用现有代码，而非重新实现。 | `discuss-phase`（代码库侦查） | `gsd-planner`、`gsd-phase-researcher` |
| `<specifics>` | 讨论期间逐字记录的具体"我希望它像 X 一样"的参考、产品对比或特定示例。 | `discuss-phase`（自由形式用户输入） | `gsd-planner` |
| `<deferred>` | 讨论中出现但属于其他阶段的想法，予以保留以免遗失。当待办事项经过审查但未纳入范围时，包含 `Reviewed Todos` 子节。 | `discuss-phase`（范围蔓延重定向） | 不被自动化代理消费；仅供人工参考 |

---

## 决策标识符格式

`<decisions>` 中的每条决策均带有顺序编号的 `D-NN` 标识符：

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

标识符的作用域限定在阶段内。第 3 阶段中的 `D-01` 与第 7 阶段中的 `D-01` 无关。计划检查器（维度 7）会验证每个 `D-NN` 是否在生成计划中至少有一个任务动作加以覆盖。

---

## 规范引用

`<canonical_refs>` 块为**必填项**。如果代理发现其缺失，会将该 CONTEXT.md 视为不完整并发出警告。条目按主题分组，包含完整相对路径以及对文件所决定或定义内容的简要说明：

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

当项目没有外部规格文档时，该节应明确说明：

```
No external specs — requirements fully captured in decisions above
```

在 `<decisions>` 中散落的内联提及（如"参见 ADR-019"）是不够的；代理需要在专用节中获取完整路径。

---

## 决策覆盖关卡关系

计划检查器的**维度 7：上下文合规性**在规划完成后执行覆盖关卡检查：

1. `<decisions>` 中的每个 `D-NN` 标识符必须出现在至少一个计划任务的 `<action>` 或说明中。
2. 任何任务均不得实现 `<deferred>` 中列出的内容（即范围蔓延）。
3. `Claude's Discretion` 领域免于此检查——规划者可自由选择。

决策被成功纳入计划的 CONTEXT.md 被视为合规。决策被悄然丢弃或部分交付的 CONTEXT.md 会触发**维度 7b：范围缩减检测**，这始终是一个**阻断项**。

---

## SPEC.md 集成

当 `/gsd-spec-phase` 在讨论阶段之前运行时，`check_spec` 步骤会找到 `*-SPEC.md` 文件并激活 `<spec_lock>`：

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

当 `<spec_lock>` 存在时，`<decisions>` 中仅包含来自讨论的实现决策——即"如何做"，而非"做什么"。需求不会在两个文件之间重复。

---

## 页脚

每份 CONTEXT.md 以身份页脚结尾：

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## 相关内容

- [PLAN.md 结构](plan-md.md)
- [规划产物](planning-artifacts.md)
- [讨论模式](../workflow-discuss-mode.md)
- [文档索引](../README.md)
