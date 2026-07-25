# GSD 配置参考

`.planning/config.json` 的完整 schema 参考。有关设置向导和任务操作指南，请参阅[文档索引](README.md)。

> 完整配置 schema、工作流开关、模型配置文件及 git 分支选项。有关功能背景，请参阅[功能参考](FEATURES.md)。

---

## 配置文件

GSD 将项目设置存储在 `.planning/config.json` 中。该文件在 `/gsd-new-project` 时创建，通过 `/gsd-settings` 更新。

### 完整 Schema

```json
{
  "mode": "interactive",
  "granularity": "standard",
  "model_profile": "balanced",
  "model_overrides": {},
  "models": {},
  "dynamic_routing": null,
  "planning": {
    "commit_docs": true,
    "search_gitignored": false,
    "sub_repos": []
  },
  "context": null,
  "workflow": {
    "research": true,
    "plan_check": true,
    "verifier": true,
    "auto_advance": false,
    "nyquist_validation": true,
    "ui_phase": true,
    "ui_safety_gate": true,
    "ui_review": true,
    "node_repair": true,
    "node_repair_budget": 2,
    "research_before_questions": false,
    "discuss_mode": "discuss",
    "max_discuss_passes": 3,
    "skip_discuss": false,
    "human_verify_mode": "end-of-phase",
    "tdd_mode": false,
    "text_mode": false,
    "use_worktrees": true,
    "code_review": true,
    "code_review_depth": "standard",
    "plan_bounce": false,
    "plan_bounce_script": null,
    "plan_bounce_passes": 2,
    "plan_chunked": false,
    "code_review_command": null,
    "cross_ai_execution": false,
    "cross_ai_command": null,
    "cross_ai_timeout": 300,
    "security_enforcement": true,
    "security_asvs_level": 1,
    "security_block_on": "high",
    "post_planning_gaps": true,
    "build_command": null,
    "test_command": null
  },
  "code_quality": {
    "fallow": {
      "enabled": false,
      "scope": "phase",
      "profile": "standard",
      "mcp": false
    }
  },
  "ship": {
    "pr_body_sections": []
  },
  "hooks": {
    "context_warnings": true,
    "workflow_guard": false
  },
  "statusline": {
    "context_position": "end"
  },
  "review": {
    "default_reviewers": null,
    "models": {}
  },
  "parallelization": {
    "enabled": true,
    "plan_level": true,
    "task_level": false,
    "skip_checkpoints": true,
    "max_concurrent_agents": 3,
    "min_plans_for_parallel": 2
  },
  "git": {
    "branching_strategy": "none",
    "create_tag": true,
    "phase_branch_template": "gsd/phase-{phase}-{slug}",
    "milestone_branch_template": "gsd/{milestone}-{slug}",
    "quick_branch_template": null
  },
  "gates": {
    "confirm_project": true,
    "confirm_phases": true,
    "confirm_roadmap": true,
    "confirm_breakdown": true,
    "confirm_plan": true,
    "execute_next_plan": true,
    "issues_review": true,
    "confirm_transition": true
  },
  "safety": {
    "always_confirm_destructive": true,
    "always_confirm_external_services": true
  },
  "project_code": null,
  "agent_skills": {},
  "response_language": null,
  "features": {
    "thinking_partner": false,
    "global_learnings": false
  },
  "learnings": {
    "max_inject": 10
  },
  "intel": {
    "enabled": false
  },
  "claude_md_path": "./CLAUDE.md"
}
```

---

## 核心设置

