# 如何配置模型配置文件

为您的项目选择合适的模型层级策略，然后在不编写大型覆盖块的情况下调整单个代理或整个阶段类型。本指南从最简单的控制选项开始，逐步介绍到动态路由。

---

## 四种配置文件（以及 `adaptive` 和 `inherit`）

在 `.planning/config.json` 中设置 `model_profile`，或通过 `/gsd-config --profile <name>` 设置：

| 配置文件 | 规划器 | 执行器 | 研究员 | 验证器 | 适用场景 |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | 对成本要求较低、注重生产质量的工作 |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | 常规开发——默认选项 |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | 快速原型开发、成本敏感场景 |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | 与其他层级在运行时感知配置文件下的解析方式相同；在频繁切换运行时环境时使用 |
| `inherit` | （会话模型） | （会话模型） | （会话模型） | （会话模型） | 非 Anthropic 提供商（OpenRouter、本地模型）——所有代理遵循当前会话模型 |

上表展示的是代表性子集。全部 33 个内置代理在 `gsd-core/bin/shared/model-catalog.json` 中均有明确的按配置文件层级分配。完整表格请参阅配置参考中的 [模型配置文件](../CONFIGURATION.md#model-profiles)。

**通过命令快速切换：**

```bash
/gsd-config --profile balanced   # Normal development
/gsd-config --profile budget     # Prototyping or high-cost phases
/gsd-config --profile quality    # Production release
/gsd-config --profile inherit    # OpenRouter, local models
```

**或直接编辑 `.planning/config.json`：**

```json
{
  "model_profile": "balanced"
}
```

---

## 按代理覆盖（`model_overrides`）

如果某个代理需要不同的层级而不想更改整个配置文件，请使用 `model_overrides`：

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

有效值：`opus`、`sonnet`、`haiku`、`inherit`，或任何完全限定的模型 ID（例如 `"openai/o3"`、`"google/gemini-2.5-pro"`）。

`model_overrides` 可在 `.planning/config.json` 中按项目设置，也可在 `~/.gsd/defaults.json` 中全局设置。项目级条目在冲突时优先；不冲突的全局条目会被保留。

**关于 Codex 和 OpenCode 的重要说明：** 这些运行时会在安装时将解析后的模型嵌入每个代理的静态配置中。编辑 `model_overrides` 后，需重新运行安装程序使更改生效：

```bash
npx @opengsd/gsd-core@latest --codex --global   # or --opencode, --kilo, etc.
```

---

## 按阶段类型设置模型（`models`）

如果您希望在不学习全部 33 个代理名称的情况下实现"规划阶段用 Opus、其余用 Sonnet"的效果，请使用 `models` 块。它将六种阶段类型映射到层级别名：

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

阶段类型及其对应的代理：

| 阶段类型 | 涵盖的代理 |
|---|---|
| `planning` | `gsd-planner`、`gsd-roadmapper`、`gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`、`gsd-project-researcher`、`gsd-research-synthesizer`、`gsd-codebase-mapper`、`gsd-ui-researcher` |
| `execution` | `gsd-executor`、`gsd-debugger`、`gsd-doc-writer` |
| `verification` | `gsd-verifier`、`gsd-plan-checker`、`gsd-integration-checker`、`gsd-nyquist-auditor`、`gsd-ui-checker`、`gsd-ui-auditor`、`gsd-doc-verifier`、`gsd-code-reviewer` |
| `discuss` | `gsd-assumptions-analyzer` |
| `completion` | 保留——目前无子代理；已被模式接受以备向后兼容 |

`models` 块仅接受层级别名（`opus`、`sonnet`、`haiku`、`inherit`）。如需使用完全限定的模型 ID，请改用按代理设置的 `model_overrides`。

**将 `models` 与按代理例外结合使用：**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

全部五个研究代理解析为 `sonnet`，*除* `gsd-codebase-mapper` 被固定为 `haiku` 之外。

---

## 动态路由——默认使用低成本层级，失败时升级

如果您希望默认使用较低成本的层级，仅在代理未通过质量门控时才升级，请启用 `dynamic_routing`：

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

每个代理都有一个默认层级（`light`、`standard` 或 `heavy`）。第一次尝试时，GSD Core 选择 `tier_models[default_tier]`。如果编排器检测到软失败（验证不确定、计划检查被标记等），则将代理提升一级重新启动。`max_escalations` 限制总重试次数。

已处于 `heavy` 层级的代理无法进一步升级。

**在保留动态解析的同时关闭升级：**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

无论结果如何，每次尝试都使用 `tier_models[default_tier]`——适用于希望明确指定层级到模型的映射但不需要升级行为的场景。

`dynamic_routing` **默认禁用**。省略该块或设置 `enabled: false` 将保留静态解析。

---

## 在非 Anthropic 运行时上使用 GSD Core

如果您为 Codex、OpenCode、Gemini CLI 或 Kilo 安装了 GSD Core，安装程序已在您的配置中设置了 `resolve_model_ids: "omit"`。这告知 GSD Core 跳过 Anthropic 模型 ID 解析，让运行时选择其自己的默认模型。基本情况下无需手动设置。

**如果您希望在 Codex 上使用分层模型：**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

GSD Core 将每个层级别名解析为运行时层级映射中定义的 Codex 原生模型和推理力度。

**如果您希望在任意非 Claude 运行时上使用按代理模型 ID：**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

有关完整的运行时感知配置文件参考及 `model_policy` 接口（v1.42 中新增的提供商中立预设），请参阅[配置参考——模型配置文件](../CONFIGURATION.md#model-profiles)。

---

## 解析优先级（从高到低）

当多个层级同时适用时，解析器选取优先级最高的条目：

```text
1. model_overrides[<agent>]           — per-agent; full IDs; targeted exception
2. dynamic_routing.tier_models[<tier>] — when enabled; escalates on soft failure
3. models[<phase_type>]               — coarse phase-level tier
4. model_profile (per-agent column)   — global tier strategy
5. Runtime default                    — when nothing else applies
```

---

## 选择合适的控制选项

| 您的需求 | 使用 |
|---|---|
| 对所有代理采用统一的层级策略 | `model_profile` |
| 粗粒度的阶段级调整（"规划阶段用 Opus"） | `models.<phase_type>` |
| 按代理精细控制（"强制代码库映射器使用 Haiku"） | `model_overrides[<agent>]` |
| 为特定代理指定完全限定的模型 ID | `model_overrides[<agent>]: "openai/gpt-5"` |
| 默认低成本，仅在失败时升级 | `dynamic_routing` |
| 所有代理遵循会话模型（非 Anthropic 提供商） | `model_profile: "inherit"` |

---

## 相关文档

- [配置参考](../CONFIGURATION.md)
- [多代理编排](../explanation/multi-agent-orchestration.md)
- [命令参考](../COMMANDS.md)
- [文档索引](../README.md)
