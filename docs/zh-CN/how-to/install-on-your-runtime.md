# 如何在您的运行时上安装 GSD Core

将 GSD Core（`@opengsd/gsd-core`）安装到您日常使用的 AI 编码运行时中。本指南提供各支持运行时的标准安装路径，以及适用于未安装 Node.js 的机器的手动安装路径。

**所需条件：** Node.js 18+ 及 npm（或 npx）。如果您没有 Node.js，请跳转至[不使用 Node.js 安装](#不使用-nodejs-安装)。

---

## 为什么需要安装程序

GSD Core 以 Claude Code 原生 frontmatter 格式分发代理和命令文件。每个支持的运行时需要不同的 schema、目录结构和命令调用语法。安装程序负责执行必要的转换——例如，为 OpenCode 转换工具列表和颜色值、为 Codex 写入 TOML 代理条目，以及将所有命令体从连字符格式（`/gsd-update`）重写为冒号格式（`/gsd-update`）以适配 Gemini CLI。

**请勿直接从 `agents/` 或 `commands/` 复制文件。** 这样做会绕过转换过程，导致 schema 验证错误或命令缺失。

---

## 标准安装

在任意目录运行安装程序。它会提示您选择运行时，以及是全局安装（所有项目）还是本地安装（仅此项目）。

```bash
npx @opengsd/gsd-core@latest
```

这是全新安装或切换运行时后重新运行安装程序所需的唯一命令。

---

## 各运行时安装说明

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

技能文件存放于 `~/.claude/`。下次 Claude Code 会话中，命令将以 `/gsd-*` 斜杠命令的形式出现。重启 Claude Code 以加载它们。

**覆盖安装目录：**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

技能文件存放于 `~/.gemini/`。安装程序将所有命令体重写为 Gemini 的冒号命名空间格式（`/gsd-update`、`/gsd-config` 等）。安装后重启 Gemini CLI。

**覆盖安装目录：**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

技能文件存放于 `~/.config/opencode/`（XDG）或 `~/.opencode/`。安装程序将代理 frontmatter 转换为 OpenCode 的 schema——移除 `tools:` 字段并将颜色值转换为十六进制格式。如需了解具体变更内容，请参阅[不使用 Node.js 安装 — OpenCode 转换](#opencode--必要转换)。

**覆盖安装目录：**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

技能文件存放于 `~/.config/kilo/`（XDG）或 `~/.kilo/`。使用与 OpenCode 相同的平铺 Markdown 命令格式。

**覆盖安装目录：**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

技能文件存放于 `~/.codex/skills/gsd-*/SKILL.md`。代理以每个代理独立的 TOML 条目写入 `config.toml`。安装后重启 Codex（或运行 `codex --reload`）。

**最低支持版本：** Codex CLI 0.130.0。更早版本额外扫描技能根目录，可能导致重复列出条目。

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

技能文件存放于 `~/.copilot/`。GSD 以代理 `.md` 文件和仓库指令文件的形式安装。

**覆盖安装目录：**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

技能文件存放于 `~/.cursor/`。GSD 安装技能、代理和规则引用。

**覆盖安装目录：**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

技能文件存放于 `~/.codeium/windsurf/`。GSD 安装技能、代理和工作区规则。

**覆盖安装目录：**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

Cline 使用基于规则的集成方式——GSD 以 `.clinerules` 形式安装，而非斜杠命令。

```bash
# 全局安装（所有项目）
npx @opengsd/gsd-core@latest --cline --global

# 本地安装（仅此项目）
npx @opengsd/gsd-core@latest --cline --local
```

全局安装写入 `~/.cline/`。本地安装写入 `./.cline/`。规则由 Cline 自动加载——不注册自定义斜杠命令。

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

技能文件存放于 `~/.codebuddy/skills/gsd-*/SKILL.md`。

---

### Qwen Code

Qwen Code 使用与 Claude Code 2.1.88+ 相同的开放技能标准。

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

技能文件存放于 `~/.qwen/skills/gsd-*/SKILL.md`。

**覆盖安装目录：**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

技能文件存放于 `~/.augment/`。GSD 安装技能和代理，不拥有 hook 或状态栏所有权。

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

安装程序自动检测 Antigravity 配置目录（`~/.gemini/antigravity`、`~/.gemini/antigravity-ide` 或 `~/.gemini/antigravity-cli`）。使用与 Gemini 兼容的设置策略。

**覆盖安装目录：**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

技能文件存放于 `~/.trae/`。GSD 安装技能、代理和规则引用。

---

## 本地安装与全局安装

上述所有示例均使用 `--global`，即为您的用户账户全局安装 GSD。若要将安装范围限定到单个项目，请将 `--global` 替换为 `--local`：

```bash
npx @opengsd/gsd-core@latest --claude --local
```

本地安装写入项目根目录下的 `.claude/` 目录。当全局安装和本地安装同时存在时，本地安装的设置优先于全局设置。

---

## 安装预发布版（Next / Nightly / Insiders / Preview）

运行时的预发布版（Windsurf Next、Cursor Nightly、VS Code Insiders、Codex 预览通道等）从同级配置目录读取配置。在运行安装程序前设置对应的 `*_CONFIG_DIR` 环境变量：

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

在安装程序提示中选择对应的稳定版运行时。GSD 不将预发布版作为独立命名运行时枚举——它们通过此环境变量机制提供尽力支持，不在发布 CI 中单独测试。

---

## 不使用 Node.js 安装

如果您无法运行 `npx`（例如在没有 Node.js 的 Windows 机器上），有两种方案可选。

**方案 A——使用有 Node.js 的机器。** 任何有 Node.js 的机器均可：WSL、Linux 虚拟机、CI runner 或 Docker 容器。在那台机器上运行安装程序，然后将输出目录复制到目标机器。以 OpenCode 为例：

```bash
npx @opengsd/gsd-core@latest --opencode --global
# 然后将 ~/.config/opencode/agents/ 复制到 Windows 机器
```

**方案 B——手动转换源文件。** 代理源文件位于 GSD Core 仓库的 `agents/` 目录下，格式为 Claude Code 原生 frontmatter 格式。每个运行时期望不同的结构。有关各运行时的具体字段转换说明，请参阅用户指南中的[手动安装 / 无 Node.js 设置](../USER-GUIDE.md#manual-install--no-nodejs-setup)，其中详细介绍了 OpenCode 的转换内容，并指向安装程序中其他运行时对应的 `convert*Frontmatter` 函数。

---

## 安装后

重启您的运行时以加载新命令和代理。然后启动新项目或接入现有仓库：

```bash
/gsd-new-project   # 新建项目
/gsd-onboard       # 现有代码库
```

如果重启后找不到该命令，请确认安装目录与运行时预期的配置路径匹配。上方的预发布版章节介绍了最常见的路径不匹配情况。

---

## 相关链接

- [您的第一个项目](../tutorials/your-first-project.md)
- [更新 GSD Core](update-gsd.md)
- [配置](../CONFIGURATION.md)
- [文档索引](../README.md)
