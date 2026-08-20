# How to enable live-DOM verification

Let GSD open a real browser and check a phase's UI acceptance criteria against the live DOM —
during execution, not only after it — without widening what the plan executor can reach.

> **Default-off, and deliberately so.** A browser MCP server you configured for unrelated work
> must not start driving your project's UI on its own. You opt in per project with one key. See
> the [explanation](../explanation/live-dom-uat-capability.md) for why the executor's own tool
> surface was left alone.

**What you need:**

- GSD installed with the `full` profile (the capability is `tier: full`).
- A browser MCP server registered in your runtime — either
  [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp) (exposes
  `mcp__chrome-devtools__*`) or Claude-in-Chrome (exposes `mcp__claude-in-chrome__*`).
- Something serving your UI — a dev server, a preview deployment, any reachable URL.
- A phase whose plan actually states UI acceptance criteria. The verifier will not invent them.

---

## Step 1 — Turn the key on

```bash
gsd-tools query config-set workflow.live_dom_uat true
```

Verify it took:

```bash
gsd-tools query config-get workflow.live_dom_uat
# → true
```

That one key gates both halves: the `gsd-dom-verifier` step that runs after each execution
wave, and the extra browser families the orchestrator's own UI-verification step will consider.
With it off, neither reaches a browser.

---

## Step 2 — Make the browser reachable to more than one wave

`chrome-devtools-mcp` keeps an **exclusive lock** on its browser profile at
`$HOME/.cache/chrome-devtools-mcp/chrome-profile`. A second instance fails with:

```
The browser is already running for <dir>. Use --isolated to run multiple browser instances.
```

GSD runs execution waves in parallel, so two verifiers can reach for one profile. **GSD cannot
fix this for you** — `--isolated` is a flag on *your* MCP server registration, not something
GSD passes. Add it there:

```jsonc
{
  "mcpServers": {
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest", "--isolated"]
    }
  }
}
```

`--isolated` gives each instance a throwaway profile. If you would rather share one server
across concurrent agents, `--experimentalPageIdRouting` routes tools per page instead.

Skipping this step is safe — you just get `could_not_look` / `profile_locked` on the waves that
lost the race, never a failed wave.

---

## Step 3 — Run a phase and read the report

Execute normally. After each wave, `gsd-dom-verifier` writes
`.planning/phases/<phase>/<n>-DOM-VERIFY.md`:

```markdown
---
schema_version: 1
wave: 2
outcome: verified
reason: ok
checked: 4
passed: 3
failed: 0
needs_review: 1
---
```

The body lists one line per criterion with the observation behind its verdict.

---

## Reading the outcome — "nothing to report" is not "could not look"

This is the part worth learning, because a report that says *no issues* when it never opened a
browser is worse than no report at all.

| `outcome` | `reason` | What actually happened | What to do |
|---|---|---|---|
| `verified` | `ok` | Criteria existed and were observed | Read the per-criterion lines |
| `nothing_to_report` | `no_criteria` | The wave's plan stated no UI acceptance criteria | Nothing. This is a clean result |
| `could_not_look` | `no_browser_mcp` | Key is on, but no browser MCP answered | Check your MCP server is registered and running |
| `could_not_look` | `profile_locked` | Another instance holds the browser profile | Add `--isolated` — see Step 2 |
| `could_not_look` | `target_unreachable` | Nothing was serving the criterion's URL | Start your dev server before executing |

Only `could_not_look` means the check did not happen. `nothing_to_report` means it happened and
found nothing to check.

---

## What this does not do

- **It never blocks.** The step is advisory by construction — it cannot fail a task, fail a
  wave, or stop a phase. Findings are findings; the executor still owns task outcomes.
- **It does not widen the executor.** `gsd-executor` carries no browser tools in any
  configuration. The browser reach lives in `gsd-dom-verifier` alone.
- **It does not sandbox the browser.** Once the key is on there is no domain allowlist and
  nothing inspects what a page fetched. Turn it on for projects where that is acceptable.
- **It observes the DOM only.** No screenshot diffing, no accessibility audit, no performance
  tracing. A criterion needing one of those comes back `needs_review` with the reason named.

---

## Turning it back off

```bash
gsd-tools query config-set workflow.live_dom_uat false
```

The capability resolves inactive immediately and the hook stops rendering. See
[Turn a capability off (and keep it off)](turn-a-capability-off.md) for removing it entirely.
