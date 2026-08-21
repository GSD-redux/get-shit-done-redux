# 如何为阶段设计 UI

**目标：** 生成一份已锁定的 UI 设计契约（`UI-SPEC.md`），在规划者编写任务之前，确定间距、颜色、字体和文案的决策，从而防止执行阶段因随意选择样式导致视觉不一致。

**前置条件：** `.planning/ROADMAP.md` 已存在，且该阶段包含前端或 UI 工作。强烈建议先运行 `/gsd-discuss-phase N`——UI 研究员会读取 `CONTEXT.md`，以避免重复询问您已经做出的决策。

---

## 判断此阶段是否需要 UI 契约

并非所有阶段都需要 `/gsd-ui-phase`。在以下情况下使用它：

- 该阶段引入新的 UI 界面（页面、流程、布局）
- 将构建多个组件，且视觉一致性至关重要
- 您正在为新项目的前端建立设计系统基线
- 您正在为现有项目新增大量 UI 工作，希望在执行前锁定 token、间距和颜色

在以下情况下跳过它：

- 该阶段纯粹是后端、基础设施或数据工作，没有面向用户的输出
- 早期阶段已存在 UI-SPEC.md，且此阶段在完全相同的视觉模式上构建，不引入新界面

如果不确定，安全门会提示您：当 `workflow.ui_safety_gate` 启用时（默认启用），`/gsd-plan-phase` 在检测到前端工作但没有 UI-SPEC.md 时会发出警告，并询问是否先运行 `/gsd-ui-phase`。

---

## 运行 UI 设计契约

```bash
/gsd-ui-phase 2
```

如果未指定阶段编号，GSD Core 会以当前阶段为目标。

该命令分两个阶段运行：

1. **`gsd-ui-researcher`** — 读取 `CONTEXT.md`、`RESEARCH.md` 和 `REQUIREMENTS.md` 中的已有决策，检测设计系统状态（shadcn `components.json`、Tailwind 配置、现有 token），并仅针对以下五个领域中尚未回答的设计问题进行提问：间距、颜色、字体、文案和注册表安全。
2. **`gsd-ui-checker`** — 从七个维度验证生成的 `UI-SPEC.md`。如果发现问题，修订循环会重新运行研究员（最多两次迭代），专门针对被标记的项目。

**输出：** `.planning/phases/{phase-dir}/` 中的 `{padded_phase}-UI-SPEC.md`。

---

## UI-SPEC 涵盖的内容

研究员在五个领域锁定决策：

| 领域 | 示例 |
|---|---|
| **间距** | 基础比例（4px 或 8px）、网格对齐、组件内边距 |
| **颜色** | 主色、强调色、中性色调色板；60/30/10 规则；深色模式考量 |
| **字体** | 字体家族、字号/字重比例约束、标题层次结构 |
| **文案** | CTA 标签、空状态消息、错误状态文案、加载指示器 |
| **注册表安全** | shadcn 组件检查协议（见下文） |

检查器按六个支柱验证规格，每项评分 1–4：文案、视觉、颜色、字体、间距和体验设计（加载/错误/空状态覆盖）。

---

## shadcn 初始化

对于 React、Next.js 和 Vite 项目，若未找到 `components.json`，研究员会提议初始化 shadcn。流程如下：

1. 访问 `ui.shadcn.com/create`，配置您的预设（颜色、边框圆角、字体）
2. 复制预设字符串
3. 运行：

```bash
npx shadcn init --preset <paste>
```

预设字符串成为 GSD Core 规划产物中的一等公民，可在各阶段和里程碑间复现。

---

## 注册表安全门

第三方 shadcn 注册表可能注入任意代码。当 `workflow.ui_safety_gate` 启用时（默认启用），规格要求在安装任何非官方组件之前执行以下步骤：

```bash
npx shadcn view <component>   # inspect source before installing
npx shadcn diff <component>   # compare against the official registry
```

如果未处理注册表安全问题，检查器会将规格标记为 BLOCKED。若您的项目不使用 shadcn，或您有其他审查流程，可通过 `/gsd-settings` 禁用此门控。

---

## 使用草图发现结果作为起点

如果您已运行 `/gsd-sketch --wrap-up`，UI 研究员会自动加载 `.claude/skills/sketch-findings-[project]/`。经过预验证的决策（布局、调色板、字体、间距）将被视为已锁定——研究员不会重新询问它们。运行开始时会显示一条提示：

```text
⚡ Sketch findings detected: .claude/skills/sketch-findings-[project]/SKILL.md
   Pre-validated decisions (layout, palette, typography, spacing) should be treated
   as locked — not re-asked.
```

这是在 `/gsd-ui-phase` 之前运行 `/gsd-sketch --wrap-up` 的主要原因：它将对话式的设计探索转化为具有约束力的契约输入。

---

## 使用 `/gsd-ui-review` 进行事后视觉审计

`/gsd-ui-review` 在执行之后运行，而非之前。用它来对照 UI-SPEC 审计已实现的前端（当没有规格时，则对照抽象的六支柱标准进行审计）。

```bash
/gsd-ui-review        # audit the current phase
/gsd-ui-review 3      # audit phase 3 specifically
```

它适用于任何包含前端代码的项目——不需要 GSD 项目初始化。

**检查内容（六支柱，每项评分 1–4）：**

1. 文案 — CTA 标签、空状态、错误状态
2. 视觉 — 焦点、视觉层次、图标无障碍性
3. 颜色 — 强调色使用规范、60/30/10 合规性
4. 字体 — 字号和字重约束遵循情况
5. 间距 — 网格对齐、token 一致性
6. 体验设计 — 加载、错误和空状态覆盖

**输出：** `{padded_phase}-UI-REVIEW.md`，包含评分和前三项优先修复事项。当配置了 `gsd-browser` 等浏览器 MCP 服务器时，审计还会捕获截图作为视觉证据。

**截图存储：** 截图保存至 `.planning/ui-reviews/`。系统会自动创建 `.gitignore` 以防止二进制文件提交到 git。截图会在 `/gsd-complete-milestone` 期间清理。

---

## 在阶段生命周期中的推荐位置

```text
/gsd-discuss-phase N      ← lock implementation preferences
/gsd-ui-phase N           ← lock design contract (frontend phases)
/gsd-plan-phase N         ← research + plan (reads UI-SPEC.md as context)
/gsd-execute-phase N      ← parallel execution
/gsd-verify-work N        ← manual UAT
/gsd-ui-review N          ← retroactive visual audit (optional but recommended)
```

`/gsd-ui-phase` 位于 discuss 和 plan 之间，因为规划者会将 `UI-SPEC.md` 作为设计上下文读取——`PLAN.md` 中的任务会引用规格锁定的间距 token、颜色变量和文案决策。

---

## 相关文档

- [Spike 与草图](spike-and-sketch.md)
- [规划阶段](plan-a-phase.md)
- [命令参考](../COMMANDS.md)
- [文档索引](../README.md)
