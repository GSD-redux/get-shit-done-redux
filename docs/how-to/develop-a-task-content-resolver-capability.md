# Develop a task-content resolver capability

**Goal:** Declare a `taskContentResolver` in a capability manifest so `execute-plan.md` resolves
a task's `<action>`/`<verify>`/`<acceptance_criteria>`/`<read_first>`/`<done>` content from your
external issue tracker instead of reading it inline from `PLAN.md`.

**Prerequisites:** You already have a capability (`capability.json`), or you are creating one —
see [Develop a Capability for GSD 1.5+](develop-a-capability.md) first if this is your first one.
GSD 1.28 or later ([ADR-3646](../adr/3646-per-task-content-resolution-seam.md)).

---

## Why this exists

A project that wants an external tracker — beads, Linear, Jira, GitHub Issues — to own task
*content*, not just task *status*, has no seam for that today: `execute-plan.md` reads every
task's instructions directly out of the `PLAN.md` task block. `taskContentResolver` adds one, with
a hard-halt guarantee: if your tracker is declared as the source of truth and it fails to resolve,
execution stops rather than silently falling back to stale `PLAN.md` text. That guarantee is the
entire point of the feature — a silent fallback would require the tracker and `PLAN.md` to stay in
sync forever, defeating the reason to move content out of `PLAN.md` in the first place.

---

## Declare the resolver

Add a `taskContentResolver` block to your capability's manifest body (`role: "feature"` only):

```json
{
  "id": "beads",
  "role": "feature",
  "version": "1.0.0",
  "title": "Beads issue tracker",
  "description": "Resolves task content from the bd issue tracker.",
  "tier": "standard",
  "requires": [],
  "runtimeCompat": { "supported": ["*"], "unsupported": [] },
  "skills": [],
  "agents": [],
  "hooks": [],
  "config": {},
  "steps": [],
  "contributions": [],
  "gates": [],

  "taskContentResolver": {
    "trackerPrefix": "beads",
    "invoke": {
      "binary": "bd",
      "args": ["show", "{{id}}", "--json"],
      "timeoutMs": 10000
    }
  }
}
```

Two fields decide whether the seam works at all:

- **`trackerPrefix`** must match the prefix of a task's `tracker-id` attribute — everything
  before the **first** `:`. Given `<task tracker-id="beads:GSD-42">`, the prefix is `beads` and
  the id passed to your resolver is `GSD-42`. If a tracker's own ids contain colons, that is fine:
  only the first colon splits prefix from id, so `beads:team:GSD-42` resolves to id `team:GSD-42`.
- **`invoke.args`** must contain the `{{id}}` placeholder at least once — GSD substitutes it with
  the task's id before spawning your binary. A declaration whose `args` never carries the
  placeholder fails validation at install time, because the id could never reach your resolver.

`invoke.timeoutMs` is required. An unbounded resolver subprocess is this repo's named Unbounded
Subprocesses defect class — declare a bound that matches how long your tracker's lookup actually
takes, plus margin.

`trackerPrefix` must be unique across the merged first-party ∪ overlay capability set; a
collision — two installed capabilities both claiming `"beads"` — is a build-time validation
error, not a runtime ambiguity.

---

## What your resolver must output

`execute-plan.md` invokes your `invoke.binary`/`invoke.args` and expects a single JSON object on
stdout when the lookup succeeds:

| Field | Type | Required | Maps to |
|---|---|---|---|
| `description` | string | Yes | The task's `<action>` |
| `verify` | string | No | The task's `<verify>` |
| `acceptance_criteria` | string[] | No | The task's `<acceptance_criteria>` |
| `read_first` | string[] | No | The task's `<read_first>` |
| `done` | string | No | The task's `<done>` |

An absent or empty-string `description` is treated as "nothing resolved" — `execute-plan.md`
falls back to the task's inline `PLAN.md` content, the one legitimate pre-migration boundary case
(for tasks authored before your tracker migration). This is the *only* silent fallback path; every
other failure is a hard halt.

**Exit code and stderr matter.** Exit `0` with valid JSON on stdout is the only success path.
Anything else — a non-zero exit, a timeout past `invoke.timeoutMs`, or stdout that fails to parse
as JSON — is treated as a resolution failure. Write a clear one-line reason to stderr; it is
surfaced verbatim to the person watching execution. Stderr on a **successful** (exit 0) run is not
an error — write informational logs there if your CLI already does; only the exit code and the
JSON parse outcome decide success.

---

## What happens on failure

A resolver that is declared, invoked, and fails — non-zero exit, timeout, or malformed JSON —
makes `gsd_run task resolve-content` itself exit non-zero. `execute-plan.md` treats that as a
**hard halt**: it stops before doing any work on the task, surfaces the tracker-id, the tracker
prefix, and your resolver's stderr, and never proceeds to read the task's inline `PLAN.md` content
as a substitute. See [ADR-3646](../adr/3646-per-task-content-resolution-seam.md) for why this is
the load-bearing safety property of the whole feature, and
[`loop-hook-dispatch.md`](../../gsd-core/references/loop-hook-dispatch.md#the-executetask-point-a-different-shape)
for how this call site differs from the twelve prose-dispatched loop extension points.

---

## Worked example: a `bd`/beads-shaped resolver

Suppose `bd show GSD-42 --json` already returns:

```json
{
  "id": "GSD-42",
  "title": "Add rate-limit check to login",
  "status": "open",
  "description": "Add a rate-limit check to processLogin using the existing RateLimiter.",
  "acceptance": [
    "Login attempts beyond the configured limit return 429",
    "Existing successful-login tests still pass"
  ],
  "notes": "See src/util/rate.ts for the existing limiter."
}
```

Your resolver is a thin adapter, not `bd` itself — it maps `bd`'s field names onto the shape
`execute-plan.md` expects and exits non-zero on anything `bd` itself reports as a failure:

```bash
#!/usr/bin/env bash
set -euo pipefail

id="$1"
raw=$(bd show "$id" --json)

node -e '
  const raw = JSON.parse(process.argv[1]);
  const out = {
    description: raw.description || "",
    acceptance_criteria: raw.acceptance || [],
  };
  process.stdout.write(JSON.stringify(out));
' "$raw"
```

Declare it as the `invoke.binary`/`invoke.args` pair (or point `invoke.binary` at `bd` directly if
its own `--json` output already matches the expected field names — no adapter needed in that
case). Either way, `invoke.args` must carry `{{id}}` so GSD can substitute the task's tracker id
before spawning it.

---

## Related

- [ADR-3646](../adr/3646-per-task-content-resolution-seam.md) — the design decision and rejected
  alternatives
- [Capability manifest → `taskContentResolver`](../reference/capability-manifest.md#taskcontentresolver) —
  the full field table
- [`loop-hook-dispatch.md`](../../gsd-core/references/loop-hook-dispatch.md#the-executetask-point-a-different-shape) —
  how `execute:task` differs from the twelve loop extension points
- [Develop a Capability for GSD 1.5+](develop-a-capability.md) — manifests, registry generation,
  and federated config
