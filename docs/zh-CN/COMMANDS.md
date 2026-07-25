# GSD Core 命令参考

> GSD Core 命令参考手册 — 所有稳定命令的语法、标志、选项及示例。功能详情请参阅[功能参考](FEATURES.md)；工作流程演示请参阅[用户指南](USER-GUIDE.md)；文档索引请参阅 [README](README.md)。

---

## 命令语法

- **Claude Code / Copilot / OpenCode / Kilo：** `/gsd-command-name [args]`（连字符形式）
- **Gemini CLI：** `/gsd:command-name [args]`（冒号形式 — Gemini 将命令置于 `gsd:` 命名空间下）
- **Codex：** `$gsd-command-name [args]`

连字符形式与冒号形式是*同一命令在不同运行时中的拼写方式*。无论使用哪种运行时，安装程序都会将正确的形式写入该运行时的命令目录。

---

## 命名空间元技能

v1.40 中，六个命名空间路由器作为第一阶段入口点随附发布。与平铺式 86 个技能列表（约 2150 个 token）相比，它们将预加载技能列表的 token 开销保持在较低水平（6 个路由器约 120 个 token），同时完整功能仍可直接调用。模型先选择命名空间，再路由到具体子技能。详见 [#2792](https://github.com/open-gsd/gsd-core/issues/2792)。

| 命令 | 路由至 |
|---------|-----------|
| `/gsd-workflow` | 阶段流水线 — discuss / plan / execute / verify / phase / progress |
| `/gsd-project` | 项目生命周期 — 里程碑、审计、摘要 |
| `/gsd-quality` | 质量关卡 — 代码审查、调试、审计、安全、评估、界面 |
| `/gsd-context` | 代码库智能 — 映射、图谱、文档、学习记录 |
| `/gsd-manage` | 管理 — 配置、工作区、工作流、线程、更新、发布、收件箱 |
| `/gsd-ideate` | 探索与捕捉 — 探索、草图、实验、规格、捕捉 |

命名空间技能是**叠加式**的 — 每个现有的具体命令（例如 `/gsd-plan-phase`、`/gsd-code-review --fix`）仍可直接调用。

---

## 核心工作流命令

### `/gsd-new-project`

通过深度上下文收集初始化新项目。

| 标志 | 描述 |
|------|-------------|
| `--auto @file.md` | 从文档中自动提取，跳过交互式问题 |

**前提条件：** 不存在 `.planning/PROJECT.md`
**产出：** `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md`、`config.json`、`research/`、`CLAUDE.md`

```bash
/gsd-new-project                    # 交互模式
/gsd-new-project --auto @prd.md     # 从 PRD 自动提取
```

---

### `/gsd-onboard`

引导现有代码库完成首次 GSD 接入。该命令检查仓库状态，安全地转到代码库映射、可选文档摄取、项目初始化，并在规划文件齐备后创建 onboarding summary。

| 标志 | 描述 |
|------|-------------|
| `--fast` | 优先使用轻量 `/gsd-map-codebase --fast` 映射交接；在 `/gsd-new-project` 前仍需要完整映射 |
| `--text` | 使用编号纯文本关卡，而不是 TUI 菜单 |

**前提条件：** 现有仓库或规划文档。空的绿地项目请使用 `/gsd-new-project`。
**产出：** 由 map-codebase 生成的 `.planning/codebase/`，由 new-project 或 ingest-docs 生成的 `.planning/`，以及项目设置后的 `.planning/onboarding/SUMMARY.md`。

```bash
/gsd-onboard           # 引导式 brownfield 接入
/gsd-onboard --fast    # 先使用轻量映射，并在项目设置前补全完整映射
```

---

### `/gsd-workspace`

管理 GSD 工作区 — 创建、列出或移除隔离的工作区环境，包含仓库副本和独立的 `.planning/` 目录。

| 标志 | 描述 |
|------|-------------|
| `--new` | 创建新工作区（与 `--name`、`--repos` 等配合使用） |
| `--list` | 列出活动的 GSD 工作区及其状态 |
| `--remove <name>` | 移除工作区并清理 git 工作树 |
| `--name <name>` | 工作区名称（与 `--new` 配合使用） |
| `--repos repo1,repo2` | 逗号分隔的仓库路径或名称（与 `--new` 配合使用） |
| `--path /target` | 目标目录（默认：`~/gsd-workspaces/<name>`） |
| `--strategy worktree\|clone` | 复制策略（默认：`worktree`） |
| `--branch <name>` | 要检出的分支（默认：`workspace/<name>`） |
| `--auto` | 跳过交互式问题 |

**使用场景：**
- 多仓库：在隔离的 GSD 状态下处理仓库子集
- 功能隔离：`--repos .` 为当前仓库创建工作树

**产出：** `WORKSPACE.md`、`.planning/`、仓库副本（工作树或克隆）

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
/gsd-workspace --new --name feature-b --repos . --strategy worktree  # 同仓库隔离
/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

### `/gsd-discuss-phase`

在规划前通过自适应提问收集阶段上下文。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号（默认为当前阶段） |

| 标志 | 描述 |
|------|-------------|
| `--all` | 跳过领域选择 — 交互式讨论所有灰色地带（不自动推进） |
| `--auto` | 自动为所有问题选择推荐的默认值 |
| `--batch` | 将问题分组批量输入，而非逐条处理 |
| `--analyze` | 在讨论期间添加权衡分析 |
| `--power` | 基于文件的批量问题解答，从预先准备的答案文件中读取 |
| `--assumptions` | 无需交互会话，直接呈现 Claude 对该阶段实现的假设 |

**前提条件：** `.planning/ROADMAP.md` 已存在
**产出：** `{phase}-CONTEXT.md`、`{phase}-DISCUSSION-LOG.md`（审计追踪）

```bash
/gsd-discuss-phase 1                # 阶段 1 的交互式讨论
/gsd-discuss-phase 1 --all          # 不经选择步骤讨论所有灰色地带
/gsd-discuss-phase 3 --auto         # 自动为阶段 3 选择默认值
/gsd-discuss-phase --batch          # 当前阶段的批量模式
/gsd-discuss-phase 2 --analyze      # 含权衡分析的讨论
/gsd-discuss-phase 1 --power        # 从文件批量解答
/gsd-discuss-phase 3 --assumptions  # 在规划前呈现 Claude 的假设
```

---

### `/gsd-ui-phase`

为前端阶段生成 UI 设计契约。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号（默认为当前阶段） |

**前提条件：** `.planning/ROADMAP.md` 已存在，该阶段包含前端/UI 工作
**产出：** `{phase}-UI-SPEC.md`

```bash
/gsd-ui-phase 2                     # 阶段 2 的设计契约
```

---

### `/gsd-plan-phase`

研究、规划并验证一个阶段。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号（默认为下一个未规划的阶段） |

| 标志 | 描述 |
|------|-------------|
| `--auto` | 跳过交互式确认 |
| `--research` | 即使 RESEARCH.md 已存在也强制重新研究 |
| `--skip-research` | 跳过领域研究步骤 |
| `--research-phase <N>` | 仅研究模式：为阶段 `<N>` 生成研究报告，写入 RESEARCH.md 后退出，不进入规划器。取代已删除的独立研究命令（#3042）。 |
| `--view` | 仅研究模式修饰符：与 `--research-phase` 配合使用时，将现有 RESEARCH.md 打印到标准输出并退出（不生成新报告）。RESEARCH.md 不存在时报错。 |
| `--gaps` | 差距闭合模式（读取 VERIFICATION.md，跳过研究） |
| `--skip-verify` | 跳过计划检查器验证循环 |
| `--prd <file>` | 使用 PRD 文件而非 discuss-phase 获取上下文 |
| `--ingest <path-or-glob>` | 使用 ADR 文件代替 discuss-phase 进行上下文综合 |
| `--ingest-format <auto\|nygard\|madr\|narrative>` | `--ingest` 的可选 ADR 解析器格式覆盖 |
| `--reviews` | 根据 REVIEWS.md 中的跨 AI 审查反馈重新规划 |
| `--bounce` | 规划完成后运行外部计划弹回验证（使用 `workflow.plan_bounce_script`） |
| `--skip-bounce` | 即使配置中已启用也跳过计划弹回 |
| `--mvp` | 垂直 MVP 模式 — 规划器将任务组织为功能切片（UI→API→DB），而非水平分层。在无先前阶段摘要的新项目第 1 阶段使用时，还会生成 `SKELETON.md`（行走骨架）。可通过在 ROADMAP.md 中设置 `**Mode:** mvp` 持久化应用于某阶段，届时无需标志即可自动应用 `--mvp`。 |
| `--tdd` | TDD 模式 — 规划器对符合条件的行为添加任务应用 `type: tdd`，使每个任务以失败测试开始。可与 `--mvp` 组合：`--mvp --tdd` 产生每个行为添加任务以红-绿流程开始的垂直切片。 |

**前提条件：** `.planning/ROADMAP.md` 已存在
**产出：** `{phase}-RESEARCH.md`、`{phase}-{N}-PLAN.md`、`{phase}-VALIDATION.md`；行走骨架模式触发时产出 `{phase}/SKELETON.md`

**仅研究模式（`--research-phase <N>`）：**
- 无修饰符：如果 RESEARCH.md 已存在，提示 `update / view / skip`。
- 加 `--research`：强制刷新 — 无条件重新生成，不提示。
- 加 `--view`：将现有 RESEARCH.md 打印到标准输出，不生成新报告。RESEARCH.md 不存在时报错。

**包合法性检查门（v1.42.1）：**
当研究者推荐外部包时，会对每个包运行 `slopcheck install <pkg> --json` 并在 RESEARCH.md 中写入 `## Package Legitimacy Audit` 表格，记录注册表、年龄、下载量、源码仓库和 slopcheck 裁决。裁决结果：

- `[SLOP]` — 包从 RESEARCH.md 中完全移除，永远不会进入规划器
- `[SUS]` — 包被标记；规划器在安装任务前插入 `checkpoint:human-verify`
- `[OK]` — 包已批准，不添加检查点

来自 WebSearch 的包被标记为 `[ASSUMED]`（而非 `[VERIFIED]`），处理方式与 `[SUS]` 相同 — 安装前需要人工检查点。如果无法安装 `slopcheck`，所有推荐的包都会被标记为 `[ASSUMED]` 并加以限制。

完整的检查点格式、裁决表和故障排除，请参阅[用户指南中的包合法性检查门](USER-GUIDE.md#package-legitimacy-gate-v1421)。

```bash
/gsd-plan-phase 1                              # 研究 + 规划 + 验证阶段 1
/gsd-plan-phase 3 --skip-research              # 无需研究直接规划（熟悉的领域）
/gsd-plan-phase --auto                         # 非交互式规划
/gsd-plan-phase 1 --bounce                     # 规划 + 外部弹回验证
/gsd-plan-phase 2 --ingest docs/adr/0010.md   # 使用 ADR 快速通道进行上下文综合
/gsd-plan-phase 2 --ingest 'docs/adr/00*.md' --ingest-format auto
/gsd-plan-phase --research-phase 4             # 仅研究阶段 4（RESEARCH.md 存在时提示）
/gsd-plan-phase --research-phase 4 --view      # 打印现有 RESEARCH.md，不生成新报告
/gsd-plan-phase --research-phase 4 --research  # 强制刷新研究，不提示
/gsd-plan-phase 1 --mvp                        # 阶段 1 的垂直切片规划
/gsd-plan-phase 1 --mvp --tdd                  # 垂直切片 + 每个行为添加任务以失败测试开始
```

---

### `/gsd-plan-review-convergence`

跨 AI 计划收敛循环 — 根据审查反馈重新规划，直到没有 HIGH 级别问题为止。运行 `plan-phase → review → replan → re-review` 循环（默认最多 3 个循环）。为规划和审查生成隔离代理；编排器处理循环控制、HIGH 问题计数、停滞检测和升级。

| 参数 / 标志 | 必填 | 描述 |
|-----------------|----------|-------------|
| `N` | **是** | 要规划和审查的阶段编号 |
| `--codex` / `--gemini` / `--claude` / `--opencode` | 否 | 单一审查者选择 |
| `--all` | 否 | 并行运行所有已配置的审查者 |
| `--max-cycles N` | 否 | 覆盖循环上限（默认 3） |

**退出行为：** HIGH 计数归零时循环退出。停滞检测在 HIGH 计数在各循环间未减少时发出警告。当达到 `--max-cycles` 且仍有 HIGH 问题未解决时，升级门询问用户是继续还是手动审查。

```bash
/gsd-plan-review-convergence 3                    # 默认审查者，3 个循环
/gsd-plan-review-convergence 3 --codex            # 仅 Codex 审查
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

---

### `/gsd-ultraplan-phase`

**[测试版]** 将阶段规划卸载到 Claude Code 的 ultraplan 云端；在浏览器中审查并导入回来。计划在远程起草，终端保持空闲；在浏览器中审查内联评论，然后通过 `/gsd-import` 将最终计划导入 `.planning/`。

| 标志 | 必填 | 描述 |
|------|----------|-------------|
| `N` | **是** | 要远程规划的阶段编号 |

**隔离性：** 有意与 `/gsd-plan-phase` 分开，以防上游 ultraplan 变更影响核心规划流水线。

```bash
/gsd-ultraplan-phase 4                  # 卸载阶段 4 的规划
```

---

### `/gsd-execute-phase`

通过基于波次的并行化执行阶段中的所有计划，或运行特定波次。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要执行的阶段编号 |
| `--wave N` | 否 | 仅执行阶段中的第 `N` 波 |
| `--cross-ai` | 否 | 将执行委托给外部 AI CLI（使用 `workflow.cross_ai_command`） |
| `--no-cross-ai` | 否 | 即使配置中启用了跨 AI 也强制本地执行 |

**前提条件：** 阶段已有 PLAN.md 文件
**产出：** 每个计划的 `{phase}-{N}-SUMMARY.md`、git 提交，以及阶段完全完成时的 `{phase}-VERIFICATION.md`

**包安装失败（v1.42.1）：** 如果计划的安装步骤失败，执行器会显示 `checkpoint:human-verify` 并停止。它不会自动安装名称相似的替代包。这是有意为之的 — 静默替换包名是 slopsquatting 传播的方式。在注册表页面验证包后再响应检查点。

```bash
/gsd-execute-phase 1                # 执行阶段 1
/gsd-execute-phase 1 --wave 2       # 仅执行第 2 波
/gsd-execute-phase 2 --cross-ai     # 将阶段 2 委托给外部 AI CLI
```

---

### `/gsd-verify-work`

带自动诊断的用户验收测试。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号（默认为最后执行的阶段） |

**前提条件：** 阶段已被执行
**产出：** `{phase}-UAT.md`，如果发现问题则生成修复计划

如需基于浏览器的 UAT，请使用已配置的浏览器 MCP 服务器。当前的 Open GSD 配套工具是 `gsd-browser`（`gsd-browser mcp`），提供确定性导航、版本化引用、断言、截图、视觉差异对比、录制和人工接管功能。已配置的旧版 Playwright MCP 服务器仍可使用。

```bash
/gsd-verify-work 1                  # 阶段 1 的 UAT
```

---

---

### `/gsd-ship`

从已完成的阶段工作创建带自动生成正文的 PR。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号或里程碑版本（例如 `4` 或 `v1.0`） |
| `--draft` | 否 | 创建为草稿 PR |

**前提条件：** 阶段已验证（`/gsd-verify-work` 通过），`gh` CLI 已安装并完成身份验证
**产出：** 带有规划产物丰富正文的 GitHub PR，STATE.md 已更新

```bash
/gsd-ship 4                         # 发布阶段 4
/gsd-ship 4 --draft                 # 作为草稿 PR 发布
```

**PR 正文包含：**
- ROADMAP.md 中的阶段目标
- SUMMARY.md 文件中的变更摘要
- 已解决的需求（REQ-IDs）
- 验证状态
- 关键决策
- 来自 `ship.pr_body_sections` 的可选配置 PRD 风格章节

自定义 PR 正文章节的入门指南、示例和验证规则，请参阅[自定义 PR 正文章节](../ship-pr-body-sections.md)。

---

### `/gsd-ui-review`

对已实现前端的追溯性六柱视觉审计。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号（默认为最后执行的阶段） |

**前提条件：** 项目有前端代码（可独立运行，无需 GSD 项目）
**产出：** `{phase}-UI-REVIEW.md`，截图保存在 `.planning/ui-reviews/`

如需更丰富的视觉证据，可将此命令与 `gsd-browser` 或其他浏览器 MCP 服务器配合使用，以便审计可以捕获截图、状态、控制台/网络上下文和可重现的交互步骤。

```bash
/gsd-ui-review                      # 审计当前阶段
/gsd-ui-review 3                    # 审计阶段 3
```

---

### `/gsd-audit-uat`

跨阶段审计所有未完成的 UAT 和验证项目。

**前提条件：** 至少有一个阶段已执行并包含 UAT 或验证
**产出：** 带有人工测试计划的分类审计报告

```bash
/gsd-audit-uat
```

---

### `/gsd-audit-milestone`

验证里程碑是否满足完成定义。

**前提条件：** 所有阶段已执行
**产出：** 带有差距分析的审计报告

```bash
/gsd-audit-milestone
```

---

### `/gsd-complete-milestone`

归档里程碑，标记发布版本。

**前提条件：** 建议先完成里程碑审计
**产出：** `MILESTONES.md` 条目，git 标签

```bash
/gsd-complete-milestone
```

---

### `/gsd-milestone-summary`

从里程碑产物生成全面的项目摘要，用于团队入职和审查。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `version` | 否 | 里程碑版本（默认为当前/最新里程碑） |

**前提条件：** 至少有一个已完成或进行中的里程碑
**产出：** `.planning/reports/MILESTONE_SUMMARY-v{version}.md`

**摘要包含：**
- 概述、架构决策、逐阶段分解
- 关键决策和权衡
- 需求覆盖率
- 技术债务和延期事项
- 新团队成员入门指南
- 生成后提供交互式问答

```bash
/gsd-milestone-summary                # 摘要当前里程碑
/gsd-milestone-summary v1.0           # 摘要特定里程碑
```

---

### `/gsd-new-milestone`

启动下一个版本周期。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `name` | 否 | 里程碑名称 |
| `--reset-phase-numbers` | 否 | 从第 1 阶段重新开始新里程碑，并在路线图制定前归档旧阶段目录 |

**前提条件：** 上一个里程碑已完成
**产出：** 已更新的 `PROJECT.md`、新的 `REQUIREMENTS.md`、新的 `ROADMAP.md`

```bash
/gsd-new-milestone                  # 交互式
/gsd-new-milestone "v2.0 Mobile"    # 命名里程碑
/gsd-new-milestone --reset-phase-numbers "v2.0 Mobile"  # 从 1 重新开始里程碑编号
```

---

## 阶段管理命令

### `/gsd-phase`

ROADMAP.md 中阶段的 CRUD 操作 — 通过单一合并命令添加、插入、移除或编辑阶段。

| 标志 | 描述 |
|------|-------------|
| （无） | 在当前里程碑末尾追加新的整数阶段 |
| `--insert <N>` | 在阶段 N 后插入紧急工作作为小数阶段（例如 3.1） |
| `--remove <N>` | 移除未来的某个阶段并重新编号后续阶段 |
| `--edit <N>` | 就地编辑现有阶段的任意字段 |
| `--force` | 允许编辑进行中或已完成的阶段（与 `--edit` 配合使用） |

**前提条件：** `.planning/ROADMAP.md` 已存在
**产出：** 已更新的 ROADMAP.md

```bash
/gsd-phase "Add authentication system"          # 追加带描述的新阶段
/gsd-phase --insert 3 "Fix auth race condition" # 在阶段 3 和 4 之间插入 → 创建 3.1
/gsd-phase --remove 7               # 移除阶段 7，8→7、9→8 等重新编号
/gsd-phase --edit 5                 # 编辑阶段 5 的任意字段
/gsd-phase --edit 5 --force         # 即使阶段 5 进行中或已完成也进行编辑
```

---

### `/gsd-mvp-phase`

阶段的引导式 MVP 规划 — 提示输入用户故事，运行 SPIDR 拆分检查，将 `**Mode:** mvp` 写入 ROADMAP.md，然后委托给 `/gsd-plan-phase`（通过路线图字段自动检测 MVP 模式）。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要转换为 MVP 模式的阶段编号（整数或小数，如 `2.1`） |

| 标志 | 描述 |
|------|-------------|
| `--force` | 允许转换 `in_progress` 或 `completed` 状态的阶段 |

**前提条件：** 阶段必须已存在于 ROADMAP.md 中（通过 `/gsd-new-project`、`/gsd-phase` 或 `/gsd-phase --insert` 创建）。该命令不创建新阶段 — 它转换现有阶段。

**行为：** 收集结构化用户故事，验证格式，运行 SPIDR 拆分检查，将 `**Goal:**` 和 `**Mode:** mvp` 写入阶段的 ROADMAP.md 章节，然后委托给 `/gsd-plan-phase <N>`。演示请参阅[如何规划 MVP 阶段](USER-GUIDE.md#mvp-phase-planning)。

**行走骨架：** 当在无先前阶段摘要的新项目第 1 阶段使用 `--mvp`（或 `mode: mvp`）时自动触发。规划器在 `PLAN.md` 旁边生成 `SKELETON.md`。

**产出：** 已更新的 ROADMAP.md，以及 `/gsd-plan-phase` 的所有产物；行走骨架模式触发时生成 `SKELETON.md`。

```bash
/gsd-mvp-phase 1                    # 阶段 1 的 MVP 规划
/gsd-mvp-phase 2.1                  # 小数阶段的 MVP 规划
/gsd-mvp-phase 3 --force            # 即使阶段 3 进行中也进行转换
```

---

### `/gsd-validate-phase`

追溯性审计并填补 Nyquist 验证空白。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号 |

```bash
/gsd-validate-phase 2               # 审计阶段 2 的测试覆盖率
```

---

## 导航命令

### `/gsd-progress`

显示状态、下一步操作，并自动推进至下一个逻辑工作流步骤。读取项目状态并确定适当的操作。

| 标志 | 描述 |
|------|-------------|
| `--next` | 无需手动选择路由，自动推进至下一个逻辑工作流步骤 |
| `--do "task description"` | 分析自由形式的意图并分派到最合适的 GSD 命令 |
| `--forensic` | 在标准报告后附加 6 项完整性审计（STATE 一致性、孤立切换、延期范围漂移、内存标记的待处理工作、阻塞性 todo、未提交代码） |

**自动路由行为（`--next`）：**
- 无项目 → 建议 `/gsd-new-project`
- 阶段需要讨论 → 运行 `/gsd-discuss-phase`
- 阶段需要规划 → 运行 `/gsd-plan-phase`
- 阶段需要执行 → 运行 `/gsd-execute-phase`
- 阶段需要验证 → 运行 `/gsd-verify-work`
- 所有阶段已完成 → 建议 `/gsd-complete-milestone`

```bash
/gsd-progress                       # "我在哪里？下一步是什么？"（含自动路由）
/gsd-progress --next                # 自动推进至下一步
/gsd-progress --do "fix the auth bug"  # 将自由形式意图分派到最佳 GSD 命令
/gsd-progress --forensic            # 标准报告 + 完整性审计
```

### `/gsd-resume-work`

从上次会话恢复完整上下文。

```bash
/gsd-resume-work                    # 上下文重置或新会话后使用
```

### `/gsd-pause-work`

在阶段中途停止时保存上下文切换信息。

| 标志 | 描述 |
|------|-------------|
| `--report` | 在 `.planning/reports/` 中生成会话后摘要，捕获提交、文件变更和阶段进度 |

```bash
/gsd-pause-work                     # 创建 continue-here.md
/gsd-pause-work --report            # 创建 continue-here.md + 会话报告
```

### `/gsd-manager`

用于从单个终端管理多个阶段的交互式命令中心。

**前提条件：** `.planning/ROADMAP.md` 已存在
**行为：**
- 带有视觉状态指示器的所有阶段仪表板
- 根据依赖关系和进度推荐最优的下一步操作
- 分派工作：discuss 在内联运行，plan/execute 作为后台代理运行
- 专为从单个终端并行处理多个阶段工作的高级用户设计
- 通过 `manager.flags` 配置支持每步直通标志（参阅[配置](CONFIGURATION.md#manager-passthrough-flags)）

```bash
/gsd-manager                        # 打开命令中心仪表板
/gsd-manager --analyze-deps         # 在并行执行前扫描 ROADMAP 阶段的依赖关系
```

**检查点心跳（#2410）：**

后台 `execute-phase` 运行在每个波次和计划边界处发出 `[checkpoint]` 标记，以防 Claude API SSE 流在多计划阶段上因空闲时间过长而触发 `Stream idle timeout - partial response received`。格式为：

```
[checkpoint] phase {N} wave {W}/{M} starting, {count} plan(s), {P}/{Q} plans done
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} complete ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} complete, {P}/{Q} plans done ({ok}/{count} ok)
```

如果后台阶段中途失败，请在转录中 grep `[checkpoint]` 以查看最后确认的边界。管理器的后台完成处理器在代理出错时使用这些标记报告部分进度。

**管理器直通标志：**

在 `.planning/config.json` 的 `manager.flags` 下配置每步标志。这些标志会附加到每个分派的命令中：

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--cross-ai"
    }
  }
}
```

