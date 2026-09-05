# GSD CLI 工具参考

> `gsd-tools` CLI（`gsd-core/bin/gsd-tools.cjs`）参考文档。斜杠命令与用户流程请参见[命令参考](COMMANDS.md)。返回[文档索引](README.md)。

---

## 概述

`gsd-tools.cjs` 集中处理配置解析、模型解析、阶段查找、Git 提交、摘要验证、状态管理以及模板操作，供 GSD 命令、工作流和代理使用。


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **发布路径**   | `gsd-core/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **实现**       | `gsd-core/bin/lib/` 下的 20 个领域模块（以该目录为准）                                                                                                                                              |
| **状态**       | 编排、工作流和自动化的主要运行时命令接口。 |


**用法（CJS）：**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**全局标志（CJS）：**


| 标志           | 说明                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `--raw`        | 机器可读输出（JSON 或纯文本，无格式）                  |
| `--cwd <path>` | 覆盖工作目录（用于沙箱子代理）                         |
| `--ws <name>`  | `.planning/workstreams/<name>` 路径的工作流上下文 |


---

## 状态命令

管理 `.planning/STATE.md`——项目的活动记忆。

```bash
# 以 JSON 格式加载完整项目配置和状态
node gsd-tools.cjs state load

# 以 JSON 格式输出 STATE.md frontmatter
node gsd-tools.cjs state json

# 更新单个字段
node gsd-tools.cjs state update <field> <value>

# 获取 STATE.md 内容或特定章节
node gsd-tools.cjs state get [section]

# 批量更新多个字段
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# 递增计划计数器
node gsd-tools.cjs state advance-plan

# 记录执行指标
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# 重新计算进度条
node gsd-tools.cjs state update-progress

# 添加决策
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# 或从文件读取：
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]

# 添加/解决阻塞项
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state resolve-blocker --text "..."

# 记录会话连续性
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path]

# 阶段开始——为新阶段更新 STATE.md 的状态/最后活动
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# 代理可发现的阻塞信号（由 discuss-phase / UI 流程使用）
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

### 状态快照

对完整 STATE.md 进行结构化解析：

```bash
node gsd-tools.cjs state-snapshot
```

返回 JSON，包含：当前位置、阶段、计划、状态、决策、阻塞项、指标、最后活动。

---

## 阶段命令

管理阶段——目录、编号和路线图同步。

```bash
# 按编号查找阶段目录
node gsd-tools.cjs find-phase <phase>

# 计算插入用的下一个小数阶段编号
node gsd-tools.cjs phase next-decimal <phase>

# 向路线图追加新阶段并创建目录
node gsd-tools.cjs phase add <description>

# 在现有阶段后插入小数阶段
node gsd-tools.cjs phase insert <after> <description>

# 移除阶段，对后续阶段重新编号
node gsd-tools.cjs phase remove <phase> [--force]

# 标记阶段完成，更新状态和路线图
node gsd-tools.cjs phase complete <phase>

# 按波次和状态索引计划
node gsd-tools.cjs phase-plan-index <phase>

# 列出阶段并过滤
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]
```

---

## 路线图命令

解析和更新 `ROADMAP.md`。

```bash
# 从 ROADMAP.md 提取阶段章节
node gsd-tools.cjs roadmap get-phase <phase>

# 带磁盘状态的完整路线图解析
node gsd-tools.cjs roadmap analyze

# 从磁盘更新进度表行
node gsd-tools.cjs roadmap update-plan-progress <N>
```

---

## 配置命令

读写 `.planning/config.json`。

```bash
# 以默认值初始化 config.json
node gsd-tools.cjs config-ensure-section

# 设置配置值（点号表示法）
node gsd-tools.cjs config-set <key> <value>

# 获取配置值
node gsd-tools.cjs config-get <key>

# 设置模型配置文件
node gsd-tools.cjs config-set-model-profile <profile>
```

---

## 模型解析

