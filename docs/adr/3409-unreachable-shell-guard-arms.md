# ADR-3409: Shell Guards Must Observe Their Own Failure Arm

- **Status:** Accepted
- **Date:** 2026-08-15
- **Issue:** [#3409](https://github.com/open-gsd/gsd-core/issues/3409) (`epic` + `approved-enhancement`), which is why this ADR carries its number.
- **Supersedes:** nothing
- **Relationship to prior work:** applies [ADR-3180](3180-planning-semantic-model-single-owner.md)'s Decision 4 mechanism — whole-repo discovery, exemption by documented reason rather than file allowlist, and the shrink-only ratchet of 4(e) — to a **different invariant**, one layer up from the derivation-counting `lint-planning-prompt-drift.cjs` owns. Distinct from [#3473](https://github.com/open-gsd/gsd-core/issues/3473), which owns the upstream fix described in Decision 7 below; this ADR deliberately does not attempt it.

Symbol names and shell idioms are the durable anchors throughout. Line references, where given, are as of `next` @ `bc9a22868` and will drift.

## Context

ADR-3180 established, for the `src/` layer, that **a failure path returning a plausible default is the core defect class**. The identical class is alive one layer up, in the shell snippets embedded in `gsd-core/workflows/*.md`, `commands/`, `agents/` and `skills/` — but with a distinct mechanism that no `.cts`-scoped guard can see, because the code is markdown.

### The measured root fact

`gsd-tools.cjs`'s `--pick <field>` extractor coerces a missing or absent field to the empty string and exits **0**. `gsd_run` passes the child exit code through unchanged. Measured against the real CLI:

| Invocation | exit | stdout |
|---|---|---|
| `query phases.list --pick summaries_total` | 0 | *(empty)* |
| `query phases.list --pick totally_bogus_field_xyz` | 0 | *(empty)* |
| `query init.plan-phase 01 --pick phase_req_ids` | 0 | *(empty)* |
| `query roadmap.analyze --pick next_phase` | 0 | *(empty)* |
| `query config-get <key>` *(no `--pick`)* | **1** | *(empty)* |
| `query bogus.verb --pick x` | 1 | *(empty)* |

So in `X=$(gsd_run query V --pick F 2>/dev/null || echo D)` the `|| echo D` arm can fire **only on a typo in the verb name** — never on the field absence it was written to handle. The guard cannot observe its own failure.

The same shape arrives by a second route. Under `shopt -s nullglob` an unmatched glob expands to **zero operands**, so a command that consumes the glob still *succeeds*:

- `ls <glob> || echo "<message>"` — `ls` runs with no operands, lists the current directory, exits 0. The message never prints; the user sees a directory listing instead.
- `cat <glob>` — `cat` with no operands reads **stdin** and blocks. Measured: killed at 3s (rc=137) with a blocked stdin; merely `rc=1` with `nullglob` unset.

Two mechanisms, one shape: **a fallback arm defeated by a legitimate success-on-empty.**

### Why the existing guards cannot see it

`scripts/lint-planning-prompt-drift.cjs` (#3218, ADR-3180 Phase 8) is scoped to plan/summary **counting** re-derivation — a set glob plus `wc -l`/`grep -c` on one line — and its header explicitly excludes bare `ls`/`cat` globbing. `lint-portable-timeout.cjs` covers timeout portability only. Nothing in `scripts/` targets the guard idioms themselves, and a ninth `--pick … || echo` landed between this issue being filed (8 sites) and being worked (9).

### What discovery found

The audit this ADR mandates (Decision 5) surfaced more than the issue knew about — 20 sites in total, none previously tracked beyond the two named bugs:

| Shape | Sites | Note |
|---|---|---|
| `--pick … \|\| echo <default>` | 9 | 2 causing live wrong behavior ([#3365](https://github.com/open-gsd/gsd-core/issues/3365); `phase_req_ids` never reaching its `TBD` sentinel); 7 dead-but-misleading |
| bare `cat <glob>` (stdin hang) | 8 | in files [#3300](https://github.com/open-gsd/gsd-core/issues/3300) never touched |
| `ls <glob> \|\| echo "<message>"` | 3 | message unreachable; one in a **generated** `skills/` artifact |
| `if`/`while ls <glob>` | 0 | the #3300 shape, now extinct |
| informational `ls <glob>` (stdout consumed) | 97 | **not this class** — see Decision 2 |

## Decision

**1. The invariant.** A guard in shipped prompt-layer shell must be able to observe the condition it guards against. A fallback arm that a legitimate success-on-empty defeats is a defect, not a style preference — it is output-identical to the success case, which is precisely what ADR-3180 exists to eliminate.

**2. Detection keys on a documented contract, never a heuristic.** `--pick` is Detector A's discriminator because the extractor's "missing field → empty string, exit 0" behavior *is* a contract. `exit-code-consumed-by-a-real-fallback` is Detector B's, for the same reason. The consequence is load-bearing in both directions:

- `config-get … || echo "default"` **stays** — it genuinely exits 1 on a missing key, measured. This is ~132 of the 141 `$(… || echo …)` lines in the prompt layer.
- informational `ls <glob>` whose **stdout** is consumed **stays** — 97 sites. It is not a guard; nothing about it has a failure arm to be unreachable.
- `ls <glob> || true` **stays** — suppressing a failure is not a guard, and there is no fallback value to defeat.

A rule keyed on "invokes `gsd_run` and has `|| echo`" was written, measured at 111 matches, and **rejected**: it would have reddened CI on ~132 legitimate lines. A rule keyed on "`cat`/`ls` with any glob operand" was written, measured at a 106-entry baseline including 8 lines of pure markdown prose, and **rejected** for the reason in Decision 4.

**3. The guard consumes the shared scanner; it does not copy it.** `scripts/lint-unreachable-guard-drift.cjs` uses `scripts/lib/drift-scan.cjs` for the tree walk, root confinement, symlink handling and report sanitizer. ADR-3180 Decision 4 already rejected "let the new drift guard copy Phase 1's tree-walk." This repo now carries 46 `scripts/lint-*.cjs` guards; that count is a standing Greenspun signal, and the shared module is the answer to it. A guard that copies the scanner turns the family into the ad hoc engine. No off-the-shelf linter fits the target — ESLint parses JS ASTs, `shellcheck` parses real shell, and this input is shell fragments inside markdown fences carrying `${}` prompt interpolation that is not valid shell.

**4. The ratchet's target is zero, and a baseline is not a parking lot.** The shrink-only mechanism of ADR-3180 Decision 4(e) is adopted verbatim: keyed on (file, trimmed text) never line number, each entry carrying a `count` and naming the issue that removes it, with a stale entry failing as loudly as a fresh one. But the ratchet exists for a site whose owner is *another epic* — not as a place to park a detector that over-fires. **A baseline large enough to skim past is a failed detector, not an acknowledged debt.** This guard ships with an empty baseline: every site it can find is fixed.

**5. `nullglob` is audited once, centrally — including in the fix.** Whether a glob-consuming command is safe depends on a shell option that may be set in a *different fenced block* of the same file, which the author of any one line cannot see. Two consequences:

- The detector flags the shape regardless of whether `nullglob` is visibly set in that file. Locally-undecidable means decide conservatively.
- **The remedy is `[ -e "${_ARR[0]}" ]`, not `[ ${#_ARR[@]} -gt 0 ]`.** The count form is correct *only* when `nullglob` is set: without it the array holds the unmatched literal pattern, so the count is 1 and the guard passes wrongly. Measured both ways. `gsd-core/workflows/review.md` keeps its count guards because that block sets `nullglob` two lines above them; every site fixed under this ADR uses `-e`, because six of the seven files involved never set it at all.

**6. Exemption is per-line and must name an owner.** A deliberate counter-example — documentation showing the anti-pattern — is byte-identical to a regression, so only a declaration can separate them. The marker is `# gsd-scan-ignore: <reason>` on the violating line, where the reason must name an issue (`#NNN`) or an `http(s)://` URL, matching the precedent in `tests/commit-files-pathspec.test.cjs` and the sibling `allow-test-rule:` marker of [ADR-456](456-test-rigor-architecture.md). A malformed reason is reported as a *distinct* malformed-declaration error rather than silently exempting. **File allowlists remain forbidden** (ADR-3180 Decision 4(a)) — an allowlist points at the file most likely to grow the next copy.

**7. The upstream contract fix is explicitly out of scope.** The true single-owner cure is at `--pick` itself: it should signal absence rather than emitting `''` at exit 0, so that no caller has to guard for it. That is a CRITICAL-blast-radius change across 111+ call sites and it belongs to [#3473](https://github.com/open-gsd/gsd-core/issues/3473) ("enforcement by construction — one owner per invariant … failure returns"). This ADR governs the shell layer and the guard; it does not re-litigate the CLI contract. Until #3473 lands, every new `--pick` caller remains one careless line from this class — which is exactly what the guard makes visible in review.

## Consequences

**Downstream callers can rely on:**

- A `--pick` read in shipped prompt shell is followed by an explicit empty test, never by an exit-code fallback. The idiom is a two-line `X=$(…)` / `X="${X:-default}"`, or a direct comparison against the expected literal where the safe direction is "do not act" (the Walking Skeleton gate fires only on a literal `"0"`, so an unanswerable query leaves it off rather than firing unconditionally).
- A glob-consuming `cat`/`ls` in shipped prompt shell is guarded by `[ -e "${_ARR[0]}" ]` and therefore behaves identically whether or not `nullglob` is set.
- `npm run lint:ci` fails on a new instance of either shape.

**Costs accepted:**

- **A cross-line split defeats Detector A** — `--pick` on one line, `|| echo` on the next — as does `|| printf`. Same per-line-scan tradeoff the two sibling guards document; left to code review.
- **Detector B is conservative by construction.** It flags a glob operand even where `nullglob` is provably unset in that file, because the option is not locally decidable.
- **The lint cannot distinguish the correct remedy from a subtly wrong one.** Both `[ -e "${_ARR[0]}" ]` and `[ ${#_ARR[@]} -gt 0 ]` remove the glob from the command, so both pass. Decision 5's rule is therefore documented in `docs/how-to/resolve-unreachable-guard-findings.md` rather than enforced — a reference table cannot carry it.
- **One more guard to run in `lint:ci`**, and one more baseline file that a maintainer must regenerate with `--update` after a migration.

**Explicitly not changed:** the 97 informational `ls <glob>` sites, the ~15 `ls <glob> || true` sites, and the ~132 `config-get … || echo` defaults. Each was measured, and none carries an unreachable failure arm.
