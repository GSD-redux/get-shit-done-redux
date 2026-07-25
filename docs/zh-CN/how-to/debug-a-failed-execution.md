# 如何调试失败的执行

**目标：** 在某个阶段执行失败、卡住或产生不完整工作时进行恢复，并在不丢失进度或重复已成功工作的情况下干净地继续。

**前提条件：** 您已运行 `/gsd-execute-phase N`，执行在写入 `VERIFICATION.md` 之前停止，或者您看到意外输出、缺少文件，或进度条卡住不动。

---

## 判断执行是卡住还是失败

在采取任何恢复操作之前，先确认实际发生了什么。

### 如果您看到"Spawning…"后超过 1–5 分钟没有输出

这是正常现象，并非冻结。GSD 子代理在独立的上下文窗口中运行。spawn 行上的存活注释可以确认这一点。请不要中断会话。

如果超过 10 分钟仍无结果，请检查 Claude Code 侧边栏。如果代理任务显示已完成但没有输出，结果可能在上下文切换中丢失——请重新运行相同的命令：

```bash
/gsd-execute-phase 1
```

GSD 在分派执行器之前会检查 `SUMMARY.md` 文件。已有该文件的计划将被自动跳过。

### 如果执行在某个 wave 中途停止并显示错误信息

检查 git 历史记录，查看哪些计划已成功提交：

```bash
git log --oneline -20
```

已提交工作的计划会有类似 `feat(01-02): …` 的条目。没有提交的计划是不完整的，重新运行时会被重新执行。

### 如果执行器已提交代码但未写入 SUMMARY.md

GSD 会在下次运行时检测到这一情况，并弹出一个安全恢复确认界面，提供三个选项：

- **手动收尾** — 自行检查提交内容，写入 `SUMMARY.md`，然后重新运行。
- **从头重新执行** — 在分派新执行器之前，回滚或覆盖部分提交。
- **标记并跳过** — 记录异常并继续，仅在您明确确认后执行。

---

## 诊断根本原因

### 运行 `/gsd-debug --diagnose`

如果执行产生了错误输出、存根代码或验证失败，使用诊断模式进行调查，而不应用任何修复：

```bash
/gsd-debug --diagnose "Phase 2 executor produced stubs instead of real code"
```

`--diagnose` 在找到根本原因后停止，不修改您的文件。它会在 `.planning/debug/<slug>.md` 创建一个会话文件，以便您在需要时稍后继续调查。

要启动同时应用修复的完整调试会话：

```bash
/gsd-debug "Login middleware not handling 401 correctly after phase 3"
```

GSD 收集症状，使用科学方法进行结构化调查，并提出修复方案。如果您的配置中设置了 `tdd_mode: true`，则在应用任何修复之前需要先有一个失败的测试。

### 查看活动调试会话

```bash
/gsd-debug list
```

显示所有打开的会话及其当前假设和下一步操作。要恢复特定会话：

```bash
/gsd-debug continue <slug>
```

---

## 使用 `/gsd-forensics` 进行事后分析

如果根本原因从错误输出中无法判断——例如，计划引用了不存在的文件、执行产生了意外结果，或状态似乎已损坏——请运行取证调查：

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

GSD 分析 git 历史记录、`.planning/` 制品完整性、STATE.md 一致性、未提交的工作和孤立的 worktree。它将结构化报告写入 `.planning/forensics/report-<timestamp>.md`，并给出推荐的修复步骤。

`/gsd-forensics` 是只读的——它不会修改您的项目文件。

**可检测的问题：**

- **卡死循环** — 同一文件在短时间内出现在三个或更多连续提交中（如果提交消息相似，则置信度为 HIGH）
- **缺失制品** — 某阶段有提交但没有 `SUMMARY.md` 或 `VERIFICATION.md`
- **遗弃的工作** — 存在未提交的更改，且 STATE.md 显示执行进行到一半，最后一次提交超过两小时前
- **崩溃或中断** — 未提交的更改结合活动的执行状态和孤立的 worktree
- **范围漂移** — 最近的提交触及了当前阶段预期文件集之外的文件

---

## 恢复后继续执行

一旦底层问题解决，重新运行执行命令：

```bash
/gsd-execute-phase 1
```

GSD 会跳过 `SUMMARY.md` 已存在的计划，仅为剩余计划分派执行器。

如果您只需要重新执行特定的 wave：

```bash
/gsd-execute-phase 1 --wave 2
```

---

## 使用 `/gsd-undo` 回滚

如果执行产生了您想完全丢弃的代码，请使用计划清单进行回滚，而不是手动 `git revert`：

### 回滚单个计划

```bash
/gsd-undo --plan 03-02
```

回滚阶段 `3` 中计划 `02` 的所有提交。GSD 在写入任何更改之前会显示确认界面。

### 回滚整个阶段

```bash
/gsd-undo --phase 03
```

回滚阶段 `3` 的所有提交。GSD 会检查后续阶段是否依赖该阶段，并在继续之前发出警告。

### 从最近的提交中交互式选择

```bash
/gsd-undo --last 5
```

显示最近五个 GSD 提交，让您选择要回滚的内容。

---

## 中断后恢复会话上下文

如果您在上下文重置或新会话后返回项目：

```bash
/gsd-resume-work
```

从上次交接中恢复您的完整会话上下文，包括当前阶段、阻塞项以及执行停止的位置。

或者，要查看当前进度并自动跳转到下一个正确步骤：

```bash
/gsd-progress --next
```

---

## 相关内容

- [执行阶段](execute-a-phase.md)
- [恢复与故障排查](recover-and-troubleshoot.md)
- [命令](../COMMANDS.md)
- [文档索引](../README.md)