```bash
# 根据当前配置文件获取代理使用的模型
node gsd-tools.cjs resolve-model <agent-name>
# 原始输出返回所选模型 ID/层级。
# JSON 输出还包括配置文件，以及当活跃运行时支持时的
# reasoning_effort。
```

代理名称：`gsd-planner`、`gsd-executor`、`gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-roadmapper`、`gsd-debugger`、`gsd-codebase-mapper`、`gsd-nyquist-auditor`

---

## 验证命令

验证计划、阶段、引用和提交。

```bash
# 验证 SUMMARY.md 文件
node gsd-tools.cjs verify-summary <path> [--check-count N]

# 检查 PLAN.md 结构和任务
node gsd-tools.cjs verify plan-structure <file>

# 检查所有计划是否有摘要
node gsd-tools.cjs verify phase-completeness <phase>

# 检查 @-引用和路径是否可解析
node gsd-tools.cjs verify references <file>

# 批量验证提交哈希
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# 检查 must_haves.artifacts
node gsd-tools.cjs verify artifacts <plan-file>

# 检查 must_haves.key_links
node gsd-tools.cjs verify key-links <plan-file>
```

---

## 校验命令

检查项目完整性。

```bash
# 检查阶段编号、磁盘/路线图同步
node gsd-tools.cjs validate consistency

# 检查 .planning/ 完整性，可选修复
node gsd-tools.cjs validate health [--repair]

# 探测上下文窗口利用率（用于状态行/钩子调用方）（v1.40.0）
node gsd-tools.cjs validate context

# 以类型化 JSON 接口输出上下文利用率（#455）
node gsd-tools.cjs validate context --json
```

`validate context` 输出包含 `utilization`、`status`（在 60% / 70% 阈值处分别为 `ok` / `warn` / `critical`）以及 `suggestion` 字符串的结构化信封。相同数据支撑 `/gsd-health --context`。
传入 `--json` 可直接接收类型化中间表示（适用于脚本和测试断言）。

---

## 模板命令

模板选择与填充。

```bash
# 根据粒度选择摘要模板
node gsd-tools.cjs template select <type>

# 用变量填充模板
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

`fill` 的模板类型：`summary`、`plan`、`verification`

---

## Frontmatter 命令

对任意 Markdown 文件执行 YAML frontmatter 的增删改查。

```bash
# 以 JSON 格式提取 frontmatter
node gsd-tools.cjs frontmatter get <file> [--field key]

# 更新单个字段
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# 将 JSON 合并到 frontmatter
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# 验证必填字段
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## 脚手架命令

创建预结构化文件和目录。

```bash
# 创建 CONTEXT.md 模板
node gsd-tools.cjs scaffold context --phase N

# 创建 UAT.md 模板
node gsd-tools.cjs scaffold uat --phase N

# 创建 VERIFICATION.md 模板
node gsd-tools.cjs scaffold verification --phase N

# 创建阶段目录
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

---

## Init 命令（复合上下文加载）

通过单次调用加载特定工作流所需的所有上下文。返回包含项目信息、配置、状态和工作流专属数据的 JSON。`init onboard [--fast] [--text]` 会为 `/gsd-onboard` 返回 brownfield 信号、planning 文档候选、代码库映射完整性、fast 映射就绪状态、文本模式路由、部分 planning 状态和 onboarding summary 状态。

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init onboard [--fast] [--text]
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress

# 工作流范围的 init（`--ws` 标志）
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**大载荷处理：** 当输出超过约 50KB 时，CLI 会将内容写入临时文件并返回 `@file:/tmp/gsd-init-XXXXX.json`。工作流检查 `@file:` 前缀并从磁盘读取：

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## 里程碑命令

```bash
# 归档里程碑
node gsd-tools.cjs milestone complete <version> (--confirm | --dry-run) [--name <name>] [--no-archive-phases] [--force] [--archive-quick]