| 设置 | 类型 | 可选值 | 默认值 | 描述 |
|---------|------|---------|---------|-------------|
| `mode` | enum | `interactive`, `yolo` | `interactive` | `yolo` 自动批准决策；`interactive` 在每个步骤进行确认 |
| `granularity` | enum | `coarse`, `standard`, `fine` | `standard` | 控制阶段数量：`coarse`（3-5 个）、`standard`（5-8 个）、`fine`（8-12 个） |
| `model_profile` | enum | `quality`, `balanced`, `budget`, `adaptive`, `inherit` | `balanced` | 每个 agent 的模型层级（参见[模型配置文件](#模型配置文件)）。`adaptive` 根据 [#1713](https://github.com/open-gsd/gsd-core/issues/1713) / [#1806](https://github.com/open-gsd/gsd-core/issues/1806) 添加，在运行时感知的配置文件下与其他层级以相同方式解析。 |
| `runtime` | string | `claude`, `codex` 或任意字符串 | （无） | [运行时感知配置文件解析](#运行时感知配置文件-2517)的活跃运行时。设置后，配置文件层级（opus/sonnet/haiku）解析为运行时原生模型 ID。目前仅 Codex 安装路径通过此解析器为每个 agent 生成模型 ID；其他运行时（`opencode`、`gemini`、`qwen`、`copilot` 等）在 spawn 时消费该解析器，并在 [#2612](https://github.com/open-gsd/gsd-core/issues/2612) 中获得专用安装路径支持。未设置时（默认），行为与之前版本相同。v1.39 新增 |
| `model_profile_overrides.<runtime>.<tier>` | string \| object | 按运行时的层级覆盖 | （无） | 覆盖特定 `(runtime, tier)` 的运行时感知层级映射。层级为 `opus`、`sonnet`、`haiku` 之一。值为模型 ID 字符串（如 `"gpt-5-pro"`）或 `{ model, reasoning_effort }`。参见[运行时感知配置文件](#运行时感知配置文件-2517)。v1.39 新增 |
| `model_policy.provider` | string | `openai`, `anthropic`, `anthropic-fable`, `google`, `qwen`, `generic` | （无） | 声明模型提供商。已知提供商（`openai`、`anthropic`、`anthropic-fable`、`google`、`qwen`）启用基于目录的预设。`generic` 将所有模型 ID 视为不透明字符串——无前缀推断，无推理努力默认值。`model_policy.runtime_tiers` 在旧版 `model_profile_overrides` 之前解析。参见[模型策略预设](#模型策略预设-model_policy--v142-新增)。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.budget` | enum | `high`, `medium`, `low` | （无） | 使用已知提供商时选择预算层级。GSD 在解析时将匹配的目录预设具体化为显式层级映射。当 `provider` 为 `generic` 或 `custom` 时忽略。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.high` | string | 模型 ID | （无） | `generic`/`custom` 提供商的高成本层级模型 ID。当 `provider: "generic"` 或 `"custom"` 时使用。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.medium` | string | 模型 ID | （无） | `generic`/`custom` 提供商的中等成本层级模型 ID。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.low` | string | 模型 ID | （无） | `generic`/`custom` 提供商的低成本层级模型 ID。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `model_policy.runtime_tiers.<runtime>.<tier>` | object | `{ model, reasoning_effort? }` | （无） | 按运行时、按层级的显式模型条目。`tier` 为 `opus`、`sonnet`、`haiku` 之一（与现有配置文件层级名称匹配）。`reasoning_effort` 仅转发给支持它的运行时；不支持的运行时不会接收该字段。优先级高于 `model_profile_overrides`。v1.42 新增（[#49](https://github.com/open-gsd/gsd-core/issues/49)） |
| `models.<phase_type>` | enum | `opus`, `sonnet`, `haiku`, `inherit` | （无） | 按阶段类型的模型层级。六个可接受的槽位：`planning`、`discuss`、`research`、`execution`、`verification`、`completion`。允许在阶段级别调整（"规划用 Opus，其余用 Sonnet"），而无需了解 agent 名称。解析优先级在 `model_overrides`（更高）和 `model_profile`（更低）之间；参见[按阶段类型的模型](#按阶段类型的模型-models--v140-新增)。v1.40 新增（[#3023](https://github.com/open-gsd/gsd-core/pull/3030)） |
| `dynamic_routing.enabled` | boolean | `true`, `false` | `false` | [动态路由与失败层级升级](#动态路由与失败层级升级-dynamic_routing--v140-新增)的主开关。为 `true` 时，agent 解析为 `tier_models[default_tier]`，并在编排器检测到软性失败时升级一个层级。v1.40 新增（[#3024](https://github.com/open-gsd/gsd-core/pull/3031)） |
| `dynamic_routing.tier_models.<tier>` | enum | `opus`, `sonnet`, `haiku` | （无） | `light`、`standard` 或 `heavy` 的层级别名。当 `dynamic_routing.enabled: true` 时使用。v1.40 新增 |
| `dynamic_routing.escalate_on_failure` | boolean | `true`, `false` | `true` | 为 `false` 时，即使 `enabled: true` 也禁用升级——每次尝试使用默认层级。v1.40 新增 |
| `dynamic_routing.max_escalations` | integer | `0`, `1`, `2`, … | `1` | 每次 agent 调用的硬性重试上限。超过上限后，解析器返回上限层级的模型。v1.40 新增 |
| `project_code` | string | 任意短字符串 | （无） | 阶段目录名称的前缀（如 `"ABC"` 生成 `ABC-01-setup/`）。v1.31 新增 |
| `phase_id_convention` | enum | `"milestone-prefixed"`, `null` | `null` | 阶段 ID 命名规范。`null` = 旧版数字 ID（`Phase 1`、`Phase 2`）。`"milestone-prefixed"` = 编码所属里程碑的全局唯一 ID（`Phase 1-01`、`Phase 1-02`）。运行 `gsd-tools roadmap upgrade --convention milestone-prefixed` 迁移现有 ROADMAP.md。 |
| `response_language` | string | 语言代码 | （无） | agent 响应语言（如 `"pt"`、`"ko"`、`"ja"`）。传播至所有派生 agent，实现跨阶段语言一致性。v1.32 新增 |
| `context_window` | number | 任意整数 | `200000` | 上下文窗口大小（token 数）。对于 1M 上下文模型（如 `claude-fable-5`），设置为 `1000000`。`>= 500000` 的值启用自适应上下文增强（完整读取之前的 SUMMARY.md，更深入的反模式读取）。通过 `/gsd-config --advanced` 配置。 |
| `context_profile` | string | `dev`, `research`, `review` | （无） | 执行上下文预设，为当前工作类型应用预配置的模式、模型和工作流设置包。v1.34 新增 |
| `claude_md_path` | string | 任意文件路径 | `./CLAUDE.md` | 生成的 CLAUDE.md 文件的自定义输出路径。适用于需要将 CLAUDE.md 放在非根目录位置的 monorepo 或项目。默认为项目根目录下的 `./CLAUDE.md`。v1.36 新增 |
| `claude_md_assembly.mode` | enum | `embed`, `link` | `embed` | 控制如何将受管理的节写入 CLAUDE.md。`embed`（默认）在 GSD 标记之间内联内容。`link` 改为写入 `@.planning/<source-path>`——Claude Code 在运行时展开引用，在典型项目中将 CLAUDE.md 大小减少约 65%。`link` 仅适用于有真实源文件的节；`workflow` 和回退节始终嵌入。按块覆盖：`claude_md_assembly.blocks.<section>`（如 `claude_md_assembly.blocks.architecture: link`）。v1.38 新增 |
| `context` | string | 任意文本 | （无） | 注入到项目所有 agent 提示词中的自定义上下文字符串。用于提供每个 agent 都应了解的持久性项目特定指导（如编码规范、团队实践） |
| `phase_naming` | string | 任意字符串 | （无） | 阶段目录名称的自定义前缀。设置后，覆盖自动生成的阶段 slug（如 `"feature"` 生成 `feature-01-setup/` 而非路线图派生的 slug） |
| `brave_search` | boolean | `true`/`false` | 自动检测 | 覆盖 Brave Search API 可用性的自动检测。未设置时，GSD 检查 `BRAVE_API_KEY` 环境变量或 `~/.gsd/brave_api_key` 文件 |
| `firecrawl` | boolean | `true`/`false` | 自动检测 | 覆盖 Firecrawl API 可用性的自动检测。未设置时，GSD 检查 `FIRECRAWL_API_KEY` 环境变量或 `~/.gsd/firecrawl_api_key` 文件 |
| `exa_search` | boolean | `true`/`false` | 自动检测 | 覆盖 Exa Search API 可用性的自动检测。未设置时，GSD 检查 `EXA_API_KEY` 环境变量或 `~/.gsd/exa_api_key` 文件 |
| `search_gitignored` | boolean | `true`/`false` | `false` | `planning.search_gitignored` 的旧版顶层别名。优先使用命名空间形式；此别名为向后兼容而保留 |

> **注意：** `granularity` 在 v1.22.3 中从 `depth` 重命名而来。现有配置会自动迁移。

---

## 集成设置

通过 [`/gsd-config --integrations`](COMMANDS.md#gsd-config) 交互式配置。这些是*连接*设置——API 密钥和跨工具路由——特意与 `/gsd-settings`（工作流开关）分开。

### 搜索 API 密钥

API 密钥字段接受字符串值（密钥本身）。也可以设置为哨兵值 `true`/`false`/`null` 来覆盖来自环境变量 / `~/.gsd/*_api_key` 文件的自动检测（旧版行为，参见上方各行）。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `brave_search` | string \| boolean \| null | `null` | 用于网络研究的 Brave Search API 密钥。在所有 UI / `config-set` 输出中显示为 `****<末4位>`；从不以明文回显 |
| `firecrawl` | string \| boolean \| null | `null` | 用于深度抓取的 Firecrawl API 密钥。显示时已脱敏 |
| `exa_search` | string \| boolean \| null | `null` | 用于语义搜索的 Exa Search API 密钥。显示时已脱敏 |

**脱敏规范（`gsd-core/bin/lib/secrets.cjs`）：** 8 个字符及以上的密钥显示为 `****<末4位>`；较短的密钥显示为 `****`；`null`/空值显示为 `(unset)`。明文原样写入 `.planning/config.json`——该文件是安全边界——但 CLI、确认表格、日志和 `AskUserQuestion` 描述中不显示明文。这也适用于 `config-set` 命令本身的输出：`config-set brave_search <key>` 返回带脱敏值的 JSON 负载。

### 代码审查 CLI 路由

`review.models.<cli>` 将审查器类型映射到 shell 命令。当请求匹配的类型时，代码审查工作流使用此命令进行 shell 调用。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `review.models.claude` | string | （会话模型） | Claude 风格审查的命令。未设置时默认使用会话模型 |
| `review.models.codex` | string | `null` | Codex 审查命令，如 `"codex exec --model gpt-5"` |
| `review.models.gemini` | string | `null` | Gemini 审查命令，如 `"gemini -m gemini-2.5-pro"` |
| `review.models.opencode` | string | `null` | OpenCode 审查命令，如 `"opencode run --model claude-sonnet-4"` |

`<cli>` slug 需通过 `[a-zA-Z0-9_-]+` 验证。空值或包含路径的 slug 会被 `config-set` 拒绝。

### `/gsd-review` 的默认审查器

使用 `review.default_reviewers` 将无标志的 `/gsd-review` 运行限定为已检测审查器的子集。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `review.default_reviewers` | string[] \| null | `null`（所有已检测审查器） | 无标志 `/gsd-review` 的可选默认子集，如 `["gemini","codex"]`。优先级顺序：显式审查器标志 > `--all` > `review.default_reviewers` > 所有已检测。未知 slug 以警告忽略；已知但未检测到的 slug 以信息提示忽略；空数组会被 `config-set` 拒绝。 |

示例：

```json
{
  "review": {
    "default_reviewers": ["gemini", "codex"]
  }
}
```

### Agent 技能注入（动态）

`agent_skills.<agent-type>` 扩展下方记录的 `agent_skills` 映射。slug 需通过 `[a-zA-Z0-9_-]+` 验证——无路径分隔符、无空格、无 shell 元字符。通过 `/gsd-config --integrations` 交互式配置。

---

## 工作流开关

所有工作流开关遵循**缺失 = 启用**模式。如果配置中缺少某个键，默认值为 `true`。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `workflow.research` | boolean | `true` | 规划每个阶段前进行领域调研 |
| `workflow.plan_check` | boolean | `true` | 计划验证循环（最多 3 次迭代） |
| `workflow.verifier` | boolean | `true` | 执行后针对阶段目标的验证 |
| `workflow.auto_advance` | boolean | `false` | 自动串联 discuss → plan → execute，无需停顿 |
| `workflow.nyquist_validation` | boolean | `true` | 计划阶段研究期间的测试覆盖率映射 |
| `workflow.ui_phase` | boolean | `true` | 为前端阶段生成 UI 设计契约 |
| `workflow.ui_safety_gate` | boolean | `true` | 在计划阶段期间，提示为前端阶段运行 /gsd-ui-phase |
| `workflow.ui_review` | boolean | `true` | 在自主模式下阶段执行后运行视觉质量审计（`/gsd-ui-review`）。为 `false` 时跳过 UI 审计步骤。 |
| `workflow.node_repair` | boolean | `true` | 验证失败时自主任务修复 |
| `workflow.node_repair_budget` | number | `2` | 每个失败任务的最大修复尝试次数 |
| `workflow.research_before_questions` | boolean | `false` | 在讨论问题之前而非之后运行研究 |
| `workflow.discuss_mode` | string | `'discuss'` | 控制 `/gsd-discuss-phase` 如何收集上下文。`'discuss'`（默认）逐一提问。`'assumptions'` 先读取代码库，生成带置信度的结构化假设，只要求纠正错误内容。v1.28 新增 |
| `workflow.max_discuss_passes` | number | `3` | 工作流停止提问前讨论阶段的最大轮数。在无头/自动模式下防止无限讨论循环。 |
| `workflow.skip_discuss` | boolean | `false` | 为 `true` 时，`/gsd-autonomous` 完全跳过讨论阶段，从 ROADMAP 阶段目标写入最简 CONTEXT.md。适用于开发者偏好已完整写入 PROJECT.md/REQUIREMENTS.md 的项目。v1.28 新增 |
| `workflow.text_mode` | boolean | `false` | 将 AskUserQuestion TUI 菜单替换为纯文本编号列表。在 TUI 菜单无法渲染的 Claude Code 远程会话（`/rc` 模式）中必需。也可通过讨论阶段的 `--text` 标志按会话设置。v1.28 新增 |
| `workflow.use_worktrees` | boolean | `true` | 为 `false` 时，禁用并行执行的 git worktree 隔离。偏好顺序执行或环境不支持 worktree 的用户可以禁用此选项。v1.31 新增 |
| `workflow.worktree_skip_hooks` | boolean | `false` | 为 `true` 时，worktree 模式下的执行器 agent 传递 `--no-verify`（跳过提交前钩子），波次后的钩子验证改为针对合并结果运行。适用于钩子无法在 agent worktree 中运行的项目的可选逃生舱口。默认 `false` 对每次提交运行钩子（#2924）。 |
| `workflow.code_review` | boolean | `true` | 启用 `/gsd-code-review` 和 `/gsd-code-review --fix` 命令。为 `false` 时，命令以配置门禁消息退出。v1.34 新增 |
| `workflow.code_review_depth` | string | `standard` | `/gsd-code-review` 的默认审查深度：`quick`（仅模式匹配）、`standard`（按文件分析）或 `deep`（带导入图的跨文件）。可通过 `--depth=` 按次运行覆盖。v1.34 新增 |
| `workflow.plan_bounce` | boolean | `false` | 针对生成的计划运行外部验证脚本。启用后，计划阶段编排器将每个 PLAN.md 通过 `plan_bounce_script` 指定的脚本管道处理，并在非零退出时阻塞。v1.36 新增 |
| `workflow.plan_bounce_script` | string | （无） | 用于计划反弹验证的外部脚本路径。接收 PLAN.md 路径作为第一个参数。当 `plan_bounce` 为 `true` 时必需。v1.36 新增 |
| `workflow.plan_bounce_passes` | number | `2` | 顺序执行的反弹轮数。每轮将上一轮的输出反馈给验证器。较高的值提升严格性，但会增加延迟。v1.36 新增 |
| `workflow.post_planning_gaps` | boolean | `true` | 统一的规划后差距报告（#2493）。所有计划生成并提交后，扫描 REQUIREMENTS.md 和 CONTEXT.md 的 `<decisions>` 与阶段目录中的每个 PLAN.md，然后打印一个 `Source \| Item \| Status` 表格。单词边界匹配（REQ-1 vs REQ-10）和自然排序（REQ-02 在 REQ-10 之前）。非阻塞——仅为信息性报告。设为 `false` 跳过计划阶段的步骤 13e。 |
| `workflow.plan_review_convergence` | boolean | `false` | 启用 `/gsd-plan-review-convergence` 命令。默认禁用——此键为 `false` 时命令以启用说明退出。该命令自动化手动计划→审查→重新规划循环：派生已配置的审查器（Codex、Gemini、Claude、OpenCode、Ollama、LM Studio、llama.cpp），通过 CYCLE_SUMMARY 契约计算未解决的 HIGH 问题，用 `--reviews` 反馈重新规划，并重复直至收敛或达到最大循环次数。通过 `gsd config-set workflow.plan_review_convergence true` 启用。v1.39 新增 |
| `workflow.plan_chunked` | boolean | `false` | 启用分块规划模式。为 `true`（或向 `/gsd-plan-phase` 传递 `--chunked` 标志）时，编排器将单个长期规划器任务拆分为一个简短的轮廓任务，后跟 N 个简短的按计划任务（每个约 3-5 分钟）。每个计划单独提交以具备崩溃韧性。如果任务挂起且终端被强制终止，使用 `--chunked` 重新运行将从最后完成的计划处恢复。在长期任务可能在 stdio 上挂起的 Windows 上特别有用。v1.38 新增 |
| `workflow.code_review_command` | string | （无） | `/gsd-ship` 中外部代码审查集成的 shell 命令。通过 stdin 接收更改的文件路径。非零退出阻塞发布工作流。v1.36 新增 |
| `workflow.tdd_mode` | boolean | `false` | 将 TDD 流水线作为一等执行模式启用。为 `true` 时，规划器积极地将 `type: tdd` 应用于符合条件的任务（业务逻辑、API、验证、算法），执行器强制执行 RED/GREEN/REFACTOR 门禁序列。阶段结束时的协作审查检查点验证门禁合规性。v1.36 新增 |
| `workflow.human_verify_mode` | string | `'end-of-phase'` | 控制人工验证检查点。`'end-of-phase'`（自 #3309 起为默认值）抑制 `checkpoint:human-verify` 任务，并将检查嵌入 `<verify><human-check>` 块以供阶段结束审查。`'mid-flight'` 恢复阻塞式检查点任务。`checkpoint:decision` 和 `checkpoint:human-action` 不受影响。参见[检查点参考](../../gsd-core/references/checkpoints.md#checkpoint_types)。 |
| `workflow.cross_ai_execution` | boolean | `false` | 将阶段执行委托给外部 AI CLI，而非派生本地执行器 agent。适用于利用不同模型在特定阶段的优势。v1.36 新增 |
| `workflow.cross_ai_command` | string | （无） | 跨 AI 执行的 shell 命令模板。通过 stdin 接收阶段提示词。必须生成与 SUMMARY.md 兼容的输出。当 `cross_ai_execution` 为 `true` 时必需。v1.36 新增 |
| `workflow.cross_ai_timeout` | number | `300` | 跨 AI 执行命令的超时秒数。防止失控的外部进程。v1.36 新增 |
| `workflow.ai_integration_phase` | boolean | `true` | 启用 `/gsd-ai-integration-phase` 命令。为 `false` 时，命令以配置门禁消息退出 |
| `workflow.auto_prune_state` | boolean | `false` | 为 `true` 时，在阶段边界自动清理 STATE.md 中的过期条目，而非提示确认 |
| `workflow.pattern_mapper` | boolean | `true` | 在研究和规划之间运行 `gsd-pattern-mapper` agent，将新文件映射到现有代码库类似物 |
| `workflow.subagent_timeout` | number | `600` | 单个 subagent 调用的超时秒数。对于长时间运行的研究或执行阶段可适当增加 |
| `executor.stall_detect_interval_minutes` | number | `5` | 执行器 agent 活跃时，执行器停滞检测的间隔分钟数。执行阶段编排器以此频率检查最近的提交，避免无限等待静默的 agent。 |
| `executor.stall_threshold_minutes` | number | `10` | 执行器完成或预期分支提交活动缺失超过此分钟数后，执行阶段为可能停滞的执行器提供恢复选项。 |
| `workflow.inline_plan_threshold` | number | `3` | 阶段中任务数量的最大值，超过此值后规划器生成单独的 PLAN.md 文件而非在提示词中内联任务 |
| `workflow.drift_threshold` | number | `3` | 阶段期间引入的新结构元素（新目录、桶形导出、迁移、路由模块）的最小数量，超过此值后执行后代码库漂移门禁采取行动。参见 [#2003](https://github.com/open-gsd/gsd-core/issues/2003)。v1.39 新增 |
| `workflow.drift_action` | string | `warn` | `/gsd-execute-phase` 后超过 `workflow.drift_threshold` 时的处理方式。`warn` 打印建议运行 `/gsd-map-codebase --paths …` 的消息；`auto-remap` 派生 `gsd-codebase-mapper` 限定于受影响路径。v1.39 新增 |
| `workflow.build_command` | string | （无） | 在执行阶段步骤 5.6 的步骤 A 中（合并后构建门禁）构建项目的 shell 命令。未设置时，门禁自动检测：Xcode（存在 `.xcodeproj`）→ `xcodebuild build`，带 `build:` 目标的 `Makefile` → `make build`，Justfile → `just build`，`Cargo.toml` → `cargo build`，`go.mod` → `go build ./...`，Python → `python -m py_compile`，带 `build` 脚本的 `package.json` → `npm run build`。5 分钟超时运行；失败时递增 `WAVE_FAILURE_COUNT`。v1.39 新增 |
| `workflow.test_command` | string | （无） | 在执行阶段步骤 5.6 的步骤 B 中（合并后测试门禁）和回归门禁中运行项目测试套件的 shell 命令。未设置时，门禁自动检测：Xcode（存在 `.xcodeproj`）→ `xcodebuild test`，带 `test:` 目标的 `Makefile` → `make test`，Justfile → `just test`，`package.json` → `npm test`，`Cargo.toml` → `cargo test`，`go.mod` → `go test ./...`，Python → `python -m pytest`。5 分钟超时运行；失败时递增 `WAVE_FAILURE_COUNT`。v1.39 新增 |

## 代码质量设置

`code_quality.*` 命名空间控制可选的结构分析工具，作为 `/gsd-code-review` 的补充。各设置为增量式：每个工具独立选择启用，默认关闭。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `code_quality.fallow.enabled` | boolean | `false` | 为 `/gsd-code-review` 启用 fallow 结构预处理。为 `false` 时，不生成 fallow 二进制探针或 JSON 产物。 |
| `code_quality.fallow.scope` | string | `phase` | fallow 分析范围：`phase`（当前审查文件范围）或 `repo`（整个仓库）。 |
| `code_quality.fallow.profile` | string | `standard` | 传递给预处理运行器的 fallow 配置文件选择器（`minimal`、`standard`、`strict`）。 |
| `code_quality.fallow.mcp` | boolean | `false` | **保留——尚未实现。** 为 `true` 时，为支持 MCP 服务器路由的运行时启用基于 MCP 的结构性发现模式。当前将此设为 `true` 是无操作，并会发出运行时警告。 |

## 发布设置

`ship.pr_body_sections` 为 `/gsd-ship` 添加额外的 PR 正文节，用于项目特定的 PRD/PR 正文内容，而无需编辑 `gsd-core/workflows/ship.md`。

有关入门示例和故障排除的用户指南，请参阅[自定义 PR 正文节](../ship-pr-body-sections.md)。

此列表为仅追加：已配置的条目在核心的 `Summary`、`Changes`、`Requirements Addressed`、`Verification` 和 `Key Decisions` 节之后添加。它们不能替换、删除或重新排序必需节。

推荐的精益/敏捷 PRD 用途包括用户故事、验收标准、完成定义或发布标准、风险和依赖关系、成功指标以及利益相关者审查说明。保持这些节简短且以证据为导向，使 PR 正文成为活跃的发布产物而非静态需求转储。

每个条目支持：

| 字段 | 类型 | 默认值 | 描述 |
|-------|------|---------|-------------|
| `heading` | string | 必需 | 渲染为 `## {heading}` 的 Markdown 节标题。必须为单行。 |
| `enabled` | boolean | `true` | 为 `false` 时，入门时可在配置中保留候选节而不在生成的 PR 正文中渲染。 |
| `source` | string | （无） | 规划产物标题的可选回退链，如 `PLAN.md ## Risks \|\| VERIFICATION.md ## Manual Checks`。允许的产物有 `ROADMAP.md`、`PLAN.md`、`SUMMARY.md`、`VERIFICATION.md`、`STATE.md`、`REQUIREMENTS.md` 和 `CONTEXT.md`。 |
| `template` | string | （无） | 带封闭 token 的字面 Markdown：`{phase_number}`、`{phase_name}`、`{phase_dir}`、`{base_branch}`、`{padded_phase}`。 |
| `fallback` | string | （无） | 当 `source` 不产生内容且未提供 `template` 时使用的字面 Markdown。 |

每个节至少需要 `source`、`template` 或 `fallback` 之一。默认为 `[]`，因此现有项目在入门添加启用条目之前保持当前的 `/gsd-ship` 输出。

示例：

```json
{
  "ship": {
    "pr_body_sections": [
      {
        "heading": "User Stories & Acceptance Criteria",
        "enabled": true,
        "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
        "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
      },
      {
        "heading": "Risks & Rollback",
        "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Rollback",
        "fallback": "- Rollback: revert this PR."
      },
      {
        "heading": "Stakeholder Sign-off",
        "enabled": false,
        "template": "- Product owner: pending for {phase_name}"
      }
    ]
  }
}
```

### 常用设置组合

以下 `mode`、`granularity`、`model_profile` 和工作流开关的组合常常一起使用。有关设置指导，请参阅[配置模型配置文件](how-to/configure-model-profiles.md)。

| 场景 | mode | granularity | profile | research | plan_check | verifier |
|----------|------|-------------|---------|----------|------------|----------|
| 原型开发 | `yolo` | `coarse` | `budget` | `false` | `false` | `false` |
| 常规开发 | `interactive` | `standard` | `balanced` | `true` | `true` | `true` |
| 生产发布 | `interactive` | `fine` | `quality` | `true` | `true` | `true` |

---

## 规划设置

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `planning.commit_docs` | boolean | `true` | `.planning/` 文件是否提交到 git |
| `planning.search_gitignored` | boolean | `false` | 向大范围搜索添加 `--no-ignore` 以包含 `.planning/` |
| `planning.sub_repos` | string 数组 | `[]` | 相对于项目根目录的嵌套子仓库路径。设置后，GSD 感知工具按子仓库划定阶段查找、路径解析和提交操作的范围，而非将外层仓库视为 monorepo |

### 多仓库工作空间中的项目根目录解析

当设置了 `sub_repos` 且从列出的子仓库内部调用 `gsd-tools.cjs` 或 `gsd-tools query` 时，两个 CLI 都会向上走到拥有 `.planning/` 的父工作空间，然后再分发处理程序。解析顺序（在每个祖先最多向上检查 10 层，不超过 `$HOME`）：

1. 如果起始目录本身有 `.planning/`，则其为项目根目录（不向上走）。
2. 父目录有 `.planning/config.json`，且其 `sub_repos`（或旧版 `planning.sub_repos` 形式）中列出了起始目录的顶层段。
3. 父目录有 `.planning/config.json`，带旧版 `multiRepo: true`，且起始目录在某个 git 仓库内。
4. 父目录有 `.planning/`，且候选父目录到某个祖先之间包含 `.git`（启发式回退）。

如果都不匹配，则返回起始目录不变。显式的 `--project-dir /path/to/workspace` 在此解析下是幂等的。

### 自动检测

如果 `.planning/` 在 `.gitignore` 中，则 `commit_docs` 自动为 `false`，无论 config.json 如何设置。这可防止 git 错误。

---

## 钩子设置

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `hooks.context_warnings` | boolean | `true` | 通过上下文监控钩子显示上下文窗口使用警告 |
| `hooks.workflow_guard` | boolean | `false` | 当文件编辑发生在 GSD 工作流上下文之外时发出警告（建议使用 `/gsd-quick` 或 `/gsd-fast`） |
| `statusline.show_last_command` | boolean | `false` | 向状态行追加 `last: /<cmd>` 后缀，显示最近调用的斜杠命令。选择性启用；读取活跃会话记录以提取最新的 `<command-name>` 标签（关闭 #2538） |
| `statusline.context_position` | string | `"end"` | 上下文窗口计量器的位置。`"end"`（默认）在行尾渲染；`"front"` 在模型名称后立即渲染，使计量器在窄终端中保持可见。关闭 #2937 |

提示词注入防护钩子（gsd-prompt-guard.js）始终激活，无法禁用——它是安全特性，而非工作流开关。

### 私有规划设置

当 `planning.commit_docs` 为 `false` 且 `.planning/` 在 `.gitignore` 中时，GSD 将规划产物视为仅本地存在。`planning.search_gitignored: true` 确保此配置下大范围搜索仍然包含 `.planning/` 目录。有关设置步骤，请参阅[配置私有规划](how-to/configure-model-profiles.md)。

---

## Agent 技能注入

向 GSD subagent 提示词注入自定义技能文件。技能在 agent spawn 时读取，为其提供 CLAUDE.md 之外的项目特定指令。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `agent_skills` | object | `{}` | agent 类型到技能目录路径的映射 |

### 配置

在 `.planning/config.json` 中添加 `agent_skills` 节，将 agent 类型映射到技能目录路径数组（相对于项目根目录）：

```json
{
  "agent_skills": {
    "gsd-executor": ["skills/testing-standards", "skills/api-conventions"],
    "gsd-planner": ["skills/architecture-rules"],
    "gsd-verifier": ["skills/acceptance-criteria"]
  }
}
```

每个路径必须是包含 `SKILL.md` 文件的目录。路径经过安全验证（不允许遍历到项目根目录之外）。

### 支持的 Agent 类型

任何 GSD agent 类型都可以接收技能。常用类型：

- `gsd-executor` -- 执行实施计划
- `gsd-planner` -- 创建阶段计划
- `gsd-checker` -- 验证计划质量
- `gsd-verifier` -- 执行后验证
- `gsd-researcher` -- 阶段研究
- `gsd-project-researcher` -- 新项目研究
- `gsd-debugger` -- 诊断 agent
- `gsd-codebase-mapper` -- 代码库分析
- `gsd-advisor` -- 讨论阶段顾问
- `gsd-ui-researcher` -- UI 设计契约创建
- `gsd-ui-checker` -- UI 规格验证
- `gsd-roadmapper` -- 路线图创建
- `gsd-synthesizer` -- 研究综合

### 工作原理

在 spawn 时，工作流调用 `gsd-tools query agent-skills <type>`（或旧版 `node gsd-tools.cjs agent-skills <type>`）来加载已配置的技能。如果该 agent 类型存在技能，它们将作为 `<agent_skills>` 块注入到 Task() 提示词中：

```xml
<agent_skills>
Read these user-configured skills:
- @skills/testing-standards/SKILL.md
- @skills/api-conventions/SKILL.md
</agent_skills>
```

如果未配置技能，则省略该块（零开销）。

### CLI

通过 CLI 设置技能：

```bash
gsd-tools query config-set agent_skills.gsd-executor '["skills/my-skill"]'
```

---

## 功能标志

通过 `features.*` 配置命名空间切换可选功能。功能标志默认为 `false`（禁用）——启用标志即选择新行为，不影响现有工作流。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `features.thinking_partner` | boolean | `false` | 在工作流决策点启用思维伙伴分析 |
| `features.global_learnings` | boolean | `false` | 启用跨项目学习流水线（阶段完成时自动复制，注入规划器） |
| `learnings.max_inject` | number | `10` | 注入每个规划器提示词的最大跨项目学习数量。较低值减少提示词大小；较高值提供更广泛的历史上下文 |
| `intel.enabled` | boolean | `false` | 启用可查询的代码库情报系统。为 `true` 时，`/gsd-map-codebase --query` 命令在 `.planning/intel/` 中构建和查询 JSON 索引。v1.34 新增 |

<a id="plan-review-settings"></a>
### 计划审查设置

`plan_review.*` 命名空间控制计划漂移防护，该功能验证生成计划中引用的符号（装饰器、类、函数、CLI 标志）在审查时实际存在于源代码中。这在执行开始前捕获幻觉名称。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `plan_review.source_grounding` | boolean | `true` | 启用计划漂移防护。为 `true`（默认）时，计划审查将 PLAN.md 中引用的每个符号与实时源代码树对比解析。引用不存在的函数、类、装饰器或 CLI 标志的计划在计划批准前产生 `needs-acknowledgement` 通知。设为 `false` 完全跳过符号验证。可在设置期间（`/gsd:new-project`）或随时通过 `/gsd:settings` 切换。 |
| `plan_review.source_grounding_authority` | enum | `grep` | 选择用于验证符号存在性的解析器适配器。允许值：`grep`（默认——对源文件进行 ripgrep/grep 搜索，任何项目无需额外工具即可使用），`intel`（查询 `/gsd:map-codebase` 构建的 `.planning/intel/api-map.json` 索引；需要 `intel.enabled: true`），`treesitter`（保留用于未来的 tree-sitter 适配器），`lsp`（保留用于未来的 LSP 适配器），`scip`（保留用于未来的 SCIP/LSIF 适配器）。当您已运行 `/gsd:map-codebase` 并希望使用更快的预索引查找时，使用 `intel`。`grep` 和 `intel` 之外的所有值均为保留值，在当前版本中无效。 |

<a id="graphify-settings"></a>
### Graphify 设置

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `graphify.enabled` | boolean | `false` | 启用项目知识图谱。为 `true` 时，`/gsd-graphify` 在 `.planning/graphs/` 中构建和查询图谱。v1.36 新增 |
| `graphify.build_timeout` | number（秒） | `300` | `/gsd-graphify build` 运行中止前的最大允许秒数。v1.36 新增 |
| `graphify.auto_update` | boolean | `false` | **选择性启用（issue #3347）。** 为 `true`（且 `graphify.enabled` 也为 `true`）时，捆绑的 PostToolUse 钩子 `hooks/gsd-graphify-update.sh` 在默认分支（`git.base_branch` 覆盖，否则为 `main`/`master`/`trunk`）上执行 `git commit/merge/pull/rebase --continue/cherry-pick` 后，在后台分离进程中自动重建项目知识图谱。钩子立即返回；重建更新 `.planning/graphs/{graph.json,graph.html,GRAPH_REPORT.md}` 并写入 `.planning/graphs/.last-build-status.json`（`{ts, status: "running"\|"ok"\|"failed", exit_code, duration_ms, head_at_build}`）。PID 锁定，CI 感知（`$CI` 环境变量抑制），若 `graphify` 不在 `PATH` 中则静默退出。默认 `false`，升级后现有行为不变。 |

#### 多开发者设置

当多个开发者在同一仓库中重建图谱时，`graphify hook install`（每个克隆运行一次）安装一个 git 合并驱动程序，对并发的 `graph.json` 写入进行联合合并，消除冲突标记。它还注册提交后重建钩子，写入 `.gitattributes`，并将 `graphify merge-driver` 添加到 `.git/config`。单人项目可跳过此步骤。随 graphify v0.7.0 一同引入，以及 `/gsd-graphify status` 显示的 `built_at_commit` 新鲜度信号。

#### 基于提交的过期性

`/gsd-graphify status` 报告两个正交的过期性信号：

- **`stale`**（基于 mtime，24 小时窗口）——图谱文件最后写入时间。在 graphify 未自动运行时有用。
- **`commit_stale`**（基于提交，需要 graphify v0.7+）——图谱是否针对当前 `git HEAD` 构建。存在时可信。
  三态值：`true` / `false` / `null`。`null` 表示信号不可用（v0.7 之前的图谱、无 git 或无法访问提交）——回退到 mtime 标志。

在旧检出上重建的 CI 图谱在 mtime 上显示为新鲜，但 `commit_stale: true`。回答架构问题时两者都应呈现。

### 用法

```bash
# 启用功能
gsd-tools query config-set features.global_learnings true

# 禁用功能
gsd-tools query config-set features.thinking_partner false
```

`features.*` 命名空间是动态键模式——无需修改 `VALID_CONFIG_KEYS` 即可添加新的功能标志。任何匹配 `features.<name>` 的键都被配置系统接受。

---

## 并行化设置

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `parallelization` | boolean | `true` | `parallelization.enabled` 的简写。设置 `parallelization false` 禁用并行执行而不更改其他子键 |
| `parallelization.enabled` | boolean | `true` | 同时运行独立计划 |
| `parallelization.plan_level` | boolean | `true` | 在计划级别并行化 |
| `parallelization.task_level` | boolean | `false` | 并行化计划内的任务 |
| `parallelization.skip_checkpoints` | boolean | `true` | 并行执行期间跳过检查点 |
| `parallelization.max_concurrent_agents` | number | `3` | 最大同时 agent 数 |
| `parallelization.min_plans_for_parallel` | number | `2` | 触发并行执行的最小计划数 |

> **提交前钩子和并行执行**：当并行化启用时，执行器 agent 使用 `--no-verify` 提交，以避免构建锁争用（如 Rust 项目中的 cargo lock 冲突）。编排器在每个波次完成后统一验证钩子。STATE.md 写入通过文件级锁保护，防止并发写入损坏。如果需要每次提交都运行钩子，请设置 `parallelization.enabled: false`。

---

## STATE.md 前言（阶段生命周期）

`STATE.md` 携带 YAML 前言，状态行钩子在每次渲染时读取。v1.40 添加了四个可选的阶段生命周期字段，由 `parseStateMd()` 读取并由 `formatGsdState()` 渲染：

| 字段 | 类型 | 用途 |
|-------|------|---------|
| `active_phase` | string（如 `"4.5"`） | 编排器命令执行中时的阶段编号 |
| `next_action` | string | 空闲时推荐的下一个命令（`discuss-phase` / `plan-phase` / `execute-phase` / `verify-phase`） |
| `next_phases` | YAML 流数组 | `next_action` 适用的阶段（如 `["4.5"]`） |
| `progress` | block | 嵌套的 `total_phases` / `completed_phases` / `percent`，用于里程碑进度条 |

所有四个字段均为**可选且增量式**——没有这些字段的 STATE.md 文件与 v1.38.x 中的渲染完全相同。有关完整字段参考、解析器约束和渲染场景，请参阅 [STATE.md schema](reference/state-md.md)。

---

## Git 分支

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `git.branching_strategy` | enum | `none` | `none`、`phase` 或 `milestone` |
| `git.base_branch` | string | `main` | 创建阶段/里程碑分支并合并回的集成分支。当仓库使用 `master` 或发布分支时可覆盖 |
| `git.create_tag` | boolean | `true` | 在里程碑完成时创建 git 标签（`v[X.Y]`）。对于有自己发布流程的项目，设为 `false` |
| `git.phase_branch_template` | string | `gsd/phase-{phase}-{slug}` | 阶段策略的分支名称模板 |
| `git.milestone_branch_template` | string | `gsd/{milestone}-{slug}` | 里程碑策略的分支名称模板 |
| `git.quick_branch_template` | string 或 null | `null` | `/gsd-quick` 任务的可选分支名称模板 |

### 策略对比

| 策略 | 创建分支 | 范围 | 合并点 | 最适合 |
|----------|---------------|-------|-------------|----------|
| `none` | 从不 | 不适用 | 不适用 | 单人开发、简单项目 |
| `phase` | 在 `execute-phase` 开始时 | 一个阶段 | 用户在阶段后合并 | 按阶段代码审查、细粒度回滚 |
| `milestone` | 在首次 `execute-phase` 时 | 里程碑中的所有阶段 | 在 `complete-milestone` 时 | 发布分支、按版本 PR |

### 模板变量

| 变量 | 适用于 | 示例 |
|----------|-------------|---------|
| `{phase}` | `phase_branch_template` | `03`（零填充） |
| `{slug}` | 两种模板 | `user-authentication`（小写、连字符） |
| `{milestone}` | `milestone_branch_template` | `v1.0` |
| `{num}` / `{quick}` | `quick_branch_template` | `260317-abc`（快速任务 ID） |

快速任务分支示例：

```json
"git": {
  "quick_branch_template": "gsd/quick-{num}-{slug}"
}
```

### 里程碑完成时的合并选项

| 选项 | Git 命令 | 结果 |
|--------|-------------|--------|
| Squash 合并（推荐） | `git merge --squash` | 每个分支一个干净的提交 |
| 带历史合并 | `git merge --no-ff` | 保留所有单独提交 |
| 不合并直接删除 | `git branch -D` | 丢弃分支工作 |
| 保留分支 | （无） | 稍后手动处理 |

---

## 门禁设置

控制工作流期间的确认提示。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `gates.confirm_project` | boolean | `true` | 最终确定前确认项目详情 |
| `gates.confirm_phases` | boolean | `true` | 确认阶段分解 |
| `gates.confirm_roadmap` | boolean | `true` | 继续前确认路线图 |
| `gates.confirm_breakdown` | boolean | `true` | 确认任务分解 |
| `gates.confirm_plan` | boolean | `true` | 执行前确认每个计划 |
| `gates.execute_next_plan` | boolean | `true` | 执行下一个计划前确认 |
| `gates.issues_review` | boolean | `true` | 创建修复计划前审查 issue |
| `gates.confirm_transition` | boolean | `true` | 确认阶段过渡 |

---

## 安全设置

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `safety.always_confirm_destructive` | boolean | `true` | 确认破坏性操作（删除、覆盖） |
| `safety.always_confirm_external_services` | boolean | `true` | 确认外部服务交互 |

---

## 安全加固设置

安全加固功能（v1.31）的设置。所有设置遵循**缺失 = 启用**模式。这些键位于 `.planning/config.json` 的 `workflow.*` 下——与 `workflows/plan-phase.md`、`workflows/execute-phase.md`、`workflows/secure-phase.md` 和 `workflows/verify-work.md` 中的发布模板和运行时读取位置一致。

这些键位于 `workflow.*` 下——工作流和安装器在此处写入和读取。在 `config.json` 顶层设置它们会被静默忽略。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `workflow.security_enforcement` | boolean | `true` | 通过 `/gsd-secure-phase` 启用威胁模型锚定的安全验证。为 `false` 时完全跳过安全检查 |
| `workflow.security_asvs_level` | number（1-3） | `1` | OWASP ASVS 验证级别。级别 1 = 机会性，级别 2 = 标准，级别 3 = 全面 |
| `workflow.security_block_on` | string | `"high"` | 阻止阶段推进的最低严重性。选项：`"high"`、`"medium"`、`"low"` |

---

## 决策覆盖门禁（`workflow.context_coverage_gate`）

当 `discuss-phase` 将实施决策写入 CONTEXT.md 的 `<decisions>` 时，两个门禁确保这些决策在进入计划和发布代码的过程中得以保留（issue #2492）。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `workflow.context_coverage_gate` | boolean | `true` | 两个决策覆盖门禁的总开关。为 `false` 时，计划阶段转化门禁和验证阶段确认门禁均静默跳过。 |

### 门禁作用

**计划阶段转化门禁（阻塞性）。** 在现有需求覆盖门禁之后、计划提交之前立即运行。对于 `<decisions>` 中的每个可追踪决策，检查决策 id（`D-NN`）或其文本是否出现在至少一个计划的 `must_haves`、`truths` 或正文中。遗漏会按 id 显示缺失的决策，并拒绝将阶段标记为已规划。

**验证阶段确认门禁（非阻塞性）。** 与其他验证步骤同时运行。在每个可追踪决策的所有发布产物（PLAN.md、SUMMARY.md、已修改文件、最近的提交主题）中搜索。遗漏作为警告节写入 VERIFICATION.md，但**不**翻转整体验证状态。这种不对称是有意为之——在验证阶段，工作已完成，模糊的子字符串遗漏不应使其他通过的阶段失败。

### 编写门禁可接受的决策

讨论阶段模板已生成带 `D-NN` 编号的决策。当满足以下条件时门禁最为高效：

1. 每个实施决策的计划在某处**引用该 id**——`must_haves.truths: ["D-12: bit offsets exposed"]` 或计划正文中的 `D-12:` 提及。严格 id 匹配是最便宜、最确定的路径。
2. 软短语匹配是同义表达的回退——如果决策文本的 6 个以上单词的片段逐字出现在计划/摘要中，则计入。

### 豁免

在以下任何情况下，决策**不受**门禁约束：

- 它位于 `<decisions>` 中的 `### Claude's Discretion` 标题下。
- 它在项目符号中标记为 `[informational]`、`[folded]` 或 `[deferred]`（如 `- **D-08 [informational]:** Naming style for internal helpers`）。

当决策真正不需要计划覆盖时，使用这些逃生舱口——实施决策权、为记录捕获的未来想法，或已推迟到后续阶段的项目。

---

## 审查设置

为 `/gsd-review` 配置按 CLI 的模型选择。设置后，覆盖该审查器的 CLI 默认模型。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `review.models.gemini` | string | （CLI 默认） | 调用 `--gemini` 审查器时使用的模型 |
| `review.models.claude` | string | （CLI 默认） | 调用 `--claude` 审查器时使用的模型 |
| `review.models.codex` | string | （CLI 默认） | 调用 `--codex` 审查器时使用的模型 |
| `review.models.opencode` | string | （CLI 默认） | 调用 `--opencode` 审查器时使用的模型 |
| `review.models.qwen` | string | （CLI 默认） | 调用 `--qwen` 审查器时使用的模型 |
| `review.models.cursor` | string | （CLI 默认） | 调用 `--cursor` 审查器时使用的模型 |
| `review.models.ollama` | string | （服务器默认） | 调用 `--ollama` 审查器时传递给 Ollama 的模型名称。未设置时使用服务器报告的第一个可用模型（如 `llama3`）。设置为特定标签：`gsd config-set review.models.ollama codellama` |
| `review.models.lm_studio` | string | （服务器默认） | 调用 `--lm-studio` 审查器时传递给 LM Studio 的模型名称。未设置时使用服务器报告的第一个可用模型。 |
| `review.models.llama_cpp` | string | （服务器默认） | 调用 `--llama-cpp` 审查器时传递给 llama.cpp 的模型名称。未设置时使用 `/v1/models` 报告的第一个模型。 |
| `review.default_reviewers` | string[] \| null | （所有已检测审查器） | 无标志 `/gsd-review` 的默认审查器子集。示例：`["gemini","codex"]`。显式标志和 `--all` 覆盖此设置。 |
| `review.max_prompt_tokens` | number\|null | null | 组装审查提示词的默认最大预估 token 数。设置后，在发送给每个审查器之前对提示词进行确定性裁剪。按审查器覆盖通过 `review.max_prompt_tokens_per_reviewer` 优先。null = 不裁剪（当前行为）。 |
| `review.max_prompt_tokens_per_reviewer` | object | {} | 按审查器的 token 预算覆盖。键为审查器 slug（ollama、llama_cpp、lm_studio、gemini、claude、codex、opencode、qwen、cursor）。值覆盖该审查器的 `review.max_prompt_tokens`。推荐用于本地模型服务器。 |
| `review.ollama_host` | string | `http://localhost:11434` | Ollama 服务器的基础 URL。在非默认端口或远程主机上运行 Ollama 时覆盖：`gsd config-set review.ollama_host http://192.168.1.10:11434` |
| `review.lm_studio_host` | string | `http://localhost:1234` | LM Studio 本地服务器的基础 URL。使用非默认端口时覆盖。 |
| `review.llama_cpp_host` | string | `http://localhost:8080` | llama.cpp 服务器（`llama-server`）的基础 URL。使用非默认端口时覆盖。 |

### 小上下文审查器的提示词预算

本地模型服务器（Ollama、llama.cpp、LM Studio）通常接受的 token 数远少于云 API。设置 `review.max_prompt_tokens_per_reviewer`（或全局 `review.max_prompt_tokens` 回退）会在将提示词发送给该审查器之前触发确定性裁剪：首先删除 CONTEXT，然后是 RESEARCH，然后是 REQUIREMENTS；PROJECT.md 头部收缩至前 40 行；PLAN 按比例尾部截断——指令和路线图始终保留。当审查器被裁剪时，在提示词顶部注入一条披露说明，并将裁剪元数据（预算、省略节、截断百分比）记录在 REVIEWS.md 前言的 `trimmed_reviewers` 下。如果即使是最小审查集（指令 + 路线图 + 计划存根）也超出预算，则跳过该审查器并发出警告，而非发送会产生误导性反馈的截断提示词。

### 示例

```json
{
  "review": {
    "models": {
      "gemini": "gemini-2.5-pro",
      "qwen": "qwen-max"
    }
  }
}
```

键缺失时回退到各 CLI 的配置默认值。v1.35.0 新增（#1849）。

---

## 管理器透传标志

配置 `/gsd-manager` 追加到每个分发命令的按步骤标志。这允许在不手动输入标志的情况下自定义管理器运行 discuss、plan 和 execute 步骤的方式。

| 设置 | 类型 | 默认值 | 描述 |
|---------|------|---------|-------------|
| `manager.flags.discuss` | string | （无） | 追加到 discuss-phase 命令的标志（如 `"--auto"`） |
| `manager.flags.plan` | string | （无） | 追加到 plan-phase 命令的标志（如 `"--skip-research"`） |
| `manager.flags.execute` | string | （无） | 追加到 execute-phase 命令的标志（如 `"--cross-ai"`） |

**示例：**

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

无效的标志 token 会被净化并记录为警告。只有已识别的 GSD 标志才会透传。

---

## 模型配置文件

### 配置文件定义

| Agent | `quality` | `balanced` | `budget` | `adaptive` | `inherit` |
|-------|-----------|------------|----------|------------|-----------|
| gsd-planner | Opus | Opus | Sonnet | Opus | Inherit |
| gsd-roadmapper | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-executor | Opus | Sonnet | Sonnet | Sonnet | Inherit |
| gsd-phase-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-project-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-research-synthesizer | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-debugger | Opus | Sonnet | Sonnet | Opus | Inherit |
| gsd-codebase-mapper | Sonnet | Haiku | Haiku | Haiku | Inherit |
| gsd-verifier | Sonnet | Sonnet | Haiku | Sonnet | Inherit |
| gsd-plan-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-integration-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-nyquist-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-pattern-mapper | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-researcher | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-ui-checker | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-ui-auditor | Sonnet | Sonnet | Haiku | Haiku | Inherit |
| gsd-doc-writer | Opus | Sonnet | Haiku | Sonnet | Inherit |
| gsd-doc-verifier | Sonnet | Sonnet | Haiku | Haiku | Inherit |

> **所有 33 个发布 agent 在目录（`sdk/shared/model-catalog.json`）中均有显式的按配置文件层级分配。** 上表显示最常用 agent 的代表性子集。对于此处未列出的 agent，`model_overrides` 接受任何已发布的 agent 名称。权威的配置文件数据通过 `gsd-core/bin/lib/model-catalog.cjs` 和 `sdk/src/model-catalog.ts` 从 `sdk/shared/model-catalog.json` 导出。

### 按 Agent 覆盖

覆盖特定 agent 而不更改整个配置文件：

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-planner": "haiku"
  }
}
```

有效的覆盖值：`opus`、`sonnet`、`haiku`、`inherit`，或任何完全限定的模型 ID（如 `"openai/o3"`、`"google/gemini-2.5-pro"`）。

`model_overrides` 可以设置在 `.planning/config.json`（按项目）或 `~/.gsd/defaults.json`（全局）中。按项目条目在冲突时优先，不冲突的全局条目被保留，因此可以在一个仓库中调整单个 agent 的模型而无需重新设置全局默认值。这在 Claude Code、Codex、OpenCode、Kilo 和其他支持的运行时中统一适用。在 Codex 和 OpenCode 上，解析后的模型在安装时嵌入每个 agent 的静态配置中——`spawn_agent` 和 OpenCode 的 `task` 接口不接受内联 `model` 参数，因此编辑 `model_overrides` 后需要运行 `gsd install <runtime>` 才能使更改生效。参见 issue #2256。

### 按阶段类型的模型（`models`）— v1.41 新增

> 在**阶段**级别（规划、研究、执行、验证）进行调整，无需了解 agent 分类。添加于 [#3023](https://github.com/open-gsd/gsd-core/pull/3030)。

`model_overrides` 是按 **agent** 的（精确但冗长；需要知道 `gsd-codebase-mapper` 属于研究，`gsd-doc-writer` 属于执行）。`models` 块允许用两行表达"规划和执行用 Opus，其余用 Sonnet"：

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
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

#### 阶段类型 → agent 映射

| 阶段类型 | Agents |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `discuss` | `gsd-assumptions-analyzer` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `completion` | （保留——当前无 subagent） |

`discuss` 和 `completion` 被 schema 接受以保持前向兼容性；今天设置它们是无操作，直到某个 subagent 映射到它们为止。

#### 解析优先级（从高到低）

```text
1. model_overrides[<agent>]              ← 按 agent；完整 ID；针对性例外
2. dynamic_routing.tier_models[<tier>]   ← 启用时（参见§动态路由）
3. models[<phase_type>]                  ← 粗粒度阶段级层级（本节）
4. model_profile（按 agent 列）          ← 全局层级策略
5. 运行时默认值                          ← 其他均不适用时
```

五层从上到下组合：`model_profile` 是基础层级，`models[<phase_type>]` 在阶段级别覆盖，`dynamic_routing`（启用时）在软性失败时按尝试次数升级，`model_overrides[<agent>]` 在顶层切出按 agent 的例外，运行时默认值在其他均不适用时生效。在上面的示例中，所有五个研究 agent 解析为 `sonnet`，*除了* `gsd-codebase-mapper`，它被按 agent 覆盖固定为 `haiku`。`dynamic_routing` 默认禁用——关闭时（`enabled: false` 或省略该块），本节的行为与当前相同。

#### 可接受的值

`models.<phase_type>` 仅接受层级别名：

| 值 | 效果 |
|---|---|
| `"opus"` / `"sonnet"` / `"haiku"` | 标准层级——运行时解析映射到该层级的活跃运行时模型 |
| `"inherit"` | 此阶段的 agent 遵循会话模型（与 `model_profile: "inherit"` 语义相同） |

如果需要完全限定的模型 ID（`"openai/gpt-5"`、`"google/gemini-2.5-pro"`），请改为按 agent 使用 `model_overrides`。`models.*` 有意仅接受层级别名，以便运行时感知映射在 Codex / OpenCode / Gemini CLI 安装上保持正确。

#### 何时使用哪种方式

| 您想要 | 使用 |
|---|---|
| 一个全局层级策略（"全部 balanced"） | `model_profile` |
| 粗粒度阶段级调整（"规划用 Opus"） | `models.<phase_type>` |
| 按 agent 精度（"强制代码库映射器使用 haiku"） | `model_overrides[<agent>]` |
| 特定 agent 的完整模型 ID | `model_overrides[<agent>]: "openai/gpt-5"` |

自由混合——上述优先规则确定性地解决任何重叠。

#### 验证

`config-set` 拒绝未知阶段类型：

```bash
$ gsd config-set models.deployment opus
Error: 'models.deployment' is not a valid config key

# 有效：
$ gsd config-set models.research sonnet
```

直接编辑 `.planning/config.json` 较为宽松——解析器简单地忽略无法识别的值并回退到配置文件层级——因此拼写错误不会静默破坏层级解析。

### 动态路由与失败层级升级（`dynamic_routing`）— v1.41 新增

> 默认使用廉价层级，仅在 agent 失败门禁时升级。添加于 [#3024](https://github.com/open-gsd/gsd-core/pull/3031)。

`dynamic_routing` 让您默认支付廉价层级的费用，仅在编排器检测到软性失败（验证不确定、计划检查 FLAG 等）时升级到更昂贵的层级。

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

#### Agent 默认层级

`MODEL_PROFILES` 中的每个 agent 声明三个默认层级之一。解析器为第一次尝试选择 `tier_models[default_tier]`。

| 层级 | Agents | 用途 |
|---|---|---|
| `light` | gsd-codebase-mapper, gsd-doc-classifier, gsd-doc-verifier, gsd-integration-checker, gsd-intel-updater, gsd-nyquist-auditor, gsd-pattern-mapper, gsd-plan-checker, gsd-research-synthesizer, gsd-ui-auditor, gsd-ui-checker | 廉价/快速——纯映射器、扫描器、低风险审计 |
| `standard` | gsd-advisor-researcher, gsd-ai-researcher, gsd-code-fixer, gsd-code-reviewer, gsd-doc-synthesizer, gsd-doc-writer, gsd-domain-researcher, gsd-eval-auditor, gsd-executor, gsd-phase-researcher, gsd-project-researcher, gsd-ui-researcher, gsd-verifier | 默认主力——研究、写作、主要验证 |
| `heavy` | gsd-assumptions-analyzer, gsd-debug-session-manager, gsd-debugger, gsd-eval-planner, gsd-framework-selector, gsd-planner, gsd-roadmapper, gsd-security-auditor, gsd-user-profiler | 深度推理——已处于顶层，无法进一步升级 |

#### 升级流程

```text
1. 编排器派生 agent → 解析器返回 tier_models[default_tier]
2. 软性失败？
   ├─ 否 → ✓ 完成（廉价路径）
   └─ 是 → 编排器以 attempt+1 重新派生
            → 解析器返回 tier_models[next_tier_up]
            → 上限为 max_escalations
3. 硬性失败（异常/崩溃）→ 绕过升级，立即显示
```

如果 `dynamic_routing.escalate_on_failure: false`，软性失败**不会**推进层级——每次重新派生都继续使用 `tier_models[default_tier]`，不论尝试计数如何。此终止开关覆盖上述软性失败分支。

`light → standard → heavy → heavy`（heavy 保持在 heavy；无法进一步）。

#### 解析优先级（从高到低）

1. **`model_overrides[<agent>]`** — 接受完整 ID；针对性例外
2. **`dynamic_routing.tier_models[<tier>]`**（当 `enabled: true` 时）
3. **`models[<phase_type>]`** — 粗粒度阶段级（#3023）
4. **`model_profile`** — 活跃配置文件中按 agent 的列
5. **运行时默认值**

`dynamic_routing` 块**默认禁用**——`enabled: false`（或省略该块）完全保留当前的静态解析行为。

#### 设置

| 键 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `dynamic_routing.enabled` | boolean | `false` | 主开关。为 `true` 时，动态路由解析器用于层级选择。 |
| `dynamic_routing.tier_models.light` | enum | （无） | 轻量层级的层级别名。通常为 `haiku`。 |
| `dynamic_routing.tier_models.standard` | enum | （无） | 标准层级的别名。通常为 `sonnet`。 |
| `dynamic_routing.tier_models.heavy` | enum | （无） | 重量层级的别名。通常为 `opus`。 |
| `dynamic_routing.escalate_on_failure` | boolean | `true` | 为 false 时禁用升级（每次尝试使用默认层级）。 |
| `dynamic_routing.max_escalations` | integer | `1` | 每次 agent 调用的硬性重试上限。防止失控循环。 |

#### 何时使用哪种方式

| 您想要 | 使用 |
|---|---|
| 所有 agent 的一种层级策略 | `model_profile` |
| 粗粒度阶段级调整 | `models.<phase_type>` |
| 按 agent 精度（完整 ID） | `model_overrides` |
| **默认廉价，仅失败时升级** | **`dynamic_routing`** |

`dynamic_routing` 在结构上是*成本杠杆*：只有在真正需要 Opus 的困难情况下才支付 Opus 费率。与 `model_overrides` 组合以实现按 agent 例外（覆盖始终优先）。

---

### 努力控制（`effort`）— v1.42 新增

> 统一的跨提供商努力旋钮。添加于 [#443](https://github.com/open-gsd/gsd-core/issues/443)。

使用单个配置控制 agent 调用的推理努力。通用阶梯为：

```
minimal < low < medium < high < xhigh < max
```

努力按运行时渲染：Claude 的 `output_config.effort`（Claude Code subagent `effort` 前言 / `CLAUDE_CODE_EFFORT_LEVEL` 环境变量），Codex 的 `model_reasoning_effort`（Responses API `reasoning.effort`）。

**跨提供商限制：** `max` 仅适用于 Anthropic——在 Codex 上限制为 `xhigh`。`minimal` 仅适用于 Codex——在 Claude 上限制为 `low`。

模型目录的按层级 `reasoning_effort` 提示是保留供参考的旧版字段；努力现在由配置驱动。

**优先级（从高到低）：**
1. 调用覆盖（如 `resolve-execution` 上的 `--effort` 标志）
2. `effort.agent_overrides[<agent-id>]`
3. `effort.routing_tier_defaults[<light|standard|heavy>]`
4. `effort.default`
5. `"high"`（Claude 通用默认值）

```json
{
  "effort": {
    "default": "high",
    "routing_tier_defaults": {
      "light":    "low",
      "standard": "high",
      "heavy":    "xhigh"
    },
    "agent_overrides": {
      "gsd-planner": "max"
    }
  }
}
```

#### 设置

| 键 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `effort.default` | enum | `"high"` | 全局回退努力级别。无层级或 agent 覆盖匹配时应用。 |
| `effort.routing_tier_defaults.light` | enum | `"low"` | 轻量层级 agent（快速映射器/扫描器）的努力。 |
| `effort.routing_tier_defaults.standard` | enum | `"high"` | 标准层级 agent（主力 agent）的努力。 |
| `effort.routing_tier_defaults.heavy` | enum | `"xhigh"` | 重量层级 agent（深度推理）的努力。 |
| `effort.agent_overrides.<agent-id>` | enum | （无） | 按 agent 的努力覆盖。优先于层级默认值。 |

有效努力值：`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。

---

### 快速模式（`fast_mode`）— v1.42 新增

> 按 agent 的 fast_mode 传播旋钮。添加于 [#443](https://github.com/open-gsd/gsd-core/issues/443)。

控制是否将 fast_mode 传播到 agent 调用。仅接受真正的布尔值——字符串 `"true"` 会被拒绝。

**注意：** `fast_mode` 仅可通过 API 运行时传播（`api` speed:"fast"）。Claude Code 没有按 subagent 的快速模式机制——`/fast` 仅在会话级别，因此在 Claude subagent 上发出 `fast_mode` 前言键是静默无操作。`resolve-execution` 输出中的 `fast_mode_supported` 告知您配置的运行时是否支持它。

**优先级（从高到低）：**
1. 调用覆盖（如 `resolve-execution` 上的 `--fast-mode` 标志）
2. `fast_mode.agent_overrides[<agent-id>]`（布尔值）
3. `fast_mode.routing_tier_defaults[<light|standard|heavy>]`（布尔值）
4. `fast_mode.enabled`（布尔值）
5. `false`

```json
{
  "fast_mode": {
    "enabled": false,
    "routing_tier_defaults": {
      "light":    true,
      "standard": false,
      "heavy":    false
    },
    "agent_overrides": {}
  }
}
```

#### 设置

| 键 | 类型 | 默认值 | 描述 |
|---|---|---|---|
| `fast_mode.enabled` | boolean | `false` | 全局 fast_mode 标志。无层级/agent 覆盖匹配时才生效。 |
| `fast_mode.routing_tier_defaults.light` | boolean | `true` | 轻量层级 agent 的快速模式。 |
| `fast_mode.routing_tier_defaults.standard` | boolean | `false` | 标准层级 agent 的快速模式。 |
| `fast_mode.routing_tier_defaults.heavy` | boolean | `false` | 重量层级 agent 的快速模式。 |
| `fast_mode.agent_overrides.<agent-id>` | boolean | （无） | 按 agent 的 fast_mode 覆盖。 |

---

### 执行查询（`resolve-execution`）

使用 `node gsd-tools.cjs resolve-execution <agent-type> [--effort <level>] [--fast-mode <true|false>] [--attempt <n>]` 获取 agent 的完整解析后执行上下文：

```json
{
  "model":             "opus",
  "profile":           "balanced",
  "effort":            "xhigh",
  "effort_rendered":   "xhigh",
  "effort_param":      "output_config.effort",
  "effort_propagation": "frontmatter",
  "fast_mode":         false,
  "fast_mode_supported": false
}
```

`effort_param` 告知您要设置哪个运行时参数。`fast_mode_supported` 告知您配置的运行时是否支持按 agent 的 fast_mode 传播。

---

### 非 Claude 运行时（Codex、OpenCode、Gemini CLI、Kilo）

> **Codex CLI 最低支持版本：`0.130.0`**（issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)）。
>
> [Codex CLI 0.130.0](https://github.com/openai/codex/releases/tag/rust-v0.130.0)（2026-05-08 发布）通过 [openai/codex#21485](https://github.com/openai/codex/pull/21485) 移除了通过 extra-skills-roots 发现功能。从此版本起，Codex CLI 仅扫描 `~/.codex/skills/<name>/SKILL.md`、`<project>/.codex/skills/` 和已注册的插件根目录以查找可调用技能。GSD 将 `$gsd-*` 界面安装为 `~/.codex/skills/gsd-<name>/SKILL.md`，因此命令在 Codex 重启后解析。早期 Codex CLI 版本可能显示重复列表（旧版 extra-roots 扫描加上用户根目录副本）——重启 Codex 并升级到 ≥ 0.130.0，或在升级前接受重复项。

当 GSD 为非 Claude 运行时安装时，安装器自动在 `~/.gsd/defaults.json` 中设置 `resolve_model_ids: "omit"`。这使 GSD 为所有 agent 返回空模型参数，因此每个 agent 使用运行时配置的任何模型。默认情况下无需额外设置。

如果您希望不同 agent 使用不同模型，请使用带有运行时可识别的完全限定模型 ID 的 `model_overrides`：

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3",
    "gsd-codebase-mapper": "o4-mini"
  }
}
```

意图与 Claude 配置文件层级相同——对规划和调试使用更强的模型（推理质量最重要的地方），对执行和映射使用更廉价的模型（计划中已包含推理）。

**何时使用哪种方式：**

| 场景 | 设置 | 效果 |
|----------|---------|--------|
| 非 Claude 运行时，单一模型 | `resolve_model_ids: "omit"`（安装器默认） | 所有 agent 使用运行时默认模型 |
| 非 Claude 运行时，分层模型 | `resolve_model_ids: "omit"` + `model_overrides` | 命名 agent 使用特定模型，其他使用运行时默认 |
| 带 OpenRouter/本地提供商的 Claude Code | `model_profile: "inherit"` | 所有 agent 遵循会话模型 |
| 带 OpenRouter 的 Claude Code，分层 | `model_profile: "inherit"` + `model_overrides` | 命名 agent 使用特定模型，其他继承 |

**`resolve_model_ids` 值：**

| 值 | 行为 | 使用场景 |
|-------|----------|----------|
| `false`（默认） | 返回 Claude 别名（`opus`、`sonnet`、`haiku`） | 使用原生 Anthropic API 的 Claude Code |
| `true` | 将别名映射到完整 Claude 模型 ID（`claude-opus-4-8`） | 使用需要完整 ID 的 API 的 Claude Code |
| `"omit"` | 返回空字符串（运行时选择其默认值） | 非 Claude 运行时（Codex、OpenCode、Gemini CLI、Kilo） |

### 运行时感知配置文件（#2517）

当设置了 `runtime` 时，配置文件层级（`opus`/`sonnet`/`haiku`）解析为运行时原生模型 ID，而非 Claude 别名。这让单个共享的 `.planning/config.json` 在 Claude 和 Codex 之间干净运行。

`resolve-model` JSON 输出包含 `reasoning_effort`（当为该 agent 解析的运行时层级定义了 `reasoning_effort` 时）。运行时适配器可将该值传递给支持它的子 agent 启动调用；不明确支持的运行时省略它。

**内置层级映射：**

| 运行时 | `opus` | `sonnet` | `haiku` | reasoning_effort |
|---------|--------|----------|---------|------------------|
| `claude` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | （不使用） |
| `codex` | `gpt-5.6-sol` | `gpt-5.6-terra` | `gpt-5.6-luna` | `xhigh` / `medium` / `medium` |
| `gemini` | `gemini-3-pro` | `gemini-3-flash` | `gemini-2.5-flash-lite` | （不使用） |
| `qwen` | `qwen3-max-2026-01-23` | `qwen3-coder-plus` | `qwen3-coder-next` | （不使用） |
| `opencode` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | （不使用） |
| `copilot` | `claude-opus-4-8` | `claude-sonnet-5` | `claude-haiku-4-5` | （不使用） |
| `hermes` | `anthropic/claude-opus-4-8` | `anthropic/claude-sonnet-5` | `anthropic/claude-haiku-4-5` | （不使用） |
| B 组（`kilo`、`cline`、`cursor`、`windsurf`、`augment`、`trae`、`codebuddy`、`antigravity`） | （无内置默认——您的运行时处理模型选择） | | | |

**Codex 示例** — 单个配置，分层模型，无大型 `model_overrides` 块：

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

这将 `gsd-planner` 解析为 `gpt-5.6-sol`（xhigh），`gsd-executor` 解析为 `gpt-5.6-terra`（medium），`gsd-codebase-mapper` 解析为 `gpt-5.6-luna`（medium）。Codex 安装器将 `model = "..."` 和 `model_reasoning_effort = "..."` 嵌入每个生成的 agent TOML。

**Claude 示例** — 显式选择解析到完整 Claude ID（无需 `resolve_model_ids: true`）：

```json
{
  "runtime": "claude",
  "model_profile": "quality"
}
```

**按运行时覆盖** — 替换一个或多个层级默认值：

```json
{
  "runtime": "codex",
  "model_profile": "quality",
  "model_profile_overrides": {
    "codex": {
      "opus": "gpt-5-pro",
      "haiku": { "model": "gpt-5-nano", "reasoning_effort": "low" }
    }
  }
}
```

**优先级（从高到低）：**

1. `model_overrides[<agent>]` — 显式的按 agent ID 始终优先。
2. **运行时感知层级解析**（本节）——当设置了 `runtime` 且配置文件不是 `inherit` 时。
3. `resolve_model_ids: "omit"` — 未设置 `runtime` 时返回空字符串。
4. Claude 原生默认——`model_profile` 层级作为别名（当前默认）。
5. `inherit` — 为 `Task(model="inherit")` 语义传播字面量 `inherit`。

**向后兼容性。** 未设置 `runtime` 的配置零行为变化——每个现有配置继续完全相同地工作。自动设置 `resolve_model_ids: "omit"` 的 Codex 安装继续省略模型字段，除非用户通过设置 `runtime: "codex"` 选择启用。

**未知运行时。** 如果 `runtime` 设置为没有内置层级映射且没有 `model_profile_overrides[<runtime>]` 的值，GSD 回退到 Claude 别名安全默认值，而非发出运行时无法接受的模型 ID。要支持新运行时，请在 `model_profile_overrides.<runtime>.{opus,sonnet,haiku}` 中填入有效 ID。

### 配置文件哲学

| 配置文件 | 哲学 | 何时使用 |
|---------|-----------|-------------|
| `quality` | 所有决策用 Opus，验证用 Sonnet | 配额充足、关键架构工作 |
| `balanced` | 仅规划用 Opus，其余一切用 Sonnet | 常规开发（默认） |
| `budget` | 代码编写用 Sonnet，研究/验证用 Haiku | 大批量工作、不太关键的阶段 |
| `inherit` | 所有 agent 使用当前会话模型 | 动态模型切换、**非 Anthropic 提供商**（OpenRouter、本地模型） |

---

## 模型策略预设（`model_policy`）— v1.42 新增

> **[#49](https://github.com/open-gsd/gsd-core/issues/49)** — 提供商中立的模型策略配置界面。在旧版 `model_profile_overrides` 之前解析。

`model_policy` 提供了一种更简单、提供商中立的方式来跨运行时配置模型层级。对于手动知道正确模型 ID 需要使用 `model_profile_overrides` 的非 Anthropic 运行时，这是首选界面。通过 `/gsd:settings` → 第 8 节（模型策略）配置。

### 已知提供商预设

通过设置工作流选择提供商和预算级别；GSD 为该提供商/预算组合写入规范模型 ID：

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "budget": "medium",
    "high":   "gpt-5.6-sol",
    "medium": "gpt-5.6-terra",
    "low":    "gpt-5.6-luna"
  }
}
```

已知提供商：`openai`、`anthropic`、`anthropic-fable`、`google`、`qwen`。预算级别：`high`、`medium`、`low`。使用 `anthropic` 保留基于 Opus 4.8 的 Claude 预设，或使用 `anthropic-fable` 在高预算路由中选择 Claude Fable 5。

对于高级的按运行时控制，`runtime_tiers` 接受使用内部配置文件层级名称（`opus`、`sonnet`、`haiku`）的显式条目：

```json
{
  "runtime": "codex",
  "model_policy": {
    "provider": "openai",
    "runtime_tiers": {
      "codex": {
        "opus":   { "model": "gpt-5.6-sol",        "reasoning_effort": "high" },
        "sonnet": { "model": "gpt-5.6-terra",     "reasoning_effort": "medium" },
        "haiku":  { "model": "gpt-5.6-luna",      "reasoning_effort": "low" }
      }
    }
  }
}
```

### 通用提供商（逃生舱口）

对于 OpenRouter、LiteLLM、本地网关或任何需要提供精确模型 ID 的运行时，使用 `provider: "generic"`（或 `"custom"`）。GSD 将模型 ID 视为不透明字符串——无前缀推断，无提供商特定默认值：

```json
{
  "runtime": "opencode",
  "model_policy": {
    "provider": "generic",
    "high":   "openrouter/anthropic/claude-opus-4-5",
    "medium": "openrouter/anthropic/claude-sonnet-4-5",
    "low":    "openrouter/anthropic/claude-haiku-4-5"
  }
}
```

### 推理努力门控

`runtime_tiers` 条目中的 `reasoning_effort` 仅转发给声明支持它的运行时（当前：`codex`）。不在允许列表中的任何运行时都不接收该字段——它被静默剥离，从不泄露。

### 优先级

`model_policy` 解析位于解析器中 `model_profile_overrides` 之上：

1. `model_overrides[<agent>]` — 按 agent 显式 ID（最高）
2. `model_policy.runtime_tiers[<runtime>][<tier>]` — 显式运行时/层级条目
3. `model_policy` 扁平 `high`/`medium`/`low` 键 — 用于 `generic`/`custom` 提供商
4. `model_profile_overrides[<runtime>][<tier>]` — 旧版按运行时覆盖
5. 内置运行时目录默认值
6. `model_profile` 层级别名

**向后兼容性。** 没有 `model_policy` 的配置不受影响。现有的 `model_profile_overrides` 块继续完全按之前工作。

---

## 环境变量

| 变量 | 用途 |
|----------|---------|
| `CLAUDE_CONFIG_DIR` | 覆盖默认配置目录（`~/.claude/`） |
| `GEMINI_API_KEY` | 由上下文监控器检测以切换钩子事件名称 |
| `GSD_AUDIT` | 设置为 `1` 以启用调度审计文件（`.planning/.gsd-trace.jsonl`） |
| `GSD_AUDIT_ARGS` | 设置为 `1` 以在审计/错误事件中包含命令参数（默认省略） |
| `GSD_PROJECT` | 覆盖多项目工作空间支持的项目根目录（v1.32） |
| `GSD_SKIP_SCHEMA_CHECK` | 跳过执行阶段期间的 schema 漂移检测（v1.31） |
| `WSL_DISTRO_NAME` | 由安装器检测以处理 WSL 路径 |

---

## 全局默认值

将设置保存为未来项目的全局默认值：

**位置：** `~/.gsd/defaults.json`

当 `/gsd-new-project` 创建新的 `config.json` 时，它读取全局默认值并将其作为初始配置合并。按项目设置始终覆盖全局设置。

---

## 可观测性

命令路由中心在每次调度后发出结构化的 `DispatchEvent`。默认行为是**成功时静默**，**错误时向 stderr 输出一行结构化 JSON**。

### Stderr 错误格式

当调度失败时，向 stderr 输出一行 JSON：

```json
{ "kind": "HandlerFailure", "traceId": "...", "command": "plan", "timestamp": "...", "message": "..." }
```

`kind` 字段匹配中心的错误变体之一：`UnknownCommand`、`InvalidArgs`、`HandlerRefusal` 或 `HandlerFailure`。参数默认省略（隐私）；参见下方 `GSD_AUDIT_ARGS`。

### 审计跟踪（选择性启用）

启用仅追加审计文件以记录每次调度（成功和错误）：

**通过环境变量：**
```bash
GSD_AUDIT=1 gsd plan
```

**通过配置（`config.audit.enabled`）：**
```json
{
  "audit": {
    "enabled": true
  }
}
```

**审计文件位置：** `.planning/.gsd-trace.jsonl`（已 gitignore）

每行都是一个完整的 `DispatchEvent` JSON 对象，包含 `traceId`（每次调度的唯一 UUID v4）和 `parentTraceId`（当调用者将 `req.parentTraceId` 传入 `Hub.dispatch` 时存在）。未来的初始化编排器（第 2 阶段）将自动连接 `parentTraceId`，使单个顶层调用的所有子调度共享一个公共父级；在此之前，叶子调度发出 `parentTraceId: undefined`。您可以通过在审计文件上过滤 `parentTraceId === <rootTraceId>` 来将子事件关联到父级。文件为仅追加，从不截断；需要时手动轮换或删除。`parentTraceId` 必须是规范的 UUID v4（RFC 4122，格式 `xxxxxxxx-xxxx-4xxx-[89ab]xxx-xxxxxxxxxxxx`）；不匹配此格式的值会从发出的事件中静默删除，不会出现在审计输出中。

### 参数编辑

默认情况下，命令参数从所有发出的事件（stderr 错误和审计文件）中**省略**。要逐字包含参数：

```bash
GSD_AUDIT_ARGS=1 GSD_AUDIT=1 gsd plan --tdd
```

`GSD_AUDIT_ARGS` 同时适用于 stderr 错误行和审计文件。

---

## 相关链接

- [命令参考](COMMANDS.md)
- [配置模型配置文件](how-to/configure-model-profiles.md)
- [STATE.md schema](reference/state-md.md)
- [文档索引](README.md)
