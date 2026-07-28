# Testing Suites

This project's `tests/` directory uses **filename suffix markers** to group tests into named suites. The harness `scripts/run-tests.cjs` filters by suite when given `--suite <name>`. Without a flag it runs every `*.test.cjs` file (the historical default — unchanged).

> Tracked by issue [#3597](https://github.com/open-gsd/gsd-core/issues/3597).

## Suites

| Suite | Filename pattern | What goes here |
|---|---|---|
| `unit` | `*.test.cjs` (no other marker) | Default fast lane. Pure logic, no network, no external processes beyond `gsd-tools`. Most tests live here. |
| `integration` | `*.integration.test.cjs` | Cross-module flows: full installer end-to-end, multi-tool orchestration, anything that crosses two or more bin entry points. |
| `install` | `*.install.test.cjs` | Tests that perform a real install/uninstall against a sandbox project. Slower; PR CI skips these on PRs and runs them on `main` push only. |
| `security` | `*.security.test.cjs` | Adversarial input, prompt-injection guards, fixture-driven hostile-payload sweeps. |
| `slow` | `*.slow.test.cjs` | Anything that routinely takes >5s wall-clock or holds significant memory. |
| `all` | (any) | Explicit alias for "no filter". Equivalent to running with no `--suite` flag. |

## How to place a new test

1. Pick the most specific bucket above.
2. Name the file with the matching suffix: `tests/<feature>.<suite>.test.cjs`.
3. If unsure, leave the suffix off — the file lands in `unit`, the default fast lane.

Examples:
- `tests/agent-frontmatter.test.cjs` — `unit`
- `tests/prompt-injection-guards.security.test.cjs` — `security`
- `tests/installer-end-to-end.install.test.cjs` — `install`
- `tests/sdk-mutation-stress.slow.test.cjs` — `slow`

The suite-suffix convention was chosen over a directory layout (`tests/security/`) so the 545+ existing test files don't need to move. Existing files all classify as `unit` until someone explicitly retags them.

## Regression tests

**Do not create new top-level `tests/bug-NNNN-*.test.cjs` files.** Add the
regression case to the owning module's main test file instead (e.g. a
`describe('regressions')` block in `tests/<module>.test.cjs`).

`node --test` spawns one child process per FILE, so file count — not test
count — is the unit of CI overhead, and it is worst on Windows lanes where
every spawn is Defender-scanned. The 2026-06 CI audit found 244 one-off
`bug-*` files (~38% of the suite). That population is grandfathered in
`scripts/lint-regression-test-names.allowlist.json` and enforced by an
identity ratchet (`npm run lint:regression-names`, part of `npm run lint:ci`):

- A **new** `bug-*` file fails CI — fold it into the owning module's file.
- **Deleting/consolidating** a grandfathered file requires pruning its
  allowlist entry, so the baseline only ever shrinks.
- **Inherited drift** (the failure names files your PR didn't add — e.g. the
  base branch merged `bug-*` files without feeding the allowlist, or you
  rebased and carried a pre-rebase allowlist): run
  `node scripts/lint-regression-test-names.cjs --update` and commit the
  regenerated allowlist. Snapshot artifacts like this allowlist (and
  `docs/INVENTORY.md`) must be regenerated **after** rebasing, never carried
  through a rebase.

