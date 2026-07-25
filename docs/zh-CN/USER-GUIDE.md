# GSD 用户指南

GSD Core 的叙述性辅助指南——从这里开始了解系统全貌，然后按链接进入各专项文档。

> **GSD Core 的文档按照 [Diataxis](https://diataxis.fr) 框架组织。**
> 按目标浏览：[教程](README.md#tutorials) · [操作指南](README.md#how-to-guides) · [参考手册](README.md#reference) · [说明](README.md#explanation) · [文档索引](README.md)

---

## 目录

- [斜杠命令形式](#slash-command-forms-hyphen-vs-colon)
- [命名空间路由入门](#namespace-routing-primer-gsdnamespace-v140)
- [项目生命周期概览](#project-lifecycle-overview)
- [工作流程图](#workflow-diagrams)
- [UI 设计契约](#ui-design-contract)
- [探针与草图](#spiking--sketching)
- [待办事项与线程](#backlog--threads)
- [工作流与工作区](#workstreams--workspaces)
- [安全](#security)
- [使用示例](#usage-examples)
- [故障排查](#troubleshooting)
- [快速恢复参考](#recovery-quick-reference)
- [项目文件结构](#project-file-structure)
- [相关资源](#related)

如需从 GitHub / Linear / Jira issue 直接驱动 GSD，请参阅
[issue-driven-orchestration](issue-driven-orchestration.md) 指南——该指南将跟踪器 issue
映射到工作区 → 讨论 → 计划 → 执行 → 验证 → 审查 → 发布的循环，使用现有的 GSD 基础功能实现。

---

## 斜杠命令形式（连字符 vs 冒号）

GSD 向所有支持的运行时提供**同一套技能**，但有两种斜杠拼写方式：

- **连字符形式** — `/gsd-command-name` — 供 Claude Code、Copilot、OpenCode、Kilo、Cursor、Windsurf、Augment、Antigravity 和 Trae 使用。
- **冒号形式** — `/gsd:command-name` — **仅供 Gemini CLI 使用**。Gemini 将每个插件的命令置于插件 ID 的命名空间下，因此安装时会在 `--gemini` 安装过程中将所有正文引用和命令文件改写为冒号形式。

无需手动选择——安装器会为您所针对的每个运行时写入正确形式。在 Gemini 终端上阅读演示时，将每个斜杠命令中 `gsd` 后的连字符替换为冒号即可。

## 命名空间路由入门（`gsd:<namespace>`，v1.40）

v1.40 提供了六个**命名空间元技能**，作为分层路由的第一阶段入口——它们将贪婪技能列举的 token 成本保持在较低水平（6 个路由器约 120 个 token，而扁平列举 86 个技能约需 2,150 个 token），同时每个具体子技能仍可直接调用。每个命名空间路由器的正文包含一张路由表，将您的意图映射到正确的具体子技能。

| 命名空间 | 路由器 | 路由目标 |
|-----------|--------|-----------|
| 阶段流水线 | `/gsd-workflow` | discuss / plan / execute / verify / phase / progress |
| 项目生命周期 | `/gsd-project` | milestones, audits, summary |
| 质量关卡 | `/gsd-quality` | code review, debug, audit, security, eval, ui |
| 代码库情报 | `/gsd-context` | map, graphify, docs, learnings |
| 管理 | `/gsd-manage` | config, workspace, workstreams, thread, update, ship, inbox |
| 探索与捕获 | `/gsd-ideate` | explore, sketch, spike, spec, capture |

您几乎不需要亲自输入命名空间路由器。它们的价值在于为模型提供发现正确子技能的路由层——其存在使系统提示只需列出 6 条而非 86 条。如果您已经知道具体命令（例如 `/gsd-plan-phase`），可直接调用。

---

## 项目生命周期概览

GSD 核心循环为：**discuss → plan → execute → verify → ship**，每个阶段重复一次。包括示例输出、创建哪些文件以及所有生效标志的完整逐步演练，请参阅专项教程。

参见 [您的第一个项目](tutorials/your-first-project.md)。

在开始新里程碑之前对现有代码库进行引导，请参见 [引导现有代码库](tutorials/onboarding-an-existing-codebase.md)。

**相关标志速览：**

| 标志 | 命令 | 使用场景 |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | 跳过交互式问题，从 PRD 文件导入 |
| `--research` | `/gsd-quick` | 为临时任务添加研究 Agent |
| `--validate` | `/gsd-quick` | 添加计划检查和执行后验证 |
| `--chain` | `/gsd-discuss-phase` | 自动链式运行 discuss → plan → execute 而不中断 |
| `--skip-research` | `/gsd-plan-phase` | 在领域已熟悉时跳过研究 Agent |
| `--draft` | `/gsd-ship` | 创建草稿 PR 而非待审查 PR |

完整命令参考（含所有标志）请参阅 [`docs/COMMANDS.md`](COMMANDS.md)。配置选项（模型配置文件、工作流 Agent、git 分支策略）请参阅 [`docs/CONFIGURATION.md`](CONFIGURATION.md)。

---

## 工作流程图

### 完整项目生命周期

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### 计划 Agent 协调

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### 验证架构（奈奎斯特层）

在计划阶段研究期间，GSD 会在编写任何代码之前将自动化测试覆盖率映射到每个阶段的需求上。研究者会检测您现有的测试基础设施，将每个需求映射到特定的测试命令，并识别在实施开始前必须创建的测试脚手架（Wave 0 任务）。计划检查器将此作为第 8 个验证维度执行：缺少自动化验证命令的任务计划将不会被批准。

**输出：** `{phase}-VALIDATION.md` — 阶段的反馈契约。

**禁用：** 在 `/gsd-settings` 中将 `workflow.nyquist_validation: false` 设置为 false，适用于测试基础设施不是重点的快速原型阶段。

### 追溯验证（`/gsd-validate-phase`）

对于在奈奎斯特验证出现之前执行的阶段，或仅有传统测试套件的现有代码库，可追溯审计并填补覆盖缺口：

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

审计器永不修改实现代码——仅修改测试文件和 VALIDATION.md。如果测试揭示了实现中的错误，将以升级问题的形式标记供您处理。

### 假设讨论模式

默认情况下，`/gsd-discuss-phase` 会就您的实现偏好提出开放性问题。假设模式将此倒转：GSD 首先读取您的代码库，提出关于如何构建该阶段的结构化假设，然后仅就修正内容提问。

**启用：** 通过 `/gsd-settings` 将 `workflow.discuss_mode` 设置为 `'assumptions'`。

完整的讨论模式参考请参阅 [docs/workflow-discuss-mode.md](workflow-discuss-mode.md)。

### 决策覆盖关卡

讨论阶段将实现决策以编号项（`- **D-01:** …`）的形式捕获到 CONTEXT.md 的 `<decisions>` 块中。两个关卡确保这些决策能延续到计划和交付代码中。

**计划阶段转换关卡（阻塞）。** 计划完成后，GSD 会拒绝将阶段标记为已计划，直到每个可跟踪决策出现在至少一个计划的 `must_haves`、`truths` 或正文中。

**验证阶段验证关卡（非阻塞）。** 在验证期间，GSD 会在计划、SUMMARY.md、修改文件和最近提交消息中搜索每个可跟踪决策。遗漏项以警告章节的形式记录到 VERIFICATION.md；验证状态不变。

**将决策排除在外。** 将其移至 `<decisions>` 内的 `### Claude's Discretion` 标题下，或添加标签：`- **D-08 [informational]:** …`、`- **D-09 [folded]:** …`、`- **D-10 [deferred]:** …`。

**禁用关卡。** 在 `.planning/config.json` 中设置 `workflow.context_coverage_gate: false`（或通过 `/gsd-settings`）。默认值为 `true`。

### 执行波次协调

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

---

## UI 设计契约

AI 生成的前端在视觉上不一致，原因不在于 Claude Code 在 UI 方面能力不足，而在于执行前没有建立设计契约。`/gsd-ui-phase` 在计划前锁定设计契约；`/gsd-ui-review` 在执行后审计结果。

完整工作流、配置、shadcn 初始化以及注册表安全关卡，请参阅 [设计 UI 阶段](how-to/design-a-ui-phase.md)。

**快速参考：**

| 命令              | 描述                                              |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | 为前端阶段生成 UI-SPEC.md 设计契约 |
| `/gsd-ui-review [N]` | 对已实现 UI 进行追溯性六维视觉审计      |

| 设置                   | 默认值 | 描述                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | 为前端阶段生成 UI 设计契约            |
| `workflow.ui_safety_gate` | `true`  | 计划阶段提示为前端阶段运行 /gsd-ui-phase |

---

## 探针与草图

使用 `/gsd-spike` 在计划前验证技术可行性，使用 `/gsd-sketch` 在设计前探索视觉方向。两者均将产物存储在 `.planning/` 中，并通过其配套的收尾工具与项目技能系统集成。

完整工作流和流程图请参阅 [探针与草图](how-to/spike-and-sketch.md)。

**典型流程：**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## 待办事项与线程

### 待办事项停车场

尚未准备好进入主动计划的想法使用 999.x 编号进入待办事项，保持在活跃阶段序列之外。

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

待办事项获得完整的阶段目录，因此您可以使用 `/gsd-discuss-phase 999.1` 进一步探索某个想法，或在准备好时使用 `/gsd-plan-phase 999.1`。

**审查和提升**使用 `/gsd-review-backlog`——它显示所有待办事项，并让您选择提升（移至活跃序列）、保留（留在待办事项中）或移除（删除）。

### 种子

种子是带有触发条件的前瞻性想法。与待办事项不同，种子会在正确的里程碑到来时自动浮现。

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone` 会扫描所有种子并呈现匹配项。**存储位置：** `.planning/seeds/SEED-NNN-slug.md`

### 持久上下文线程

线程是轻量级的跨会话知识存储，用于跨多个会话但不属于任何特定阶段的工作。

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

线程成熟后可提升为阶段（`/gsd-phase`）或待办事项（`/gsd-capture --backlog`）。**存储位置：** `.planning/threads/{slug}.md`

---

## 工作流与工作区

工作流（Workstreams）和工作区（Workspaces）都提供隔离，但级别不同。

**Workstreams** 共享同一代码库和 git 历史，但隔离规划产物——更轻量，适合并发处理多个里程碑区域。参见 [使用 Workstreams 并行工作](how-to/work-in-parallel-with-workstreams.md)。

**Workspaces** 创建各自拥有 `.planning/` 的独立仓库工作树——更重，用于特性分支或多仓库隔离。参见 [使用 Workspaces 隔离工作](how-to/isolate-work-with-workspaces.md)。

| 命令                            | 用途                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | 创建具有隔离计划状态的新工作流 |
| `/gsd-workstreams switch <name>`   | 将活跃上下文切换到不同的工作流      |
| `/gsd-workstreams list`            | 显示所有工作流及当前活跃的工作流             |
| `/gsd-workstreams complete <name>` | 将工作流标记为完成并归档其状态      |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## 安全

### 纵深防御（v1.27）

GSD 生成的 Markdown 文件会成为 LLM 系统提示。这意味着流入规划产物的任何用户控制文本都是潜在的间接提示注入向量。v1.27 引入了集中式安全加固：

**路径遍历防护：** 所有用户提供的文件路径（`--text-file`、`--prd`）均经过验证，确保解析在项目目录内。macOS 的 `/var` → `/private/var` 符号链接解析已处理。

**提示注入检测：** `security.cjs` 模块在用户提供的文本进入规划产物之前扫描已知的注入模式。

**运行时钩子：**

- `gsd-prompt-guard.js` — 扫描写入 `.planning/` 的 Write/Edit 调用中的注入模式（始终活跃，仅建议）
- `gsd-workflow-guard.js` — 对 GSD 工作流上下文之外的文件编辑发出警告（通过 `hooks.workflow_guard` 选择性启用）

**CI 扫描器：** `prompt-injection-scan.security.test.cjs` 扫描所有 agent、工作流和命令文件中的嵌入式注入向量。

---

### 包合法性关卡（v1.42.1）

AI 编码工具会幻觉出包名。攻击者会在 npm、PyPI 和 crates.io 上预先注册这些名称，并附带恶意的安装后脚本——这种技术称为 *slopsquatting*。v1.42.1 增加了三层关卡，在到达您的 shell 之前阻止这一问题。

**在 RESEARCH.md 中** — 每个推荐外部包的阶段都包含一个 `## Package Legitimacy Audit` 表：

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

`[SLOP]` 包将从 RESEARCH.md 中完全删除，永远不会到达规划器。

**在 PLAN.md 中** — `[SUS]` 或 `[ASSUMED]` 包会在安装前触发 `checkpoint:human-verify` 任务。

**执行期间** — 如果安装失败，执行器会显示检查点并停止，而不是静默尝试替代方案。

**Slopcheck 判定：**

| 判定 | 含义 | GSD 操作 |
|---------|---------|------------|
| `[OK]` | 通过所有合法性检查 | 继续——不添加检查点 |
| `[SUS]` | 存在可疑信号 | 标记；规划器添加 `checkpoint:human-verify` |
| `[SLOP]` | 高置信度幻觉 | 从 RESEARCH.md 中删除；永远不会到达规划器 |

手动安装 slopcheck：

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## 代码审查工作流

执行阶段后，在 UAT 前进行结构化代码审查。完整工作流请参阅 [设置跨 AI 审查](how-to/set-up-cross-ai-review.md)。

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

审查步骤插入在执行之后、UAT 之前：

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## 命令与配置参考

- **命令参考：** 参见 [`docs/COMMANDS.md`](COMMANDS.md)，包含每个稳定命令的标志、子命令和示例。
- **配置参考：** 参见 [`docs/CONFIGURATION.md`](CONFIGURATION.md)，包含完整的 `config.json` 模式、模型配置文件表、git 分支策略和安全设置。
- **讨论模式：** 参见 [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md)，了解访谈模式与假设模式。

---

## 使用示例

### 新建项目（完整周期）

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### 从现有文档新建项目

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### 现有代码库

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow printed handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

**执行后漂移检测（#2003）。** 每次 `/gsd-execute-phase` 之后，GSD 会检查该阶段是否引入了足够的结构变化，使 `.planning/codebase/STRUCTURE.md` 过时。通过以下方式调整行为：

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### 计划漂移守卫

**默认开启。** 计划漂移守卫（`plan_review.source_grounding: true`）在计划审查期间运行，验证计划中引用的每个符号——装饰器、类、函数、CLI 标志——在审查时实际存在于源代码树中。这可以在任何执行 Agent 运行前捕获幻觉的名称。

**捕获内容：**

- PLAN.md 步骤中引用的函数在源代码中不存在
- 自计划编写以来被重命名或删除的类或装饰器名称
- 计划中记录的 CLI 标志未在参数解析器中定义
- 实现步骤中引用的模块路径未解析到任何文件

**needs-acknowledgement 行为。** 当守卫发现缺失的符号时，它会在计划审查输出中发出 needs-acknowledgement 通知，而不是硬性阻塞。您可以确认并继续（该符号可能是有意新增的），或请求修改计划。守卫不会自动拒绝计划——它为人工决策提供信号。

**无需 intel 即可工作。** 默认情况下，守卫使用 `grep`/`ripgrep` 搜索源文件——无需预先索引。如果您已使用 `intel.enabled: true` 运行 `/gsd:map-codebase`，请将 `plan_review.source_grounding_authority: intel` 设置为使用更快的预构建 `api-map.json` 索引。

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

在项目设置时切换（`/gsd:new-project` 在工作流偏好设置期间询问）或随时通过 `/gsd:settings`（计划部分 → 漂移守卫）切换。

### 快速修复 Bug

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### 休息后恢复工作

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### 准备发布

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### 速度与质量预设

| 场景    | 模式          | 粒度 | 配置文件    | 研究 | 计划检查 | 验证器 |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| 原型开发 | `yolo`        | `coarse`    | `budget`   | 关闭      | 关闭        | 关闭      |
| 常规开发  | `interactive` | `standard`  | `balanced` | 开启       | 开启        | 开启       |
| 生产环境  | `interactive` | `fine`      | `quality`  | 开启       | 开启        | 开启       |

**在自主模式下跳过讨论阶段：** 以 `yolo` 模式运行时，通过 `/gsd-settings` 设置 `workflow.skip_discuss: true`。

### 里程碑中期范围变更

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## 故障排查

完整的故障排查指南请参阅 [恢复与故障排查](how-to/recover-and-troubleshoot.md)。以下是最常见问题的摘要。

### 程序化 CLI（`gsd-tools query` 与 `gsd-tools.cjs`）

对于自动化，优先使用带有已注册子命令的 **`gsd-tools query`**（参见 [CLI-TOOLS.md — SDK 和程序化访问](CLI-TOOLS.md#sdk-and-programmatic-access) 及 QUERY-HANDLERS.md）。旧版 `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` CLI 仍受支持。

### STATE.md 不同步

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### 命令在"Spawning..."后似乎冻结

GSD 子 Agent 在单独的上下文窗口中运行——其工作在进行中对父会话不可见。请勿中断会话。等待结果；研究和计划 Agent 通常需要 1–5 分钟。

### 长会话期间上下文退化

在主要命令之间清除上下文窗口：在 Claude Code 中使用 `/clear`。GSD 围绕全新上下文设计——每个子 Agent 获得一个干净的 200K 窗口。清除后使用 `/gsd-resume-work` 或 `/gsd-progress` 恢复状态。

### 计划似乎不正确或不一致

在计划前运行 `/gsd-discuss-phase [N]`。大多数计划质量问题来源于 Claude 在 `CONTEXT.md` 本可避免的情况下做出假设。

### 执行失败或产生存根

检查计划是否过于雄心勃勃。计划最多应有 2–3 个任务。以更小的范围重新计划。

### 不知道当前位置

运行 `/gsd-progress`。它读取所有状态文件，精确告诉您当前所在位置和下一步操作。

### 模型成本过高

切换到预算配置文件：`/gsd-config --profile budget`。如果领域已熟悉，通过 `/gsd-settings` 禁用研究和计划检查 Agent。

### 按阶段调整模型成本（`models`）——v1.40 新增

在 `.planning/config.json` 中添加 `models` 块：

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  }
}
```

需要针对单个 Agent 的例外情况？在旁边添加 `model_overrides`——它优先于 `models`：

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

完整的映射表和解析优先级规则，请参阅 [按阶段类型分配模型](CONFIGURATION.md#per-phase-type-models-models--added-in-v140)。

### 使用 `dynamic_routing` 默认降低成本——v1.40 新增

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

完整的 Agent → 层级映射，请参阅 [动态路由](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140)。

### 精简 MCP 服务器以降低每次交互成本

在调整 `model_profile` 或 `models.<phase_type>` 之前，请审计您的运行时启用了哪些 **MCP 服务器**。每个启用的 MCP 服务器都会将其工具模式注入每次交互——重量级服务器每次可能消耗超过 20k 个 token。

这是**运行时设置**，不是 GSD 设置。切换项位于 `.claude/settings.json`：

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

长阶段前的快速审计：

- 此阶段没有 UI 工作时，是否有任何浏览器 / playwright 工具被启用？
- 不需要时，是否有任何平台特定工具被启用？
- 是否有来自其他项目的项目专属 MCP 仍在此处启用？

每个被禁用的服务器都会从后续每次交互中移除其模式。精简 MCP **与** `model_profile` 调整形成叠加效果——两个杠杆是累加的，MCP 节省效果立即体现在编排器生成的每个子 Agent 上。

完整审计、运行时参考及与 `model_profile` 的组合说明，请参阅捆绑的 `context-budget.md` 参考中的 [MCP 工具模式成本](../../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern)。

### 使用非 Claude 运行时（Codex、OpenCode、Gemini CLI、Kilo）

> **Codex CLI 最低支持版本：`0.130.0`**（issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)）。

如果您为非 Claude 运行时安装了 GSD，安装器已配置好模型解析。无需手动设置——`resolve_model_ids: "omit"` 会自动设置，告知 GSD 跳过 Anthropic 模型 ID 解析，让运行时选择其默认模型。

在非 Claude 运行时上分配不同模型：

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### 通过一次配置更改从 Claude 切换到 Codex（#2517）

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

参见 [运行时感知配置文件](CONFIGURATION.md#runtime-aware-profiles-2517)。

### 手动安装 / 无 Node.js 设置

如果无法运行 GSD 安装器，则无法直接使用 `agents/` 中的源文件——它们采用 Claude Code 的原生 frontmatter 格式。对于 OpenCode，需要进行两项转换：

| 字段 | GSD 源格式 | OpenCode 有效格式 | 操作 |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep`（逗号字符串） | 不是 frontmatter 字段 | 完全删除 `tools:` 行 |
| `color:` | 纯 CSS 颜色名称 | 十六进制或 OpenCode 语义名称 | 转换为十六进制或删除 |

**替代方案：** 在任何有 Node.js 的机器上运行安装器：

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### 为 Cline 安装

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### 为 CodeBuddy 安装

```bash
npx @opengsd/gsd-core --codebuddy --global
```

### 为 Qwen Code 安装

```bash
npx @opengsd/gsd-core --qwen --global
```

### 为预发布版本安装

在运行安装器前，将运行时的 `*_CONFIG_DIR` 环境变量设置为预发布目录：

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**支持运行时的环境变量参考：**

| 运行时 | 稳定默认值 | 覆盖环境变量 |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `~/.gemini` | `GEMINI_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | （按 Codex CLI） | `--config-dir` 标志 |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | 自动检测 | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### 将 Claude Code 与非 Anthropic 提供商结合使用

切换到 `inherit` 配置文件：`/gsd-config --profile inherit`。这使所有 Agent 使用您当前的会话模型。

### 处理敏感/私有项目

在 `/gsd-new-project` 期间或通过 `/gsd-settings` 设置 `commit_docs: false`。将 `.planning/` 添加到您的 `.gitignore`。

### GSD 更新覆盖了我的本地更改

自 v1.17 起，安装器会将本地修改的文件备份到 `gsd-local-patches/`。运行 `/gsd-update --reapply` 将您的更改合并回来。

### 无法通过 npm 更新

参见 [docs/manual-update.md](../manual-update.md) 中的逐步手动更新程序。

### 工作流诊断（`/gsd-forensics`）

当工作流以不明显的方式失败时，运行 `/gsd-forensics` 生成涵盖 git 历史异常、产物完整性和状态不一致的诊断报告。输出写入 `.planning/forensics/`。

### 执行器子 Agent 在 Bash 命令上遇到"Permission denied"

将所需模式添加到 `~/.claude/settings.json`。所有技术栈所需的核心模式：

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**项目级权限：** 将相同的 `permissions.allow` 块添加到项目根目录的 `.claude/settings.local.json`，而不是 `~/.claude/settings.json`。

### 并行执行导致构建锁定错误

GSD 自 v1.26 起自动处理此问题。如果您使用的是旧版本，请在项目的 `CLAUDE.md` 中添加：

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

完全禁用并行执行：`/gsd-settings` → 将 `parallelization.enabled` 设置为 `false`。

---

## 快速恢复参考

| 问题                              | 解决方案                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 丢失上下文 / 新会话           | `/gsd-resume-work` 或 `/gsd-progress`                                    |
| 阶段出错                     | `git revert` 阶段提交，然后重新计划                             |
| 需要更改范围                 | `/gsd-phase`（默认）、`/gsd-phase --insert` 或 `/gsd-phase --remove`  |
| 出现问题                      | `/gsd-debug "description"`（添加 `--diagnose` 进行分析而不修复） |
| STATE.md 不同步                 | `state validate` 然后 `state sync`                                       |
| 工作流状态似乎损坏       | `/gsd-forensics`                                                         |
| 快速定向修复                   | `/gsd-quick`                                                             |
| 计划与您的愿景不符       | `/gsd-discuss-phase [N]` 然后重新计划                                    |
| 成本持续上涨                   | `/gsd-config --profile budget` 并通过 `/gsd-settings` 关闭 Agent  |
| 更新破坏了本地更改           | `/gsd-update --reapply`                                                  |
| 需要为利益相关者生成会话摘要 | `/gsd-pause-work --report`                                               |
| 不知道下一步是什么         | `/gsd-progress --next`                                                   |
| 并行执行构建错误      | 更新 GSD 或设置 `parallelization.enabled: false`                       |

---

## 项目文件结构

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    completed/             # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase or /gsd-onboard)
  onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## 相关资源

- [文档索引](README.md)
- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [阶段循环](explanation/the-phase-loop.md)