# 将需求标记为完成
node gsd-tools.cjs requirements mark-complete <ids>
# 接受格式：REQ-01,REQ-02 或 REQ-01 REQ-02 或 [REQ-01, REQ-02]
```

---

## 代理技能

输出指定代理类型的技能块。

```bash
# 输出原始 XML 技能块（默认——适合 shell 展开）
node gsd-tools.cjs agent-skills <agent-type>

# 输出类型化 JSON 接口（#455）——{ agent_type, block, skills_count }
node gsd-tools.cjs agent-skills <agent-type> --json
```

`--json` 标志返回适合结构化消费和测试断言的类型化中间表示对象，而默认（无标志）保留工作流 shell 展开所依赖的原始 XML 输出。

---

## 技能清单

预计算并缓存技能发现结果，以加快命令加载速度。

```bash
# 生成技能清单（写入 .claude/skill-manifest.json）
node gsd-tools.cjs skill-manifest

# 生成并指定自定义输出路径
node gsd-tools.cjs skill-manifest --output <path>
```

返回所有可用 GSD 技能的 JSON 映射，包含其元数据（名称、描述、文件路径、参数提示）。由安装程序和会话启动钩子使用，以避免重复的文件系统扫描。

---

## 工具命令

```bash
# 将文本转换为 URL 安全的 slug
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# 获取时间戳
node gsd-tools.cjs current-timestamp [full|date|filename]

# 统计并列出待办事项
node gsd-tools.cjs list-todos [area]

# 检查文件/目录是否存在
node gsd-tools.cjs verify-path-exists <path>

# 聚合所有 SUMMARY.md 数据
node gsd-tools.cjs history-digest

# 从 SUMMARY.md 提取结构化数据
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# 项目统计
node gsd-tools.cjs stats [json|table]

# 进度渲染（人类可读）
node gsd-tools.cjs progress [json|table|bar]

# 以类型化 JSON 接口输出进度（#455）
node gsd-tools.cjs progress --json

# 完成待办事项
node gsd-tools.cjs todo complete <filename> [--dry-run]

# UAT 审计——扫描所有阶段的未解决事项
node gsd-tools.cjs audit-uat

# 跨制品审计队列——扫描 `.planning/` 中未解决的审计事项
node gsd-tools.cjs audit-open [--json]

# 将 GSD-2 项目反向迁移到当前结构（支撑 `/gsd-import --from-gsd2`）
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# 带配置检查的 Git 提交
node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]
```

> `--no-verify`：跳过预提交钩子。由并行执行器代理在基于波次的执行过程中使用，以避免构建锁争用（例如 Rust 项目中的 cargo lock 冲突）。编排器在每个波次完成后运行一次钩子。顺序执行时不要使用 `--no-verify`——让钩子正常运行。
> `--files <paths>` **暂存行为**：默认情况下，`--files` 在提交前对每个命名文件运行 `git add -- <path>`。这会覆盖通过 `git add -p` 设置的任何按块暂存。传入 `--respect-staged` 可跳过 `git add` 步骤，仅提交已在索引中且在请求路径规格内的内容。如果该范围内没有已暂存的内容，命令将返回 `{ committed: false, reason: 'nothing staged' }` 而不报错。两种模式下提交都会附加 `-- <paths>` 路径规格，因此 `--files` 范围之外已暂存的文件永远不会被包含（#3061 不变量）。

# 网页搜索（需要 Brave API 密钥）
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Graphify

在 `.planning/graphs/` 中构建、查询和检查项目知识图谱。需要在 `config.json` 中设置 `graphify.enabled: true`（参见[配置参考](CONFIGURATION.md#graphify-settings)）。

```bash
# 构建或重建知识图谱
node gsd-tools.cjs graphify build

# 在图谱中搜索某个词
node gsd-tools.cjs graphify query <term>

# 显示图谱新鲜度和统计数据
node gsd-tools.cjs graphify status

# 显示自上次构建以来的变更
node gsd-tools.cjs graphify diff