---

### `/gsd-help`

按请求层级显示 GSD 命令。默认适合单屏显示；`--full` 为完整参考；`<topic>` 直接跳转到某一章节。

```bash
/gsd-help                           # 单页导览（默认）
/gsd-help --brief                   # 约 10 行的顶级命令简明摘要
/gsd-help --full                    # 完整参考（每个命令，每个标志）
/gsd-help <topic>                   # 仅一个章节（例如 /gsd-help debug）
/gsd-help --brief <topic>           # 简洁的范围查找 — 签名 + 单行摘要
```

完整别名表请参阅 `gsd-core/workflows/help/modes/topic.md`。未知主题将打印已识别的列表。

---

## 实用工具命令

### `/gsd-explore`

苏格拉底式构思会话 — 通过深度提问引导某个想法，可选择生成研究内容，然后将输出路由到正确的 GSD 产物（笔记、待办、种子、研究问题、需求或新阶段）。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `topic` | 否 | 要探索的主题（例如 `/gsd-explore authentication strategy`） |

```bash
/gsd-explore                        # 开放式构思会话
/gsd-explore authentication strategy  # 探索特定主题
```

---

### `/gsd-undo`

安全 git 回退 — 使用阶段清单并通过依赖检查和确认门回滚 GSD 阶段或计划提交。

