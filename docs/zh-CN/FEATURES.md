# GSD 功能参考

> GSD Core 的功能索引与参考文档。架构细节请参见[架构文档](ARCHITECTURE.md)。命令语法请参见[命令参考](COMMANDS.md)。返回[文档索引](README.md)。

---

## 目录

- [核心功能](#core-features)
  - [项目初始化](#1-project-initialization)
  - [阶段讨论](#2-phase-discussion)
  - [UI 设计契约](#3-ui-design-contract)
  - [阶段规划](#4-phase-planning)
  - [阶段执行](#5-phase-execution)
  - [工作验收](#6-work-verification)
  - [UI 审查](#7-ui-review)
  - [里程碑管理](#8-milestone-management)
- [规划功能](#planning-features)
  - [阶段管理](#9-phase-management)
  - [快速模式](#10-quick-mode)
  - [自主模式](#11-autonomous-mode)
  - [自由路由](#12-freeform-routing)
  - [笔记捕获](#13-note-capture)
  - [自动推进 (Next)](#14-auto-advance-next)
- [质量保障功能](#quality-assurance-features)
  - [Nyquist 验证](#15-nyquist-validation)
  - [计划检查](#16-plan-checking)
  - [执行后验证](#17-post-execution-verification)
  - [节点修复](#18-node-repair)
  - [健康验证](#19-health-validation)
  - [跨阶段回归门控](#20-cross-phase-regression-gate)
  - [需求覆盖门控](#21-requirements-coverage-gate)
- [上下文工程功能](#context-engineering-features)
  - [上下文窗口监控](#22-context-window-monitoring)
  - [会话管理](#23-session-management)
  - [会话报告](#24-session-reporting)
  - [多智能体编排](#25-multi-agent-orchestration)
  - [模型配置](#26-model-profiles)
- [棕地功能](#brownfield-features)
  - [代码库映射](#27-codebase-mapping)
  - [现有代码库接入](#27b-现有代码库接入)
- [实用功能](#utility-features)
  - [调试系统](#28-debug-system)
  - [待办事项管理](#29-todo-management)
  - [统计仪表板](#30-statistics-dashboard)
  - [更新系统](#31-update-system)
  - [设置管理](#32-settings-management)
  - [测试生成](#33-test-generation)
- [基础设施功能](#infrastructure-features)
  - [Git 集成](#34-git-integration)
  - [CLI 工具](#35-cli-tools)
  - [多运行时支持](#36-multi-runtime-support)
  - [钩子系统](#37-hook-system)
  - [开发者画像](#38-developer-profiling)
  - [执行加固](#39-execution-hardening)
  - [验证债务追踪](#40-verification-debt-tracking)
- [v1.27 功能](#v127-features)
  - [快速模式](#41-fast-mode)
  - [跨 AI 同行评审](#42-cross-ai-peer-review)
  - [待办停车场](#43-backlog-parking-lot)
  - [持久化上下文线程](#44-persistent-context-threads)
  - [PR 分支过滤](#45-pr-branch-filtering)
  - [安全加固](#46-security-hardening)
  - [多仓库工作区支持](#47-multi-repo-workspace-support)
  - [讨论审计追踪](#48-discussion-audit-trail)
- [v1.28 功能](#v128-features)
  - [取证分析](#49-forensics)
  - [里程碑摘要](#50-milestone-summary)
  - [工作流命名空间](#51-workstream-namespacing)
  - [管理仪表板](#52-manager-dashboard)
  - [假设讨论模式](#53-assumptions-discussion-mode)
  - [UI 阶段自动检测](#54-ui-phase-auto-detection)
  - [多运行时安装选择](#55-multi-runtime-installer-selection)
- [v1.29 功能](#v129-features)
  - [Windsurf 运行时支持](#56-windsurf-runtime-support)
  - [国际化文档](#57-internationalized-documentation)
- [v1.31 功能](#v131-features)
  - [Schema 漂移检测](#59-schema-drift-detection)
  - [安全强制执行](#60-security-enforcement)
  - [文档生成](#61-documentation-generation)
  - [讨论链模式](#62-discuss-chain-mode)
  - [单阶段自主执行](#63-single-phase-autonomous)
  - [范围缩减检测](#64-scope-reduction-detection)
  - [声明来源标记](#65-claim-provenance-tagging)
  - [工作树切换](#66-worktree-toggle)
  - [项目代码前缀](#67-project-code-prefixing)
  - [Claude Code 技能迁移](#68-claude-code-skills-migration)
- [v1.32 功能](#v132-features)
  - [STATE.md 一致性门控](#69-statemd-consistency-gates)
  - [自主 `--to N` 标志](#70-autonomous---to-n-flag)
  - [研究门控](#71-research-gate)
  - [验证器里程碑范围过滤](#72-verifier-milestone-scope-filtering)
  - [编辑前读取守护钩子](#73-read-before-edit-guard-hook)
  - [上下文压缩](#74-context-reduction)
  - [讨论阶段 `--power` 标志](#75-discuss-phase---power-flag)
  - [调试 `--diagnose` 标志](#76-debug---diagnose-flag)
  - [阶段依赖分析](#77-phase-dependency-analysis)
  - [反模式严重级别](#78-anti-pattern-severity-levels)
  - [方法论构件类型](#79-methodology-artifact-type)
  - [规划器可达性检查](#80-planner-reachability-check)
  - [Playwright-MCP UI 验证](#81-playwright-mcp-ui-verification)
  - [暂停工作扩展](#82-pause-work-expansion)
  - [响应语言配置](#83-response-language-config)
  - [手动更新流程](#84-manual-update-procedure)
  - [新运行时支持（Trae、Cline、Augment Code）](#85-new-runtime-support-trae-cline-augment-code)
  - [自主 `--interactive` 标志](#86-autonomous---interactive-flag)
  - [提交文档守护钩子](#87-commit-docs-guard-hook)
  - [社区钩子选项](#88-community-hooks-opt-in)
- [v1.34.0 功能](#v1340-features)
  - [全局学习存储](#89-global-learnings-store)
  - [可查询代码库智能](#90-queryable-codebase-intelligence)
  - [执行上下文配置](#91-execution-context-profiles)
  - [门控分类](#92-gates-taxonomy)
  - [代码审查流水线](#93-code-review-pipeline)
  - [苏格拉底式探索](#94-socratic-exploration)
  - [安全撤销](#95-safe-undo)
  - [计划导入](#96-plan-import)
  - [快速代码库扫描](#97-rapid-codebase-scan)
  - [自主审计修复](#98-autonomous-audit-to-fix)
  - [改进的提示注入扫描器](#99-improved-prompt-injection-scanner)
  - [规划阶段停滞检测](#100-stall-detection-in-plan-phase)
  - [/gsd-progress --next 中的硬停止安全门控](#101-hard-stop-safety-gates-in-gsd-progress---next)
  - [自适应模型预设](#102-adaptive-model-preset)
  - [合并后 Hunk 验证](#103-post-merge-hunk-verification)
- [v1.35.0 功能](#v1350-features)
  - [新运行时支持（Cline、CodeBuddy、Qwen Code）](#104-new-runtime-support-cline-codebuddy-qwen-code)
  - [GSD-2 反向迁移](#105-gsd-2-reverse-migration)
  - [AI 集成阶段向导](#106-ai-integration-phase-wizard)
  - [AI 评估审查](#107-ai-eval-review)
- [v1.36.0 功能](#v1360-features)
  - [计划弹跳](#108-plan-bounce)
  - [外部代码审查命令](#109-external-code-review-command)
  - [跨 AI 执行委托](#110-cross-ai-execution-delegation)
  - [架构职责映射](#111-architectural-responsibility-mapping)
  - [提取学习成果](#112-extract-learnings)
  - [上下文窗口感知提示精简](#114-context-window-aware-prompt-thinning)
  - [可配置的 CLAUDE.md 路径](#115-configurable-claudemd-path)
  - [TDD 流水线模式](#116-tdd-pipeline-mode)
- [v1.37.0 功能](#v1370-features)
  - [Spike 命令](#117-spike-command)
  - [Sketch 命令](#118-sketch-command)
  - [智能体大小预算强制](#119-agent-size-budget-enforcement)
  - [共享样板提取](#120-shared-boilerplate-extraction)
  - [知识图谱集成](#121-knowledge-graph-integration)
- [v1.40.0 功能](#v1400-features)
  - [技能界面整合](#122-skill-surface-consolidation)
  - [命名空间元技能（两阶段路由）](#123-namespace-meta-skills-two-stage-routing)
  - [上下文窗口利用率守护](#124-context-window-utilization-guard)
  - [阶段生命周期状态行读取侧](#125-phase-lifecycle-status-line-read-side)
- [v1.41.0 功能](#v1410-features)
  - [按阶段类型选择模型](#126-per-phase-type-model-selection)
  - [带失败层级升级的动态路由](#127-dynamic-routing-with-failure-tier-escalation)
  - [更新横幅选项](#128-update-banner-opt-in)
  - [Issue 驱动编排指南](#129-issue-driven-orchestration-guide)
  - [Graphify 基于提交的过期检测](#130-graphify-commit-based-staleness)
- [v1.42.1 功能](#v1421-features)
  - [包合法性门控](#132-package-legitimacy-gate)
  - [技能界面预算](#133-skill-surface-budgeting)
  - [安装迁移](#134-installer-migrations)
  - [自定义 Ship PR 正文节区](#135-custom-ship-pr-body-sections)
  - [评审默认审查者](#136-review-default-reviewers)
  - [Fallow 结构性审查预处理](#137-fallow-structural-review-pre-pass)
  - [阶段末人工验证模式](#138-end-of-phase-human-verification-mode)
  - [配额与速率限制失败分类](#139-quota-and-rate-limit-failure-classification)
  - [状态栏上下文位置](#140-statusline-context-position)
  - [里程碑标签创建开关](#141-milestone-tag-creation-toggle)
  - [结构化 JSON 错误模式](#142-structured-json-error-mode)

---

## 核心功能

### 1. 项目初始化

**命令：** `/gsd-new-project [--auto @file.md]`

**目的：** 将用户想法转化为具有研究支撑、范围需求和阶段路线图的完整结构化项目。

**需求：**
- REQ-INIT-01：系统必须进行自适应提问，直到充分理解项目范围
- REQ-INIT-02：系统必须派生并行研究智能体，调查领域生态系统
- REQ-INIT-03：系统必须将需求提取并分类为 v1（必须有）、v2（未来）和超出范围三类
- REQ-INIT-04：系统必须生成具有需求可追溯性的阶段路线图
- REQ-INIT-05：系统必须在继续之前要求用户审批路线图
- REQ-INIT-06：当 `.planning/PROJECT.md` 已存在时，系统必须阻止重新初始化
- REQ-INIT-07：系统必须支持 `--auto @file.md` 标志，以跳过交互式问题并从文档中提取信息

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `PROJECT.md` | 项目愿景、约束条件、技术决策、演进规则 |
| `REQUIREMENTS.md` | 带唯一 ID（REQ-XX）的范围化需求 |
| `ROADMAP.md` | 带状态跟踪和需求映射的阶段分解 |
| `STATE.md` | 含位置、决策、指标的初始项目状态 |
| `config.json` | 工作流配置 |
| `research/SUMMARY.md` | 综合领域研究 |
| `research/STACK.md` | 技术栈调研 |
| `research/FEATURES.md` | 功能实现模式 |
| `research/ARCHITECTURE.md` | 架构模式与权衡 |
| `research/PITFALLS.md` | 常见失败模式与缓解措施 |

**流程：**
1. **提问** — 以"梦想提取"理念（而非需求收集）为指导的自适应提问
2. **研究** — 4 个并行研究智能体分别调查技术栈、功能、架构和陷阱
3. **综合** — 研究综合器将发现汇总为 SUMMARY.md
4. **需求** — 从用户回答与研究成果中提取，按范围分类
5. **路线图** — 阶段分解映射至需求，粒度设置控制阶段数量

**功能需求：**
- 问题根据检测到的项目类型（Web 应用、CLI、移动端、API 等）自适应调整
- 研究智能体具备网页搜索能力，可获取当前生态系统信息
- 粒度设置控制阶段数量：`coarse`（3-5）、`standard`（5-8）、`fine`（8-12）
- `--auto` 模式从提供的文档中提取所有信息，无需交互式提问
- 如果存在来自 `/gsd-map-codebase` 的代码库上下文，将自动加载

---

### 2. 阶段讨论

**命令：** `/gsd-discuss-phase [N] [--auto] [--batch]`

**目的：** 在研究和规划开始之前，捕获用户的实现偏好和决策。消除导致 AI 猜测的灰色地带。

**需求：**
- REQ-DISC-01：系统必须分析阶段范围并识别决策区域（灰色地带）
- REQ-DISC-02：系统必须按类型（视觉、API、内容、组织等）对灰色地带进行分类
- REQ-DISC-03：系统必须只提问先前 CONTEXT.md 文件中尚未回答的问题
- REQ-DISC-04：系统必须将决策持久化到 `{phase}-CONTEXT.md`，并附带规范引用
- REQ-DISC-05：系统必须支持 `--auto` 标志，自动选择推荐的默认值
- REQ-DISC-06：系统必须支持 `--batch` 标志，用于分组问题采集
- REQ-DISC-07：系统必须在识别灰色地带之前侦查相关源文件（代码感知讨论）
- REQ-DISC-08：当 USER-PROFILE.md 显示用户为非技术负责人时（learning_style: guided、frustration_triggers 中含行话，或解释深度偏高层），系统必须将灰色地带语言调整为产品成果术语
- REQ-DISC-09：当 REQ-DISC-08 适用时，advisor_research 理由段落必须用通俗语言改写——相同的决策，转化后的表达方式

**产出物：** `{padded_phase}-CONTEXT.md` — 输入研究和规划的用户偏好

**灰色地带类别：**
| 类别 | 决策示例 |
|----------|-------------------|
| 视觉功能 | 布局、密度、交互、空状态 |
| API/CLI | 响应格式、标志、错误处理、详细程度 |
| 内容系统 | 结构、语气、深度、流程 |
| 组织 | 分组标准、命名、重复项、例外情况 |

---

### 3. UI 设计契约

**命令：** `/gsd-ui-phase [N]`

**目的：** 在规划之前锁定设计决策，使阶段中所有组件共享一致的视觉标准。

**需求：**
- REQ-UI-01：系统必须检测现有设计系统状态（shadcn components.json、Tailwind 配置、令牌）
- REQ-UI-02：系统必须只提问尚未回答的设计契约问题
- REQ-UI-03：系统必须从 6 个维度进行验证（文案、视觉、颜色、排版、间距、注册表安全）
- REQ-UI-04：当验证返回 BLOCKED 时，系统必须进入修订循环（最多 2 次迭代）
- REQ-UI-05：对于没有 `components.json` 的 React/Next.js/Vite 项目，系统必须提供 shadcn 初始化
- REQ-UI-06：系统必须对第三方 shadcn 注册表实施注册表安全门控

**产出物：** `{padded_phase}-UI-SPEC.md` — 执行者使用的设计契约

**6 个验证维度：**
1. **文案** — CTA 标签、空状态、错误消息
2. **视觉** — 焦点、视觉层次、图标无障碍
3. **颜色** — 强调色使用规范、60/30/10 合规性
4. **排版** — 字体大小/粗细约束遵守情况
5. **间距** — 网格对齐、令牌一致性
6. **注册表安全** — 第三方组件检查要求

**shadcn 集成：**
- 检测 React/Next.js/Vite 项目中缺失的 `components.json`
- 引导用户完成 `ui.shadcn.com/create` 预设配置
- 预设字符串成为可跨阶段复现的规划构件
- 安全门控要求在使用第三方组件前执行 `npx shadcn view` 和 `npx shadcn diff`

---

### 4. 阶段规划

**命令：** `/gsd-plan-phase [N] [--auto] [--skip-research] [--skip-verify]`

**目的：** 研究实现领域，生成经过验证的原子化执行计划。

**需求：**
- REQ-PLAN-01：系统必须派生阶段研究员来调查实现方案
- REQ-PLAN-02：系统必须生成每个包含 2-3 个任务的计划，大小适合单个上下文窗口
- REQ-PLAN-03：系统必须将计划结构化为 XML，`<task>` 元素包含 `name`、`files`、`action`、`verify` 和 `done` 字段
- REQ-PLAN-04：系统必须在每个计划中包含 `read_first` 和 `acceptance_criteria` 节区
- REQ-PLAN-05：系统必须运行计划检查验证循环（最多 3 次迭代），除非设置了 `--skip-verify`
- REQ-PLAN-06：系统必须支持 `--skip-research` 标志以绕过研究阶段
- REQ-PLAN-07：当检测到前端阶段且不存在 UI-SPEC.md 时，系统必须提示用户运行 `/gsd-ui-phase`（UI 安全门控）
- REQ-PLAN-08：当 `workflow.nyquist_validation` 启用时，系统必须包含 Nyquist 验证映射
- REQ-PLAN-09：规划完成前，系统必须验证所有阶段需求至少被一个计划覆盖（需求覆盖门控）

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `{phase}-RESEARCH.md` | 生态系统研究发现 |
| `{phase}-{N}-PLAN.md` | 原子化执行计划（每个 2-3 个任务） |
| `{phase}-VALIDATION.md` | 测试覆盖映射（Nyquist 层） |

**计划结构（XML）：**
```xml
<task type="auto">
  <name>Create login endpoint</name>
  <files>src/app/api/auth/login/route.ts</files>
  <action>
    Use jose for JWT. Validate credentials against users table.
    Return httpOnly cookie on success.
  </action>
  <verify>curl -X POST localhost:3000/api/auth/login returns 200 + Set-Cookie</verify>
  <done>Valid credentials return cookie, invalid return 401</done>
</task>
```

**计划检查验证（8 个维度）：**
1. 需求覆盖 — 计划覆盖所有阶段需求
2. 任务原子性 — 每个任务可独立提交
3. 依赖顺序 — 任务正确排序
4. 文件范围 — 计划之间无过多文件重叠
5. 验证命令 — 每个任务有可测试的完成标准
6. 上下文适配 — 任务适合单个上下文窗口
7. 间隙检测 — 无缺失的实现步骤
8. Nyquist 合规 — 任务有自动化验证命令（启用时）

---

### 5. 阶段执行

**命令：** `/gsd-execute-phase <N>`

**目的：** 使用基于波次的并行化方式执行阶段中所有计划，每个执行器使用全新的上下文窗口。

**需求：**
- REQ-EXEC-01：系统必须分析计划依赖关系并将其分组为执行波次
- REQ-EXEC-02：系统必须在每个波次内并行派生独立计划
- REQ-EXEC-03：系统必须为每个执行器提供全新的上下文窗口（200K tokens）
- REQ-EXEC-04：系统必须为每个任务生成原子化 git 提交
- REQ-EXEC-05：系统必须为每个已完成的计划生成 SUMMARY.md
- REQ-EXEC-06：系统必须运行执行后验证器，检查阶段目标是否达成
- REQ-EXEC-07：系统必须支持 git 分支策略（`none`、`phase`、`milestone`）
- REQ-EXEC-08：当任务验证失败时，系统必须调用节点修复操作符（启用时）
- REQ-EXEC-09：在验证之前，系统必须运行先前阶段的测试套件，以捕获跨阶段回归

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `{phase}-{N}-SUMMARY.md` | 每个计划的执行结果 |
| `{phase}-VERIFICATION.md` | 执行后验证报告 |
| Git 提交 | 每个任务的原子化提交 |

**波次执行：**
- 无依赖的计划 → 波次 1（并行）
- 依赖波次 1 的计划 → 波次 2（并行，等待波次 1 完成）
- 持续直到所有计划完成
- 文件冲突迫使同一波次内顺序执行

**执行器能力：**
- 读取包含完整任务指令的 PLAN.md
- 可访问 PROJECT.md、STATE.md、CONTEXT.md、RESEARCH.md
- 使用结构化提交消息原子化地提交每个任务
- 并行执行期间使用 `--no-verify` 提交，避免构建锁竞争
- 处理检查点类型：`auto`、`checkpoint:human-verify`、`checkpoint:decision`、`checkpoint:human-action`
- 在 SUMMARY.md 中报告对计划的偏差

**并行安全：**
- **pre-commit 钩子**：并行智能体跳过（`--no-verify`），每个波次后由编排器统一运行一次
- **STATE.md 锁定**：文件级锁文件防止智能体间并发写入损坏

---

### 6. 工作验收

**命令：** `/gsd-verify-work [N]`

**目的：** 用户验收测试 — 引导用户逐一测试每个可交付成果，并自动诊断失败。

**需求：**
- REQ-VERIFY-01：系统必须从阶段中提取可测试的可交付成果
- REQ-VERIFY-02：系统必须逐一呈现可交付成果供用户确认
- REQ-VERIFY-03：系统必须派生调试智能体自动诊断失败
- REQ-VERIFY-04：系统必须为识别出的问题创建修复计划
- REQ-VERIFY-05：对于修改服务器/数据库/种子/启动文件的阶段，系统必须注入冷启动冒烟测试
- REQ-VERIFY-06：系统必须生成包含通过/失败结果的 UAT.md

**产出物：** `{phase}-UAT.md` — 用户验收测试结果，如有问题则附修复计划

---

### 6.5. Ship

**命令：** `/gsd-ship [N] [--draft]`

**目的：** 将本地完成状态桥接到已合并的 PR。验证通过后，推送分支，根据规划构件自动生成 PR 正文，创建 PR，可选触发审查，并在 STATE.md 中跟踪。

**需求：**
- REQ-SHIP-01：系统必须在发布前验证阶段已通过验证
- REQ-SHIP-02：系统必须通过 `gh` CLI 推送分支并创建 PR
- REQ-SHIP-03：系统必须从 SUMMARY.md、VERIFICATION.md 和 REQUIREMENTS.md 自动生成 PR 正文
- REQ-SHIP-04：系统必须用发布状态和 PR 号更新 STATE.md
- REQ-SHIP-05：系统必须支持 `--draft` 标志，用于草稿 PR
- REQ-SHIP-06：系统必须支持通过 `ship.pr_body_sections` 配置的仅追加项目 PR 正文节区

**前提条件：** 阶段已验证、已安装并认证 `gh` CLI、工作在功能分支上

**产出物：** 具有丰富正文的 GitHub PR，可选配置的 PRD 风格节区，STATE.md 已更新

**用户文档：** [自定义 PR 正文节区](../ship-pr-body-sections.md)

---

### 7. UI 审查

**命令：** `/gsd-ui-review [N]`

**目的：** 对已实现的前端代码进行追溯性 6 支柱视觉审计。可作为独立工具用于任何项目。

**需求：**
- REQ-UIREVIEW-01：系统必须对 6 个支柱分别按 1-4 分进行评分
- REQ-UIREVIEW-02：系统必须通过 Playwright CLI 截图并保存到 `.planning/ui-reviews/`
- REQ-UIREVIEW-03：系统必须为截图目录创建 `.gitignore`
- REQ-UIREVIEW-04：系统必须识别优先级最高的 3 个修复点
- REQ-UIREVIEW-05：系统必须能独立运行（无需 UI-SPEC.md），使用抽象质量标准

**6 个审计支柱（1-4 分）：**
1. **文案** — CTA 标签、空状态、错误状态
2. **视觉** — 焦点、视觉层次、图标无障碍
3. **颜色** — 强调色使用规范、60/30/10 合规性
4. **排版** — 字体大小/粗细约束遵守情况
5. **间距** — 网格对齐、令牌一致性
6. **体验设计** — 加载/错误/空状态覆盖

**产出物：** `{padded_phase}-UI-REVIEW.md` — 评分和优先级修复建议

---

### 8. 里程碑管理

**命令：** `/gsd-audit-milestone`、`/gsd-complete-milestone`、`/gsd-new-milestone [name]`

**目的：** 验证里程碑完成情况，归档，打发布标签，启动下一个开发周期。

**需求：**
- REQ-MILE-01：审计必须验证所有里程碑需求均已满足
- REQ-MILE-02：审计必须检测存根、占位符实现和未测试代码
- REQ-MILE-03：审计必须检查各阶段的 Nyquist 验证合规性
- REQ-MILE-04：完成时必须将里程碑数据归档到 MILESTONES.md
- REQ-MILE-05：完成时必须提供发布的 git 标签创建选项
- REQ-MILE-06：完成时必须提供压缩合并或带历史合并的选项（用于分支策略）
- REQ-MILE-07：完成时必须清理 UI 审查截图
- REQ-MILE-08：新里程碑必须遵循与新项目相同的流程（提问 → 研究 → 需求 → 路线图）
- REQ-MILE-09：新里程碑不得重置现有工作流配置


---

## 规划功能

### 9. 阶段管理

**命令：** `/gsd-phase`、`/gsd-phase --insert [N]`、`/gsd-phase --remove [N]`

**目的：** 开发过程中动态修改路线图。

**需求：**
- REQ-PHASE-01：添加操作必须在当前路线图末尾追加新阶段
- REQ-PHASE-02：插入操作必须在现有阶段之间使用小数编号（例如 3.1）
- REQ-PHASE-03：删除操作必须对后续所有阶段重新编号
- REQ-PHASE-04：删除操作必须阻止删除已执行的阶段
- REQ-PHASE-05：所有操作必须更新 ROADMAP.md 并创建/删除阶段目录

---

### 10. 快速模式

**命令：** `/gsd-quick [--full] [--discuss] [--research]`

**目的：** 临时任务执行，具备 GSD 保证但路径更快。

**需求：**
- REQ-QUICK-01：系统必须接受自由格式的任务描述
- REQ-QUICK-02：系统必须使用与完整工作流相同的规划器 + 执行器智能体
- REQ-QUICK-03：默认情况下，系统必须跳过研究、计划检查和验证器
- REQ-QUICK-04：`--full` 标志必须启用计划检查（最多 2 次迭代）和执行后验证
- REQ-QUICK-05：`--discuss` 标志必须运行轻量级预规划讨论
- REQ-QUICK-06：`--research` 标志必须在规划之前派生专注研究智能体
- REQ-QUICK-07：标志必须可组合（`--discuss --research --full`）
- REQ-QUICK-08：系统必须在 `.planning/quick/YYMMDD-xxx-slug/` 中跟踪快速任务
- REQ-QUICK-09：系统必须为快速任务执行生成原子化提交

---

### 11. 自主模式

**命令：** `/gsd-autonomous [--from N]`

**目的：** 自主运行所有剩余阶段 — 每个阶段依次执行讨论 → 规划 → 执行。

**需求：**
- REQ-AUTO-01：系统必须按路线图顺序遍历所有未完成的阶段
- REQ-AUTO-02：系统必须为每个阶段运行讨论 → 规划 → 执行
- REQ-AUTO-03：系统必须暂停以获取明确的用户决策（灰色地带确认、阻塞问题、验证）
- REQ-AUTO-04：系统必须在每个阶段完成后重新读取 ROADMAP.md，以捕获动态插入的阶段
- REQ-AUTO-05：`--from N` 标志必须从指定的阶段号开始

---

### 12. 自由路由

**命令：** `/gsd-progress --do`（另见 `/gsd-manager` 用于交互式路由）

**目的：** 分析自由文本并路由到适当的 GSD 命令。

**需求：**
- REQ-DO-01：系统必须从自然语言输入中解析用户意图
- REQ-DO-02：系统必须将意图映射到最匹配的 GSD 命令
- REQ-DO-03：系统必须在执行前向用户确认路由
- REQ-DO-04：系统必须针对项目已存在与无项目的上下文采用不同处理方式

---

### 13. 笔记捕获

**命令：** `/gsd-capture`

**目的：** 零摩擦的想法捕获，不中断工作流。追加带时间戳的笔记、列出所有笔记，或将笔记提升为结构化待办事项。

**需求：**
- REQ-NOTE-01：系统必须通过单次 Write 调用保存带时间戳的笔记文件
- REQ-NOTE-02：系统必须支持 `list` 子命令，显示项目和全局范围内的所有笔记
- REQ-NOTE-03：系统必须支持 `promote N` 子命令，将笔记转换为结构化待办事项
- REQ-NOTE-04：系统必须支持 `--global` 标志用于全局范围操作
- REQ-NOTE-05：系统不得使用 Task、AskUserQuestion 或 Bash — 仅内联运行

---

### 14. 自动推进 (Next)

**命令：** `/gsd-progress --next`

**目的：** 自动检测当前项目状态并推进到下一个逻辑工作流步骤，无需记忆所在的阶段/步骤。

**需求：**
- REQ-NEXT-01：系统必须读取 STATE.md、ROADMAP.md 和阶段目录以确定当前位置
- REQ-NEXT-02：系统必须检测是否需要讨论、规划、执行或验证
- REQ-NEXT-03：系统必须自动调用正确的命令
- REQ-NEXT-04：如果不存在项目，系统必须建议 `/gsd-new-project`
- REQ-NEXT-05：当所有阶段完成时，系统必须建议 `/gsd-complete-milestone`

**状态检测逻辑：**
| 状态 | 操作 |
|-------|--------|
| 无 `.planning/` 目录 | 建议 `/gsd-new-project` |
| 阶段无 CONTEXT.md | 运行 `/gsd-discuss-phase` |
| 阶段无 PLAN.md 文件 | 运行 `/gsd-plan-phase` |
| 阶段有计划但无 SUMMARY.md | 运行 `/gsd-execute-phase` |
| 阶段已执行但无 VERIFICATION.md | 运行 `/gsd-verify-work` |
| 所有阶段完成 | 建议 `/gsd-complete-milestone` |

---

## 质量保障功能

### 15. Nyquist 验证

**目的：** 在编写任何代码之前，将自动化测试覆盖映射到阶段需求。以奈奎斯特采样定理命名 — 确保每个需求都有反馈信号。

**需求：**
- REQ-NYQ-01：系统必须在规划阶段研究期间检测现有测试基础设施
- REQ-NYQ-02：系统必须将每个需求映射到特定的测试命令
- REQ-NYQ-03：系统必须识别波次 0 任务（实现之前需要测试脚手架）
- REQ-NYQ-04：计划检查器必须将 Nyquist 合规性作为第 8 个验证维度强制执行
- REQ-NYQ-05：系统必须通过 `/gsd-validate-phase` 支持追溯验证
- REQ-NYQ-06：系统必须可通过 `workflow.nyquist_validation: false` 禁用

**产出物：** `{phase}-VALIDATION.md` — 测试覆盖契约

**追溯验证（`/gsd-validate-phase [N]`）：**
- 扫描实现并将需求映射到测试
- 识别需求缺乏自动化验证的间隙
- 派生审计器生成测试（最多 3 次尝试）
- 绝不修改实现代码 — 仅修改测试文件和 VALIDATION.md
- 将实现错误标记为需要用户处理的升级项

---

### 16. 计划检查

**目的：** 目标反向验证，确保计划在执行前能够实现阶段目标。

**需求：**
- REQ-PLANCK-01：系统必须从 8 个质量维度验证计划
- REQ-PLANCK-02：系统必须循环最多 3 次迭代，直到计划通过
- REQ-PLANCK-03：系统必须对失败提供具体、可操作的反馈
- REQ-PLANCK-04：系统必须可通过 `workflow.plan_check: false` 禁用

---

### 17. 执行后验证

**目的：** 自动检查代码库是否交付了阶段所承诺的内容。

**需求：**
- REQ-POSTVER-01：系统必须对照阶段目标进行检查，而不仅仅是任务完成情况
- REQ-POSTVER-02：系统必须生成带有通过/失败分析的 VERIFICATION.md
- REQ-POSTVER-03：系统必须记录问题供 `/gsd-verify-work` 处理
- REQ-POSTVER-04：系统必须可通过 `workflow.verifier: false` 禁用

---

### 18. 节点修复

**目的：** 当执行期间任务验证失败时进行自主恢复。

**需求：**
- REQ-REPAIR-01：系统必须分析失败并选择一种策略：RETRY（重试）、DECOMPOSE（分解）或 PRUNE（修剪）
- REQ-REPAIR-02：RETRY 必须通过具体调整进行尝试
- REQ-REPAIR-03：DECOMPOSE 必须将任务分解为更小的可验证子步骤
- REQ-REPAIR-04：PRUNE 必须删除不可实现的任务并向用户升级
- REQ-REPAIR-05：系统必须遵守修复预算（默认：每个任务 2 次尝试）
- REQ-REPAIR-06：系统必须可通过 `workflow.node_repair_budget` 和 `workflow.node_repair` 配置

---

### 19. 健康验证

**命令：** `/gsd-health [--repair]`

**目的：** 验证 `.planning/` 目录完整性并自动修复问题。

**需求：**
- REQ-HEALTH-01：系统必须检查缺少的必需文件
- REQ-HEALTH-02：系统必须验证配置一致性
- REQ-HEALTH-03：系统必须检测无摘要的孤立计划
- REQ-HEALTH-04：系统必须检查阶段编号和路线图同步
- REQ-HEALTH-05：`--repair` 标志必须自动修复可恢复的问题

---

### 20. 跨阶段回归门控

**目的：** 通过在执行后运行先前阶段的测试套件，防止回归问题在阶段间累积。

**需求：**
- REQ-REGR-01：系统必须在阶段执行后运行所有已完成的先前阶段的测试套件
- REQ-REGR-02：系统必须将任何测试失败报告为跨阶段回归
- REQ-REGR-03：回归问题必须在执行后验证之前浮现
- REQ-REGR-04：系统必须识别哪个先前阶段的测试被破坏

**触发时机：** 在 `/gsd-execute-phase` 期间，在验证器步骤之前自动运行。

---

### 21. 需求覆盖门控

**目的：** 确保所有阶段需求在规划完成前至少被一个计划覆盖。

**需求：**
- REQ-COVGATE-01：系统必须从 ROADMAP.md 中提取分配到该阶段的所有需求 ID
- REQ-COVGATE-02：系统必须验证每个需求至少出现在一个 PLAN.md 中
- REQ-COVGATE-03：未覆盖的需求必须阻止规划完成
- REQ-COVGATE-04：系统必须报告哪些具体需求缺乏计划覆盖

**触发时机：** 在 `/gsd-plan-phase` 结束时，在计划检查器循环之后自动运行。

---

## 上下文工程功能

### 22. 上下文窗口监控

**目的：** 在上下文即将耗尽时向用户和智能体发出警报，防止上下文腐烂。

**需求：**
- REQ-CTX-01：状态行必须向用户显示上下文使用百分比
- REQ-CTX-02：上下文监控器必须在剩余 ≤35% 时注入面向智能体的警告（WARNING）
- REQ-CTX-03：上下文监控器必须在剩余 ≤25% 时注入面向智能体的警告（CRITICAL）
- REQ-CTX-04：警告必须去抖动（两次重复警告之间间隔 5 次工具使用）
- REQ-CTX-05：严重性升级（WARNING→CRITICAL）必须绕过去抖动
- REQ-CTX-06：上下文监控器必须区分 GSD 激活与非 GSD 激活项目
- REQ-CTX-07：警告必须是建议性的，绝不是覆盖用户偏好的命令式指令
- REQ-CTX-08：所有钩子必须静默失败，绝不阻止工具执行

**架构：** 双部分桥接系统：
1. 状态行将指标写入 `/tmp/claude-ctx-{session}.json`
2. 上下文监控器读取指标并注入 `additionalContext` 警告

---

### 23. 会话管理

**命令：** `/gsd-pause-work`、`/gsd-resume-work`、`/gsd-progress`

**目的：** 在上下文重置和会话间维护项目连续性。

**需求：**
- REQ-SESSION-01：暂停必须将当前位置和后续步骤保存到 `continue-here.md` 和结构化的 `HANDOFF.json`
- REQ-SESSION-02：恢复必须从 HANDOFF.json（优先）或状态文件（回退）恢复完整项目上下文
- REQ-SESSION-03：进度必须显示当前位置、下一步操作和整体完成情况
- REQ-SESSION-04：进度必须读取所有状态文件（STATE.md、ROADMAP.md、阶段目录）
- REQ-SESSION-05：所有会话操作必须在 `/clear`（上下文重置）后正常工作
- REQ-SESSION-06：HANDOFF.json 必须包含阻塞问题、待处理的人工操作和正在进行的任务状态
- REQ-SESSION-07：恢复必须在会话开始时立即呈现人工操作和阻塞问题

---

### 24. 会话报告

**命令：** `/gsd-pause-work --report`

**目的：** 生成结构化的会话后摘要文档，记录已执行的工作、取得的成果和预估的资源使用情况。

**需求：**
- REQ-REPORT-01：系统必须从 STATE.md、git 日志和计划/摘要文件中收集数据
- REQ-REPORT-02：系统必须包含已提交的记录、已执行的计划和推进的阶段
- REQ-REPORT-03：系统必须根据会话活动估算 token 使用量和成本
- REQ-REPORT-04：系统必须包含活跃的阻塞问题和已做出的决策
- REQ-REPORT-05：系统必须推荐后续步骤

**产出物：** `.planning/reports/SESSION_REPORT.md`

**报告节区：**
- 会话概览（持续时间、里程碑、阶段）
- 已执行工作（提交、计划、阶段）
- 成果和可交付成果
- 阻塞问题和决策
- 资源估算（tokens、成本）
- 后续步骤建议

---

### 25. 多智能体编排

**目的：** 协调专业智能体，每个任务使用全新的上下文窗口。

**需求：**
- REQ-ORCH-01：每个智能体必须接收全新的上下文窗口
- REQ-ORCH-02：编排器必须保持精简 — 派生智能体、收集结果、路由到下一步
- REQ-ORCH-03：上下文负载必须包含所有相关的项目构件
- REQ-ORCH-04：并行智能体必须完全独立（无共享可变状态）
- REQ-ORCH-05：智能体结果必须在编排器处理之前写入磁盘
- REQ-ORCH-06：失败的智能体必须被检测到（抽查实际输出与报告的失败）

---

### 26. 模型配置

**命令：** `/gsd-config --profile <quality|balanced|budget|adaptive|inherit>`

**目的：** 控制每个智能体使用的 AI 模型，平衡质量与成本。

**需求：**
- REQ-MODEL-01：系统必须支持 4 种配置：`quality`、`balanced`、`budget`、`inherit`
- REQ-MODEL-02：每种配置必须为每个智能体定义模型层级（见配置表）
- REQ-MODEL-03：每个智能体的覆盖设置必须优先于配置文件
- REQ-MODEL-04：`inherit` 配置必须遵从运行时当前的模型选择
- REQ-MODEL-04a：在使用非 Anthropic 提供商（OpenRouter、本地模型）时，必须使用 `inherit` 配置，以避免意外的 API 费用
- REQ-MODEL-05：配置文件切换必须是程序化的（脚本，而非 LLM 驱动）
- REQ-MODEL-06：模型解析必须在每次编排时发生一次，而非每次派生时发生

**配置分配：**

| 智能体 | `quality` | `balanced` | `budget` | `inherit` |
|-------|-----------|------------|----------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Inherit |

---

## 棕地功能

### 27. 代码库映射

**命令：** `/gsd-map-codebase [area]`

**目的：** 在启动新项目之前，或作为 `/gsd-onboard` 的映射交接，分析现有代码库，使 GSD 了解已有内容。

**需求：**
- REQ-MAP-01：系统必须为每个分析领域派生并行映射智能体
- REQ-MAP-02：系统必须在 `.planning/codebase/` 中生成结构化文档
- REQ-MAP-03：系统必须检测：技术栈、架构模式、编码规范、关注点
- REQ-MAP-04：后续的 `/gsd-new-project` 必须加载代码库映射，并将问题集中在新增内容上
- REQ-MAP-05：可选的 `[area]` 参数必须将映射范围限定到特定区域

**产出物：**
| 文档 | 内容 |
|----------|---------|
| `STACK.md` | 语言、框架、数据库、基础设施 |
| `ARCHITECTURE.md` | 模式、层次、数据流、边界 |
| `CONVENTIONS.md` | 命名规范、文件组织、代码风格、测试模式 |
| `CONCERNS.md` | 技术债务、安全问题、性能瓶颈 |
| `STRUCTURE.md` | 目录布局和文件组织 |
| `TESTING.md` | 测试基础设施、覆盖率、模式 |
| `INTEGRATIONS.md` | 外部服务、API、第三方依赖 |

**增量重映射 — `--paths` (#2003)：** 映射器接受可选的 `--paths <p1,p2,...>` 范围提示。提供时，它将探索限制在列出的仓库相对前缀，而非扫描整个代码树。这是执行后代码库漂移门控用于仅刷新阶段实际修改的子树的路径。每个生成的文档在其 YAML 前置元数据中携带 `last_mapped_commit`，以便相对于映射点（而非 HEAD）来测量漂移。

### 27b. 现有代码库接入

**命令：** `/gsd-onboard [--fast] [--text]`

**目的：** 引导现有仓库完成首次设置，检查 brownfield 状态，并安全交接到代码库映射、docs 摄取和项目初始化。

**需求：**
- REQ-ONBOARD-01：系统必须检测现有代码、package manifest、规划文档、部分 `.planning/` 状态以及缺失的代码库映射文件。
- REQ-ONBOARD-02：当 brownfield 缺少所需 `.planning/codebase/` 映射文件时，系统必须交接到 `/gsd-map-codebase` 或 `/gsd-map-codebase --fast`。fast 映射 readiness 是部分状态，不得视为足以运行 `/gsd-new-project`。
- REQ-ONBOARD-03：当存在 ADR/PRD/SPEC/RFC 候选且 project 不存在时，系统必须在 `/gsd-new-project` 前提供 `/gsd-ingest-docs`。
- REQ-ONBOARD-04：在 `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md` 全部存在前，系统不得报告 onboarding 完成。
- REQ-ONBOARD-05：系统必须仅在 project setup 后创建或确认 `.planning/onboarding/SUMMARY.md`。
- REQ-ONBOARD-06：系统必须为没有交互式菜单的运行时支持 `--text` 编号纯文本关卡。

**产出：**
| Artifact | 说明 |
|----------|-------------|
| `.planning/codebase/` | 由 `/gsd-map-codebase` 交接生成的代码库映射 |
| `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` | 由 `/gsd-new-project` 或 `/gsd-ingest-docs` 生成的规划设置 |
| `.planning/onboarding/SUMMARY.md` | Onboarding status、artifact index 和 next-command summary |

### 27a. 执行后代码库漂移检测

**引入版本：** #2003
**触发条件：** 在每次 `/gsd-execute-phase` 结束时自动运行
**配置：**
- `workflow.drift_threshold`（整数，默认 `3`）— 门控触发前的最小新增结构元素数。
- `workflow.drift_action`（`warn` | `auto-remap`，默认 `warn`）— 仅警告或派生 `gsd-codebase-mapper` 并将 `--paths` 限定到受影响的子树。

**漂移计入的情况：**
- 映射路径之外的新目录
- `(packages|apps)/*/src/index.*` 处的新桶导出
- 新的迁移文件（supabase/prisma/drizzle/src/migrations/…）
- `routes/` 或 `api/` 下的新路由模块

**非阻塞保证：** 任何内部失败（缺少 STRUCTURE.md、git 错误、映射器派生失败）都只记录一行日志，阶段继续执行。漂移检测不能导致验证失败。

**需求：**
- REQ-DRIFT-01：系统必须从 `git diff --name-status last_mapped_commit..HEAD` 检测四类漂移
- REQ-DRIFT-02：仅当元素数量 ≥ `workflow.drift_threshold` 时才触发操作
- REQ-DRIFT-03：`warn` 操作不得派生任何智能体
- REQ-DRIFT-04：`auto-remap` 操作必须向映射器传递经过净化的 `--paths`
- REQ-DRIFT-05：检测/重映射失败对 `/gsd-execute-phase` 必须是非阻塞的
- REQ-DRIFT-06：`last_mapped_commit` 通过每个 `.planning/codebase/*.md` 文件的 YAML 前置元数据进行往返

---

## 实用功能

### 28. 调试系统

**命令：** `/gsd-debug [description]`

**目的：** 系统化调试，在上下文重置后保持持久状态。

**需求：**
- REQ-DEBUG-01：系统必须在 `.planning/debug/` 中创建调试会话文件
- REQ-DEBUG-02：系统必须跟踪假设、证据和已排除的理论
- REQ-DEBUG-03：系统必须持久化状态，以便调试能在上下文重置后继续
- REQ-DEBUG-04：系统必须在标记为已解决之前要求人工验证
- REQ-DEBUG-05：已解决的会话必须追加到 `.planning/debug/knowledge-base.md`
- REQ-DEBUG-06：新调试会话必须参考知识库，防止重复调查

**调试会话状态：** `gathering` → `investigating` → `fixing` → `verifying` → `awaiting_human_verify` → `resolved`

---

### 29. 待办事项管理

**命令：** `/gsd-capture [desc]`、`/gsd-capture --list`

**目的：** 在会话期间捕获想法和任务以供后续工作。

**需求：**
- REQ-TODO-01：系统必须从当前对话上下文中捕获待办事项
- REQ-TODO-02：待办事项必须存储在 `.planning/todos/pending/`
- REQ-TODO-03：已完成的待办事项必须移至 `.planning/todos/completed/`
- REQ-TODO-04：查看待办事项必须列出所有待处理项目，并提供选择处理其中一项的功能

---

### 30. 统计仪表板

**命令：** `/gsd-stats`

**目的：** 显示项目指标 — 阶段、计划、需求、git 历史和时间线。

**需求：**
- REQ-STATS-01：系统必须显示阶段/计划完成数量
- REQ-STATS-02：系统必须显示需求覆盖情况
- REQ-STATS-03：系统必须显示 git 提交指标
- REQ-STATS-04：系统必须支持多种输出格式（json、table、bar）

---

### 31. 更新系统

**命令：** `/gsd-update`

**目的：** 使用变更日志预览将 GSD 更新至最新版本。

**需求：**
- REQ-UPDATE-01：系统必须通过 npm 检查新版本
- REQ-UPDATE-02：系统必须在更新前显示新版本的变更日志
- REQ-UPDATE-03：系统必须感知运行时并针对正确的目录
- REQ-UPDATE-04：系统必须将本地修改的文件备份到 `gsd-local-patches/`
- REQ-UPDATE-05：`/gsd-update --reapply` 必须在更新后恢复本地修改

---

### 32. 设置管理

**命令：** `/gsd-settings`

**目的：** 交互式配置工作流开关和模型配置。

**需求：**
- REQ-SETTINGS-01：系统必须以切换选项呈现当前设置
- REQ-SETTINGS-02：系统必须更新 `.planning/config.json`
- REQ-SETTINGS-03：系统必须支持保存为全局默认值（`~/.gsd/defaults.json`）

**可配置设置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `mode` | enum | `interactive` | `interactive` 或 `yolo`（自动审批） |
| `granularity` | enum | `standard` | `coarse`、`standard` 或 `fine` |
| `model_profile` | enum | `balanced` | `quality`、`balanced`、`budget` 或 `inherit` |
| `models.<phase_type>` | enum | （无） | 每阶段类型层级覆盖（`planning`、`discuss`、`research`、`execution`、`verification`、`completion`）。取值：`opus`、`sonnet`、`haiku`、`inherit`。粗粒度阶段级调优，优先于 `model_profile`，但低于每智能体 `model_overrides`。参见 [CONFIGURATION.md](CONFIGURATION.md#per-phase-type-models-models--added-in-v140)。v1.40 新增 |
| `dynamic_routing.enabled` | boolean | `false` | 失败层级升级的主开关。为 `true` 时，智能体解析到 `tier_models[default_tier]`，并在编排器检测到软失败时升级一级。受 `max_escalations` 限制。参见 [CONFIGURATION.md](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140)。v1.40 新增 |
| `workflow.research` | boolean | `true` | 规划前的领域研究 |
| `workflow.plan_check` | boolean | `true` | 计划验证循环 |
| `workflow.verifier` | boolean | `true` | 执行后验证 |
| `workflow.auto_advance` | boolean | `false` | 自动链接讨论→规划→执行 |
| `workflow.nyquist_validation` | boolean | `true` | Nyquist 测试覆盖映射 |
| `workflow.ui_phase` | boolean | `true` | UI 设计契约生成 |
| `workflow.ui_safety_gate` | boolean | `true` | 在前端阶段提示运行 ui-phase |
| `workflow.node_repair` | boolean | `true` | 自主任务修复 |
| `workflow.node_repair_budget` | number | `2` | 每个任务的最大修复尝试次数 |
| `planning.commit_docs` | boolean | `true` | 将 `.planning/` 文件提交到 git |
| `planning.search_gitignored` | boolean | `false` | 在搜索中包含 gitignored 文件 |
| `parallelization.enabled` | boolean | `true` | 同时运行独立计划 |
| `git.branching_strategy` | enum | `none` | `none`、`phase` 或 `milestone` |

---

### 33. 测试生成

**命令：** `/gsd-add-tests [N]`

**目的：** 根据 UAT 标准和实现，为已完成的阶段生成测试。

**需求：**
- REQ-TEST-01：系统必须分析已完成阶段的实现
- REQ-TEST-02：系统必须根据 UAT 标准和验收标准生成测试
- REQ-TEST-03：系统必须使用现有的测试基础设施模式

---

## 基础设施功能

### 34. Git 集成

**目的：** 原子化提交、分支策略和清晰的历史管理。

**需求：**
- REQ-GIT-01：每个任务必须有其原子化提交
- REQ-GIT-02：提交消息必须遵循结构化格式：`type(scope): description`
- REQ-GIT-03：系统必须支持 3 种分支策略：`none`、`phase`、`milestone`
- REQ-GIT-04：phase 策略必须为每个阶段创建一个分支
- REQ-GIT-05：milestone 策略必须为每个里程碑创建一个分支
- REQ-GIT-06：完成里程碑必须提供压缩合并（推荐）或带历史合并选项
- REQ-GIT-07：系统必须遵守 `.planning/` 文件的 `commit_docs` 设置
- REQ-GIT-08：系统必须自动检测 `.gitignore` 中的 `.planning/` 并跳过提交

**提交格式：**
```
type(phase-plan): description

# 示例：
docs(08-02): complete user registration plan
feat(08-02): add email confirmation flow
fix(03-01): correct auth token expiry
```

---

### 35. CLI 工具

**目的：** 工作流和智能体的程序化实用工具，替代重复性的内联 bash 模式。

**需求：**
- REQ-CLI-01：系统必须提供用于状态、配置、阶段、路线图操作的原子化命令
- REQ-CLI-02：系统必须提供复合 `init` 命令，为每个工作流加载所有上下文
- REQ-CLI-03：系统必须支持 `--raw` 标志用于机器可读输出
- REQ-CLI-04：系统必须支持 `--cwd` 标志用于沙箱子智能体操作
- REQ-CLI-05：所有操作在 Windows 上必须使用正斜杠路径

**命令类别：** 状态（11 个子命令）、阶段（5）、路线图（3）、验证（8）、模板（2）、前置元数据（4）、脚手架（4）、初始化（12）、验证（2）、进度、统计、待办

---

### 36. 多运行时支持

**目的：** 跨多个 AI 编程智能体运行时运行 GSD。

**需求：**
- REQ-RUNTIME-01：系统必须支持 Claude Code、OpenCode、Gemini CLI、Kilo、Codex、Copilot、Antigravity、Trae、Cline、Augment Code、CodeBuddy、Qwen Code
- REQ-RUNTIME-02：安装器必须按运行时转换内容（工具名称、路径、前置元数据）
- REQ-RUNTIME-03：安装器必须支持交互式和非交互式（`--claude --global`）模式
- REQ-RUNTIME-04：安装器必须支持全局和本地安装
- REQ-RUNTIME-05：卸载必须干净地移除所有 GSD 文件，不影响其他配置
- REQ-RUNTIME-06：安装器必须处理平台差异（Windows、macOS、Linux、WSL、Docker）

**运行时转换：**

| 方面 | Claude Code | OpenCode | Gemini | Kilo | Codex | Copilot | Antigravity | Trae | Cline | Augment | CodeBuddy | Qwen Code |
|--------|------------|----------|--------|-------|-------|---------|-------------|------|-------|---------|-----------|-----------|
| 命令 | 斜杠命令 | 斜杠命令 | 斜杠命令 | 斜杠命令 | Skills (TOML) | 斜杠命令 | Skills | Skills | Rules | Skills | Skills | Skills |
| 智能体格式 | Claude 原生 | `mode: subagent` | Claude 原生 | `mode: subagent` | Skills | 工具映射 | Skills | Skills | Rules | Skills | Skills | Skills |
| 钩子事件 | `PostToolUse` | N/A | `AfterTool` | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A | N/A |
| 配置 | `settings.json` | `opencode.json(c)` | `settings.json` | `kilo.json(c)` | TOML | Instructions | Config | Config | `.clinerules` | Config | Config | Config |

---

### 37. 钩子系统

**目的：** 用于上下文监控、状态显示和更新检查的运行时事件钩子。

**需求：**
- REQ-HOOK-01：状态行必须显示模型、当前任务、目录和上下文使用情况
- REQ-HOOK-02：上下文监控器必须在阈值级别注入面向智能体的警告
- REQ-HOOK-03：更新检查器必须在会话开始时在后台运行
- REQ-HOOK-04：所有钩子必须遵守 `CLAUDE_CONFIG_DIR` 环境变量
- REQ-HOOK-05：所有钩子必须包含 3 秒 stdin 超时守护
- REQ-HOOK-06：所有钩子在发生任何错误时必须静默失败
- REQ-HOOK-07：上下文使用情况必须针对自动压缩缓冲区进行归一化（保留 16.5%）
- REQ-HOOK-08：更新横幅必须是选项，且在没有可用更新时保持静默（PR #2795）

**状态行显示：**
```text
[⬆ /gsd-update │] model │ [current task │] directory [█████░░░░░ 50%]
```

颜色编码：<50% 绿色，<65% 黄色，<80% 橙色，≥80% 红色带骷髅表情

**更新横幅（选项，当未使用 GSD 状态行时）：**

当用户拒绝（或保留非 GSD）状态行时，安装器提供一个 SessionStart 横幅，在不占用状态行空间的情况下显示更新可用性。横幅读取 `~/.cache/gsd/gsd-update-check.json`（由 `gsd-check-update-worker.js` 写入），仅在有可用更新时输出一行：

```text
GSD update available: 1.39.0 → 1.40.0. Run /gsd-update.
```

无更新时横幅保持静默，"检查失败"诊断每 24 小时限流一次。通过 `npx @opengsd/gsd-core --uninstall` 或删除引用 `gsd-update-banner.js` 的 SessionStart 条目可干净移除。

### 38. 开发者画像

**命令：** `/gsd-profile-user [--questionnaire] [--refresh]`

**目的：** 分析 Claude Code 会话历史，从 8 个维度构建行为画像，生成可个性化 Claude 响应风格的构件。

**维度：**
1. 沟通风格（简洁 vs 冗长，正式 vs 随意）
2. 决策模式（快速 vs 审慎，风险承受度）
3. 调试方式（系统化 vs 直觉化，日志偏好）
4. 用户体验偏好（设计敏感度、无障碍意识）
5. 供应商/技术选择（框架偏好、生态系统熟悉度）
6. 挫折触发点（工作流中造成摩擦的因素）
7. 学习风格（文档 vs 示例，深度偏好）
8. 解释深度（高层次 vs 实现细节）

**生成的构件：**
- `USER-PROFILE.md` — 带证据引用的完整行为画像
- `CLAUDE.md` 画像节区 — 由 Claude Code 自动发现

**标志：**
- `--questionnaire` — 当会话历史不可用时的交互式问卷回退
- `--refresh` — 重新分析会话并重新生成画像

**流水线模块：**
- `profile-pipeline.cjs` — 会话扫描、消息提取、采样
- `profile-output.cjs` — 画像渲染、问卷、构件生成
- `gsd-user-profiler` 智能体 — 从会话数据进行行为分析

**需求：**
- REQ-PROF-01：会话分析必须涵盖至少 8 个行为维度
- REQ-PROF-02：画像必须引用实际会话消息中的证据
- REQ-PROF-03：当没有会话历史时，必须提供问卷作为回退
- REQ-PROF-04：生成的构件必须可被 Claude Code 发现（CLAUDE.md 集成）

### 39. 执行加固

**目的：** 执行流水线的三项附加质量改进，在级联之前捕获跨计划失败。

**组件：**

**1. 波次前依赖检查**（execute-phase）
在派生波次 N+1 之前，验证先前波次构件中的关键链接是否存在并正确连接。在下游失败级联之前捕获跨计划依赖间隙。

**2. 跨计划数据契约 — 维度 9**（plan-checker）
新增分析维度，检查共享数据流水线的计划具有兼容的转换。当一个计划剥离了另一个计划在原始形式下需要的数据时进行标记。

**3. 导出级别抽查**（verify-phase）
在第 3 级连接验证通过后，对单个导出进行实际使用抽查。捕获存在于连接文件中但从未被调用的死存储。

**需求：**
- REQ-HARD-01：波次前检查必须在派生下一波次之前验证所有先前波次构件中的关键链接
- REQ-HARD-02：跨计划契约检查必须检测计划间不兼容的数据转换
- REQ-HARD-03：导出抽查必须识别连接文件中的死存储

---

### 40. 验证债务追踪

**命令：** `/gsd-audit-uat`

**目的：** 当项目在有待处理测试的阶段后推进时，防止 UAT/验证项目的静默丢失。跨所有先前阶段呈现验证债务，确保项目不被遗忘。

**组件：**

**1. 跨阶段健康检查**（progress.md 步骤 1.6）
每次 `/gsd-progress` 调用都会扫描当前里程碑中的所有阶段，查找未处理项目（pending、skipped、blocked、human_needed）。显示带可操作链接的非阻塞警告节区。

**2. `status: partial`**（verify-work.md、UAT.md）
新的 UAT 状态，区分"会话结束"和"所有测试已解决"。当测试仍处于待处理、阻塞或无故跳过状态时，阻止 `status: complete`。

**3. 带 `blocked_by` 标签的 `result: blocked`**（verify-work.md、UAT.md）
被外部依赖项（服务器、物理设备、发布构建、第三方服务）阻塞的测试的新结果类型。与跳过的测试分开分类。

**4. HUMAN-UAT.md 持久化**（execute-phase.md）
当验证返回 `human_needed` 时，项目作为带 `status: partial` 的可追踪 HUMAN-UAT.md 文件持久化。用于跨阶段健康检查和审计系统。

**5. 阶段完成警告**（phase.cjs、transition.md）
`phase complete` CLI 在其 JSON 输出中返回验证债务警告。过渡工作流在确认前呈现未处理项目。

**需求：**
- REQ-DEBT-01：系统必须在 `/gsd-progress` 中呈现所有先前阶段的未处理 UAT/验证项目
- REQ-DEBT-02：系统必须区分不完整测试（partial）和已完成测试（complete）
- REQ-DEBT-03：系统必须使用 `blocked_by` 标签对阻塞的测试进行分类
- REQ-DEBT-04：系统必须将 human_needed 验证项目持久化为可追踪的 UAT 文件
- REQ-DEBT-05：系统在阶段完成和过渡期间发现验证债务时，必须发出（非阻塞）警告
- REQ-DEBT-06：`/gsd-audit-uat` 必须扫描所有阶段，按可测试性分类项目，并生成人工测试计划

---

## v1.27 功能

### 41. 快速模式

**命令：** `/gsd-fast [task description]`

**目的：** 内联执行简单任务，无需派生子智能体或生成 PLAN.md 文件。适用于不值得规划开销的任务：修复拼写错误、配置更改、小型重构、遗漏的提交、简单添加。

**需求：**
- REQ-FAST-01：系统必须直接在当前上下文中执行任务，无需子智能体
- REQ-FAST-02：系统必须为更改生成原子化 git 提交
- REQ-FAST-03：系统必须在 `.planning/quick/` 中跟踪任务以保持状态一致性
- REQ-FAST-04：系统不得用于需要研究、多步骤规划或验证的任务

**何时使用 vs `/gsd-quick`：**
- `/gsd-fast` — 可在 2 分钟内完成的一句话任务（拼写错误、配置更改、小型添加）
- `/gsd-quick` — 任何需要研究、多步骤规划或验证的事项

---

### 42. 跨 AI 同行评审

**命令：** `/gsd-review --phase N [--gemini] [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy] [--antigravity] [--ollama] [--lm-studio] [--llama-cpp] [--kimi-code] [--all]`

**目的：** 调用外部 AI CLI（Gemini、Claude、Codex、CodeRabbit、OpenCode、Qwen Code、Cursor、Antigravity、Kimi Code）和本地 OpenAI 兼容服务器（Ollama、LM Studio、llama.cpp）独立审查阶段计划。生成包含每位审查者反馈的结构化 REVIEWS.md。

**需求：**
- REQ-REVIEW-01：系统必须检测系统上可用的 AI CLI
- REQ-REVIEW-02：系统必须从阶段计划构建结构化审查提示
- REQ-REVIEW-03：系统必须独立调用每个选定的 CLI
- REQ-REVIEW-04：系统必须收集响应并生成 `REVIEWS.md`
- REQ-REVIEW-05：审查结果必须可被 `/gsd-plan-phase --reviews` 使用
- REQ-REVIEW-06：系统必须通过 `review.default_reviewers` 支持项目级无标志默认值
- REQ-REVIEW-07：审查者优先级必须为：明确标志 > `--all` > `review.default_reviewers` > 所有检测到的审查者

**产出物：** `{phase}-REVIEWS.md` — 每位审查者的结构化反馈

**用户配置说明：**
- 在 `.planning/config.json` 中（或通过 `gsd config-set`）设置 `review.default_reviewers`，控制无标志 `/gsd-review` 的扇出。
- 使用 `--all` 进行完整的预合并扫描，而不更改项目默认值。
- 对于上下文窗口较小的本地模型服务器，设置 `review.max_prompt_tokens_per_reviewer` 可按审查者自动裁剪提示 — 参见 CONFIGURATION.md 中的[小上下文审查者提示预算](../CONFIGURATION.md#prompt-budgets-for-small-context-reviewers)。

---

### 43. 待办停车场

**命令：** `/gsd-capture --backlog <description>`、`/gsd-review-backlog`、`/gsd-capture --seed <idea>`

**目的：** 捕获尚未准备好进行主动规划的想法。待办事项使用 999.x 编号，保持在活跃阶段序列之外。种子是具有触发条件的前瞻性想法，在适当的里程碑时自动浮现。

**需求：**
- REQ-BACKLOG-01：待办事项必须使用 999.x 编号，保持在活跃阶段序列之外
- REQ-BACKLOG-02：必须立即创建阶段目录，以便 `/gsd-discuss-phase` 和 `/gsd-plan-phase` 可以在其上运行
- REQ-BACKLOG-03：`/gsd-review-backlog` 必须支持每个项目的提升、保留和删除操作
- REQ-BACKLOG-04：提升的项目必须重新编号进入活跃里程碑序列
- REQ-SEED-01：种子必须捕获完整的原因和浮现时机条件
- REQ-SEED-02：`/gsd-new-milestone` 必须扫描种子并呈现匹配项

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `.planning/phases/999.x-slug/` | 待办事项目录 |
| `.planning/seeds/SEED-NNN-slug.md` | 带触发条件的种子 |

---

### 44. 持久化上下文线程

**命令：** `/gsd-thread [name | description]`

**目的：** 跨会话的轻量级知识存储，用于跨多个会话但不属于任何特定阶段的工作。比 `/gsd-pause-work` 更轻量 — 无阶段状态，无计划上下文。

**需求：**
- REQ-THREAD-01：系统必须支持创建、列出和恢复模式
- REQ-THREAD-02：线程必须以 Markdown 文件形式存储在 `.planning/threads/`
- REQ-THREAD-03：线程文件必须包含目标、上下文、参考资料和后续步骤节区
- REQ-THREAD-04：恢复线程必须将其完整上下文加载到当前会话
- REQ-THREAD-05：线程必须可提升为阶段或待办事项

**产出物：** `.planning/threads/{slug}.md` — 持久化上下文线程

---

### 45. PR 分支过滤

**命令：** `/gsd-pr-branch [target branch]`

**目的：** 通过过滤掉 `.planning/` 提交，创建适合拉取请求的干净分支。审查者只看到代码更改，而不是 GSD 规划构件。

**需求：**
- REQ-PRBRANCH-01：系统必须识别仅修改 `.planning/` 文件的提交
- REQ-PRBRANCH-02：系统必须创建过滤掉规划提交的新分支
- REQ-PRBRANCH-03：代码更改必须完全按照提交时的状态保留

---

### 46. 安全加固

**目的：** GSD 规划构件的纵深防御安全机制。由于 GSD 生成的 Markdown 文件会成为 LLM 系统提示，流入这些文件的用户控制文本是潜在的间接提示注入向量。

**组件：**

**1. 集中式安全模块**（`security.cjs`）
- 路径遍历防护 — 验证文件路径是否解析在项目目录内
- 提示注入检测 — 扫描用户提供的文本中的已知注入模式
- 安全 JSON 解析 — 在状态损坏之前捕获格式错误的输入
- 字段名验证 — 通过配置字段名防止注入
- Shell 参数验证 — 在 shell 插值之前对用户文本进行净化

**2. 提示注入守护钩子**（`gsd-prompt-guard.js`）
PreToolUse 钩子，扫描针对 `.planning/` 的 Write/Edit 调用中的注入模式。仅为建议 — 记录检测结果以提高意识，不阻止合法操作。

**3. 工作流守护钩子**（`gsd-workflow-guard.js`）
PreToolUse 钩子，检测 Claude 在 GSD 工作流上下文之外尝试文件编辑的情况。建议使用 `/gsd-quick` 或 `/gsd-fast` 替代直接编辑。可通过 `hooks.workflow_guard` 配置（默认：false）。

**4. CI 就绪注入扫描器**（`prompt-injection-scan.security.test.cjs`）
扫描所有智能体、工作流和命令文件中嵌入注入向量的测试套件。

**需求：**
- REQ-SEC-01：所有用户提供的文件路径必须针对项目目录进行验证
- REQ-SEC-02：提示注入模式必须在文本进入规划构件之前被检测
- REQ-SEC-03：安全钩子必须仅为建议性（永不阻止合法操作）
- REQ-SEC-04：对用户输入的 JSON 解析必须优雅地捕获格式错误的数据
- REQ-SEC-05：macOS `/var` → `/private/var` 符号链接解析必须在路径验证中处理

---

### 47. 多仓库工作区支持

**目的：** 单体仓库和多仓库设置的自动检测和项目根路径解析。支持 `.planning/` 可能需要跨仓库边界解析的工作区。

**需求：**
- REQ-MULTIREPO-01：系统必须自动检测多仓库工作区配置
- REQ-MULTIREPO-02：系统必须跨仓库边界解析项目根路径
- REQ-MULTIREPO-03：执行器必须在多仓库模式下记录每个仓库的提交哈希

---

### 48. 讨论审计追踪

**目的：** 在 `/gsd-discuss-phase` 期间自动生成 `DISCUSSION-LOG.md`，提供讨论期间做出决策的完整审计追踪。

**需求：**
- REQ-DISCLOG-01：系统必须在 discuss-phase 期间自动生成 DISCUSSION-LOG.md
- REQ-DISCLOG-02：日志必须捕获提出的问题、呈现的选项和做出的决策
- REQ-DISCLOG-03：决策 ID 必须实现从 discuss-phase 到 plan-phase 的可追溯性

---

## v1.28 功能

### 49. 取证分析

**命令：** `/gsd-forensics [description]`

**目的：** 对失败或卡住的 GSD 工作流进行事后调查。

**需求：**
- REQ-FORENSICS-01：系统必须分析 git 历史中的异常（卡住的循环、长时间间隔、重复提交）
- REQ-FORENSICS-02：系统必须检查构件完整性（已完成阶段应有预期的文件）
- REQ-FORENSICS-03：系统必须生成保存到 `.planning/forensics/` 的 Markdown 报告
- REQ-FORENSICS-04：系统必须提供创建 GitHub Issue 的选项并附上发现结果
- REQ-FORENSICS-05：系统不得修改项目文件（只读调查）

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `.planning/forensics/report-{timestamp}.md` | 事后调查报告 |

**流程：**
1. **扫描** — 分析 git 历史中的异常：卡住的循环、提交间的长时间间隔、重复的相同提交
2. **完整性检查** — 验证已完成阶段是否有预期的构件文件
3. **报告** — 生成 Markdown 报告，保存到 `.planning/forensics/`
4. **Issue** — 提供创建 GitHub Issue 的选项，以便团队了解发现结果

---

### 50. 里程碑摘要

**命令：** `/gsd-milestone-summary [version]`

**目的：** 从里程碑构件生成全面的项目摘要，用于团队入职。

**需求：**
- REQ-SUMMARY-01：系统必须聚合阶段计划、摘要和验证结果
- REQ-SUMMARY-02：系统必须适用于当前和已归档的里程碑
- REQ-SUMMARY-03：系统必须生成单个可导航的文档

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `MILESTONE-SUMMARY.md` | 里程碑构件的全面可导航摘要 |

**流程：**
1. **收集** — 从目标里程碑聚合阶段计划、摘要和验证结果
2. **综合** — 将构件合并为带交叉引用的单个可导航文档
3. **输出** — 编写适合团队入职和利益相关方审查的 `MILESTONE-SUMMARY.md`

---

### 51. 工作流命名空间

**命令：** `/gsd-workstreams`

**目的：** 并行工作流，用于在不同里程碑区域上同时工作。

**需求：**
- REQ-WS-01：系统必须在独立的 `.planning/workstreams/{name}/` 目录中隔离工作流状态
- REQ-WS-02：系统必须验证工作流名称（仅限字母数字 + 连字符，无路径遍历）
- REQ-WS-03：系统必须支持 list、create、switch、status、progress、complete、resume 子命令

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `.planning/workstreams/{name}/` | 隔离的工作流目录结构 |

**流程：**
1. **创建** — 使用隔离的 `.planning/workstreams/{name}/` 目录初始化命名工作流
2. **切换** — 为后续 GSD 命令更改活跃工作流上下文
3. **管理** — 列出、检查状态、跟踪进度、完成或恢复工作流

---

### 52. 管理仪表板

**命令：** `/gsd-manager`

**目的：** 从一个终端管理多个阶段的交互式命令中心。

**需求：**
- REQ-MGR-01：系统必须显示所有阶段及其状态的概览
- REQ-MGR-02：系统必须过滤到当前里程碑范围
- REQ-MGR-03：系统必须显示阶段依赖关系和冲突

**产出物：** 交互式终端输出

**流程：**
1. **扫描** — 加载当前里程碑中的所有阶段及其状态
2. **显示** — 渲染显示阶段依赖关系、冲突和进度的概览
3. **交互** — 接受命令以导航、检查或对单个阶段采取行动

---

### 53. 假设讨论模式

**命令：** `/gsd-discuss-phase` 配合 `workflow.discuss_mode: 'assumptions'`

**目的：** 用代码库优先的假设分析替代访谈式提问。

**需求：**
- REQ-ASSUME-01：系统必须在提问之前分析代码库以生成结构化假设
- REQ-ASSUME-02：系统必须按置信度（Confident/Likely/Unclear）对假设进行分类
- REQ-ASSUME-03：系统必须生成与默认讨论模式格式相同的 CONTEXT.md
- REQ-ASSUME-04：系统必须支持基于置信度的跳过门控（全部 HIGH = 不提问）

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `{phase}-CONTEXT.md` | 与默认讨论模式格式相同 |

**流程：**
1. **分析** — 扫描代码库以生成关于实现方法的结构化假设
2. **分类** — 按置信度级别对假设进行分类：Confident、Likely、Unclear
3. **门控** — 如果所有假设都具有高置信度，则完全跳过提问
4. **确认** — 将不明确的假设作为有针对性的问题呈现给用户
5. **输出** — 以与默认讨论模式相同的格式生成 `{phase}-CONTEXT.md`

---

### 54. UI 阶段自动检测

**属于：** `/gsd-new-project` 和 `/gsd-progress`

**目的：** 自动检测 UI 密集型项目并呈现 `/gsd-ui-phase` 建议。

**需求：**
- REQ-UI-DETECT-01：系统必须检测项目描述中的 UI 信号（关键字、框架引用）
- REQ-UI-DETECT-02：当适用时，系统必须在 ROADMAP.md 阶段中添加 `ui_hint` 注释
- REQ-UI-DETECT-03：系统必须在 UI 密集型阶段的后续步骤中建议 `/gsd-ui-phase`
- REQ-UI-DETECT-04：系统不得将 `/gsd-ui-phase` 设为强制性

**流程：**
1. **检测** — 扫描项目描述和技术栈中的 UI 信号（关键字、框架引用）
2. **标注** — 在 ROADMAP.md 中为适用阶段添加 `ui_hint` 标记
3. **呈现** — 在 UI 密集型阶段的后续步骤中包含 `/gsd-ui-phase` 建议

---

### 55. 多运行时安装选择

**属于：** `npx @opengsd/gsd-core`

**目的：** 在单个交互式安装会话中选择多个运行时。

**需求：**
- REQ-MULTI-RT-01：交互式提示必须支持多选（例如 Claude Code + Gemini）
- REQ-MULTI-RT-02：CLI 标志必须继续适用于非交互式安装

**流程：**
1. **检测** — 识别系统上可用的 AI CLI 运行时
2. **提示** — 呈现运行时选择的多选界面
3. **安装** — 在单个会话中为所有选定的运行时配置 GSD

---

## v1.29 功能

### 56. Windsurf 运行时支持

**属于：** `npx @opengsd/gsd-core`

**目的：** 将 Windsurf 添加为 GSD 安装和执行支持的 AI CLI 运行时。

**需求：**
- REQ-WINDSURF-01：安装器必须检测 Windsurf 运行时并将其作为目标提供
- REQ-WINDSURF-02：GSD 命令必须在 Windsurf 会话中正确运行

**流程：**
1. **检测** — 识别系统上 Windsurf 运行时的可用性
2. **安装** — 为 Windsurf 环境配置 GSD 技能和钩子

---

### 57. 国际化文档

**属于：** `docs/`

**目的：** 提供葡萄牙语、韩语和日语版本的 GSD 文档。

**需求：**
- REQ-I18N-01：文档必须提供葡萄牙语（pt）、韩语（ko）和日语（ja）版本
- REQ-I18N-02：翻译必须与英文源文档保持同步

**流程：**
1. **翻译** — 将核心文档转换为目标语言
2. **发布** — 使翻译后的文档与英文原版一同可访问

---

## v1.31 功能

### 59. Schema 漂移检测

**命令：** 在 `/gsd-execute-phase` 期间自动执行

**目的：** 检测 ORM schema 文件在没有相应迁移或推送命令的情况下被修改，防止误报验证。

**需求：**
- REQ-SCHEMA-01：系统必须检测对 ORM schema 文件的修改（Prisma、Drizzle、Payload、Sanity、Mongoose）
- REQ-SCHEMA-02：当检测到 schema 变更时，系统必须验证对应的迁移/推送命令是否存在
- REQ-SCHEMA-03：系统必须实现双层防护：计划时注入和执行时门控
- REQ-SCHEMA-04：系统必须支持 `GSD_SKIP_SCHEMA_CHECK` 环境变量以覆盖检测
- REQ-SCHEMA-05：系统必须防止 schema 在没有迁移的情况下修改导致的误报验证

**流程：**
1. **检测** — 在计划执行期间监控 ORM schema 文件修改
2. **验证** — 检查计划中是否存在对应的迁移/推送命令
3. **门控** — 如果检测到没有迁移的 schema 漂移，则阻止执行（执行时门控）
4. **注入** — 在计划生成期间添加迁移提醒（计划时注入）

**配置：** `GSD_SKIP_SCHEMA_CHECK` 环境变量，用于绕过检测。

---

### 60. 安全强制执行

**命令：** `/gsd-secure-phase <N>`

**目的：** 对阶段实现进行以威胁模型为基础的安全验证。

**需求：**
- REQ-SEC-01：系统必须执行以威胁模型为基础的验证（非盲目扫描）
- REQ-SEC-02：系统必须支持可配置的 OWASP ASVS 验证级别（1-3）
- REQ-SEC-03：系统必须根据可配置的严重性阈值阻止阶段推进
- REQ-SEC-04：系统必须派生 `gsd-security-auditor` 智能体进行分析

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| 安全审计报告 | 带严重性分类的以威胁模型为基础的发现结果 |

**流程：**
1. **建模** — 从阶段实现上下文构建威胁模型
2. **审计** — 派生 `gsd-security-auditor` 根据威胁模型进行验证
3. **门控** — 如果发现结果达到或超过 `security_block_on` 严重性，则阻止阶段推进

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `security_enforcement` | boolean | `true` | 启用以威胁模型为基础的安全验证 |
| `security_asvs_level` | number (1-3) | `1` | OWASP ASVS 验证级别 |
| `security_block_on` | string | `"high"` | 阻止阶段推进的最低严重性 |

---

### 61. 文档生成

**命令：** `/gsd-docs-update`

**目的：** 通过准确性检查生成和验证项目文档。

**需求：**
- REQ-DOCS-01：系统必须派生 `gsd-doc-writer` 智能体生成文档
- REQ-DOCS-02：系统必须派生 `gsd-doc-verifier` 智能体检查准确性
- REQ-DOCS-03：系统必须验证生成的文档与实际实现的一致性

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| 更新的项目文档 | 已生成和验证的文档文件 |

**流程：**
1. **生成** — 派生 `gsd-doc-writer` 从实现创建或更新文档
2. **验证** — 派生 `gsd-doc-verifier` 根据代码库检查文档准确性
3. **输出** — 生成带准确性注释的已验证文档

---

### 62. 讨论链模式

**标志：** `/gsd-discuss-phase <N> --chain`

**目的：** 在一个流程中自动链接讨论、规划和执行阶段，减少手动命令排序。

**需求：**
- REQ-CHAIN-01：提供 `--chain` 标志时，系统必须自动链接讨论 → 规划 → 执行
- REQ-CHAIN-02：系统必须在链接阶段之间遵守所有门控设置
- REQ-CHAIN-03：如果任何阶段失败，系统必须停止链

**流程：**
1. **讨论** — 运行 discuss-phase 以收集上下文
2. **规划** — 使用收集的上下文自动调用 plan-phase
3. **执行** — 使用生成的计划自动调用 execute-phase

---

### 63. 单阶段自主执行

**标志：** `/gsd-autonomous --only N`

**目的：** 仅自主执行一个阶段，而不是所有剩余阶段。

**需求：**
- REQ-ONLY-01：提供 `--only N` 时，系统必须只执行指定的阶段号
- REQ-ONLY-02：系统必须遵循与完整自主模式相同的讨论 → 规划 → 执行流程
- REQ-ONLY-03：指定阶段完成后，系统必须停止

**流程：**
1. **选择** — 从 `--only N` 参数识别目标阶段
2. **执行** — 为该单个阶段运行完整的自主流程（讨论 → 规划 → 执行）
3. **停止** — 阶段完成后停止，而不是推进到下一个

---

### 64. 范围缩减检测

**属于：** `/gsd-plan-phase`

**目的：** 通过三层防护防止计划生成期间需求被静默删除。

**需求：**
- REQ-SCOPE-01：系统必须禁止规划器在没有明确理由的情况下缩减范围
- REQ-SCOPE-02：系统必须让计划检查器验证需求维度覆盖
- REQ-SCOPE-03：系统必须让编排器恢复被删除的需求并重新注入
- REQ-SCOPE-04：系统必须实现三层防护：规划器禁止、检查器维度、编排器恢复

**流程：**
1. **禁止** — 规划器指令明确禁止范围缩减
2. **检查** — 计划检查器验证计划中涵盖了所有阶段需求
3. **恢复** — 编排器检测被删除的需求并将其重新注入规划循环

---

### 65. 声明来源标记

**属于：** `/gsd-plan-phase --research-phase <N>`

**目的：** 确保研究声明被标记有来源证据，假设单独记录。

**需求：**
- REQ-PROVENANCE-01：研究员必须用来源证据引用标记声明
- REQ-PROVENANCE-02：假设必须与有来源的声明分开记录
- REQ-PROVENANCE-03：系统必须区分有证据的事实和推断的假设

**流程：**
1. **研究** — 研究员从代码库和领域来源收集信息
2. **标记** — 每个声明都用其来源进行注释（文件路径、文档、API 响应）
3. **分离** — 没有直接证据的假设记录在独立节区

---

### 66. 工作树切换

**配置：** `workflow.use_worktrees: false`

**目的：** 对于偏好顺序执行的用户，禁用 git 工作树隔离。

**需求：**
- REQ-WORKTREE-01：系统在决定隔离策略时必须遵守 `workflow.use_worktrees` 设置
- REQ-WORKTREE-02：系统必须默认为 `true`（启用工作树）以保持向后兼容
- REQ-WORKTREE-03：禁用工作树时，系统必须回退到顺序执行

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `workflow.use_worktrees` | boolean | `true` | 为 `false` 时，禁用 git 工作树隔离 |

---

### 67. 项目代码前缀

**配置：** `project_code: "ABC"`

**目的：** 使用项目代码为阶段目录名称添加前缀，用于多项目消歧义。

**需求：**
- REQ-PREFIX-01：配置后，系统必须为阶段目录添加项目代码前缀（例如 `ABC-01-setup/`）
- REQ-PREFIX-02：未设置 `project_code` 时，系统必须使用标准命名
- REQ-PREFIX-03：系统必须在所有阶段操作中一致应用前缀

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `project_code` | string | （无） | 阶段目录名称的前缀 |

---

### 68. Claude Code 技能迁移

**属于：** `npx @opengsd/gsd-core`

**目的：** 将 GSD 命令迁移到 Claude Code 2.1.88+ 技能格式，同时保持向后兼容性。

**需求：**
- REQ-SKILLS-01：安装器必须为 Claude Code 2.1.88+ 写入 `skills/gsd-*/SKILL.md`
- REQ-SKILLS-02：安装器必须自动清理旧版 `commands/gsd/` 目录
- REQ-SKILLS-03：安装器必须通过 Gemini 路径维护与旧版 Claude Code 的向后兼容性

**流程：**
1. **检测** — 检查 Claude Code 版本以确定技能支持情况
2. **迁移** — 为每个 GSD 命令写入 `skills/gsd-*/SKILL.md` 文件
3. **清理** — 如果已安装技能，则删除旧版 `commands/gsd/` 目录
4. **回退** — 为旧版 Claude Code 维护 Gemini 路径兼容性

---

## v1.32 功能

### 69. STATE.md 一致性门控

**命令：** `state validate`、`state sync [--verify]`、`state planned-phase --phase N --plans N`

**目的：** 检测并修复 STATE.md 与实际文件系统之间的漂移，防止过时状态导致的级联错误。

**需求：**
- REQ-STATE-01：`state validate` 必须检测 STATE.md 字段与文件系统现实之间的漂移
- REQ-STATE-02：`state sync` 必须从磁盘上的实际项目状态重建 STATE.md
- REQ-STATE-03：`state sync --verify` 必须执行演习，显示建议的更改而不写入
- REQ-STATE-04：`state planned-phase` 必须在 plan-phase 完成后记录状态转换（已计划/准备执行）

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| 更新的 `STATE.md` | 反映文件系统现实的已更正状态 |

**流程：**
1. **验证** — 将 STATE.md 字段与文件系统（阶段目录、计划文件、摘要）进行比较
2. **同步** — 检测到漂移时从磁盘重建 STATE.md
3. **转换** — 记录带有计划数量的规划后状态，用于执行阶段准备就绪

---

### 70. 自主 `--to N` 标志

**标志：** `/gsd-autonomous --to N`

**目的：** 在完成特定阶段后停止自主执行，允许部分自主运行。

**需求：**
- REQ-TO-01：系统必须在指定的阶段号完成后停止执行
- REQ-TO-02：系统必须对每个直到 N 的阶段遵循相同的讨论 -> 规划 -> 执行流程
- REQ-TO-03：`--to N` 必须可与 `--from N` 组合，用于有界自主范围

**流程：**
1. **限制** — 从 `--to N` 参数设置阶段上限
2. **执行** — 对每个直到（包括）阶段 N 的阶段运行自主流程
3. **停止** — 阶段 N 完成后停止

---

### 71. 研究门控

**属于：** `/gsd-plan-phase`

**目的：** 当 RESEARCH.md 有未解决的开放问题时阻止规划，防止在不完整信息基础上制定计划。

**需求：**
- REQ-RESGATE-01：规划开始前，系统必须扫描 RESEARCH.md 中未解决的开放问题
- REQ-RESGATE-02：当存在开放问题时，系统必须阻止进入 plan-phase
- REQ-RESGATE-03：系统必须向用户呈现具体的未解决问题

**流程：**
1. **扫描** — 检查 RESEARCH.md 中带有未解决项目的开放问题节区
2. **门控** — 发现未解决问题时阻止规划
3. **呈现** — 显示需要解决的具体开放问题

---

### 72. 验证器里程碑范围过滤

**属于：** `/gsd-execute-phase`（验证器步骤）

**目的：** 区分真正的间隙和推迟到后续阶段的项目，减少验证中的假阴性。

**需求：**
- REQ-VSCOPE-01：验证器必须检查间隙是否在后续里程碑阶段中得到解决
- REQ-VSCOPE-02：在后续阶段中解决的间隙必须标记为"推迟"，而不是"间隙"
- REQ-VSCOPE-03：只有真正的间隙（未被任何未来阶段覆盖）必须报告为失败

**流程：**
1. **验证** — 运行标准的目标反向验证
2. **过滤** — 将检测到的间隙与后续里程碑阶段进行交叉引用
3. **分类** — 将推迟的项目与真正的间隙分开标记

---

### 73. 编辑前读取守护钩子

**属于：** 钩子（`PreToolUse`）

**目的：** 通过确保在编辑之前读取文件，防止非 Claude 运行时中的无限重试循环。

**需求：**
- REQ-RBE-01：钩子必须检测针对在会话中未先读取的文件的 Edit/Write 工具调用
- REQ-RBE-02：钩子必须建议先读取文件（建议性，非阻塞）
- REQ-RBE-03：钩子必须防止在没有内置编辑前读取强制的运行时中常见的无限重试循环

---

### 74. 上下文压缩

**属于：** 提示组装流水线

**目的：** 通过 Markdown 截断和缓存友好的提示排序来减少上下文提示大小。

**需求：**
- REQ-CTXRED-01：系统必须截断超大 Markdown 构件以适应上下文预算
- REQ-CTXRED-02：系统必须为缓存友好的组装对提示进行排序（稳定的前缀优先）
- REQ-CTXRED-03：压缩必须保留必要信息（标题、需求、任务结构）
- REQ-CTXRED-04：技能 `description:` 字段必须 ≤ 100 个字符；由 `npm run lint:descriptions` 强制执行（参见 `scripts/lint-descriptions.cjs` 和 `tests/skill-frontmatter-contract.test.cjs`）

**流程：**
1. **测量** — 计算工作流的总提示大小
2. **截断** — 对超大构件应用 Markdown 感知截断
3. **排序** — 为最优 KV 缓存重用安排提示节区

---

### 75. 讨论阶段 `--power` 标志

**标志：** `/gsd-discuss-phase --power`

**目的：** 基于文件的 discuss-phase 批量问题回答，支持从准备好的答案文件进行批量输入。

**需求：**
- REQ-POWER-01：系统必须接受包含讨论问题预写答案的文件
- REQ-POWER-02：系统必须将答案映射到对应的灰色地带问题
- REQ-POWER-03：系统必须生成与交互式 discuss-phase 相同的 CONTEXT.md

---

### 76. 调试 `--diagnose` 标志

**标志：** `/gsd-debug --diagnose`

**目的：** 仅诊断模式，调查但不尝试修复。

**需求：**
- REQ-DIAG-01：系统必须执行完整的调试调查（假设、证据、根因）
- REQ-DIAG-02：系统不得尝试任何代码修改
- REQ-DIAG-03：系统必须生成包含发现结果和推荐修复的诊断报告

---

### 77. 阶段依赖分析

**命令：** `/gsd-manager --analyze-deps`

**目的：** 在运行 `/gsd-manager` 之前检测阶段依赖关系，并建议在 ROADMAP.md 中添加 `Depends on` 条目。

**需求：**
- REQ-DEP-01：系统必须检测阶段间的文件重叠
- REQ-DEP-02：系统必须检测语义依赖（API/Schema 生产者和消费者）
- REQ-DEP-03：系统必须检测数据流依赖（输出生产者和读取者）
- REQ-DEP-04：系统必须在写入前提出带用户确认的依赖条目建议

**产出物：** 依赖建议表；可选择更新 ROADMAP.md `Depends on` 字段

---

### 78. 反模式严重级别

**属于：** `/gsd-resume-work`

**目的：** 在恢复时进行强制性理解检查，并基于严重性的反模式强制执行。

**需求：**
- REQ-ANTI-01：系统必须按严重级别对反模式进行分类
- REQ-ANTI-02：系统必须在会话恢复时强制执行理解检查
- REQ-ANTI-03：较高严重性的反模式必须在被确认之前阻止工作流推进

---

### 79. 方法论构件类型

**属于：** 规划构件

**目的：** 为方法论文档定义消费机制，确保智能体正确消费它们。

**需求：**
- REQ-METHOD-01：系统必须将方法论支持为独特的构件类型
- REQ-METHOD-02：方法论构件必须为智能体定义消费机制

---

### 80. 规划器可达性检查

**属于：** `/gsd-plan-phase`

**目的：** 在提交执行之前验证计划步骤是否可实现。

**需求：**
- REQ-REACH-01：规划器必须验证每个计划步骤引用的文件和 API 是否可达
- REQ-REACH-02：不可达的步骤必须在规划期间标记，而不是在执行期间发现

---

### 81. Playwright-MCP UI 验证

**属于：** `/gsd-verify-work`（可选）

**目的：** 在 verify-phase 期间使用 Playwright-MCP 进行自动化视觉验证。

**需求：**
- REQ-PLAY-01：系统必须支持在 verify-phase 期间进行可选的 Playwright-MCP 视觉验证
- REQ-PLAY-02：视觉验证必须是选项，而非强制
- REQ-PLAY-03：系统必须根据 UI-SPEC.md 预期捕获并比较视觉状态

---

### 82. 暂停工作扩展

**属于：** `/gsd-pause-work`

**目的：** 支持非阶段上下文，提供更丰富的切换数据，扩大暂停工作的适用性。

**需求：**
- REQ-PAUSE-01：系统必须支持在非阶段上下文（快速任务、调试会话、线程）中暂停
- REQ-PAUSE-02：切换数据必须包含适合当前工作类型的更丰富上下文

---

### 83. 响应语言配置

**配置：** `response_language`

**目的：** 为非英语用户实现跨阶段语言一致性。

**需求：**
- REQ-LANG-01：系统必须在所有阶段和智能体中遵守 `response_language` 设置
- REQ-LANG-02：设置必须传播到所有派生智能体，以保持一致的语言输出

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `response_language` | string | （无） | 智能体响应的语言代码（例如 `"pt"`、`"ko"`、`"ja"`） |

---

### 84. 手动更新流程

**属于：** `docs/manual-update.md`

**目的：** 为 `npx` 不可用或 npm 发布出现故障的环境记录手动更新路径。

**需求：**
- REQ-MANUAL-01：文档必须描述逐步的手动更新流程
- REQ-MANUAL-02：流程必须在不使用 npm 访问的情况下正常工作

---

### 85. 新运行时支持（Trae、Cline、Augment Code）

**属于：** `npx @opengsd/gsd-core`

**目的：** 将 GSD 安装扩展到 Trae IDE、Cline 和 Augment Code 运行时。

**需求：**
- REQ-TRAE-01：安装器必须支持 `--trae` 标志用于 Trae IDE 安装
- REQ-CLINE-01：安装器必须通过 `.clinerules` 配置支持 Cline
- REQ-AUGMENT-01：安装器必须支持带有技能转换和配置管理的 Augment Code

---

### 86. 自主 `--interactive` 标志

**标志：** `/gsd-autonomous --interactive`

**目的：** 精简上下文自主模式，保持 discuss-phase 交互（用户回答问题），同时将规划和执行作为后台智能体派发。

**需求：**
- REQ-INTERACT-01：`--interactive` 必须在主上下文中内联运行 discuss-phase，进行交互式提问（不自动回答）
- REQ-INTERACT-02：`--interactive` 必须将 plan-phase 和 execute-phase 作为后台智能体派发，用于上下文隔离
- REQ-INTERACT-03：`--interactive` 必须启用流水线并行性 — 在阶段 N 构建时讨论阶段 N+1
- REQ-INTERACT-04：主上下文必须只积累讨论对话（精简上下文）

**流程：**
1. **内联讨论** — 在主上下文中与用户交互运行 discuss-phase
2. **派发** — 将规划和执行发送到带全新上下文窗口的后台智能体
3. **流水线** — 当后台智能体构建阶段 N 时，开始讨论阶段 N+1

---

### 87. 提交文档守护钩子

**钩子：** `gsd-commit-docs.js`

**目的：** PreToolUse 钩子，强制执行 `commit_docs` 配置，当 `planning.commit_docs` 为 `false` 时防止提交 `.planning/` 文件。

**需求：**
- REQ-COMMITDOCS-01：钩子必须拦截暂存 `.planning/` 文件的 git commit 命令
- REQ-COMMITDOCS-02：当 `commit_docs` 为 `false` 时，钩子必须阻止包含 `.planning/` 文件的提交
- REQ-COMMITDOCS-03：钩子必须是建议性的 — 当 `commit_docs` 为 `true` 或不存在时不阻止

---

### 88. 社区钩子选项

**钩子：** `gsd-validate-commit.sh`、`gsd-session-state.sh`、`gsd-phase-boundary.sh`

**目的：** GSD 项目的可选 git 和会话钩子，在配置中通过 `hooks.community: true` 门控。

**需求：**
- REQ-COMMUNITY-01：所有社区钩子在 `.planning/config.json` 中 `hooks.community` 为 `true` 之前必须为无操作
- REQ-COMMUNITY-02：`gsd-validate-commit.sh` 必须对 git commit 消息强制执行常规提交格式
- REQ-COMMUNITY-03：`gsd-session-state.sh` 必须跟踪会话状态转换
- REQ-COMMUNITY-04：`gsd-phase-boundary.sh` 必须强制执行阶段边界检查

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `hooks.community` | boolean | `false` | 启用用于提交验证、会话状态和阶段边界的可选社区钩子 |

---

## v1.34.0 功能

  - [全局学习存储](#89-global-learnings-store)
  - [可查询代码库智能](#90-queryable-codebase-intelligence)
  - [执行上下文配置](#91-execution-context-profiles)
  - [门控分类](#92-gates-taxonomy)
  - [代码审查流水线](#93-code-review-pipeline)
  - [苏格拉底式探索](#94-socratic-exploration)
  - [安全撤销](#95-safe-undo)
  - [计划导入](#96-plan-import)
  - [快速代码库扫描](#97-rapid-codebase-scan)
  - [自主审计修复](#98-autonomous-audit-to-fix)
  - [改进的提示注入扫描器](#99-improved-prompt-injection-scanner)
  - [规划阶段停滞检测](#100-stall-detection-in-plan-phase)
  - [/gsd-progress --next 中的硬停止安全门控](#101-hard-stop-safety-gates-in-gsd-progress---next)
  - [自适应模型预设](#102-adaptive-model-preset)
  - [合并后 Hunk 验证](#103-post-merge-hunk-verification)

---

### 89. 全局学习存储

**命令：** 在阶段完成时自动触发；由规划器使用
**配置：** `features.global_learnings`

**目的：** 在全局存储中持久化跨会话、跨项目的学习成果，以便规划智能体能够从整个项目历史中的模式学习，而不仅仅是当前会话。

**需求：**
- REQ-LEARN-01：学习成果必须在阶段完成时自动从 `.planning/` 复制到全局存储
- REQ-LEARN-02：规划智能体必须在派生时通过注入接收相关学习成果
- REQ-LEARN-03：注入必须受 `learnings.max_inject` 限制，以避免上下文膨胀
- REQ-LEARN-04：功能必须通过 `features.global_learnings: true` 选项启用

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `features.global_learnings` | boolean | `false` | 启用跨项目学习流水线 |
| `learnings.max_inject` | number | （系统默认值） | 注入规划器的最大学习条目数 |

---

### 90. 可查询代码库智能

**命令：** `/gsd-map-codebase --query [<term>|status|diff|refresh]`
**配置：** `intel.enabled`

**目的：** 在 `.planning/intel/` 中维护可查询的代码库结构、API 表面、依赖图、文件角色和架构决策的 JSON 索引。支持在不读取整个代码库的情况下进行有针对性的查找。

**需求：**
- REQ-INTEL-01：Intel 文件必须作为 JSON 存储在 `.planning/intel/`
- REQ-INTEL-02：`query` 模式必须在所有 intel 文件中搜索某个词并按文件分组结果
- REQ-INTEL-03：`status` 模式必须报告新鲜度（FRESH/STALE，过期阈值：24 小时）
- REQ-INTEL-04：`diff` 模式必须将当前 intel 状态与上一个快照进行比较
- REQ-INTEL-05：`refresh` 模式必须派生 intel 更新器智能体重建所有文件
- REQ-INTEL-06：功能必须通过 `intel.enabled: true` 选项启用

**生成的 Intel 文件：**
| 文件 | 内容 |
|------|----------|
| `stack.json` | 技术栈和依赖项 |
| `api-map.json` | 导出函数和 API 表面 |
| `dependency-graph.json` | 模块间依赖关系 |
| `file-roles.json` | 每个源文件的角色分类 |
| `arch-decisions.json` | 检测到的架构决策 |

---

### 91. 执行上下文配置

**配置：** `context_profile`

**目的：** 选择针对特定类型工作调整的预配置执行上下文（模式、模型、工作流设置），无需手动调整单个设置。

**需求：**
- REQ-CTX-01：`dev` 配置必须针对迭代开发优化（balanced 模型，启用 plan_check）
- REQ-CTX-02：`research` 配置必须针对研究密集型工作优化（较高模型层级，启用研究）
- REQ-CTX-03：`review` 配置必须针对代码审查工作优化（启用 verifier 和 code_review）

**可用配置：** `dev`、`research`、`review`

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `context_profile` | string | （无） | 执行上下文预设：`dev`、`research` 或 `review` |

---

### 92. 门控分类

**参考：** `gsd-core/references/gates.md`
**智能体：** plan-checker、verifier

**目的：** 定义构建所有工作流决策点的 4 种规范门控类型，使 plan-checker 和 verifier 智能体能够应用一致的门控逻辑。

**门控类型：**
| 类型 | 描述 |
|------|-------------|
| **确认（Confirm）** | 继续前用户审批（例如，路线图审查） |
| **质量（Quality）** | 自动化质量检查必须通过（例如，计划验证循环） |
| **安全（Safety）** | 检测到风险或违反策略时的硬停止 |
| **过渡（Transition）** | 阶段或里程碑边界确认 |

**需求：**
- REQ-GATES-01：plan-checker 必须将每个检查点分类为 4 种门控类型之一
- REQ-GATES-02：verifier 必须应用适合门控类型的门控逻辑
- REQ-GATES-03：硬停止安全门控绝不得被 `--auto` 标志绕过

---

### 93. 代码审查流水线

**命令：** `/gsd-code-review`、`/gsd-code-review --fix`

**目的：** 对阶段期间更改的源文件进行结构化审查，并通过单独的自动修复过程，每次修复以原子化提交。

**需求：**
- REQ-REVIEW-01：`gsd-code-review` 必须使用 SUMMARY.md 和 git diff 回退将文件范围限定到阶段
- REQ-REVIEW-02：审查必须支持三个深度级别：`quick`、`standard`、`deep`
- REQ-REVIEW-03：发现结果必须按严重性分类：Critical、Warning、Info
- REQ-REVIEW-04：`gsd-code-review --fix` 必须读取 REVIEW.md 并默认修复 Critical + Warning 发现
- REQ-REVIEW-05：每次修复必须以描述性消息原子化提交
- REQ-REVIEW-06：`--auto` 标志必须启用修复 + 重新审查的迭代循环，上限为 3 次迭代
- REQ-REVIEW-07：功能必须受 `workflow.code_review` 配置标志门控

**配置：**
| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `workflow.code_review` | boolean | `true` | 启用代码审查命令 |
| `workflow.code_review_depth` | string | `standard` | 默认审查深度：`quick`、`standard` 或 `deep` |

---

### 94. 苏格拉底式探索

**命令：** `/gsd-explore [topic]`

**目的：** 在提交计划之前，通过苏格拉底式探究性问题引导开发者探索想法。将输出路由到适当的 GSD 构件：笔记、待办事项、种子、研究问题、需求更新或新阶段。

**需求：**
- REQ-EXPLORE-01：探索必须使用苏格拉底式探究 — 在提出解决方案之前提问
- REQ-EXPLORE-02：会话必须提供将输出路由到适当 GSD 构件的选项
- REQ-EXPLORE-03：可选的主题参数必须为第一个问题提供引导
- REQ-EXPLORE-04：探索必须可选择派生研究智能体进行技术可行性分析

---

### 95. 安全撤销

**命令：** `/gsd-undo --last N | --phase NN | --plan NN-MM`

**目的：** 使用阶段清单和 git 日志安全回滚 GSD 阶段或计划提交，进行依赖性检查，并在应用任何回滚之前设置硬确认门控。

**需求：**
- REQ-UNDO-01：`--phase` 模式必须通过清单和 git 日志回退识别阶段的所有提交
- REQ-UNDO-02：`--plan` 模式必须识别特定计划的所有提交
- REQ-UNDO-03：`--last N` 模式必须显示最近的 GSD 提交供交互式选择
- REQ-UNDO-04：系统必须在回滚之前检查依赖的阶段/计划
- REQ-UNDO-05：执行任何 git revert 之前必须显示确认门控

---

### 96. 计划导入

**命令：** `/gsd-import --from <filepath>`

**目的：** 将外部计划文件摄入 GSD 规划系统，检测与 `PROJECT.md` 决策的冲突，将其转换为有效的 GSD PLAN.md，并通过 plan-checker 进行验证。

**需求：**
- REQ-IMPORT-01：导入器必须检测外部计划与现有 PROJECT.md 决策之间的冲突
- REQ-IMPORT-02：所有检测到的冲突必须在写入之前呈现给用户解决
- REQ-IMPORT-03：导入的计划必须以有效的 GSD PLAN.md 格式写入
- REQ-IMPORT-04：写入的计划必须通过 `gsd-plan-checker` 验证

---

### 97. 快速代码库扫描

**命令：** `/gsd-map-codebase --fast [--focus tech|arch|quality|concerns]`

**目的：** `/gsd-map-codebase` 的轻量级替代方案，为一两个组合的焦点区域派生单个映射智能体，在 `.planning/codebase/` 中生成有针对性的输出，无需 4 个并行智能体的开销。

**需求：**
- REQ-SCAN-01：扫描必须精确派生一个映射智能体（而非四个并行智能体）
- REQ-SCAN-02：焦点区域必须是以下之一：`tech`、`arch`、`quality`、`concerns` 或组合的 `tech+arch` 简写（默认：`tech+arch`）；组合焦点在单次通过中作为单个智能体运行，覆盖两个区域
- REQ-SCAN-03：输出必须以与 `/gsd-map-codebase` 相同的格式写入 `.planning/codebase/`

---

### 98. 自主审计修复

**命令：** `/gsd-audit-fix [--source <audit>] [--severity high|medium|all] [--max N] [--dry-run]`

**目的：** 端到端流水线，运行审计，将发现结果分类为可自动修复与仅手动处理，然后自主修复可自动修复的问题，进行测试验证并原子化提交。

**需求：**
- REQ-AUDITFIX-01：进行任何更改之前，发现结果必须被分类为可自动修复或仅手动处理
- REQ-AUDITFIX-02：每次修复必须在提交之前通过测试验证
- REQ-AUDITFIX-03：每次修复必须原子化提交
- REQ-AUDITFIX-04：`--dry-run` 必须显示分类表而不应用任何修复
- REQ-AUDITFIX-05：`--max N` 必须限制单次运行中应用的修复数量（默认：5）

---

### 99. 改进的提示注入扫描器

**钩子：** `gsd-prompt-guard.js`、`gsd-read-injection-scanner.js`
**脚本：** `scripts/prompt-injection-scan.sh`、`scripts/base64-scan.sh`

**目的：** 对规划构件和摄入内容中提示注入尝试的深度防御检测。实时钩子为保持独立性内联了自己的模式子集（不导入 `security.cts`）。CI 扫描器（`security.cts` 中的 `scanForInjection`）为测试中的全代码库扫描提供集中引擎。

**需求：**
- REQ-SCAN-INJ-01：实时钩子必须检测不可见 Unicode 字符（零宽空格、软连字符、Unicode 标签块 U+E0000–E007F）
- REQ-SCAN-INJ-02：实时钩子必须检测已知注入模式（指令覆盖、角色操纵、系统提示提取、伪造消息边界）。Base64 解码扫描是 CI 时控制（`scripts/base64-scan.sh`），不是实时钩子 — 实时钩子仅匹配 base64 外泄短语正则，不解码。
- REQ-SCAN-INJ-03：~~扫描器必须应用熵分析~~ — 熵分析（`scanEntropyAnomalies`）在 #2198 中作为死代码被移除（零生产调用者；实时钩子不执行熵分析）。此需求推迟到有可维护的实时实现时。
- REQ-SCAN-INJ-04：扫描器必须保持仅建议性 — 检测会被记录，而不会阻止

---

### 100. 规划阶段停滞检测

**命令：** `/gsd-plan-phase`

**目的：** 检测规划器修订循环何时停滞——在多次迭代中产生相同的输出——并通过升级到不同策略或以明确诊断退出来打破循环。

**需求：**
- REQ-STALL-01：修订循环必须检测连续迭代中相同的计划输出
- REQ-STALL-02：检测到停滞时，系统必须在重试之前升级策略
- REQ-STALL-03：最大停滞重试次数必须有界（上限为现有最大 3 次迭代）

---

### 101. /gsd-progress --next 中的硬停止安全门控

**命令：** `/gsd-progress --next`

**目的：** 通过添加硬停止安全门控和连续调用守护来阻止 `/gsd-progress --next` 进入失控循环，该守护在检测到重复的相同步骤时中断自主链式操作。

**需求：**
- REQ-NEXT-GATE-01：`/gsd-progress --next` 必须跟踪连续的相同步骤调用
- REQ-NEXT-GATE-02：重复相同步骤时，系统必须向用户呈现硬停止门控
- REQ-NEXT-GATE-03：用户必须明确确认才能通过硬停止门控继续

---

### 102. 自适应模型预设

**配置：** `model_profile: "adaptive"`

**目的：** 基于角色的模型分配，根据当前智能体的角色自动选择适当的模型层级，而不是对所有智能体应用单一层级。

**需求：**
- REQ-ADAPTIVE-01：`adaptive` 预设必须根据智能体角色分配模型层级（规划器 → quality 层，执行器 → balanced 层等）
- REQ-ADAPTIVE-02：`adaptive` 必须可通过 `/gsd-config --profile adaptive` 选择

---

### 103. 合并后 Hunk 验证

**命令：** `/gsd-update --reapply`

**目的：** 在更新后应用本地补丁后，通过将预期的补丁内容与实时文件系统进行比较，验证所有 hunk 是否实际被应用。立即呈现任何被丢弃或部分应用的 hunk，而不是静默接受不完整的合并。

**需求：**
- REQ-PATCH-VERIFY-01：重新应用补丁必须在合并后验证每个 hunk 是否被应用
- REQ-PATCH-VERIFY-02：被丢弃或部分应用的 hunk 必须向用户报告，附带文件和行上下文
- REQ-PATCH-VERIFY-03：验证必须在所有补丁应用后运行，而不是逐个补丁运行

---

## v1.35.0 功能

- [新运行时支持（Cline、CodeBuddy、Qwen Code）](#104-new-runtime-support-cline-codebuddy-qwen-code)
- [GSD-2 反向迁移](#105-gsd-2-reverse-migration)
- [AI 集成阶段向导](#106-ai-integration-phase-wizard)
- [AI 评估审查](#107-ai-eval-review)

---

### 104. 新运行时支持（Cline、CodeBuddy、Qwen Code）

**属于：** `npx @opengsd/gsd-core`

**目的：** 将 GSD 安装扩展到 Cline、CodeBuddy 和 Qwen Code 运行时。

**需求：**
- REQ-CLINE-02：Cline 安装必须将 `.clinerules` 写入 `~/.cline/`（全局）或 `./.cline/`（本地）。无自定义斜杠命令 — 仅基于规则的集成。标志：`--cline`。
- REQ-CODEBUDDY-01：CodeBuddy 安装必须将技能部署到 `~/.codebuddy/skills/gsd-*/SKILL.md`。标志：`--codebuddy`。
- REQ-QWEN-01：Qwen Code 安装必须将技能部署到 `~/.qwen/skills/gsd-*/SKILL.md`，遵循 Claude Code 2.1.88+ 使用的开放标准。`QWEN_CONFIG_DIR` 环境变量覆盖默认路径。标志：`--qwen`。

**运行时摘要：**

| 运行时 | 安装格式 | 配置路径 | 标志 |
|---------|---------------|-------------|------|
| Cline | `.clinerules` | `~/.cline/` 或 `./.cline/` | `--cline` |
| CodeBuddy | Skills (`SKILL.md`) | `~/.codebuddy/skills/` | `--codebuddy` |
| Qwen Code | Skills (`SKILL.md`) | `~/.qwen/skills/` | `--qwen` |

---

### 105. GSD-2 反向迁移

**命令：** `/gsd-import --from-gsd2 [--dry-run] [--force] [--path <dir>]`

**目的：** 将项目从 GSD-2 格式（带里程碑→切片→任务层次结构的 `.gsd/` 目录）迁移回 v1 `.planning/` 格式，恢复与所有 GSD v1 命令的完整兼容性。

**需求：**
- REQ-FROM-GSD2-01：导入器必须从指定或当前目录读取 `.gsd/`
- REQ-FROM-GSD2-02：里程碑→切片层次结构必须展平为顺序阶段号（M001/S01→阶段 01，M001/S02→阶段 02，M002/S01→阶段 03，等）
- REQ-FROM-GSD2-03：系统必须防止在没有 `--force` 的情况下覆盖现有的 `.planning/` 目录
- REQ-FROM-GSD2-04：`--dry-run` 必须预览所有更改而不写入任何文件
- REQ-FROM-GSD2-05：迁移必须生成 `PROJECT.md`、`REQUIREMENTS.md`、`ROADMAP.md`、`STATE.md` 和顺序阶段目录

**标志：**

| 标志 | 描述 |
|------|-------------|
| `--dry-run` | 预览迁移输出而不写入文件 |
| `--force` | 覆盖现有的 `.planning/` 目录 |
| `--path <dir>` | 指定 GSD-2 根目录 |

---

### 106. AI 集成阶段向导

**命令：** `/gsd-ai-integration-phase [N]`

**目的：** 引导开发者在项目阶段选择、集成和规划 AI/LLM 能力的评估。生成结构化的 `AI-SPEC.md`，输入规划和验证。

**需求：**
- REQ-AISPEC-01：向导必须呈现涵盖框架选择、模型选择和集成方式的交互式决策矩阵
- REQ-AISPEC-02：系统必须呈现与项目类型相关的特定领域失败模式和评估标准
- REQ-AISPEC-03：系统必须派生 3 个并行专业智能体：领域研究员、框架选择器和评估规划器
- REQ-AISPEC-04：输出必须生成带有框架推荐、实现指南和评估策略的 `{phase}-AI-SPEC.md`

**产出物：** 阶段目录中的 `{phase}-AI-SPEC.md`

---

### 107. AI 评估审查

**命令：** `/gsd-eval-review [N]`

**目的：** 对已执行 AI 阶段的评估覆盖与 `AI-SPEC.md` 计划进行追溯审计。在阶段关闭之前识别计划与实现评估之间的间隙。

**需求：**
- REQ-EVALREVIEW-01：审查必须读取指定阶段的 `AI-SPEC.md`
- REQ-EVALREVIEW-02：每个评估维度必须被评为 COVERED、PARTIAL 或 MISSING
- REQ-EVALREVIEW-03：输出必须包含发现结果、间隙描述和补救指南
- REQ-EVALREVIEW-04：`EVAL-REVIEW.md` 必须写入阶段目录

**产出物：** 带评分评估维度、间隙分析和补救步骤的 `{phase}-EVAL-REVIEW.md`

---

## v1.36.0 功能

### 108. 计划弹跳

**命令：** `/gsd-plan-phase N --bounce`

**目的：** 计划通过检查器后，可选地通过外部脚本（第二个 AI、linter、自定义验证器）对其进行优化。弹跳步骤备份每个计划，运行脚本，验证结果的 YAML 前置元数据完整性，重新运行计划检查器，如果任何步骤失败则从备份恢复。

**需求：**
- REQ-BOUNCE-01：`--bounce` 标志或 `workflow.plan_bounce: true` 激活该步骤；`--skip-bounce` 始终禁用它
- REQ-BOUNCE-02：`workflow.plan_bounce_script` 必须指向有效的可执行文件；缺少脚本会产生警告并跳过
- REQ-BOUNCE-03：在脚本运行之前，每个计划都备份到 `*-PLAN.pre-bounce.md`
- REQ-BOUNCE-04：YAML 前置元数据损坏或无法通过 plan-checker 的弹跳计划将从备份恢复
- REQ-BOUNCE-05：`workflow.plan_bounce_passes`（默认：2）控制脚本接收多少次优化遍历

**配置：** `workflow.plan_bounce`、`workflow.plan_bounce_script`、`workflow.plan_bounce_passes`

---

### 109. 外部代码审查命令

**命令：** `/gsd-ship`（增强版）

**目的：** 在 `/gsd-ship` 的手动审查步骤之前，如果已配置，自动运行外部代码审查命令。命令通过 stdin 接收 diff 和阶段上下文，并返回 JSON 判决（`APPROVED` 或 `REVISE`）。无论结果如何，都进入现有的手动审查流程。

**需求：**
- REQ-EXTREVIEW-01：`workflow.code_review_command` 必须设置为命令字符串；null 表示跳过
- REQ-EXTREVIEW-02：diff 使用 `--stat` 摘要针对 `BASE_BRANCH` 生成
- REQ-EXTREVIEW-03：审查提示通过 stdin 传递（从不进行 shell 插值）
- REQ-EXTREVIEW-04：120 秒超时；失败时捕获 stderr
- REQ-EXTREVIEW-05：解析 JSON 输出中的 `verdict`、`confidence`、`summary`、`issues` 字段

**配置：** `workflow.code_review_command`

---

### 110. 跨 AI 执行委托

**命令：** `/gsd-execute-phase N --cross-ai`

**目的：** 将单个计划委托给外部 AI 运行时执行。前置元数据中带 `cross_ai: true` 的计划（或使用 `--cross-ai` 时的所有计划）通过 stdin 发送到配置的命令。成功处理的计划从普通执行器队列中删除。

**需求：**
- REQ-CROSSAI-01：`--cross-ai` 强制所有计划通过跨 AI；`--no-cross-ai` 禁用它
- REQ-CROSSAI-02：每个计划激活需要 `workflow.cross_ai_execution: true` 和计划前置元数据 `cross_ai: true`
- REQ-CROSSAI-03：任务提示通过 stdin 传递，以防止注入
- REQ-CROSSAI-04：脏工作树在执行前产生警告
- REQ-CROSSAI-05：失败时，用户选择：重试、跳过（回退到普通执行器）或中止

**配置：** `workflow.cross_ai_execution`、`workflow.cross_ai_command`、`workflow.cross_ai_timeout`

---

### 111. 架构职责映射

**命令：** `/gsd-plan-phase`（增强研究步骤）

**目的：** 在阶段研究期间，阶段研究员现在将每个能力映射到其架构层所有者（浏览器、前端服务器、API、CDN/静态、数据库）。规划器对照此映射交叉检查任务，plan-checker 将层级合规性作为维度 7c 强制执行。

**需求：**
- REQ-ARM-01：阶段研究员在 RESEARCH.md 中生成架构职责映射表（步骤 1.5）
- REQ-ARM-02：规划器对照映射进行任务到层级分配的健全性检查
- REQ-ARM-03：计划检查器将层级合规性验证为维度 7c（一般不匹配时为 WARNING，安全敏感时为 BLOCKER）

**产出物：** `{phase}-RESEARCH.md` 中的 `## Architectural Responsibility Map` 节区

---

### 112. 提取学习成果

**命令：** `/gsd-extract-learnings N`

**目的：** 从已完成阶段构件中提取结构化知识。读取 PLAN.md 和 SUMMARY.md（必需）以及 VERIFICATION.md、UAT.md 和 STATE.md（可选），生成四类学习成果：决策、教训、模式和惊喜。可选择通过 `capture_thought` 工具将每个项目捕获到外部知识库。

**需求：**
- REQ-LEARN-01：需要 PLAN.md 和 SUMMARY.md；缺失时以清晰的错误退出
- REQ-LEARN-02：每个提取的项目包括来源归属（构件和节区）
- REQ-LEARN-03：如果 `capture_thought` 工具可用，使用 `source`、`project` 和 `phase` 元数据捕获项目
- REQ-LEARN-04：如果 `capture_thought` 不可用，成功完成并记录外部捕获已跳过
- REQ-LEARN-05：运行两次会覆盖之前的 `LEARNINGS.md`

**产出物：** 带 YAML 前置元数据（阶段、项目、每类别计数、missing_artifacts）的 `{phase}-LEARNINGS.md`

**可选集成 — `capture_thought`：** `capture_thought` 是**一种约定，而非捆绑工具**。GSD 不附带一个，也不要求一个。工作流检查当前会话中是否有任何 MCP 服务器暴露名为 `capture_thought` 的工具，如果有，则为每个提取的学习调用一次，签名如下。如果不存在此类工具，则该步骤静默跳过，`LEARNINGS.md` 仍然是主要输出。

预期的工具签名：
```javascript
capture_thought({
  category: "decision" | "lesson" | "pattern" | "surprise",
  phase: <phase_number>,
  content: <learning_text>,
  source: <artifact_name>
})
```

运行内存/知识库 MCP 服务器（例如 ExoCortex 风格服务器、`claude-mem` 或 `mem0` 风格服务器）的用户可以实现此工具名称，以便学习成果自动路由到其知识库，附带 `project`、`phase` 和 `source` 元数据。其他用户可以在不进行任何额外设置的情况下使用 `/gsd-extract-learnings` — `LEARNINGS.md` 构件就是该功能。

---

### 114. 上下文窗口感知提示精简

**目的：** 对于上下文窗口低于 200K tokens 的模型，将静态提示开销减少约 40%。将扩展示例和反模式列表从智能体定义中提取到按需通过 `@` required_reading 加载的参考文件中。

**需求：**
- REQ-THIN-01：当 `CONTEXT_WINDOW < 200000` 时，执行器和规划器智能体提示省略内联示例
- REQ-THIN-02：提取的内容存储在 `references/executor-examples.md` 和 `references/planner-antipatterns.md`
- REQ-THIN-03：标准（200K-500K）和富集（500K+）层级不受影响
- REQ-THIN-04：核心规则和决策逻辑保留内联；只提取冗长的示例

**参考文件：** `executor-examples.md`、`planner-antipatterns.md`

---

### 115. 可配置的 CLAUDE.md 路径

**目的：** 允许项目将其 CLAUDE.md 存储在非根位置。`claude_md_path` 配置键控制 `/gsd-profile-user` 和相关命令写入生成的 CLAUDE.md 文件的位置。

**需求：**
- REQ-CMDPATH-01：`claude_md_path` 默认为 `./CLAUDE.md`
- REQ-CMDPATH-02：画像生成命令从配置读取路径并写入指定位置
- REQ-CMDPATH-03：相对路径从项目根路径解析

**配置：** `claude_md_path`

---

### 116. TDD 流水线模式

**目的：** 将 TDD（红-绿-重构）作为一等阶段执行模式选项启用。启用后，规划器积极地为符合条件的任务选择 `type: tdd`，执行器强制执行 RED/GREEN/REFACTOR 门控序列，并在 RED 之前出现意外的 GREEN 时快速失败。

**需求：**
- REQ-TDD-01：`workflow.tdd_mode` 配置键（布尔值，默认 `false`）
- REQ-TDD-02：启用后，规划器对所有符合条件的任务（业务逻辑、API、验证、算法、状态机）应用 `references/tdd.md` 中的 TDD 启发式方法
- REQ-TDD-03：执行器对 `type: tdd` 计划强制执行门控序列 — RED 提交（`test(...)`）必须在 GREEN 提交（`feat(...)`）之前
- REQ-TDD-04：在 RED 阶段测试意外通过时执行器快速失败（功能已存在或测试有误）
- REQ-TDD-05：阶段末协作审查检查点验证所有 TDD 计划的门控合规性（建议性，非阻塞）
- REQ-TDD-06：门控违规在 SUMMARY.md 的 `## TDD Gate Compliance` 节区中呈现

**配置：** `workflow.tdd_mode`
**参考文件：** `tdd.md`、`checkpoints.md`

---

## v1.37.0 功能

### 117. Spike 命令

**命令：** `/gsd-spike [idea] [--quick]`

**目的：** 在提交实现方案之前运行 2–5 个专注的可行性实验。每个实验使用 Given/When/Then 框架，生成可执行代码，并返回 VALIDATED / INVALIDATED / PARTIAL 判决。配套的 `/gsd-spike --wrap-up` 将发现结果打包为项目本地技能。

**需求：**
- REQ-SPIKE-01：在编写任何代码之前，每个实验必须生成 Given/When/Then 假设
- REQ-SPIKE-02：每个实验必须包含可运行的代码或最小化复现
- REQ-SPIKE-03：每个实验必须返回以下之一：带证据的 VALIDATED、INVALIDATED 或 PARTIAL 判决
- REQ-SPIKE-04：结果必须存储在 `.planning/spikes/NNN-experiment-name/` 中，附带 README 和 MANIFEST.md
- REQ-SPIKE-05：`--quick` 标志跳过摄入对话，使用参数文本作为实验方向
- REQ-SPIKE-06：`/gsd-spike --wrap-up` 必须将发现结果打包到 `.claude/skills/spike-findings-[project]/`

**产出物：**

| 构件 | 描述 |
|----------|-------------|
| `.planning/spikes/NNN-name/README.md` | 假设、实验代码、判决和证据 |
| `.planning/spikes/MANIFEST.md` | 所有 spike 的带判决索引 |
| `.claude/skills/spike-findings-[project]/` | 打包的发现结果（通过 `/gsd-spike --wrap-up`） |

---

### 118. Sketch 命令

**命令：** `/gsd-sketch [idea] [--quick] [--text]`

**目的：** 在提交实现之前通过一次性 HTML 模型探索设计方向。每个设计问题生成 2–3 个交互式变体，无需构建步骤即可直接在浏览器中查看。配套的 `/gsd-sketch --wrap-up` 将获胜决策打包为项目本地技能。

**需求：**
- REQ-SKETCH-01：每个 sketch 必须回答一个具体的视觉设计问题
- REQ-SKETCH-02：每个 sketch 必须在带标签导航的单个 `index.html` 中包含 2–3 个有意义的不同变体
- REQ-SKETCH-03：所有交互元素（悬停、点击、过渡）必须可正常运行
- REQ-SKETCH-04：Sketch 必须使用真实感内容，而非 lorem ipsum
- REQ-SKETCH-05：共享的 `themes/default.css` 必须提供根据商定美学调整的 CSS 变量
- REQ-SKETCH-06：`--quick` 标志跳过情绪采集；`--text` 标志用编号列表替换 `AskUserQuestion`，适用于非 Claude 运行时
- REQ-SKETCH-07：获胜变体必须在 README 前置元数据和 HTML 标签中用 ★ 标记
- REQ-SKETCH-08：`/gsd-sketch --wrap-up` 必须将获胜决策打包到 `.claude/skills/sketch-findings-[project]/`

**产出物：**
| 构件 | 描述 |
|----------|-------------|
| `.planning/sketches/NNN-name/index.html` | 2–3 个交互式 HTML 变体 |
| `.planning/sketches/NNN-name/README.md` | 设计问题、变体、获胜者、关注点 |
| `.planning/sketches/themes/default.css` | 共享 CSS 主题变量 |
| `.planning/sketches/MANIFEST.md` | 所有 sketch 的带获胜者索引 |
| `.claude/skills/sketch-findings-[project]/` | 打包的决策（通过 `/gsd-sketch --wrap-up`） |

---

### 119. 智能体大小预算强制

**目的：** 在 CI 中通过分级行数限制使智能体提示文件保持精简。超大智能体在投入生产膨胀上下文窗口之前被捕获。

**需求：**
- REQ-BUDGET-01：`agents/gsd-*.md` 文件分为三个层级：XL（≤ 1 600 行）、Large（≤ 1 000 行）、Default（≤ 500 行）
- REQ-BUDGET-02：层级分配在文件的 YAML 前置元数据中声明（`size: xl | large | default`）
- REQ-BUDGET-03：`tests/agent-size-budget.test.cjs` 强制执行限制，违规时 CI 失败
- REQ-BUDGET-04：没有 `size` 前置元数据键的文件默认为 Default（500 行）限制

**测试文件：** `tests/agent-size-budget.test.cjs`

---

### 120. 共享样板提取

**目的：** 通过将两个常见样板块提取到按需加载的共享参考文件中，减少智能体间的重复。使智能体文件保持在大小预算内，并使样板更新成为单文件更改。

**需求：**
- REQ-BOILER-01：强制初始读取指令提取到 `references/mandatory-initial-read.md`
- REQ-BOILER-02：项目技能发现指令提取到 `references/project-skills-discovery.md`
- REQ-BOILER-03：之前内联这些块的智能体现在必须通过 `@` required_reading 引用它们

**参考文件：** `references/mandatory-initial-read.md`、`references/project-skills-discovery.md`

---

### 121. 知识图谱集成

**目的：** 在 `.planning/graphs/` 中构建、查询和检查项目的轻量级知识图谱。按项目选项启用。作为 `/gsd-graphify` 用户界面命令和 `gsd-tools.cjs graphify …` 程序化动词族公开。通过图谱视图补充 `/gsd-map-codebase --query`（快照导向），覆盖命令、智能体、工作流和阶段的节点和边。

**需求：**
- REQ-GRAPH-01：通过 `.planning/config.json` 中的 `graphify.enabled: true` 选项启用。禁用时，`/gsd-graphify` 打印激活提示并停止，不写入任何内容。
- REQ-GRAPH-02：斜杠命令 `/gsd-graphify` 公开子命令 `build`、`query <term>`、`status`、`diff`。程序化 CLI `node gsd-tools.cjs graphify …` 额外公开 `snapshot`，也在 `graphify build` 的最后一步自动调用。
- REQ-GRAPH-03：Build 在可配置的 `graphify.build_timeout`（秒）内运行；超过超时时干净中止，不留下部分图谱。
- REQ-GRAPH-04：`graphify.cjs` 在 `graph.edges` 不存在时回退到 `graph.links`，以便旧图谱构件继续渲染。
- REQ-GRAPH-05：Graphify 通过 `gsd-tools.cjs graphify ...` 命令处理器调用。

**配置：** `graphify.enabled`、`graphify.build_timeout`
**参考文件：** `commands/gsd/graphify.md`、`bin/lib/graphify.cjs`

---

## v1.40.0 功能

### 122. 技能界面整合

**目的：** 通过将 31 个微技能折叠到 4 个新的分组父技能和 6 个现有父技能（作为标志吸收子操作）中来降低急切技能列表开销。零功能损失 — 每个删除的微技能的行为通过整合父技能上的标志保留。整合后，`commands/gsd/*.md` 包含 59 个子技能（加上 6 个命名空间元技能，见 #123）。

**需求：**
- REQ-CONSOLIDATE-01：四个新的分组技能替换微技能集群：
  - `/gsd-capture` — 折叠 add-todo（默认）、note（`--note`）、add-backlog（`--backlog`）、plant-seed（`--seed`）、check-todos（`--list`）
  - `/gsd-phase` — 折叠 add-phase（默认）、insert-phase（`--insert`）、remove-phase（`--remove`）、edit-phase（`--edit`）
  - `/gsd-config` — 折叠 settings-advanced（`--advanced`）、settings-integrations（`--integrations`）、set-profile（`--profile`）
  - `/gsd-workspace` — 折叠 new-workspace（`--new`）、list-workspaces（`--list`）、remove-workspace（`--remove`）
- REQ-CONSOLIDATE-02：六个现有父技能将 wrap-up / 子操作作为标志吸收：`/gsd-update --sync`、`/gsd-update --reapply`、`/gsd-sketch --wrap-up`、`/gsd-spike --wrap-up`、`/gsd-map-codebase --fast`、`/gsd-map-codebase --query`、`/gsd-code-review --fix`、`/gsd-progress --do`、`/gsd-progress --next`。
- REQ-CONSOLIDATE-03：删除的微技能斜杠形式（裸 `gsd-add-todo`、`gsd-add-backlog`、`gsd-plant-seed`、`gsd-check-todos`、`gsd-add-phase`、`gsd-insert-phase`、`gsd-remove-phase`、`gsd-edit-phase`、`gsd-new-workspace`、`gsd-list-workspaces`、`gsd-remove-workspace`、`gsd-settings-advanced`、`gsd-settings-integrations`、`gsd-set-profile`、`gsd-sketch-wrap-up`、`gsd-spike-wrap-up`、`gsd-reapply-patches`、`gsd-code-review-fix`、…）必须解析为"未知命令" — 无影子存根。
- REQ-CONSOLIDATE-04：`autonomous.md` 调用 `/gsd-code-review --fix`（之前调用已删除的 `gsd-code-review-fix`）。

**参考 issue：** [#2790](https://github.com/open-gsd/gsd-core/issues/2790)

---

### 123. 命名空间元技能（两阶段路由）

**目的：** 用两阶段层次路由层替换扁平的急切技能列表。模型看到 6 个命名空间路由器而不是 86 个条目，选择命名空间，然后路由到子技能。描述使用管道分隔的关键字标签（≤ 60 个字符）以获得路由密度。

**命令：**
- `/gsd-workflow` — 阶段流水线路由器（讨论/规划/执行/验证/阶段/进度）
- `/gsd-project` — 项目生命周期（里程碑、审计、摘要）
- `/gsd-quality` — 质量门控（代码审查、调试、审计、安全、评估、UI）
- `/gsd-context` — 代码库智能（映射、graphify、文档、学习）
- `/gsd-manage` — 配置/工作区/工作流/线程/更新/发布/收件箱
- `/gsd-ideate` — 探索与捕获（探索、sketch、spike、规范、捕获）

**Token 成本：**

| | 条目 | 大约 tokens |
|---|---|---|
| v1.40 之前完整安装 | 86 | ~2,150 |
| 命名空间元技能 | 6 | ~120 |

**需求：**
- REQ-NS-01：六个 `commands/gsd/ns-*.md` 命名空间路由器带管道分隔的关键字标签描述（≤ 60 个字符）。
- REQ-NS-02：现有子技能保持不变，仍可直接调用 — 命名空间技能是附加的，不是替换直接斜杠形式的。
- REQ-NS-03：每个命名空间路由器的正文包含一个路由表，将用户意图映射到 #2790 后整合界面上正确的具体子技能。

**参考 issue：** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)

---

### 124. 上下文窗口利用率守护

**命令：** `/gsd-health --context`

**目的：** 上下文窗口饱和的质量守护。两个阈值：60% 利用率警告（"考虑使用 `/gsd-thread`"），70% 为临界（"推理质量可能下降"；根据最近的上下文注意力研究，与断裂点匹配）。

**需求：**
- REQ-CTX-GUARD-01：`/gsd-health --context` 打印带当前利用率、阈值层级（`ok` / `warn` / `critical`）和补救建议的结构化状态行。
- REQ-CTX-GUARD-02：相同的分类以 `gsd-tools.cjs validate context --tokens-used <int> --context-window <int>` 公开 — 状态行和钩子调用者的结构化封装（#125）。两个标志都是必需的；处理器返回与 REQ-CTX-GUARD-03 中纯分类器相同的 `{ percent, state }` 封装。
- REQ-CTX-GUARD-03：分类器（`bin/lib/context-utilization.cjs`）是纯函数：输入 `(tokensUsed, contextWindow)`，输出 `{ percent, state }`。易于单元测试，易于从任何调用者重用。

**参考 issue：** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)

---

### 125. 阶段生命周期状态行读取侧

**目的：** 在状态行上呈现阶段编排状态。`parseStateMd()` 读取四个新的 STATE.md 前置元数据字段，`formatGsdState()` 渲染进行中、空闲和进度场景。写入侧连接将在后续 RC 中进行。

**需求：**
- REQ-LIFECYCLE-01：`parseStateMd()` 读取四个可选字段：
  - `active_phase` — 编排器运行时的阶段号
  - `next_action` — 空闲时的推荐下一命令
  - `next_phases` — 下一个阶段号的 YAML 流数组
  - `progress` — 嵌套的 `total_phases` / `completed_phases` / `percent` 块
- REQ-LIFECYCLE-02：`formatGsdState()` 按优先级检查生命周期字段并输出第一个匹配的场景（阶段激活 → 空闲下一推荐 → 里程碑完成 → 默认回退）。
- REQ-LIFECYCLE-03：所有四个字段默认为 undefined；现有 STATE.md 文件的渲染与字节相同。

**参考 issue：** [#2833](https://github.com/open-gsd/gsd-core/issues/2833) — 完整字段参考和渲染规则见 [`docs/STATE-MD-LIFECYCLE.md`](reference/state-md.md)。

---

## v1.41.0 功能

### 126. 按阶段类型选择模型

**目的：** 在阶段级别（规划、研究、执行、验证）表达模型调优，无需学习完整的智能体分类。位于每智能体 `model_overrides`（精确、冗长）和全局 `model_profile` 层级（粗粒度、统一）之间。

**配置键：** `.planning/config.json` 中的 `models`

**阶段类型槽位：**

| 槽位 | 分配的智能体 |
|------|-----------------|
| `planning` | `gsd-planner`、`gsd-roadmapper`、`gsd-pattern-mapper` |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | `gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-codebase-mapper`、`gsd-ui-researcher` |
| `execution` | `gsd-executor`、`gsd-debugger`、`gsd-doc-writer` |
| `verification` | `gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-nyquist-auditor`、`gsd-ui-checker`、`gsd-ui-auditor`、`gsd-doc-verifier`、`gsd-code-reviewer` |
| `completion` | （为未来子智能体保留） |

**接受的值：** `"opus"` / `"sonnet"` / `"haiku"` / `"inherit"`

**解析优先级（从高到低）：**

```text
1. model_overrides[<agent>]
2. dynamic_routing.tier_models[<tier>]   （启用时）
3. models[<phase_type>]                  （此功能）
4. model_profile
5. 运行时默认值
```

**需求：**
- REQ-PHASE-MODELS-01：`config-schema.cjs` 和 `config-schema.ts` 接受六个命名的 `models.*` 槽位；`config-set` 拒绝未知的阶段类型。
- REQ-PHASE-MODELS-02：没有 `models` 块的配置与 v1.41 之前的行为完全相同。
- REQ-PHASE-MODELS-03：`discuss` 和 `completion` 被 schema 接受以实现向前兼容性；今天设置它们是无操作，直到子智能体映射到每个。

**参考 issue：** [#3023](https://github.com/open-gsd/gsd-core/pull/3030)

---

### 127. 带失败层级升级的动态路由

**目的：** 默认使用低成本层级；当编排器检测到软失败（验证不确定、plan-check FLAG 等）时自动升级到更强大的模型。

**配置键：** `.planning/config.json` 中的 `dynamic_routing`

**行为：**
- `enabled: false`（默认）— 功能关闭；所有智能体使用优先级链不变。
- `enabled: true` — 解析器为第一次派生选择 `tier_models[default_tier]`，在编排器检测到软失败时升级一级，受 `max_escalations` 限制。

**组合：** `model_overrides` 始终优先；`dynamic_routing.tier_models[<tier>]` 解析高于 `models.<phase_type>` 和 `model_profile`。

**需求：**
- REQ-DYNROUTE-01：`dynamic_routing.enabled` 作为主开关；为 `false` 或块不存在时，零行为变化。
- REQ-DYNROUTE-02：`core.cjs` 中的新解析器 `resolveModelForTier(cwd, agent, attempt)` 是编排器集成的单个调用点。
- REQ-DYNROUTE-03：`max_escalations` 限制升级链，防止失控成本。

**参考 issue：** [#3024](https://github.com/open-gsd/gsd-core/pull/3031)

---

### 128. 更新横幅选项

**目的：** 向已拒绝或绕过 GSD 状态行的用户呈现更新可用性，无需状态行。

**行为：**
- 安装时，如果安装器检测到没有 GSD 状态行，它提供一个选项 `SessionStart` 钩子。
- 钩子读取现有的 `~/.cache/gsd/gsd-update-check.json` 缓存 — 与状态行使用的相同缓存 — 仅在有可用更新时打印横幅。
- 无更新时保持静默。
- 失败诊断每 24 小时限流一次。
- 通过 `npx @opengsd/gsd-core --uninstall` 干净移除。

**需求：**
- REQ-BANNER-01：横幅不在没有明确选项的情况下安装。
- REQ-BANNER-02：无额外网络请求 — 重用现有的后台更新检查缓存。
- REQ-BANNER-03：卸载路径删除横幅钩子。

**参考 issue：** [#2795](https://github.com/open-gsd/gsd-core/pull/2795)

---

### 129. Issue 驱动编排指南

**目的：** 记录从 GitHub / Linear / Jira issue 驱动完整 GSD 工作流的方法，将跟踪器中心概念映射到现有 GSD 原语。

**文档：** [`docs/issue-driven-orchestration.md`](issue-driven-orchestration.md)

**覆盖的工作流：**
1. 为每个 issue 创建隔离的工作区（`/gsd-workspace --new`）
2. 运行管理仪表板以了解情况（`/gsd-manager`）
3. 自主执行（`/gsd-autonomous`）
4. 验证和审查（`/gsd-verify-work`、`/gsd-review`）
5. 发布并关闭 issue（`/gsd-ship`）

无新命令或守护进程 — 纯粹是将现有原语映射到跟踪器驱动工作流的文档构件。

**参考 issue：** [#2840](https://github.com/open-gsd/gsd-core/pull/2840)

---

### 130. Graphify 基于提交的过期检测

**目的：** 呈现架构图是从当前提交还是旧提交构建的，补充现有的基于 mtime 的过期信号。

**命令：** `/gsd-graphify status`

**返回的新字段（graphify v0.7+ 图谱）：**

| 字段 | 类型 | 描述 |
|-------|------|-------------|
| `built_at_commit` | string | 构建图谱的提交 SHA |
| `current_commit` | string | 当前 `git HEAD` |
| `commits_behind` | number | 图谱落后 HEAD 多少个提交 |
| `commit_stale` | boolean \| null | `true`=过期，`false`=最新，`null`=不可用（v0.7 之前，非 git） |

**渲染输出（当信号可用时）：**
```
Source commit: abc1234 (3 commits behind HEAD)
```

**安全性：** `built_at_commit` 在到达 `git` 之前被验证为 4–40 个十六进制字符 — 恶意的 `graph.json` 无法向 argv 注入破折号选项。

**回退：** v0.7 之前的图谱和非 git 检出返回 `commit_stale: null`；调用者回退到现有的基于 mtime 的 `stale` 标志。现有用户无行为变化。

**参考 issue：** [#3170](https://github.com/open-gsd/gsd-core/issues/3170)

---

## v1.42.1 功能

### 132. 包合法性门控

**目的：** 在被幻觉产生、可疑或 slopsquatting 的包名到达 shell 安装命令之前将其阻止。

**行为：**
- 阶段研究为推荐的包编写 `## Package Legitimacy Audit` 表格。
- 仅通过搜索验证的包被视为 `[ASSUMED]`，而不是可信的。
- `[SLOP]` 包从推荐中删除。
- 需要 `[ASSUMED]` 或可疑包的计划添加人工验证检查点。
- 执行器安装失败会暂停进行人工验证，而不是自动尝试类似命名的包。

**需求：**
- REQ-PKG-GATE-01：研究必须记录包注册表、年龄、下载/来源信号、slopcheck 判决和处置。
- REQ-PKG-GATE-02：规划器必须在执行前门控未验证或可疑的包安装。
- REQ-PKG-GATE-03：执行器在包管理器安装失败后不得自动替换包名。

**参考：** [v1.42.1 发布说明](../RELEASE-v1.42.1.md)

---

### 133. 技能界面预算

**目的：** 让用户在上下文预算重要时减少已安装的技能和智能体界面面积。

**安装配置文件：**
| 配置文件 | 目的 |
|---------|---------|
| `core` | 最小主循环界面 |
| `standard` | 核心加常用阶段管理命令 |
| `full` | 完整界面；默认 |

**运行时控制：** `/gsd:surface` 列出配置文件状态，无需重新安装即可启用、禁用或重置技能集群。

**需求：**
- REQ-SURFACE-01：安装器必须解析 `--profile=<name>` 并将活跃配置文件持久化在 `.gsd-profile` 中。
- REQ-SURFACE-02：`--minimal` 和 `--core-only` 必须保持为 `--profile=core` 的别名。
- REQ-SURFACE-03：运行时界面状态必须在安装配置文件标记之外持久化。

**参考：** [ADR-0011](../adr/0011-skill-surface-budget-module.md)

---

### 134. 安装迁移

**目的：** 在安装和更新期间使运行时配置清理变得明确、可审计且具有回滚意识。

**能力：**
- 首次基线迁移记录管理的文件。
- 旧版过期文件清理在删除或重写之前使用所有权证据。
- 用户拥有的构件被保留。
- 模糊的 GSD 风格文件通过清晰的报告阻止，而不是被静默覆盖。
- 迁移计划支持演习报告和回滚保护。

**需求：**
- REQ-INSTALL-MIGRATION-01：迁移记录必须包含元数据、安装范围和所有权证据。
- REQ-INSTALL-MIGRATION-02：所有权模糊时，破坏性操作必须封闭失败。
- REQ-INSTALL-MIGRATION-03：安装失败时，如果存在回滚数据，必须恢复预安装状态。

**参考：** [安装迁移](../installer-migrations.md)

---

### 135. 自定义 Ship PR 正文节区

**命令：** `/gsd-ship`

**配置键：** `ship.pr_body_sections`

**目的：** 在不编辑 GSD 工作流文件的情况下，将项目特定的 PRD 风格节区添加到生成的 PR 正文中。

**行为：** 配置的节区追加在必需的 `Summary`、`Changes`、`Requirements Addressed`、`Verification` 和 `Key Decisions` 节区之后。它们可以从构件标题复制、渲染模板或回退到静态文本。

**需求：**
- REQ-SHIP-SECTIONS-01：自定义节区不得替换、删除或重新排序必需的 PR 节区。
- REQ-SHIP-SECTIONS-02：配置验证必须拒绝未知的模板标记。
- REQ-SHIP-SECTIONS-03：禁用的节区必须保留在配置中而不出现在 PR 输出中。

**参考：** [自定义 PR 正文节区](../ship-pr-body-sections.md)

---

### 136. 评审默认审查者

**命令：** `/gsd-review`

**配置键：** `review.default_reviewers`

**目的：** 让团队为无标志 `/gsd-review` 运行选择默认的审查者子集。

**优先级：**
```text
explicit reviewer flags -> --all -> review.default_reviewers -> all detected reviewers
```

**需求：**
- REQ-REVIEW-DEFAULTS-01：缺少 `review.default_reviewers` 必须保留之前的全部检测行为。
- REQ-REVIEW-DEFAULTS-02：空数组必须被拒绝；删除该键以恢复全部检测行为。
- REQ-REVIEW-DEFAULTS-03：已知但不可用的审查者必须在诊断中跳过，而不是硬失败运行。

**参考：** [配置参考](CONFIGURATION.md#reviewer-defaults-for-gsd-review)

---

### 137. Fallow 结构性审查预处理

**命令：** `/gsd-code-review`

**配置键：** `code_quality.fallow.*`

**目的：** 在智能体审查之前添加可选的结构性分析遍历。

**行为：** 启用后，GSD 解析 `fallow` 二进制文件，运行有界审计，写入 `FALLOW.json`，并将结构性发现嵌入 `REVIEW.md`。

**需求：**
- REQ-FALLOW-01：Fallow 必须是选项，默认禁用。
- REQ-FALLOW-02：缺少或失败的 fallow 运行必须产生清晰的诊断。
- REQ-FALLOW-03：大于嵌入预算的发现必须在警告的情况下跳过，保留原始 JSON 构件。

**参考：** [配置参考](CONFIGURATION.md#code-quality-settings)

---

### 138. 阶段末人工验证模式

**配置键：** `workflow.human_verify_mode`

**目的：** 在保留人工验证要求的同时减少飞行中的人工检查点中断。

**行为：** 默认的 `"end-of-phase"` 模式将人工检查嵌入 `<verify><human-check>` 块用于阶段审查。`"mid-flight"` 恢复阻塞的 `checkpoint:human-verify` 任务。

**需求：**
- REQ-HUMAN-VERIFY-01：`checkpoint:decision` 和 `checkpoint:human-action` 无论模式如何都必须保持阻塞。
- REQ-HUMAN-VERIFY-02：人工需要的验证必须保持待处理，直到阶段末审查解决。
- REQ-HUMAN-VERIFY-03：没有该键的配置必须使用 `"end-of-phase"`。

**参考：** [检查点参考](../../gsd-core/references/checkpoints.md)

---

### 139. 配额与速率限制失败分类

**命令：** `/gsd-execute-phase`

**目的：** 将提供商配额和速率限制失败视为等待并恢复的条件，而不是正常的执行器失败。

**行为：** 智能体输出被分类为诸如 `429`、`rate limit`、`usage limit`、`RESOURCE_EXHAUSTED` 和 `usage_limit_reached` 等信号。匹配的失败呈现等待重置的恢复路径。

**需求：**
- REQ-QUOTA-01：配额失败不得将立即重试作为主要恢复选项。
- REQ-QUOTA-02：分类必须涵盖 Claude、Copilot、Codex、Gemini 和通用提供商哨兵。
- REQ-QUOTA-03：非配额失败必须继续通过正常的执行失败路径。

**参考：** [提供商速率限制信号](../research/provider-rate-limit-signals.md)

---

### 140. 状态栏上下文位置

**配置键：** `statusline.context_position`

**目的：** 在窄终端中保持上下文计量器可见。

**选项：**
| 值 | 行为 |
|-------|----------|
| `"end"` | 默认；在行尾附近渲染上下文计量器 |
| `"front"` | 在模型名称之后立即渲染上下文计量器 |

**需求：**
- REQ-STATUSLINE-POS-01：无效值必须被配置验证拒绝。
- REQ-STATUSLINE-POS-02：缺少配置必须保留现有的末尾位置渲染。

**参考：** [配置参考](CONFIGURATION.md#statusline-settings)

---

### 141. 里程碑标签创建开关

**命令：** `/gsd-complete-milestone`

**配置键：** `git.create_tag`

**目的：** 让具有外部发布自动化的项目在不创建本地 git 标签的情况下完成里程碑。

**行为：** `git.create_tag: false` 跳过里程碑标签创建。工作流仍然更新里程碑构件和状态。

**需求：**
- REQ-MILESTONE-TAG-01：缺少配置必须保留自动标签创建。
- REQ-MILESTONE-TAG-02：现有标签冲突必须清晰地失败，而不是覆盖标签。
- REQ-MILESTONE-TAG-03：禁用标签创建不得跳过里程碑归档。

**参考：** [配置参考](CONFIGURATION.md#git-branching)

---

### 142. 结构化 JSON 错误模式

**CLI：** `gsd-tools --json-errors`

**目的：** 为自动化调用者提供稳定的机器可读错误封装。

**行为：** 在 `--json-errors` 下失败的命令返回带错误类型、消息、命令上下文和退出映射的结构化 `ok: false` 有效负载，而不是仅有散文的 stderr。

**需求：**
- REQ-JSON-ERRORS-01：未知命令、验证错误、超时、原生失败、回退失败和内部错误必须映射到规范的错误类型。
- REQ-JSON-ERRORS-02：CLI 退出代码映射对于自动化调用者必须保持稳定。
- REQ-JSON-ERRORS-03：缺少 `--json-errors` 时，人类可读的输出必须保持为默认值。

---

## 相关文档

- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [文档索引](README.md)

**参考：** [JSON 错误模式](../json-errors.md)
