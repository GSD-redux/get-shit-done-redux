<purpose>
Socratic ideation workflow. Guides the developer through exploring an idea via probing questions,
offers mid-conversation research when useful, then routes crystallized outputs to GSD artifacts.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.

@~/.claude/gsd-core/references/questioning.md
@~/.claude/gsd-core/references/domain-probes.md
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-phase-researcher — Researches specific questions and returns concise findings
</available_agent_types>

<process>

## Step 1: Open the conversation

If a topic was provided, acknowledge it and begin exploring:
```
## Explore: {topic}

Let's think through this together. I'll ask questions to help clarify the idea
before we commit to any artifacts.
```

If no topic, ask:
```
## Explore

What's on your mind? This could be a feature idea, an architectural question,
a problem you're trying to solve, or something you're not sure about yet.
```

## Step 2: Socratic conversation (2-5 exchanges)

Guide the conversation using principles from `questioning.md` and `domain-probes.md`:

- Ask **one question at a time** (never a list of questions)
- Questions should probe: constraints, tradeoffs, users, scope, dependencies, risks
- Use domain-specific probes contextually when the topic touches a known domain
- Listen for signals: "or" / "versus" / "tradeoff" indicate competing priorities worth exploring
- Reflect back what you hear to confirm understanding before moving forward

**Conversation should feel natural, not formulaic.** Avoid rigid sequences. Follow the developer's energy — if they're excited about one aspect, go deeper there.

## Step 3: Mid-conversation research offer (after 2-3 exchanges)

If the conversation surfaces factual questions, technology comparisons, or unknowns that research could resolve, offer:

```
This touches on [specific question]. Want me to do a quick research pass before we continue?
This would take ~30 seconds and might surface useful context.

[Yes, research this] / [No, let's keep exploring]
```

If yes, spawn a research agent:

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

Resolve the researcher's model **and** the project's profile setting before dispatching. Both arm the
tier-floor guard below, and neither is sufficient alone. `--pick profile` returns the project's
**global `model_profile` setting** (`quality` | `balanced` | `budget` | `adaptive` | `inherit`) —
**not** the agent's effective resolved tier; `--raw` would drop it. `--pick model` returns the model
actually dispatched:

```bash
# Bootstrap gsd_run in THIS shell before the tier-floor probes below (#2543 B2): each
# fenced block is a fresh shell, so without this the probes hit an undefined gsd_run,
# return empty, and the floor would abstain every claim. Same resolver as Step 5.
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESEARCHER_MODEL=$(gsd_run query resolve-model gsd-phase-researcher --pick model 2>/dev/null || true)
RESEARCHER_PROFILE=$(gsd_run query resolve-model gsd-phase-researcher --pick profile 2>/dev/null || true)
```

Print: `◆ Spawning explorer... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`
```
Agent(
  prompt="Quick research: {specific_question}. Return 3-5 key findings, no more than 200 words. For EACH finding, first try to REFUTE it against a primary source, then label it [admit: <source>] (survives refute AND grounded), [refute: <source>] (a source contradicts it), or [abstain: <why>] (unverifiable, or a source conflicts with a strong prior). Every finding MUST carry exactly one of those three tags.",
  subagent_type="gsd-phase-researcher",
  model="{RESEARCHER_MODEL}"
)
```

<!-- #2517 model-omit-on-inherit -->