| 标志 | 必填 | 描述 |
|------|----------|-------------|
| `--last N` | （三选一必填） | 显示最近的 GSD 提交以供交互式选择 |
| `--phase NN` | （三选一必填） | 回退某个阶段的所有提交 |
| `--plan NN-MM` | （三选一必填） | 回退特定计划的所有提交 |

**安全性：** 回退前检查依赖的阶段/计划；始终显示确认门。

```bash
/gsd-undo --last 5                  # 从最近 5 个 GSD 提交中选择
/gsd-undo --phase 03                # 回退阶段 3 的所有提交
/gsd-undo --plan 03-02              # 回退阶段 3 第 02 号计划的提交
```

---

### `/gsd-import`

将外部计划文件导入 GSD 规划系统，在写入任何内容之前检测与 `PROJECT.md` 决策的冲突。

| 标志 | 必填 | 描述 |
|------|----------|--------------|
| `--from <filepath>` | 是（或 `--from-gsd2`） | 要导入的外部计划文件路径 |
| `--from-gsd2` | 是（或 `--from`） | 将 GSD-2（`.gsd/`）项目反向迁移回 GSD v1（`.planning/`）格式 |
| `--path <dir>` | 否 | 与 `--from-gsd2` 配合：GSD-2 项目目录路径（默认为当前目录） |

