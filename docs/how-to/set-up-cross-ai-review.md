# How to set up cross-AI review

**Goal:** Configure which AI reviewers participate in plan review, run a review of a planned phase, and use the feedback to converge on a plan with no HIGH-severity concerns.

**Prerequisites:** The phase has been planned (`{phase}-PLAN.md` files exist in `.planning/phases/`). At least one external AI CLI is installed and authenticated.

---

## Decide which reviewers to use

GSD Core can route review requests to any combination of: Gemini CLI, Claude (separate session), Codex CLI, CodeRabbit, OpenCode, Qwen Code, Cursor, Antigravity CLI, Ollama, LM Studio, llama.cpp, and Kimi Code.

That list is not fixed. Each of those is a declared reviewer lane, and a capability can ship its own — see [Ship a reviewer lane in your capability](ship-a-reviewer-lane.md). To see exactly which lanes your installation has, run `gsd-tools review-lane sections`.

Each reviewer runs the same structured prompt against your `PLAN.md` files independently. Because different models have different blind spots, multi-reviewer consensus catches more issues than any single reviewer.

**If you have no external CLIs installed yet**, install at least one:

```bash
# Gemini CLI (free with Google credentials)
npm install -g @google/gemini-cli

# Antigravity CLI (free with Google credentials)
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Codex CLI
npm install -g @openai/codex
```

---

## Set default reviewers (optional)

By default, `/gsd-review` runs all detected CLIs. To pin a subset as project defaults:

```bash
/gsd-config --integrations
```

The integrations wizard covers API keys, code-review CLI routing, and the `review.default_reviewers` list. Set the list to the reviewers you want as the no-flag default — for example `["gemini","codex"]`.

Alternatively, set it directly with `gsd-tools`:

```bash
gsd config-set review.default_reviewers '["gemini","codex"]'
```

For the full integration settings schema (API keys, model overrides per reviewer, local server host addresses), see [Configuration](../CONFIGURATION.md).

If you need multiple independent reviewer voices from the same adapter, configure `review.reviewer_instances` and add those instance names to `review.default_reviewers`. Instance names run only through `review.default_reviewers`; they are not valid `/gsd-review` flags. See [Reviewer instances](../CONFIGURATION.md#reviewer-instances) for the schema.

---

## Run a review

### Standard review (uses your configured defaults or all detected CLIs)

```bash
/gsd-review --phase 3
```

GSD invokes each reviewer in sequence, collects structured feedback (Summary, Strengths, Concerns at HIGH/MEDIUM/LOW, Suggestions, Risk Assessment), and writes the combined output to `.planning/phases/03-.../03-REVIEWS.md`.

### Select a single reviewer for a one-off run

```bash
/gsd-review --phase 3 --gemini
/gsd-review --phase 3 --codex
/gsd-review --phase 3 --cursor
```

Any explicit flag overrides both the `--all` default and `review.default_reviewers` for that run.

### Run every available reviewer in parallel

```bash
/gsd-review --phase 3 --all
```

`--all` always overrides config and runs the full detected set, including any configured local model servers (Ollama, LM Studio, llama.cpp).

### Local model server reviewers

If you run Ollama or LM Studio locally, they are included automatically with `--all` when the server is reachable. You can also target them explicitly:

```bash
/gsd-review --phase 3 --ollama
/gsd-review --phase 3 --lm-studio
```

Configure the host addresses and model selection under `review.*` keys via `/gsd-config --integrations` if the defaults (`localhost:11434` / `localhost:1234`) do not apply.

---

## Read the review output

The `{padded_phase}-REVIEWS.md` file contains:

- Individual reviews from each reviewer with severity-classified concerns
- A **Consensus Summary** section that synthesises concerns raised by two or more reviewers — start here for the highest-priority signal
- A **Divergent Views** section for areas where reviewers disagreed

---

## Incorporate feedback into the plan

Once you have reviewed the output, replan incorporating the feedback:

```bash
/gsd-plan-phase 3 --reviews
```

The planner reads `REVIEWS.md` and adjusts the plans to address the concerns before saving.

---

## Automate the plan–review–replan loop

For phases where you want to iterate until all HIGH-severity concerns are resolved, use the convergence loop:

```bash
/gsd-plan-review-convergence 3
```

This runs `plan-phase → review → replan → re-review` up to three cycles (default). The loop exits when the HIGH-concern count reaches zero.

### Convergence with a specific reviewer

```bash
/gsd-plan-review-convergence 3 --codex
/gsd-plan-review-convergence 3 --gemini
```

### Convergence with all reviewers and a higher cycle cap

```bash
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

**Stall detection:** if the HIGH-concern count is not decreasing across cycles, GSD warns you. When the cycle cap is reached with open HIGH concerns, an escalation gate asks whether to proceed or review manually.

---

## Conditionals: which reviewers to choose

| Situation | Recommended approach |
|-----------|---------------------|
| You have Gemini CLI already installed | `--gemini` is always a good starting reviewer |
| You want free multi-reviewer coverage | `--gemini` + `--agy` (both use Google credentials) |
| Your project is OpenAI-heavy | add `--codex` for an OpenAI-model perspective |
| You want GitHub Copilot's model | add `--opencode` |
| You want to avoid API costs entirely | configure Ollama with a local model and use `--ollama` |
| You need maximum coverage before a release | `/gsd-plan-review-convergence N --all` |
| You're iterating quickly and want fast feedback | pick one CLI: `/gsd-review --phase N --gemini` |

---

## Related

- [Verify and ship](verify-and-ship.md)
- [Ship a reviewer lane in your capability](ship-a-reviewer-lane.md) — add a reviewer GSD does not ship with, by declaring it in a capability manifest
- [Configuration](../CONFIGURATION.md)
- [Commands](../COMMANDS.md)
- [docs index](../README.md)
