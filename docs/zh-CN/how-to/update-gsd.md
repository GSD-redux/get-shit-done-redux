# 如何更新 GSD Core

将现有的 GSD Core 安装更新到最新版本，在确认前预览变更日志，并恢复可能被更新覆盖的本地自定义配置。

**所需条件：** 与 GSD 安装时相同的运行时环境。更新命令在后台重新运行安装程序，因此需要 Node.js 和 npx（与最初安装时的要求相同）。

---

## 标准更新流程

在 AI 运行时内，执行：

```bash
/gsd-update
```

GSD 将执行以下操作：

1. 检测已安装的版本和安装范围（全局或本地）。
2. 通过 npm 检查 `@opengsd/gsd-core` 的最新版本。
3. 获取变更日志，并显示您已安装版本与最新版本之间的变更内容。
4. 在执行任何操作前请求确认。
5. 将 GSD 管理目录中发现的用户添加文件备份至 `gsd-user-files-backup/`。
6. 运行安装程序（`npx @opengsd/gsd-core@latest --<runtime> --<scope>`）。
7. 清除更新检查缓存，使状态栏指示器重置。
8. 报告本地修改的 GSD 文件是否已备份至 `gsd-local-patches/`。

更新完成后请重启运行时，以加载新的命令和代理。

---

## 命令标志

| 标志 | 功能说明 |
|------|--------------|
| `--sync` | 更新后，从 GSD 注册表同步技能 |
| `--reapply` | 更新后，将 `gsd-local-patches/` 中本地修改的 GSD 文件合并回来 |

```bash
/gsd-update --sync        # Update and sync skills
/gsd-update --reapply     # Update and reapply local patches
```

---

## 更新前查看变更日志

`/gsd-update` 在请求确认*之前*，始终会显示您已安装版本与最新版本之间的变更日志差异。您无需另行访问 GitHub。输出内容如下所示：

```text
## GSD Update Available

Installed: 1.39.0
Latest:    1.41.0

### What's New

---

[changelog entries for 1.40.0 and 1.41.0]

---

Proceed with update? [Yes, update now / No, cancel]
```

如果无法获取变更日志（无网络访问、npm 中断），更新在确认后仍会继续进行——不会因变更日志不可用而被阻断。

---

## 恢复本地自定义配置

### 您在 GSD 管理目录中添加的文件

如果您在 GSD 管理的目录中放置了自定义文件（例如，以 `gsd-` 为前缀的自定义代理，或 `commands/gsd/` 中的额外文件），安装程序会在清除这些目录前检测到它们，并将其复制到 `gsd-user-files-backup/`。更新完成后，请从该备份位置手动恢复这些文件。

您放置在 GSD 管理目录之外的文件——不以 `gsd-` 为前缀的自定义代理、`commands/gsd/` 之外的自定义命令、您的 `CLAUDE.md` 文件以及自定义钩子——安装程序不会对其进行任何操作。

### 您直接修改的 GSD 文件

如果您编辑了 GSD 安装的某个文件（例如，调整了某个代理的系统提示），安装程序会通过与清单的哈希比对检测到该修改，将文件备份至 `gsd-local-patches/`，然后用新版本替换它。更新完成后，执行：

```bash
/gsd-update --reapply
```

此命令会将您在 `gsd-local-patches/` 中的修改合并回新安装的文件中。

如果您在之前的更新后跳过了 `--reapply`，现在想应用补丁，执行：

```bash
/gsd-update --reapply
```

单独运行 `--reapply` 而不触发新下载是安全的——如果您已是最新版本，GSD 会跳过安装步骤，直接执行补丁重新应用。

---

## 当 npm 不可用时

如果 `npx @opengsd/gsd-core@latest` 因 npm 中断、网络限制，或因您正在使用源代码仓库而失败，请使用 [docs/manual-update.md](../../manual-update.md) 中的手动更新流程。该文档涵盖拉取最新提交、构建钩子分发包以及直接运行 `node bin/install.js` 的步骤。

---

## 如果您已是最新版本

`/gsd-update` 会提前退出并显示确认消息——无需下载、无需安装、无需重启。

---

## 安装程序迁移

每个 GSD 版本可能包含安装程序迁移，用于重命名、移动或停用管理文件。迁移层会在写入新包内容之前自动运行。会影响您已修改文件的迁移操作将提示确认，而不是静默执行。有关完整设计和运行时配置合约注册表，请参阅 [docs/installer-migrations.md](../../installer-migrations.md)。

---

## 相关内容

- [在您的运行时上安装](install-on-your-runtime.md)
- [命令参考](../COMMANDS.md)
- [手动更新](../../manual-update.md)
- [安装程序迁移](../../installer-migrations.md)
- [文档索引](../README.md)