**流程：** 检测冲突 → 提示解决 → 写入为 GSD PLAN.md → 通过 `gsd-plan-checker` 验证

```bash
/gsd-import --from /tmp/team-plan.md    # 导入并验证外部计划
/gsd-import --from-gsd2                # 从 GSD-2 迁移回 v1（当前目录）
/gsd-import --from-gsd2 --path ~/old-project  # 从不同路径迁移
```

---

### `/gsd-ingest-docs`

从仓库中现有的 ADR、PRD、规格和文档引导或合并 `.planning/` 设置。运行并行分类（`gsd-doc-classifier`）以及带优先级规则和循环检测的综合（`gsd-doc-synthesizer`）。生成三分桶冲突报告（`INGEST-CONFLICTS.md`：自动解决、竞争变体、未解决阻塞项），并对 LOCKED-vs-LOCKED ADR 矛盾实施硬性阻止。

| 参数 / 标志 | 必填 | 描述 |
|-----------------|----------|-------------|
| `path` | 否 | 要扫描的目标目录（默认为仓库根目录） |
| `--mode new\|merge` | 否 | 覆盖自动检测（默认：`.planning/` 不存在时为 `new`，存在时为 `merge`） |
| `--manifest <file>` | 否 | YAML 文件，按文档列出 `{path, type, precedence?}`；覆盖启发式分类 |
| `--resolve auto` | 否 | 冲突解决模式（v1：仅 `auto`；`interactive` 保留） |

**限制：** v1 每次调用上限为 50 个文档。将共享冲突检测契约提取到 `references/doc-conflict-engine.md`，`/gsd-import` 也会使用。

```bash
/gsd-ingest-docs                            # 扫描仓库根目录，自动检测模式
/gsd-ingest-docs docs/                      # 仅摄取 docs/ 下的内容
/gsd-ingest-docs --manifest ingest.yaml     # 显式优先级清单
```

---

### `/gsd-quick`

执行带 GSD 保障的临时任务。

| 标志 | 描述 |
|------|-------------|
| `--full` | 启用完整质量流水线 — 讨论 + 研究 + 计划检查 + 验证 |
| `--validate` | 仅计划检查（最多 2 次迭代）+ 执行后验证；无讨论或研究 |
| `--discuss` | 轻量级预规划讨论 |
| `--research` | 规划前生成专注研究者 |

细粒度标志可组合：`--discuss --research --validate` 等同于 `--full`。

| 子命令 | 描述 |
|------------|-------------|
| `list` | 列出所有带状态的快速任务 |
| `status <slug>` | 显示特定快速任务的状态 |
| `resume <slug>` | 通过 slug 恢复特定快速任务 |

```bash
/gsd-quick                          # 基本快速任务
/gsd-quick --discuss --research     # 讨论 + 研究 + 规划
/gsd-quick --validate               # 仅计划检查 + 验证
/gsd-quick --full                   # 完整质量流水线
/gsd-quick list                     # 列出所有快速任务
/gsd-quick status my-task-slug      # 显示快速任务的状态
/gsd-quick resume my-task-slug      # 恢复快速任务
```

### `/gsd-autonomous`

自主运行所有剩余阶段。

| 标志 | 描述 |
|------|-------------|
| `--from N` | 从特定阶段编号开始 |
| `--to N` | 完成特定阶段编号后停止 |
| `--interactive` | 精简上下文并接受用户输入 |

```bash
/gsd-autonomous                     # 运行所有剩余阶段
/gsd-autonomous --from 3            # 从阶段 3 开始
/gsd-autonomous --to 5              # 运行到阶段 5（含）
/gsd-autonomous --from 3 --to 5     # 运行阶段 3 到 5
```

### `/gsd-debug`

带持久状态的系统性调试。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `description` | 否 | 错误描述 |