The ratchet deliberately covers only `bug-*`. Files named `feat-NNNN-*` /
`enh-NNNN-*` are *feature* test files — one (or one per suite) per feature is
the sanctioned layout (see the #443 strategy below), not a one-off regression
pattern. If `issue-*`/`perf-*` one-offs start accumulating the same way
`bug-*` did, extend the ratchet's regex and regenerate the allowlist.

## Workflow & agent size budget

> Tracked by issue [#1074](https://github.com/open-gsd/gsd-core/issues/1074).
> Bytes (not lines) per [#717](https://github.com/open-gsd/gsd-core/issues/717);
> LF-normalized per [#683](https://github.com/open-gsd/gsd-core/issues/683).

Workflow files (`gsd-core/workflows/*.md`) and agent files (`agents/gsd-*.md`)
both ship in the installed runtime and are loaded into context — workflows on
every command, agents on every subagent dispatch — so their byte size is a real
cost. Two sibling guards (`tests/workflow-size-budget.test.cjs` and
`tests/agent-size-budget.test.cjs`) keep that cost from creeping up invisibly,
sharing one byte-counter (`measureMdFiles`) and one `npm run size:baseline`
command that regenerates **both** snapshots. Each is an **anti-creep ratchet**,
sibling to the regression-name ratchet above — three layers (workflows), ordered
from day-to-day to last-resort:

| Layer | What it does | Where |
|---|---|---|
| **Per-file baseline** (primary) | Pins every workflow's *exact* current size in a committed snapshot. Any growth, shrink, add, or removal fails until the snapshot is regenerated — so sub-ceiling creep is caught by name and delta, not just at the tier's single largest file. | `tests/workflow-size-baseline.json` |
| **Loose tier hard caps** (backstop) | Absolute outer red lines per tier — `XL ≤ 98304`, `LARGE ≤ 61440`, `DEFAULT ≤ 40960` bytes. Unlike the old tighten-only ceiling, a cap is **never raised** when a file approaches it: crossing it means *extract*, not bump. | `XL/LARGE/DEFAULT_CAP` |
| **New-file cap** | A workflow not yet in the baseline must stay under `32768` bytes (the Codex `project_doc_max_bytes` anchor) unless explicitly tiered into `XL_WORKFLOWS`/`LARGE_WORKFLOWS` in the same PR. Keeps net-new orchestrators from being born oversized. | `NEW_FILE_CAP` |

`discuss-phase.md` additionally has a thin-dispatcher target of `< 32000` bytes
(the discuss-phase progressive-disclosure split, #717).

**Agents** (`tests/agent-size-budget.test.cjs`) use the same per-agent baseline
(`tests/agent-size-baseline.json`) + loose tier hard caps — `XL ≤ 57344` /
`LARGE ≤ 49152` / `DEFAULT ≤ 24576` bytes. There is no new-agent cap: a net-new
agent is DEFAULT-tier and already bounded by the DEFAULT cap. (This is distinct
from the separate 45 KB-*char* extraction-evidence threshold on `gsd-planner`
enforced by `tests/planner-decomposition.test.cjs` — that one proves mode
sections were extracted; this one bounds total agent bytes.)

### How-to: a workflow or agent grew and CI is red

The baseline guard reports the file and the byte delta (the same flow for both
the workflow and agent guards). To resolve:

1. **Regenerate the snapshot** and inspect the one-line diff:
   ```bash
   npm run size:baseline
   git diff tests/workflow-size-baseline.json
   ```
2. **Justify the growth in your PR** (a sentence in the description is enough) —
   the committed baseline diff is the review record that the larger size was a
   deliberate, seen decision, not silent drift.
3. **Or shrink it instead of baselining.** Prefer extraction when the growth is
   incidental: for a workflow, move per-mode bodies to `workflows/<name>/modes/`,
   templates to `workflows/<name>/templates/`, and shared prose to
   `gsd-core/references/`; for an agent, lift shared boilerplate into
   `gsd-core/references/` and `@`-reference it — then load it **LAZILY**. Do *not* convert them to eager `@-required_reading`
   includes: that shrinks the file's bytes without shrinking loaded context, so
   it games the guard while making the real cost worse. See
   `workflows/discuss-phase/` for the progressive-disclosure pattern.

If a hard cap (not the baseline) is what failed, regeneration will **not** help —
that is the signal to extract, per step 3.

### How-to: the baselines or golden fixtures conflict on merge

`tests/workflow-size-baseline.json`, `tests/agent-size-baseline.json` and
`tests/fixtures/golden-install-parity/*.json` are **Emitted Artifact Provenance**
files (`CONTEXT.md` → `RULESET.EMITTED_ATTRIBUTION`): pure functions of the source
tree. Their correct merge is always *recompute*, which git's ours/theirs interface
cannot express — so a conflict here is never something to hand-resolve.

Register the merge driver once per clone:

```bash
npm run setup:merge-driver
```

Afterwards a conflicting merge, rebase or cherry-pick keeps your branch's copy and
prints a one-line notice. Recompute the artifacts before committing:

```bash
npm run regen:derived
```

That one command runs every generator in dependency order (`gen:golden` last,
because it hashes installed output). On an unmodified tree it produces no diff.

Two things it deliberately does **not** do:

- **It does not clear GitHub's `CONFLICTING` label.** Merge drivers live in
  `.git/config`, so forks do not have one and github.com's own merge never runs a
  custom driver. The driver removes the labour, not the label.
- **It does not regenerate during the merge.** At the moment git invokes a merge
  driver, neither the working tree nor the index reflects the merge yet — so
  regenerating there would compute the artifact from the *pre-merge* tree and write
  a confidently wrong answer. Running `regen:derived` afterwards is what makes it
  correct.

This driver is a bridge introduced by [#2721](https://github.com/open-gsd/gsd-core/issues/2721)
and retired by [#2724](https://github.com/open-gsd/gsd-core/issues/2724), which
replaces these committed artifacts with a computed attribution check (ADR-2719).
`tests/fixtures/install-tree/*.json` is deliberately excluded and keeps normal merge
semantics — its diffs are readable and it must stay an absolute "the installer
stopped shipping X" failure.

### Reference

| Artifact | Role |
|---|---|
| `scripts/workflow-size.cjs` | Single source of truth — LF-normalized byte counter (`lfByteCount`) + generic `measureMdFiles(dir, predicate)` (backs both workflows and agents) + workflow enumeration (`listWorkflowStems`, `measureWorkflows`). Imported by **both** the guards and the generator so they can never measure differently. |
| `scripts/update-size-baseline.cjs` (`npm run size:baseline`) | Regenerates **both** `tests/workflow-size-baseline.json` and `tests/agent-size-baseline.json` — sorted keys, trailing newline, idempotent. |
| `npm run regen:derived` | Runs every generator in dependency order (build → registry → ADR index → capability matrix → inventory manifest → manifest versions → size baselines → golden fixtures). Use it instead of remembering which generator owns which artifact. |
| `scripts/git-merge-regen-driver.cjs` (`npm run setup:merge-driver`) | Registers the `gsd-regen` merge driver in this clone. Keeps your branch's copy of a conflicting generated artifact and points you at `regen:derived`. Bridge for #2721; retired by #2724. |
| `tests/workflow-size-baseline.json` | The committed per-workflow snapshot (one entry per workflow). |
| `tests/agent-size-baseline.json` | The committed per-agent snapshot (one entry per `gsd-*` agent). |
| `tests/workflow-size-budget.test.cjs` | The three workflow guards above, plus the `discuss-phase` progressive-disclosure checks. |
| `tests/agent-size-budget.test.cjs` | The per-agent baseline + tier hard-cap guards (the agent analog). |

## Running suites locally

```bash
npm test                    # everything (backcompat — same as before)
npm run test:unit           # only unit
npm run test:integration    # only integration
npm run test:install        # only install
npm run test:security       # only security
npm run test:slow           # only slow

npm run test:coverage       # backcompat — coverage over EVERY test
npm run test:coverage:unit  # fast coverage signal — only unit suite
npm run test:coverage:all   # alias for test:coverage
```

Direct harness invocation also works:

```bash
node scripts/run-tests.cjs --suite security
node scripts/run-tests.cjs --suite=security
node scripts/run-tests.cjs --files "tests/command-contract.test.cjs tests/core.test.cjs"
node scripts/run-tests.cjs --files-from .ci-selected-tests.txt
```

`npm run test:affected` (scripts/run-affected-tests.cjs) is a **local-only**
convenience that selects tests via the `require()` dependency graph of your
working-tree diff. CI does not use it — CI selection is the rule table in
`scripts/ci-test-scope.cjs`, which is the authoritative mapping. If the two
disagree, trust (and fix) the rule table.

Unknown suites exit non-zero with the list of valid suites. Empty suites (e.g. `--suite security` before any security-tagged file exists) exit `0` with a `no tests in suite "..."` notice on stderr so CI lanes don't go red while a suite is being populated.

## CI matrix

The `Tests` workflow runs every PR through a scoped gate generated by
`scripts/ci-test-scope.cjs`.

| Lane | Node 22 | Node 24 |
|---|---|---|
| `ubuntu-latest` | scoped tests | unit + integration + security |
| `windows-latest` | — | scoped Windows/path/shell tests |
| `macos-latest` | full parity when required | full parity when required |

- **Node 22** is the `engines.node` floor (`>=22.0.0`) — must stay green.
- **Node 24** is the default development lane.
- **Scoped tests** are selected from the changed paths, plus a small CLI/package
  smoke set. They are for confidence on the affected surface, not for counting
  tests.

The default PR gate runs the broad `unit` (under the c8 coverage gate),
`integration`, and `security` suites once on Ubuntu / Node 24, scoped tests on
Ubuntu / Node 22, and scoped tests on Windows / Node 24. "Scoped" means the
diff-selected list from the rule table — not the full suite and not a fixed
smoke set (the fixed smoke list is only the empty-selection fallback). The
Windows lane's list is the Windows-sensitive subset of the selection, plus
**every changed test file, unconditionally** (the #494 invariant, narrowed): a
modified test is exercised on the divergent OS before merge at per-file cost,
without paying for the three full parity lanes.

PRs touching workflow, package, test-runner, install, release, or
Windows-sensitive surfaces also run the full parity matrix on macOS and the
older Windows runtime, plus `install` and `slow` on the primary Ubuntu lane.
Everything (including the full parity matrix) runs on every push to `next`,
which covers the residual macOS / Windows-Node-22 cross-product for scoped PRs.

Coverage runs inside the Ubuntu / Node 24 full lane (not a separate job — that
duplicated the entire unit run) and stays single-lane because multiplying
coverage across OS/runtime lanes adds cost without improving the threshold
signal. Note the gate's deliberate blind spot: it measures
`gsd-core/bin/lib/*.cjs` only — `scripts/`, `hooks/`, and `bin/` are
unenforced, and `stryker.config.mjs` additionally excludes ~48% of lib lines
from mutation testing (see the UNMUTATED list there). Widening either gate is
tracked work, not an accident to "fix" silently by raising thresholds.

To inspect the scope locally:

```bash
npm run ci:test-scope -- --files "commands/gsd/plan-phase.md"
node scripts/ci-test-scope.cjs --base origin/next --head HEAD
```

## Chunk packing and the test timing table

`scripts/run-tests.cjs` does not hand the whole selected file list to one
`node --test` process. It packs the files into **chunks**, each spawned
separately, because Windows caps a command line at 32,767 characters and because
each chunk gets its own 600s timeout (`RUN_TESTS_CHUNK_TIMEOUT_MS`) and a fresh
process, which bounds memory pressure.

How files are distributed across those chunks decides whether the slowest chunk
sits near that timeout while the others idle. The packer weights each file by its
**measured duration**, read from `tests/test-timings.json`, and places files with
LPT (longest-processing-time-first: heaviest file first, each into the currently
lightest chunk). Before #2456 the weight was guessed from the filename, which
mis-ranked files badly enough that the slowest chunk ran ~3.9x the lightest.

### Reference

| Knob | Default | Meaning |
|---|---|---|
| `RUN_TESTS_MAX_FILES_PER_CHUNK` | `60` | Per-chunk weight budget. Weights are normalized so an **average-cost** file weighs 1, so this still reads as "about 60 average files". |
| `RUN_TESTS_MAX_CMDLINE_CHARS` | `28000` | argv ceiling per chunk, with headroom under the Windows 32,767 limit. |
| `RUN_TESTS_TIMINGS_FILE` | `tests/test-timings.json` | Path to the timing table. Tests override it to inject a synthetic cost profile. |
| `RUN_TESTS_CHUNK_TIMEOUT_MS` | `600000` | Per-chunk timeout. |

The timing table is **advisory and deliberately un-gated**. There is no `--check`
mode and no CI lint that fails on staleness, because timing data legitimately
varies run to run. A file missing from the table falls back to the table's median
weight, and a missing or unparseable table falls back to uniform weight — so
drift costs chunk *balance*, never a red build. A count-based floor additionally
guarantees the packer never produces fewer chunks than plain count-based packing
would, so a badly stale table cannot collapse the suite into a few fat chunks.

### How-to: regenerate the timing table

Regenerate when the suite's cost profile has visibly drifted — after adding or
removing expensive tests, not on a schedule. The input is a `node:test` reporter
event stream from a `gsd-test` run:

```bash
node scripts/gen-test-timings.cjs \
  ~/.local/state/gsd-test/runs/<run-id>/test-events-linux-node22.jsonl \
  ~/.local/state/gsd-test/runs/<run-id>/test-events-linux-node24.jsonl
```

Pass every lane you have. A file's recorded time is the **max** across the
supplied streams, not the mean: the packer exists to keep the *slowest* lane's
slowest chunk away from the timeout, so the conservative bound is the right one.
Keys are sorted so a regeneration diff shows only the files whose cost moved.

## Best practices for forward-compat (Node 24/26)

- Use `process.execPath` when spawning Node in tests so each matrix lane exercises the lane's Node version.
- Avoid stack-trace or error-message prose assertions. Assert `err.code`, structured JSON fields, or enums — Node minor releases routinely tweak error wording.
- Prefer `node:test`, `node:assert/strict`, and `node:test` mocks. No external test frameworks.
- Coverage uses `c8` and propagates `NODE_V8_COVERAGE` through the harness's child process.

---

## Test strategy: #443 effort + fast_mode engine

> Feature: unified cross-provider effort and fast_mode knobs (issue #443).
> Test files: `tests/model-resolver.test.cjs` (unit),
> `tests/model-resolver.test.cjs` (integration).

### Testing pyramid

| Layer | File | What it covers |
|---|---|---|
| **Unit** | `feat-443-effort-fast-mode.test.cjs` | Pure logic: cascade rules, clamping, escalation math, malformed config handling, schema key validation. No CLI subprocess. |
| **Integration** | `feat-443-effort-fast-mode.integration.test.cjs` | Architecture-level invariants: cross-provider validity, totality across the 33-agent registry, CLI JSON contract, config round-trip, fast-mode honesty. Real subprocesses via `runGsdTools`. |
| **E2E** *(pending)* | *(not yet wired)* | Propagation layer: effort frontmatter / `CLAUDE_CODE_EFFORT_LEVEL` env actually reaching a spawned Claude Code subagent. See "Gaps" below. |

### Architectural invariants

Each invariant exists to prevent a specific class of production failure.

#### (a) Cross-provider validity

**What:** `renderEffortForRuntime(runtime, universalEffort).value` must always
be a member of the runtime's real provider enum. Ground-truth enums are defined
as local constants in the test — not sourced from the implementation.

```
PROVIDER_EFFORT_ENUMS = {
  claude: Set { 'low', 'medium', 'high', 'xhigh', 'max' }   // Anthropic output_config.effort
  codex:  Set { 'minimal', 'low', 'medium', 'high', 'xhigh' } // OpenAI model_reasoning_effort
}
```

**Why:** Passing a value outside these sets results in a 400 from the real API.
The clamping logic (`max -> xhigh` for codex; `minimal -> low` for claude) must
hold for every cell of the VALID_EFFORTS × runtimes matrix.

#### (b) Param/channel contract

**What:** Each runtime exposes a stable `param` string (the native API field
name) and `channel` (how the value is propagated). Unknown runtimes return
`param: null, channel: null` and pass the effort value through unchanged.

**Why:** Callers read `.param` to construct the dispatch payload. A regression
here would silently drop effort from subagent invocations.

#### (c) Resolve-execution JSON contract

**What:** The `gsd-tools resolve-execution <agent>` command emits a JSON object
with all eight keys present and typed correctly: `model` (string), `profile`
(string), `effort` (VALID_EFFORTS member), `effort_rendered` (string),
`effort_param` (string|null), `effort_propagation` (string|null), `fast_mode`
(boolean), `fast_mode_supported` (boolean).

**Why:** Orchestrators and workflow dispatchers parse this JSON. A missing or
mistyped field silently breaks downstream consumers.

#### (d) Totality across the real registry

**What:** For every agent in the 33-agent registry, `resolveEffortInternal`
returns a VALID_EFFORTS member (never undefined/null), `resolveFastModeInternal`
returns a strict boolean, and `renderEffortForRuntime('claude', effort)` stays
within the claude provider enum.

**Why:** A catalog addition that introduces a missing `routingTier` mapping
would otherwise produce `undefined` and propagate silently.

#### (e) Fast-mode honesty invariant

**What:** When the runtime is `claude`, `fast_mode_supported` in
resolve-execution output is always `false`, regardless of the fast_mode config.
`RUNTIMES_WITH_FAST_MODE` contains only `'api'`.

**Why:** Claude Code's `/fast` toggle is session-level only. Emitting
`fast_mode: true` as frontmatter on a Claude subagent is a silent no-op.
Advertising `fast_mode_supported: true` for claude would cause orchestrators to
believe the knob was wired when it is not.

#### (f) Precedence first-valid-wins

**What:** Both effort and fast_mode use a layered cascade. The test table covers
all four effort layers (invocation override → agent_overrides →
routing_tier_defaults → default) and all five fast_mode layers, including the
case where an invalid value at a higher layer correctly falls through.

**Why:** Silent precedence bugs (e.g., a numeric value in agent_overrides not
being rejected) would override intentional user config.

#### (g) Dynamic-routing composition

**What:** `resolveEffortForTier` escalates effort by attempt number
independently of the model tier mapping. The test verifies the effort ladder
(`low -> medium -> high -> xhigh -> max`), the `max` clamp, the
`max_escalations` cap, and that `escalate_on_failure: false` suppresses
escalation entirely.

**Why:** Effort escalation and model escalation share configuration
(`dynamic_routing`) but must operate independently; coupling them would cause
over-escalation or under-escalation.

#### (h) Config-tooling round-trip

**What:** `gsd-tools config-set` accepts all new key namespaces
(`effort.default`, `effort.routing_tier_defaults.<tier>`,
`effort.agent_overrides.<agent>`, `fast_mode.enabled`,
`fast_mode.routing_tier_defaults.<tier>`, `fast_mode.agent_overrides.<agent>`)
without an "Unknown config key" error, and values set via `config-set` are
reflected in `resolve-execution` output.

**Why:** The schema validation gate (`VALID_CONFIG_KEYS` + `DYNAMIC_KEY_PATTERNS`)
is separate from the resolver logic. A key missing from the schema would produce
a silent write failure and appear as a bug only at runtime.

### Coverage targets

| Suite | Target |
|---|---|
| Unit | Every cascade rule, every fallthrough, every clamp. All function branches in `resolveEffortInternal`, `resolveFastModeInternal`, `resolveEffortForTier`, `renderEffortForRuntime`. |
| Integration | All 8 architectural invariants. All 33 registered agents. All 6 provider × effort combinations for the valid-enum check. Full config-set key namespace. |

### Gaps / not yet covered

**E2E orchestrator-spawn-propagation layer (pending follow-up wiring):**
The integration tests verify that GSD resolves and renders effort values
correctly. They do NOT verify that the rendered values actually reach a spawned
Claude Code or Codex subagent at runtime. Specifically uncovered:

- `CLAUDE_CODE_EFFORT_LEVEL` env var being set and read by a spawned claude subprocess
- `output_config.effort` frontmatter key surviving the AGENTS.md template substitution
- `model_reasoning_effort` field surviving serialization into a Codex API request body
- Fast-mode `speed: "fast"` field reaching an `api`-runtime request when `fast_mode_supported: true`

These require spawning real subagents (or stubs thereof) and asserting on the
process environment / request payload — a scope that belongs in a future E2E
suite under `*.slow.test.cjs` or dedicated fixture-driven integration work.
