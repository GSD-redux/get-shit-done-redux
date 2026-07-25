# 如何规划阶段

**目标：** 将阶段决策和研究成果转化为可原子化执行、可验证的任务计划。

**前提条件：** `.planning/ROADMAP.md` 已存在。强烈建议（但非必须）先通过 `/gsd-discuss-phase` 生成 `{phase}-CONTEXT.md`。

---

## 运行标准规划流程

```bash
/gsd-plan-phase 2
```

该命令按顺序执行三个阶段：

1. **研究** — `gsd-phase-researcher` 子代理调查相关领域并写入 `{phase}-RESEARCH.md`。
2. **规划** — `gsd-planner` 子代理读取上下文、研究成果和需求，然后写入一个或多个 `{phase}-{N}-PLAN.md` 文件。
3. **验证** — `gsd-plan-checker` 子代理从八个维度验证计划质量，并触发修订循环（最多三次迭代），直至质量门控通过。

若未指定阶段编号，GSD Core 将自动定位 ROADMAP.md 中下一个未规划的阶段。

---

## 跳过或强制执行研究

**如果领域已熟悉且无需新的研究：**

```bash
/gsd-plan-phase 3 --skip-research
```

**如果 RESEARCH.md 已存在但需要强制刷新：**

```bash
/gsd-plan-phase 3 --research
```

**如果只想运行研究** — 写入 RESEARCH.md 后在规划前退出：

```bash
/gsd-plan-phase --research-phase 4
```

若 RESEARCH.md 已存在，系统会提示选择更新、查看或跳过。如需强制刷新而不显示提示：

```bash
/gsd-plan-phase --research-phase 4 --research
```

将现有 RESEARCH.md 打印到标准输出而不启动研究代理：

```bash
/gsd-plan-phase --research-phase 4 --view
```

注意：`--research-phase <N>` 是 `/gsd-plan-phase` 上的标志。不存在独立的研究阶段命令——原来的独立研究命令已被弃用，以此标志取而代之。

---

## 按垂直功能切片而非水平层次进行规划

**如果希望任务按端到端的薄切片组织**（每个功能从 UI → API → DB），而非按技术层次：

```bash
/gsd-plan-phase 1 --mvp
```

在新项目的第一阶段且无先前阶段摘要的情况下，`--mvp` 还会生成 `SKELETON.md`——一份 Walking Skeleton，涵盖项目脚手架、路由、一次真实的数据库读写、一次真实的 UI 交互以及开发部署。

也可在 ROADMAP.md 中该阶段的条目里添加 `**Mode:** mvp`，无需每次使用标志即可持久启用 MVP 模式。

---

## 要求每个新增行为任务包含一个失败测试

**如果需要强制 TDD** — 每个新增行为的任务在实现前先编写一个失败测试：

```bash
/gsd-plan-phase 1 --tdd
```

可与 `--mvp` 组合使用：

```bash
/gsd-plan-phase 1 --mvp --tdd
```

这将生成垂直切片，其中每个新增行为的任务均遵循 RED → GREEN → REFACTOR 流程。规划器会对符合条件的任务（业务逻辑、API 端点、数据转换）应用 `type: tdd`，并对 UI、配置和胶水代码使用标准的 `type: execute`。

TDD 模式也可在配置中持久化：

```bash
node gsd-tools.cjs config-set workflow.tdd_mode true
```

---

## 基于跨 AI 评审反馈重新规划

**如果已运行 `/gsd-review --phase N` 且存在 `REVIEWS.md`：**

```bash
/gsd-plan-phase 3 --reviews
```

规划器会读取 `REVIEWS.md` 并修订计划以解决反馈问题。不可与 `--gaps` 组合使用。

**如果需要自动化循环** — 持续重新规划和重新评审，直至不再存在 HIGH 级别关注点：

```bash
/gsd-plan-review-convergence 3
```

收敛循环执行规划 → 评审 → 重新规划 → 再评审的周期（默认最多三次）。使用 `--max-cycles N` 可覆盖上限。

---

## 在验证失败后弥补差距

**如果 `VERIFICATION.md` 存在未解决的差距，且只想针对这些差距重新规划：**

```bash
/gsd-plan-phase 3 --gaps
```

研究阶段将被跳过；规划器直接读取验证中的差距信息。

---

## 规划完成后运行外部弹跳验证

**如果已配置 `workflow.plan_bounce_script` 且需要对完成的计划进行外部验证：**

```bash
/gsd-plan-phase 1 --bounce
```

即使在配置中已启用弹跳，也可跳过：

```bash
/gsd-plan-phase 1 --skip-bounce
```

---

## 禁止交互式确认

```bash
/gsd-plan-phase --auto
```

跳过所有提示。适用于自动化流水线。若配置中 `research_enabled` 为 false，则跳过研究阶段。

---

## 计划输出内容

成功运行后会写入以下文件：

| 文件 | 用途 |
|---|---|
| `{phase}-RESEARCH.md` | 领域研究、软件包合法性审计、验证架构 |
| `{phase}-VALIDATION.md` | 奈奎斯特测试映射——计划必须满足的测试用例（第 8 维度） |
| `{phase}-{N}-PLAN.md` | 包含前置信息、波次分配和验收标准的可执行任务计划 |
| `{phase}/SKELETON.md` | Walking Skeleton（MVP 模式，仅限新项目的第一阶段） |

每个 PLAN.md 包含带有强制 `<read_first>` 和 `<acceptance_criteria>` 字段的任务。每个 `<acceptance_criteria>` 条目均可作为源断言、行为断言、测试命令或 CLI 输出进行验证——绝不使用主观性语言。

完整的字段参考请参阅 [PLAN.md 模式](../reference/plan-md.md)。

### 计划质量维度

`gsd-plan-checker` 在允许执行前从八个维度验证计划：

1. 任务原子性——每个任务只关注单一问题
2. 依赖正确性——波次顺序一致
3. 验收标准可验证性——无主观标准
4. `<read_first>` 完整性——被修改的文件始终列入其中
5. 具体的 `<action>` 值——无模糊的"对齐"类指令
6. `must_haves` 源自阶段目标
7. 需求 ID 覆盖率——每个阶段需求 ID 至少出现在一个计划中
8. 奈奎斯特测试映射——计划涵盖 VALIDATION.md 中的验证策略

修订循环最多运行三次。若三次迭代后质量门控仍未通过，检查器将显示剩余问题供人工审查。

---

## 重新规划已关闭的阶段

如果某阶段的 `VERIFICATION.md` 中 `status: passed`，则该阶段被视为已关闭。尝试重新规划会以错误终止。如果关闭操作有误，可使用 `--force` 覆盖：

```bash
/gsd-plan-phase 2 --force
```

警告信息将写入转录记录和所有已提交的计划文档中。

---

## 相关内容

- [讨论阶段](discuss-a-phase.md)
- [执行阶段](execute-a-phase.md)
- [PLAN.md 模式](../reference/plan-md.md)
- [命令](../COMMANDS.md)