| 标志 | 描述 |
|------|-------------|
| `--diagnose` | 仅诊断模式 — 调查但不尝试修复 |

**子命令：**
- `/gsd-debug list` — 列出所有活动调试会话及状态、假设和下一步操作
- `/gsd-debug status <slug>` — 打印会话的完整摘要（证据数量、已排除数量、解决方案、TDD 检查点），不生成代理
- `/gsd-debug continue <slug>` — 通过 slug 恢复特定会话（显示当前焦点后生成延续代理）
- `/gsd-debug [--diagnose] <description>` — 开始新调试会话（现有行为；`--diagnose` 在找到根本原因后停止，不应用修复）

**TDD 模式：** 当 `.planning/config.json` 中 `tdd_mode: true` 时，调试会话需要在应用任何修复前编写并验证失败的测试（红 → 绿 → 完成）。

```bash
/gsd-debug "Login button not responding on mobile Safari"
/gsd-debug --diagnose "Intermittent 500 errors on /api/users"
/gsd-debug list
/gsd-debug status auth-token-null
/gsd-debug continue form-submit-500
```

### `/gsd-add-tests`

为已完成的阶段生成测试。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | 否 | 阶段编号 |

```bash
/gsd-add-tests 2                    # 为阶段 2 生成测试
```

### `/gsd-stats`

显示项目统计信息。

```bash
/gsd-stats                          # 项目指标仪表板
```

### `/gsd-profile-user`

通过对 Claude Code 会话的 8 个维度分析生成开发者行为档案（沟通风格、决策模式、调试方法、用户体验偏好、供应商选择、挫折触发因素、学习风格、解释深度）。生成用于个性化 Claude 响应的产物。

| 标志 | 描述 |
|------|-------------|
| `--questionnaire` | 使用交互式问卷代替会话分析 |
| `--refresh` | 重新分析会话并重新生成档案 |

**生成的产物：**
- `USER-PROFILE.md` — 完整行为档案
- `CLAUDE.md` 档案章节 — 由 Claude Code 自动发现

```bash
/gsd-profile-user                   # 分析会话并构建档案
/gsd-profile-user --questionnaire   # 交互式问卷回退方案
/gsd-profile-user --refresh         # 从新分析中重新生成
```

### `/gsd-health`