**Omit `model=` entirely when `RESEARCHER_MODEL` is `inherit` or empty** (#2517) — passing either
value through as an argument 404s on runtimes without native tier aliases. Every opus-tier agent
resolves to the literal `inherit`, so omission is the normal case, not an error path. See
@gsd-core/references/model-profile-resolution.md.

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

### Disposition the findings before sharing (three-way: admit / refute / abstain)

**Do not fold the findings into the narrative as flat assertions.** A research pass surfaces exactly the claims the model is measurably overconfident on (recent / version-drift facts). Route each surfaced claim (prior-knowledge or web) through a prompted-to-refute pass, then dispose it:

- **Admit** — the claim survives the refute pass **and** is grounded in a primary source → state it, **with the source**.
- **Refute** — a primary source contradicts it → drop or correct it, **with the source**.
- **Abstain** — unverifiable / no primary support, **or** a source conflicts with a strong prior (a **source-vs-prior** conflict) → put it in the **Unresolved ledger**, **never smoothed into the narrative**.

**Refute vs abstain — the deciding question is what the source settles, not how surprising it is.**
Both can be triggered by the same event (a source disagreeing with the claim), so decide by asking
whether the source is *authoritative for this claim*:

| Situation | Disposition |
|---|---|
| A primary source **for this claim's subject** states the opposite. The claim is simply wrong. | **Refute** — correct it, cite the source. |
| A source disagrees, but it is not authoritative for this claim (wrong version, adjacent subject, secondary/derivative), **or** two comparable sources disagree with each other. | **Abstain** — ledger it. |
| A source agrees but you could not reach a primary one at all. | **Abstain** — ledger it. |

Worked example: the claim is "Node 20+ required" and a source says "Node 22+ required." If that
source is the project's own `package.json` `engines` field or its published install docs, it is
authoritative → **refute**, and state 22+. If it is a blog post, a different package's docs, or a
release note for a version the claim did not name, it is not authoritative → **abstain**, and put
both readings in the ledger. "Strong prior" means your own pre-existing belief, which is never
authoritative on its own — it can only ever produce an abstain, never a refute.

Three guards ride with it:
- **Conflict-abstention** — a source-vs-prior conflict routes to the ledger, never a silent pick-a-side.
- **Tier floor** — present every would-be **admit** as an **abstain** instead when **either** signal
  bound above says the research ran on the cheapest tier — **or** when *neither* signal could be read
  at all:
  - `RESEARCHER_PROFILE` is `budget`, **or**
  - `RESEARCHER_MODEL` names a haiku-tier model — match `haiku` case-insensitively, which covers the
    bare alias (`haiku`) and the prefixed forms (`claude-haiku-4-5`, `anthropic/claude-haiku-4-5`), **or**
  - **both `RESEARCHER_MODEL` and `RESEARCHER_PROFILE` are empty** — `resolve-model` could not answer
    (the `2>/dev/null || true` on the resolve lines swallowed its failure). An *unknown* tier is
    treated as potentially-cheap and floored, never as verified-adequate: a resolver failure degrades
    to a stated default (abstain), it does not silently disarm the floor. This is a fail-safe default,
    not one of the disclosed escapes below.

  The budget tier for `gsd-phase-researcher` is `haiku` (`bin/shared/model-catalog.json`), which
  over-defers to whatever source it was handed, so a confident "grounded" label from that tier is not
  worth what it claims. `refute` and `abstain` are unaffected — the floor suppresses unearned
  confidence, it does not suppress corrections.

  **Both signals are required, because they catch different routes to the same tier.** In
  `resolveModelInternal` (`src/model-resolver.cts`) the per-agent `model_overrides[<agent>]` and the
  phase-type `models.research` lookups sit **above** the profile lookup, while `--pick profile` reports
  `config.model_profile` verbatim (`src/commands.cts`). So a project on `model_profile: balanced` with
  `models.research: "haiku"` — or `model_overrides.gsd-phase-researcher: "haiku"`, both documented
  patterns — dispatches a haiku model while the profile still reads `balanced`. Gating on the profile
  alone lets exactly that configuration present haiku-tier "grounded" admits at full confidence.

  **Disclosed residual — the floor is a narrowing, not a closure.** Three measured escapes remain:

  1. Runtimes whose budget tier is not an Anthropic model (`codex` → `gpt-5.6-luna`, `qwen` →
     `qwen3-coder-next`): only the profile signal fires.
  2. A per-agent `model_overrides` / `models.<phaseType>` / `model_policy` pin onto **any** non-`haiku`
     low-cost ID, on **any** runtime **including `claude`**: neither signal fires. Measured —
     `model_profile: balanced` + `model_overrides.gsd-phase-researcher: gemini-2.5-flash-lite`
     resolves that model while the profile still reads `balanced`.
  3. `model_profile: inherit`: `RESEARCHER_MODEL` is the literal `inherit`, `model=` is omitted per
     #2517, and the subagent silently inherits the session model — so neither signal describes what
     actually ran.

  Pinning a per-runtime budget-model list here was rejected deliberately: it would duplicate
  `bin/shared/model-catalog.json` and drift out of step with it. **Treat the floor as a floor, never
  as proof the research did not run cheap.** The durable fix is an effective-tier field on
  `query resolve-model`, which is an engine change outside this issue's scope.
- **Untagged findings** — a finding returned with **no** `[admit:/refute:/abstain:]` tag is treated
  as an **abstain** and goes to the ledger with the reason `untagged — disposition not reported`.
  It is never stated as flat prose and never silently dropped. This is the instruction-following
  slip case: an untagged finding is precisely one whose grounding is unknown, which is the
  definition of abstain, so no third bucket is needed. Distinguish it in the ledger anyway, because
  "the researcher did not answer" is a different signal from "the researcher could not verify."

Share the admitted claims **and** the Unresolved ledger side by side, then continue the conversation:

```
**Research (admitted — with sources):**
- {claim} — {source}

**Corrected (a primary source disagreed):**
- {corrected claim} — {source}

**Unresolved (could not stand behind):**
- {claim} — {unverifiable | source-vs-prior conflict | non-authoritative source | tier-floor: unearned confidence | untagged — disposition not reported}
```

Suppress any section with no entries — an empty heading reads as a claim that nothing fell into it.
If **every** finding landed in Unresolved, say so in one line rather than presenting an empty
admitted section: that outcome is itself the useful signal.

This is the claims-side analogue of the **#1154** honest verifier (abstain-and-flag on the non-inferable; ADR-550 D4 — *never a silent pass*). Here it is a **prompt-level** judgment on this ideation surface, reusing the #1154 *pattern* — it does **not** call the verify-time `probe-core` disposition, which sits on the verifier↔predicate rail (ADR-857) and is out of altitude for an ideation flow. It is also distinct from the `gsd_run query classify-confidence` seam the researcher **does** call (ADR-0656): that stamps a provider-**authority** tier (HIGH/MEDIUM/LOW) which feeds the tier floor above, but it runs no refute pass and yields no admit/refute/abstain verdict — the confidence tier is an *input* to the disposition, never a substitute for it.

If the topic doesn't warrant research, skip this step entirely. **Don't force it.**

## Step 4: Crystallize outputs (after 3-6 exchanges)

When the conversation reaches natural conclusions or the developer signals readiness, propose outputs. Analyze the conversation to identify what was discussed and suggest **up to 4 outputs** from:

| Type | Destination | When to suggest |
|------|-------------|-----------------|
| Note | `.planning/notes/{slug}.md` | Observations, context, decisions worth remembering |
| Todo | `.planning/todos/pending/{slug}.md` | Concrete actionable tasks identified |
| Seed | `.planning/seeds/{slug}.md` | Forward-looking ideas with trigger conditions |
| Research question | `.planning/research/questions.md` (append) | Open questions that need deeper investigation |
| Requirement | `REQUIREMENTS.md` (append) | Clear requirements that emerged from discussion |
| New phase | `ROADMAP.md` (append) | Scope large enough to warrant its own phase |
| Spike | `/gsd:spike` (invoke) | Feasibility uncertainty surfaced — "will this API work?", "can we do X?" |
| Sketch | `/gsd:sketch` (invoke) | Design direction unclear — "what should this look like?", "how should this feel?" |

Present suggestions:
```
Based on our conversation, I'd suggest capturing:

1. **Note:** "Authentication strategy decisions" — your reasoning about JWT vs sessions
2. **Todo:** "Evaluate Passport.js vs custom middleware" — the comparison you want to do
3. **Seed:** "OAuth2 provider support" — trigger: when user management phase starts

Create these? You can select specific ones or modify them.

[Create all] / [Let me pick] / [Skip — just exploring]
```

**Never write artifacts without explicit user selection.**

**Carry the research disposition into every crystallized artifact (#2543 B3).** A claim that came
from the research pass (Step 3) keeps its disposition when it lands in a durable file. Only an
**admitted** claim may be written as a settled fact, and it carries its source. A claim from the
**Unresolved ledger** must never be crystallized as a flat assertion — in a Note, Requirement, Seed,
research question, or phase — because downstream nothing can tell an abstain from an admit once it is
plain prose. If an unresolved claim is captured at all, write it **as unresolved**, carrying its
ledger reason (`unverifiable | source-vs-prior conflict | non-authoritative source | tier-floor:
unearned confidence | untagged`); otherwise omit it. This is Step 3's ledger discipline held one
layer further — the abstain must survive the trip from research to artifact, not be smoothed away at
the point it becomes durable.

## Step 5: Write selected outputs

For each selected output, write the file:

- **Notes:** Create `.planning/notes/{slug}.md` with frontmatter (title, date, context)
- **Todos:** Create `.planning/todos/pending/{slug}.md` with frontmatter (title, date, priority)
- **Seeds:** Create `.planning/seeds/{slug}.md` with frontmatter (title, trigger_condition, planted_date)
- **Research questions:** Append to `.planning/research/questions.md`
- **Requirements:** Append to `.planning/REQUIREMENTS.md` with next available REQ ID
- **Phases:** Use existing `/gsd-add-phase` command via SlashCommand

Commit if `commit_docs` is enabled:
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run query commit "docs: capture exploration — {topic_slug}" --files {file_list}
```

## Step 6: Close

```
## Exploration Complete

**Topic:** {topic}
**Outputs:** {count} artifact(s) created
{list of created files}

Continue exploring with `/gsd:explore` or start working with `/gsd:progress --next`.
```

</process>

<success_criteria>
- [ ] Socratic conversation follows questioning.md principles
- [ ] Questions asked one at a time, not in batches
- [ ] Research offered contextually (not forced)
- [ ] Up to 4 outputs proposed from conversation
- [ ] User explicitly selects which outputs to create
- [ ] Files written to correct destinations
- [ ] Commit respects commit_docs config
</success_criteria>
