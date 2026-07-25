# 如何执行阶段

**目标：** 通过基于波次的并行执行来运行已规划的阶段，并将每个计划作为原子性 git 提交落地。

**前置条件：** 该阶段至少有一个 `PLAN.md` 文件。如果规划尚未完成，请先运行 `/gsd-plan-phase N` —— 参见[规划阶段](plan-a-phase.md)。

---

## 运行完整阶段

```bash
/gsd-execute-phase 1
```

GSD Core 读取阶段的计划文件，将其按依赖关系分组为若干波次，并为每个计划生成独立的执行器代理。每个执行器在下一波次开始前以原子方式提交其工作。

在分发任何代理之前，GSD Core 会打印波次表：

```
## Execution Plan

Phase 1: Core middleware — 3 plans across 2 wave(s)

| Wave | Plans          | What it builds            |
|------|----------------|---------------------------|
| 1    | 01-01, 01-02   | Core validation function  |
| 2    | 01-03          | Express middleware wrapper |
```

第 1 波次的计划并行运行（每个在独立的 git 工作树中）。第 2 波次等待所有第 1 波次提交合并后才开始。

关于底层代理协调模型，请参见[多代理编排](../explanation/multi-agent-orchestration.md)。

---

## 运行单个波次

如果只想执行一个波次——例如，在进入第 2 波次之前先检查第 1 波次的输出——请使用 `--wave N`：

```bash
/gsd-execute-phase 1 --wave 2
```

GSD Core 仅执行第 2 波次的计划。它会首先检查所有较早波次是否已完成；如果任何第 1 波次计划仍标记为未完成，则会停止并提示你先完成较早波次。

---

## 恢复停滞的执行

如果执行中途停止——配额错误、网络断开或会话崩溃——波次级别的进度会被保留。GSD Core 会检查每个计划的 `SUMMARY.md` 文件；已有该文件的计划在重新运行时会自动跳过：

```bash
/gsd-execute-phase 1
```

GSD Core 会跳过 `SUMMARY.md` 已存在的计划，并从第一个未完成的计划继续。

**如果提交存在但 `SUMMARY.md` 缺失**（执行器已提交，但在会话结束前未写入摘要），GSD Core 会弹出一个安全恢复门并提供三个选项：

- `close out manually` — 检查提交，手动编写 `SUMMARY.md`，然后重新运行。
- `re-execute from scratch` — 在分发新执行器前回滚或替代部分提交。
- `mark-and-skip` — 记录异常并继续，仅在明确确认后执行。

关于系统性故障诊断，请参见[调试失败的执行](debug-a-failed-execution.md)。

---

## 输出位置

所有波次完成后，阶段目录包含：

```
.planning/phases/01-<name>/
  01-01-SUMMARY.md    # What plan 01 built, key files, deviations
  01-02-SUMMARY.md
  01-03-SUMMARY.md
  VERIFICATION.md     # Requirement-by-requirement pass/fail status
```

所有波次完成后，`STATE.md` 和 `ROADMAP.md` 会自动更新。`VERIFICATION.md` 仅在阶段完全完成时写入。

Git 历史记录中每个任务会有一个提交（来自各执行器），随后是编排器的跟踪提交。

---

## 跨 AI 执行

要将执行委托给在 `workflow.cross_ai_command` 中配置的外部 AI CLI（Codex、Gemini 等）：

```bash
/gsd-execute-phase 2 --cross-ai
```

要在配置中启用跨 AI 时强制本地执行：

```bash
/gsd-execute-phase 2 --no-cross-ai
```

---

## 相关内容

- [规划阶段](plan-a-phase.md)
- [验证与发布](verify-and-ship.md)
- [调试失败的执行](debug-a-failed-execution.md)
- [命令参考](../COMMANDS.md)