验证 `.planning/` 目录完整性。使用 `--context` 时，针对 60% / 70% 阈值探测上下文窗口使用率保护（v1.40.0 新增，[#2792](https://github.com/open-gsd/gsd-core/issues/2792)）。

| 标志 | 描述 |
|------|-------------|
| `--repair` | 自动修复可恢复的问题 |
| `--context` | 探测上下文窗口使用率；60% 时警告，70% 时严重警告 |

```bash
/gsd-health                         # 检查完整性
/gsd-health --repair                # 检查并修复
/gsd-health --context               # 上下文使用率分类
```

### `/gsd-cleanup`

归档已完成里程碑中积累的阶段目录，并删除上游已删除的本地分支。

**行为：** 呈现要归档的阶段目录的演练摘要（从 `.planning/phases/` 移至 `.planning/milestones/v{X.Y}-phases/`）和上游已删除的本地分支（通过 `git fetch --prune` 删除）。写入任何变更前需要确认。当前检出的分支永远不会被删除。

```bash
/gsd-cleanup
```

---

## 实验与草图命令

### `/gsd-spike`

在确定实现方案前运行 2-5 个专注的可行性实验。每个实验使用 Given/When/Then 框架，生成可执行代码，并返回 VALIDATED / INVALIDATED / PARTIAL 裁决。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `idea` | 否 | 要调查的技术问题或方法 |
| `--quick` | 否 | 跳过接收对话；直接使用 `idea` 文本 |
| `--wrap-up` | 否 | 将已完成的实验结果打包成可重用的项目本地技能 |

**产出：** `.planning/spikes/NNN-experiment-name/`（含代码、结果和 README）；`.planning/spikes/MANIFEST.md`
**`--wrap-up` 产出：** `.claude/skills/spike-findings-[project]/` 技能文件

```bash
/gsd-spike                              # 交互式接收
/gsd-spike "can we stream LLM tokens through SSE"
/gsd-spike --quick websocket-vs-polling
/gsd-spike --wrap-up                    # 将结果打包为可重用技能
```

---

### `/gsd-sketch`

在确定实现方案前通过一次性 HTML 原型探索设计方向。每个设计问题生成 2-3 个变体供直接浏览器比较。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `idea` | 否 | 要探索的 UI 设计问题或方向 |
| `--quick` | 否 | 跳过风格接收；直接使用 `idea` 文本 |
| `--text` | 否 | 文本模式回退 — 用编号列表替换交互式提示（适用于非 Claude 运行时） |
| `--wrap-up` | 否 | 将获胜的草图决策打包为可重用的项目本地技能 |

**产出：** `.planning/sketches/NNN-descriptive-name/index.html`（2-3 个交互变体）、`README.md`、共享 `themes/default.css`；`.planning/sketches/MANIFEST.md`
**`--wrap-up` 产出：** `.claude/skills/sketch-findings-[project]/` 技能文件

```bash
/gsd-sketch                             # 交互式风格接收
/gsd-sketch "dashboard layout"
/gsd-sketch --quick "sidebar navigation"
/gsd-sketch --text "onboarding flow"    # 非 Claude 运行时
/gsd-sketch --wrap-up                   # 将获胜草图打包为技能
```

---

## 诊断命令

### `/gsd-forensics`

失败 GSD 工作流的事后调查 — 诊断出了什么问题。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `description` | 否 | 问题描述（省略时提示输入） |

**前提条件：** `.planning/` 目录已存在
**产出：** `.planning/forensics/report-{timestamp}.md`

**调查内容包括：**
- Git 历史分析（最近提交、卡滞模式、时间间隔）
- 产物完整性（已完成阶段的预期文件）
- STATE.md 异常和会话历史
- 未提交的工作、冲突、废弃的变更
- 至少检查 4 种异常类型（卡滞循环、缺失产物、废弃工作、崩溃/中断）
- 如果发现可操作的结果，提供创建 GitHub issue 的选项

```bash
/gsd-forensics                              # 交互式 — 提示输入问题
/gsd-forensics "Phase 3 execution stalled"  # 带问题描述
```

---

### `/gsd-extract-learnings`

从已完成的阶段工作中提取可重用的模式、反模式和架构决策。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要提取学习记录的阶段编号 |

| 标志 | 描述 |
|------|-------------|
| `--all` | 从所有已完成的阶段中提取学习记录 |
| `--format` | 输出格式：`markdown`（默认）、`json` |

**前提条件：** 阶段已被执行（SUMMARY.md 文件已存在）
**产出：** `.planning/learnings/{phase}-LEARNINGS.md`

**提取内容：**
- 架构决策及其依据
- 运行良好的模式（可在未来阶段复用）
- 遇到的反模式及其解决方式
- 特定技术的洞察
- 性能和测试观察

```bash
/gsd-extract-learnings 3                    # 提取阶段 3 的学习记录
/gsd-extract-learnings --all                # 从所有已完成阶段提取
```

---

## 工作流管理

### `/gsd-workstreams`

管理用于并发处理不同里程碑领域的并行工作流。

**子命令：**

| 子命令 | 描述 |
|------------|-------------|
| `list` | 列出所有带状态的工作流（无子命令时的默认操作） |
| `create <name>` | 创建新工作流 |
| `status <name>` | 某个工作流的详细状态 |
| `switch <name>` | 设置活动工作流 |
| `progress` | 所有工作流的进度摘要 |
| `complete <name>` | 归档已完成的工作流 |
| `resume <name>` | 在工作流中恢复工作 |

**前提条件：** 活动的 GSD 项目
**产出：** `.planning/` 下的工作流目录，每个工作流的状态跟踪

```bash
/gsd-workstreams                    # 列出所有工作流
/gsd-workstreams create backend-api # 创建新工作流
/gsd-workstreams switch backend-api # 设置活动工作流
/gsd-workstreams status backend-api # 详细状态
/gsd-workstreams progress           # 跨工作流进度概览
/gsd-workstreams complete backend-api  # 归档已完成的工作流
/gsd-workstreams resume backend-api    # 在工作流中恢复工作
```

---

## 配置命令

### `/gsd-settings`

工作流切换和模型配置的交互式配置。问题分为六个可视化章节：

- **规划** — 研究、计划检查器、模式映射器、Nyquist、UI 阶段、UI 关卡、AI 阶段
- **执行** — 验证器、TDD 模式、代码审查、代码审查深度 _（条件性 — 仅在代码审查开启时）_、UI 审查
- **文档与输出** — 提交文档、跳过讨论、工作树
- **功能** — Intel、Graphify
- **模型与流水线** — 模型配置、自动推进、分支
- **杂项** — 上下文警告、研究问题

所有答案通过 `gsd-tools query config-set` 合并到已解析的项目配置路径（标准安装为 `.planning/config.json`，工作流处于活动状态时为 `.planning/workstreams/<active>/config.json`），保留不相关的键。确认后，用户可以将完整设置对象保存到 `~/.gsd/defaults.json`，以便未来运行 `/gsd-new-project` 时从相同的基线开始。

```bash
/gsd-settings                       # 交互式配置
```

### `/gsd-config`

通过单一合并命令交互式配置 GSD 设置 — 工作流切换、高级参数、集成和模型配置。

| 标志 | 描述 |
|------|-------------|
| （无） | 常用切换：模型、research、plan_check、verifier、branching |
| `--advanced` | 高级用户参数：规划调优、超时、分支模板、跨 AI 执行、运行时/输出 |
| `--integrations` | 第三方 API 密钥、代码审查 CLI 路由、代理技能注入 |
| `--profile <name>` | 快速配置切换：`quality`、`balanced`、`budget` 或 `inherit` |

**`--advanced` 章节：**

| 章节 | 键 |
|---------|------|
| 规划调优 | `workflow.plan_bounce`、`workflow.plan_bounce_passes`、`workflow.plan_bounce_script`、`workflow.subagent_timeout`、`workflow.inline_plan_threshold` |
| 执行调优 | `workflow.node_repair`、`workflow.node_repair_budget`、`workflow.auto_prune_state` |
| 讨论调优 | `workflow.max_discuss_passes` |
| 跨 AI 执行 | `workflow.cross_ai_execution`、`workflow.cross_ai_command`、`workflow.cross_ai_timeout` |
| Git 定制 | `git.base_branch`、`git.phase_branch_template`、`git.milestone_branch_template` |
| 运行时 / 输出 | `response_language`、`context_window`、`search_gitignored`、`graphify.build_timeout` |

所有答案通过 `gsd-tools query config-set` 合并，保留不相关的键。API 密钥在所有输出中以掩码显示（`****<last-4>`）。

```bash
/gsd-config                         # 常用交互式配置
/gsd-config --advanced              # 高级用户参数（六章节提示）
/gsd-config --integrations          # API 密钥、审查 CLI 路由、代理技能
/gsd-config --profile budget        # 切换到 budget 配置
/gsd-config --profile quality       # 切换到 quality 配置
```

完整的模式和默认值请参阅 [CONFIGURATION.md](CONFIGURATION.md)。

### `/gsd-surface`

切换显示的技能 — 应用配置、列出或禁用集群，无需重新安装。

| 子命令 | 描述 |
|------------|-------------|
| `list` | 显示已启用和已禁用的集群和技能 |
| `status` | `list` 的别名，附加 token 成本摘要 |
| `profile <name>` | 写入 `baseProfile` 并重新暂存技能 |
| `disable <cluster>` | 将集群添加到禁用列表并重新暂存 |
| `enable <cluster>` | 从禁用列表中删除集群并重新暂存 |
| `reset` | 删除表面增量；恢复安装时的配置 |

```bash
/gsd-surface list                   # 显示当前表面
/gsd-surface profile standard       # 切换到 standard 配置
/gsd-surface disable utility        # 禁用 utility 集群
/gsd-surface reset                  # 恢复安装时的配置
```

---

## 棕地命令

### `/gsd-map-codebase`

使用并行映射代理分析现有代码库。使用 `--fast` 进行快速单代理扫描，或使用 `--query` 搜索现有 intel。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `area` | 否 | 将映射范围限定到特定区域 |
| `--fast` | 否 | 快速单焦点评估 — 生成一个映射代理而非四个并行代理（轻量级替代方案） |
| `--query <term>` | 否 | 搜索 `.planning/intel/` 中可查询的代码库 intel 文件（需要 `intel.enabled: true`） |

| 标志 | 描述 |
|------|-------------|
| `--focus tech\|arch\|quality\|concerns\|tech+arch` | `--fast` 模式的焦点区域（默认：`tech+arch`） |

**产出：** `.planning/codebase/` 分析文档（完整模式）；`.planning/codebase/` 中的目标文档（`--fast`）；intel 查询结果（`--query`）

```bash
/gsd-map-codebase                   # 完整代码库分析（4 个并行代理）
/gsd-map-codebase auth              # 聚焦 auth 区域
/gsd-map-codebase --fast            # 快速技术 + 架构概览（1 个代理）
/gsd-map-codebase --fast --focus quality  # 仅质量和代码健康状况
/gsd-map-codebase --query authentication  # 搜索 intel 中的某个术语
```

### `/gsd-graphify`

构建、查询和检查存储在 `.planning/graphs/` 中的项目知识图谱。通过在 `config.json` 中设置 `graphify.enabled: true` 选择启用（参阅[配置参考](CONFIGURATION.md#graphify-settings)）；禁用时，命令打印激活提示并停止。

| 子命令 | 描述 |
|------------|-------------|
| `build` | 构建或重建知识图谱（内联运行 `graphify update .` 并刷新 `.planning/graphs/`） |
| `query <term>` | 在图谱中搜索某个术语 |
| `status` | 显示图谱新鲜度和统计信息 |
| `diff` | 显示自上次构建以来的变更 |

**产出：** `.planning/graphs/` 图谱产物（节点、边、快照）

```bash
/gsd-graphify build                 # 构建或重建知识图谱
/gsd-graphify query authentication  # 在图谱中搜索某个术语
/gsd-graphify status                # 显示新鲜度和统计信息
/gsd-graphify diff                  # 显示自上次构建以来的变更
```

**编程访问：** `node gsd-tools.cjs graphify <build|query|status|diff|snapshot>` — 参阅 [CLI 工具参考](CLI-TOOLS.md)。

### `gsd-tools intel api-surface`

将 `.planning/intel/api-map.json` 索引（由 `/gsd-map-codebase` 构建）渲染为 `.planning/intel/` 中人类可读的 `API-SURFACE.md`。以 `config.json` 中 `intel.enabled: true` 为门控；当 Intel 被禁用时，命令打印激活提示并退出。输出路径始终为 `.planning/intel/API-SURFACE.md` — 没有 `--out` 或 `--format` 标志。当 `api-map.json` 不存在或为空时，命令仍会写入文件并附带明确的"不完整"横幅，以便使用者不会将沉默误认为"什么都不存在"。

**产出：** `.planning/intel/API-SURFACE.md`

```bash
node gsd-tools.cjs intel api-surface              # 渲染 api-map.json → API-SURFACE.md
```

`API-SURFACE.md` 输出按源文件分组列出导出的符号（函数、类、装饰器、常量）及其签名和检测到的可见性。当 `plan_review.source_grounding_authority` 设置为 `intel` 时，计划漂移保护直接读取 `api-map.json` 而不是调用 `api-surface` 渲染器。

---

## AI 集成命令

### `/gsd-ai-integration-phase`

为涉及构建 AI 系统的阶段生成 AI-SPEC.md 设计契约。呈现交互式决策矩阵，显示特定领域的故障模式和评估标准，并生成包含框架推荐、实现指南和评估策略的 `AI-SPEC.md`。

**产出：** 阶段目录中的 `{phase}-AI-SPEC.md`

**生成：** 3 个并行专家代理：domain-researcher、framework-selector、ai-researcher 和 eval-planner

```bash
/gsd-ai-integration-phase              # 当前阶段的向导
/gsd-ai-integration-phase 3           # 特定阶段的向导
```

---

### `/gsd-eval-review`

审计已执行 AI 阶段的评估覆盖率并生成 EVAL-REVIEW.md 修复计划。根据 `/gsd-ai-integration-phase` 生成的 `AI-SPEC.md` 评估计划检查实现情况。将每个评估维度评分为 COVERED/PARTIAL/MISSING。

**前提条件：** 阶段已被执行且有 `AI-SPEC.md`
**产出：** `{phase}-EVAL-REVIEW.md`，包含发现结果、差距和修复指南

```bash
/gsd-eval-review                       # 审计当前阶段
/gsd-eval-review 3                     # 审计特定阶段
```

---

## 更新命令

### `/gsd-update`

更新 GSD，预览变更日志，并可选择同步技能或重新应用本地补丁。

| 标志 | 描述 |
|------|-------------|
| `--sync` | 更新后从 GSD 注册表同步技能 |
| `--reapply` | 更新后恢复本地修改（补丁） |

```bash
/gsd-update                         # 检查更新并安装
/gsd-update --sync                  # 更新并同步技能
/gsd-update --reapply               # 更新并重新应用本地补丁
```

---

## 代码质量命令

### `/gsd-code-review`

审查阶段期间更改的源文件，查找错误、安全漏洞和代码质量问题。使用 `--fix` 可在审查后自动修复发现的问题。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `N` | **是** | 要审查的阶段编号（例如 `2` 或 `02`） |
| `--depth=quick\|standard\|deep` | 否 | 审查深度级别（覆盖 `workflow.code_review_depth` 配置）。`quick`：仅模式匹配（约 2 分钟）。`standard`：按文件分析，含特定语言检查（约 5-15 分钟，默认）。`deep`：跨文件分析，包括导入图和调用链（约 15-30 分钟） |
| `--files file1,file2,...` | 否 | 显式逗号分隔的文件列表；完全跳过 SUMMARY/git 范围界定 |
| `--fix` | 否 | 审查后自动修复问题 — 读取 REVIEW.md，生成修复代理，原子性地提交每个修复 |
| `--fix --all` | 否 | 将 Info 级别的发现纳入修复范围（默认：仅 Critical + Warning） |
| `--fix --auto` | 否 | 修复 + 重新审查迭代循环，最多 3 次迭代 |

**前提条件：** 阶段已被执行且有 SUMMARY.md 或 git 历史
**产出：** `{phase}-REVIEW.md`，包含按严重性分类的发现；使用 `--fix` 时产出 `{phase}-REVIEW-FIX.md`
**生成：** `gsd-code-reviewer` 代理；使用 `--fix` 时生成 `gsd-code-fixer` 代理

**可选结构预检：** 将 `code_quality.fallow.enabled` 设置为 `true` 可在代理审查前运行 fallow。GSD 写入 `{phase}/FALLOW.json` 并在 `REVIEW.md` 中嵌入 `Structural Findings (fallow)` 章节。使用 `code_quality.fallow.scope` 和 `code_quality.fallow.profile` 配置范围和配置文件。

```bash
/gsd-code-review 3                          # 阶段 3 的标准审查
/gsd-code-review 2 --depth=deep             # 深度跨文件审查
/gsd-code-review 4 --files src/auth.ts,src/token.ts  # 显式文件列表
/gsd-code-review 3 --fix                    # 审查后修复 Critical + Warning 发现
/gsd-code-review 3 --fix --all             # 审查后修复所有发现（包括 Info）
/gsd-code-review 3 --fix --auto            # 审查、修复并重新审查直到清洁（最多 3 次迭代）
```

---

### `/gsd-audit-fix`

自主审计到修复流水线 — 运行审计、分类发现、通过测试验证自动修复可修复的问题，并原子性地提交每个修复。

| 标志 | 描述 |
|------|-------------|
| `--source <audit>` | 要运行的审计类型（默认：`audit-uat`） |
| `--severity high\|medium\|all` | 要处理的最低严重性（默认：`medium`） |
| `--max N` | 要修复的最大发现数量（默认：5） |
| `--dry-run` | 分类发现但不修复（显示分类表） |

**前提条件：** 至少有一个阶段已执行并包含 UAT 或验证
**产出：** 带测试验证的修复提交；分类报告

```bash
/gsd-audit-fix                              # 运行 audit-uat，修复 medium+ 级别的问题（最多 5 个）
/gsd-audit-fix --severity high             # 仅修复高严重性问题
/gsd-audit-fix --dry-run                   # 预览分类而不修复
/gsd-audit-fix --max 10 --severity all     # 修复任意严重性的最多 10 个问题
```

---

## 快速与内联命令

### `/gsd-fast`

内联执行简单任务 — 无子代理，无规划开销。适用于错别字修复、配置变更、小型重构、遗忘的提交。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `task description` | 否 | 要做什么（省略时提示输入） |

**不是 `/gsd-quick` 的替代品** — 任何需要研究、多步骤规划或验证的事项请使用 `/gsd-quick`。

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to gitignore"
```

---

### `/gsd-review`

来自外部 AI CLI 的阶段计划跨 AI 同行评审。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `--phase N` | **是** | 要审查的阶段编号 |

| 标志 | 描述 |
|------|-------------|
| `--gemini` | 包含 Gemini CLI 审查 |
| `--claude` | 包含 Claude CLI 审查（独立会话） |
| `--codex` | 包含 Codex CLI 审查 |
| `--coderabbit` | 包含 CodeRabbit 审查 |
| `--opencode` | 包含 OpenCode 审查（通过 GitHub Copilot） |
| `--qwen` | 包含 Qwen Code 审查（阿里巴巴 Qwen 模型） |
| `--cursor` | 包含 Cursor 代理审查 |
| `--agy` / `--antigravity` | 包含 Antigravity CLI 审查（使用 Google 凭证免费） |
| `--ollama` | 包含 Ollama 服务器审查 |
| `--lm-studio` | 包含 LM Studio 服务器审查 |
| `--llama-cpp` | 包含 llama.cpp 服务器审查 |
| `--all` | 包含所有可用的审查者（CLI + 本地模型服务器） |

**默认审查者行为（无标志）：**
- 如果 `review.default_reviewers` **未设置**，`/gsd-review` 运行所有检测到的审查者（当前默认行为）。
- 如果 `review.default_reviewers` **已设置**，`/gsd-review` 仅运行该子集（例如 `["gemini","codex"]`）。
- `--all` 始终覆盖配置并运行完整的检测集。
- 显式标志（例如 `--cursor`）在该次运行中覆盖 `--all` 和配置默认值。

**产出：** `{phase}-REVIEWS.md` — 可供 `/gsd-plan-phase --reviews` 使用

```bash
# 设置项目默认审查者，用于无标志的 /gsd-review 运行
gsd config-set review.default_reviewers '["gemini","codex"]'

/gsd-review --phase 2             # 使用配置中的 gemini+codex 运行
/gsd-review --phase 3 --all
/gsd-review --phase 2 --gemini
/gsd-review --phase 2 --cursor    # 一次性覆盖
```

---

### `/gsd-pr-branch`

通过过滤 `.planning/` 提交创建干净的 PR 分支。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `target branch` | 否 | 基础分支（默认：`main`） |

**目的：** 审查者只看到代码变更，而非 GSD 规划产物。

```bash
/gsd-pr-branch                     # 相对于 main 进行过滤
/gsd-pr-branch develop             # 相对于 develop 进行过滤
```

---

### `/gsd-secure-phase`

追溯性验证已完成阶段的威胁缓解措施。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `phase number` | 否 | 要审计的阶段（默认：最后完成的阶段） |

**前提条件：** 阶段必须已被执行。有无现有 SECURITY.md 均可运行。
**产出：** `{phase}-SECURITY.md`，包含威胁验证结果
**生成：** `gsd-security-auditor` 代理

三种运行模式：
1. SECURITY.md 已存在 — 审计并验证现有缓解措施
2. 无 SECURITY.md 但 PLAN.md 有威胁模型 — 从产物生成
3. 阶段未执行 — 退出并提供指导

```bash
/gsd-secure-phase                   # 审计最后完成的阶段
/gsd-secure-phase 5                 # 审计特定阶段
```

---

### `/gsd-docs-update`

生成或更新经代码库验证的项目文档。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| `--force` | 否 | 跳过保存提示，重新生成所有文档 |
| `--verify-only` | 否 | 检查现有文档的准确性，不生成 |

**产出：** 最多 9 个文档文件（README、架构、API、入门、开发、测试、配置、部署、贡献）
**生成：** `gsd-doc-writer` 代理（每种文档类型一个），然后是用于事实验证的 `gsd-doc-verifier` 代理

每个文档写作代理直接探索代码库 — 不存在幻觉路径或过时签名。文档验证代理对照实时文件系统检查声明。

```bash
/gsd-docs-update                    # 交互式生成/更新文档
/gsd-docs-update --force            # 重新生成所有文档
/gsd-docs-update --verify-only      # 仅验证现有文档
```

---

## 任务捕捉与待办命令

### `/gsd-capture`

将想法、任务、笔记和种子捕捉到适当的目的地。默认模式添加结构化待办事项；标志路由到专业的捕捉工作流。

| 标志 | 描述 |
|------|-------------|
| （无） | 捕捉为结构化待办事项供后续处理 |
| `--note [text]` | 零摩擦笔记 — 追加、列出（`--note list`）或提升（`--note promote N`） |
| `--backlog <description>` | 使用 999.x 编号添加到待办停车场 |
| `--seed [idea summary]` | 捕捉具有触发条件的前瞻性想法 |
| `--list` | 列出待处理的待办事项并选择一项处理 |
| `--global` | 使用全局范围（用于笔记操作） |

**待办停车场：** 999.x 编号使条目保持在活动阶段序列之外；阶段目录立即创建，以便 `/gsd-discuss-phase` 和 `/gsd-plan-phase` 可以在其上运行。
**种子：** 保留完整的原因、触发时机和面包屑 — 由 `/gsd-new-milestone` 使用。

**产出：** `.planning/todos/`（默认）、笔记文件（--note）、ROADMAP.md 待办章节（--backlog）、`.planning/seeds/SEED-NNN-slug.md`（--seed）

```bash
/gsd-capture "Consider adding dark mode support"   # 添加待办事项
/gsd-capture --note "Caching strategy idea"        # 快速笔记
/gsd-capture --note list                           # 列出所有笔记
/gsd-capture --note promote 3                      # 将笔记 3 提升为待办事项
/gsd-capture --backlog "GraphQL API layer"         # 添加到待办停车场
/gsd-capture --seed "Add real-time collaboration when WebSocket infra is in place"
/gsd-capture --list                                # 浏览并处理待办事项
```

---

### `/gsd-review-backlog`

审查并将待办停车场中的条目提升到活动里程碑。

**每个条目的操作：** 提升（移至活动序列）、保留（留在待办停车场）、移除（删除）。

```bash
/gsd-review-backlog
```

---

### `/gsd-thread`

管理用于跨会话工作的持久上下文线程。

| 参数 | 必填 | 描述 |
|----------|----------|-------------|
| （无）/ `list` | — | 列出所有线程 |
| `list --open` | — | 仅列出状态为 `open` 或 `in_progress` 的线程 |
| `list --resolved` | — | 仅列出状态为 `resolved` 的线程 |
| `status <slug>` | — | 显示特定线程的状态 |
| `close <slug>` | — | 将线程标记为已解决 |
| `name` | — | 通过名称恢复现有线程 |
| `description` | — | 创建新线程 |

线程是用于跨多个会话但不属于任何特定阶段的工作的轻量级跨会话知识存储。比 `/gsd-pause-work` 更轻量。

```bash
/gsd-thread                         # 列出所有线程
/gsd-thread list --open             # 仅列出开放/进行中的线程
/gsd-thread list --resolved         # 仅列出已解决的线程
/gsd-thread status fix-deploy-key   # 显示线程状态
/gsd-thread close fix-deploy-key    # 将线程标记为已解决
/gsd-thread fix-deploy-key-auth     # 恢复线程
/gsd-thread "Investigate TCP timeout in pasta service"  # 创建新线程
```

---

## 路线图管理命令

### `roadmap validate`

验证 ROADMAP.md 的结构完整性，包括里程碑前缀一致性。

**前提条件：** `.planning/ROADMAP.md` 已存在
**产出：** 验证报告；发现任何错误或警告时以非零值退出

```bash
node gsd-tools.cjs roadmap validate
```

---

### `roadmap upgrade --convention milestone-prefixed`

将旧版 `Phase N` ID 迁移到以里程碑为前缀的 `Phase M-NN` 约定。

| 标志 | 必填 | 描述 |
|------|----------|-------------|
| `--convention milestone-prefixed` | 是 | 要迁移到的目标约定 |
| `--apply` | 否 | 将变更写入磁盘（默认：仅演练） |

**前提条件：** `.planning/ROADMAP.md` 已存在
**产出：** 演练差异（默认）或就地 ROADMAP.md 重写（`--apply`）

```bash
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed         # 演练
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed --apply  # 应用
```

---

## 状态管理命令

### `state validate`

检测 STATE.md 与实际文件系统之间的漂移。

**前提条件：** `.planning/STATE.md` 已存在
**产出：** 验证报告，显示 STATE.md 字段与文件系统实际情况之间的任何漂移

```bash
node gsd-tools.cjs state validate
```

---

### `state sync [--verify]`

从磁盘上的实际项目状态重建 STATE.md。

| 标志 | 描述 |
|------|-------------|
| `--verify` | 演练模式 — 显示建议的变更而不写入 |

**前提条件：** `.planning/` 目录已存在
**产出：** 反映文件系统实际情况的已更新 `STATE.md`

```bash
node gsd-tools.cjs state sync             # 从磁盘重建 STATE.md
node gsd-tools.cjs state sync --verify    # 演练：显示变更而不写入
```

---

### `state planned-phase`

在 plan-phase 完成后记录状态转换（已规划/准备执行）。

| 标志 | 描述 |
|------|-------------|
| `--phase N` | 已规划的阶段编号 |
| `--plans N` | 生成的计划数量 |

**前提条件：** 阶段已被规划
**产出：** 包含规划后状态的已更新 `STATE.md`

```bash
node gsd-tools.cjs state planned-phase --phase 3 --plans 2
```

---

## 社区命令

### 社区钩子

可选的 git 和会话钩子，由 `.planning/config.json` 中的 `hooks.community: true` 控制。除非明确启用，否则均为无操作。

| 钩子 | 用途 |
|------|---------|
| `gsd-validate-commit.sh` | 对 git 提交信息强制执行 Conventional Commits 格式 |
| `gsd-session-state.sh` | 跟踪会话状态转换 |
| `gsd-phase-boundary.sh` | 执行阶段边界检查 |

启用方式：
```json
{ "hooks": { "community": true } }
```

---

### 社区邀请

加入 GSD Discord 社区，请访问 GSD README 中的链接，或运行 `/gsd-help` 并点击其中显示的 Discord 链接。

---

## 贡献：技能描述标准

技能描述（每个 `commands/gsd/*.md` frontmatter 中的 `description:` 字段）会被注入到每个会话的系统提示中。为保持每会话开销较低，描述必须不超过 100 个字符，且不得重复 `argument-hint:` 中已有的标志文档。

一个 lint 门执行此预算：

```bash
npm run lint:descriptions
```

该检查也作为 `npm test` 的一部分通过 `tests/skill-frontmatter-contract.test.cjs` 运行。

---

## 相关文档

- [配置参考](CONFIGURATION.md)
- [CLI 工具参考](CLI-TOOLS.md)
- [功能参考](FEATURES.md)
- [文档索引](README.md)