# 写入当前图谱的命名快照
node gsd-tools.cjs graphify snapshot [name]
```

用户入口：`/gsd-graphify`（参见[命令参考](COMMANDS.md#gsd-graphify)）。

---

## 模块架构

| 模块 | 文件 | 导出 |
|--------|------|---------|
| 核心 | `lib/core.cjs` | `error()`、`output()`、`parseArgs()`、共享工具、兼容性重导出 |
| 状态 | `lib/state.cjs` | 所有 `state` 子命令、`state-snapshot` |
| 阶段 | `lib/phase.cjs` | 阶段增删改查、`find-phase`、`phase-plan-index`、`phases list` |
| 规划工作区 | `lib/planning-workspace.cjs` | 规划接缝：`planningDir`、`planningPaths`、活跃工作流路由、`.planning/.lock` |
| 路线图 | `lib/roadmap.cjs` | 路线图解析、阶段提取、进度更新 |
| 配置 | `lib/config.cjs` | 配置读写、章节初始化 |
| 验证 | `lib/verify.cjs` | 所有验证和校验命令 |
| 模板 | `lib/template.cjs` | 模板选择和变量填充 |
| Frontmatter | `lib/frontmatter.cjs` | YAML frontmatter 增删改查 |
| Init | `lib/init.cjs` | 所有工作流的复合上下文加载 |
| 里程碑 | `lib/milestone.cjs` | 里程碑归档、需求标记 |
| 命令 | `lib/commands.cjs` | 杂项：slug、时间戳、待办事项、脚手架、统计、网页搜索 |
| 模型配置文件 | `lib/model-profiles.cjs` | 配置文件解析表 |
| UAT | `lib/uat.cjs` | 跨阶段 UAT/验证审计 |
| 配置文件输出 | `lib/profile-output.cjs` | 开发者配置文件格式化 |
| 配置文件流水线 | `lib/profile-pipeline.cjs` | 会话分析流水线 |
| Graphify | `lib/graphify.cjs` | 知识图谱构建/查询/状态/差异/快照（支撑 `/gsd-graphify`） |
| 学习记录 | `lib/learnings.cjs` | 从阶段/SUMMARY 制品中提取学习记录（支撑 `/gsd-extract-learnings`） |
| 审计 | `lib/audit.cjs` | 阶段/里程碑审计队列处理器；`audit-open` 助手 |
| GSD2 导入 | `lib/gsd2-import.cjs` | 从 GSD-2 项目反向迁移导入（支撑 `/gsd-import --from-gsd2`） |
| Intel | `lib/intel.cjs` | 可查询的代码库智能索引（支撑 `/gsd-map-codebase --query`） |

---

## 审阅器 CLI 路由

`review.models.<cli>` 将审阅器类型映射到代码审查工作流调用的 shell 命令。通过 [`/gsd-config --integrations`](COMMANDS.md#gsd-config) 或直接设置：

```bash
node gsd-tools.cjs config-set review.models.codex    "codex exec --model gpt-5"
node gsd-tools.cjs config-set review.models.gemini   "gemini -m gemini-2.5-pro"
node gsd-tools.cjs config-set review.models.opencode "opencode run --model claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # 清除——回退到会话模型
```

Slug 将针对 `[a-zA-Z0-9_-]+` 进行验证；空或包含路径的 slug 将被拒绝。完整字段参考请参见 [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing)。

## 密钥处理

通过 `/gsd-settings` 配置的 API 密钥（`brave_search`、`firecrawl`、`exa_search`）以明文形式写入 `.planning/config.json`，但在所有 `config-set` / `config-get` 输出、确认表格和交互式提示中均会被遮蔽（`****<last-4>`）。遮蔽实现请参见 `gsd-core/bin/lib/secrets.cjs`。`config.json` 文件本身是安全边界——请通过文件系统权限保护它，并将其排除在 git 之外（`.planning/` 默认已被 gitignore）。

---

## 相关文档

- [命令](COMMANDS.md)
- [配置](CONFIGURATION.md)
- [架构](ARCHITECTURE.md)
- [文档索引](README.md)
