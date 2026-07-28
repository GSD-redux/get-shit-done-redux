# ADR-2719: Emitted-artifact attribution — replace the committed parity fixtures with a computed conservation law

- **Status:** Accepted
- **Date:** 2026-07-27
- **Issue:** [#2719](https://github.com/open-gsd/gsd-core/issues/2719) (epic); Phase 0 tracked by [#2720](https://github.com/open-gsd/gsd-core/issues/2720)
- **Supersedes:** [ADR-2264](2264-golden-parity-redesign.md) (Redesign golden-install-parity) — replaces its Decision §2–§4 and its 2026-07-14 Amendment. ADR-2264 **Phase 1 is retained and depended upon**: the single-source `buildParityManifest` and the four exclusion constants in `tests/helpers/install-shared.cjs` are the foundation this design builds on, not something being reverted.
- **Relationship to prior work:** Evolves the ADR-1239 Phase-B installer byte-parity harness. Related: ADR-3660 / ADR-1508 (Runtime Artifact Layout / Conversion / Install Plan), #2086, #2100, #2117, #2266, #2267, #2268.

## Context

Three families of committed artifacts are pure functions of the source tree: `tests/fixtures/golden-install-parity/*.json` (19 path→hash manifests), `tests/workflow-size-baseline.json`, and `tests/agent-size-baseline.json`. Every edit to shipped content requires regenerating them by hand.

Measured against `origin/next` @ `1c93df04` with `git merge-tree`:

- **7 of 7** conflicting open PRs collide on the identical 20-file set.
- **140 of 143** conflicted-file instances across those PRs are these artifacts. Three other conflicts exist in total.
- **16 of 32** open PRs touch these paths at all.

The conflicts split into two mechanisms, and neither is what a reviewer would guess.

**Adjacency (3 of 7).** #2662, #2531 and #2301 change manifest keys entirely disjoint from what `next` changed — zero overlap. They conflict only because the map is sorted and unrelated keys fall inside git's three-line diff context. The union of the two edits *is* the correct merge. These are false conflicts.

**Same key (4 of 7).** Both sides re-hashed the same emitted file. Git offers ours or theirs; both are wrong, because the correct value is neither — it is recomputed from the merged tree. Git's merge interface cannot express the resolution this artifact always needs.

Amplification makes it worse: content under `gsd-core/workflows/`, `references/`, `templates/` and `contexts/` is copied to every host, so one source edit rewrites the same hash in all 19 manifests. The conflict surface is 19× the change. 281 of claude's 440 emitted paths (64%) are plain identity copies.

### Why the current design cannot be patched into shape

The premise that this is an *absolute* invariant does not survive inspection. When a contributor changes emitted bytes they run `npm run gen:golden`, and the anchor is overwritten. Every PR re-blesses the snapshot. What makes it feel absolute is manual friction, not a fixed reference point — the golden is already a relative check wearing an absolute costume.

Its stated purpose is detecting a change that propagated further than the author intended. That detection path currently runs entirely through a human noticing an anomaly in 7,500 lines of hex:

- The fixtures carry no `linguist-generated` marker, so GitHub renders them expanded.
- `.github/CODEOWNERS:1-2` is advisory — `required_approving_review_count: 0`.
- `.github/PULL_REQUEST_TEMPLATE.md` never mentions fixtures, baselines, or regeneration.
- `CONTEXT.md` has no entry for this artifact family under any name, so a contributor who sees "conflicts" has nothing to look up.
- No single command regenerates it. `npm run build` covers five of eleven generators; `gen:golden`, `size:baseline`, `gen-inventory-manifest`, `gen:registry`, `gen-adr-index` and `gen-capability-matrix` each need separate invocation.

ADR-2264 diagnosed the churn correctly and shipped Phase 1 cleanly. Its Amendment then fixed silent staleness and correctly rejected the copy/transform split on measurement — but it walked back the churn fix without replacing it. That ADR's own 2026-07-17 audit records AC1, "editing the content of a verbatim/path-injected copied shipped file requires **zero** manual fixture regeneration," as literally unmet. This ADR satisfies AC1 rather than rewording it away.

## Decision

Stop committing the derived state. Replace it with a conservation law, checked on every PR.

### 1. The invariant is relative, and stated as attribution

Build the parity manifest at `next` HEAD and at PR HEAD. Every emitted path whose hash moved must be attributable — through a declarative provenance table — to a path the pull request actually changed. Unattributable deltas are a hard failure that names them:

```
39 emitted paths changed that nothing in this diff explains:
  gsd-core/workflows/execute-phase.md
  agents/gsd-planner.md
  ...
```

This is strictly stronger than the current mechanism for the failure it exists to catch. "You touched one thing and it rippled" stops being an anomaly a reviewer must notice and becomes a computed statement.

This is **not** the §3 property test ADR-2264's Amendment rejected. That design asserted `emitted == transform(source)` by calling the installer's own transform, which is tautological. This design never re-derives a byte; it constrains which keys are permitted to move.

### 2. Provenance comes from a declarative table with a totality guard

The mapping surface is small and stable. Per host, 13 families; of those, roughly nine are identity or prefix rewrites, one is a stem rewrite (`skills/` ← `commands/gsd/*.md`), and four are synthesized files with no repo source (`.gsd-profile`, `package.json`, `VERSION`, `.gsd-runtime`) that get their own exempt category. Roughly 15–20 rules total, changing only when a new shipped family or host appears.

**Totality is enforced.** Any emitted path matching no rule is a hard failure, not a skipped entry. A hand-maintained table's characteristic risk is becoming a silent gap; totality converts that into a loud one. If the installer starts emitting something new, the build fails rather than passing it through unattributed.

Extending the Runtime Artifact Install Plan module to emit file-level provenance is the architecturally correct long-term home and is deliberately **not** a prerequisite. `PlanItem` is `{ kind, sourceDir, destDir }` — directory-granular, covering only `commands`, `agents`, `skills` and `kimi-agents`, so the 281 bulk copies bypass it entirely. Making it a prerequisite turns one epic into two. It remains available later as a refactor with behavior already pinned.

### 3. The escape hatch is a committed acknowledgment, not a flag

Legitimate unattributable deltas exist: change a converter and emitted bytes move for files whose sources nobody touched. That is ADR-2264's "~5% git cannot review," and it must have a way through.

The way through is `tests/emitted-drift-ack.json`, which names the affected paths and states why. It is deliberately not an environment variable or a CLI flag — a contributor facing a red gate sets a flag, which is what `UPDATE_GOLDEN=1` is today.

The design property that matters: the acknowledgment file appears in the changed-files list **only when something rippled unexpectedly**. Today 100% of emitted-byte changes touch fixtures, so touching them signals nothing. Under this design, touching the acknowledgment *is* the alarm.

This does not make a bad change impossible. It converts a silent regeneration into a conspicuous declaration. That is the intended strength, stated plainly rather than overclaimed.

### 4. The size ratchet folds into the same machine

`workflow-size-baseline.json` conflicts on 7 of 7 — deleting only the golden fixtures would leave every affected PR still blocked. The attribution law does not transfer to it (growth is trivially attributable to the edit that caused it), so instead the same differential machine reports growth with exact byte deltas, and growth requires the same acknowledgment entry.

The committed number was only ever a means to "growth must be noticed and justified." That function survives, stated more legibly — `verify-work.md grew 1,247 bytes` beats a number changing inside a 93-line map — while pinning nothing and conflicting never.

Bucketing the sizes was rejected: rounding to the nearest 2KB lets a PR add 1.9KB invisibly, and invisible growth is exactly what the ratchet defends against.

### 5. The baseline is cached, not committed

The push-to-`next` run publishes the manifest and size maps; the PR lane restores them from cache, keyed on **the `next` sha the PR was merged with**. That key discipline is load-bearing — a stale baseline mis-attributes silently. Cache miss falls back to an in-job build at `origin/next`.

Bot-committing the baseline to `next` post-merge was considered and rejected. It is close to ADR-2264 Phase 3 (#2268), and notably that ADR's objection does not apply here: the Amendment deferred CI-owned regen because it "needs a write-token workflow running on PR code (an injection surface)," whereas committing post-merge runs already-reviewed code. It was rejected on a different cost — `next` carries `strict: true`, so a bot commit after every emitted-byte-changing merge doubles the rate `next` advances and taxes all ~30 open PRs. Its one unique benefit is an absolute anchor, which §1 establishes is not required.

### 6. It is a test, not a CI job

The check is a `node:test` file in the unit suite. `Required tests` already gates `next`, so it is enforced the day it lands; a separate job would need an eighth required context, and adding one under `strict: true` invalidates the status of every open PR at once — a self-inflicted instance of the problem being solved.

A baseline-unavailable path must never be a bare `return`. In `node:test` that is a **pass**, and it would make the gate fail open with nothing in CI to say so.

### 7. `install-tree` stays committed

`tests/fixtures/install-tree/*.json` conflicts on **0 of 7**. The file set genuinely changes rarely, its diffs are readable, and keeping it preserves "the installer stopped shipping X" as a hard, absolute failure with no attribution reasoning involved. It is the one artifact in this family already behaving correctly.

## Phases

- **Phase 0 — this ADR** ([#2720](https://github.com/open-gsd/gsd-core/issues/2720), docs-only).
- **Phase 1 — interim relief** ([#2721](https://github.com/open-gsd/gsd-core/issues/2721)). `merge=gsd-regen` driver, `npm run regen:derived`, and naming: `RULESET.EMITTED_ATTRIBUTION=` under `## Test rules and lint` plus `### Emitted Artifact Provenance` in the glossary. Touches no fixtures, so it breaks none of the 16 exposed PRs.
- **Phase 2 — provenance table + totality guard** ([#2722](https://github.com/open-gsd/gsd-core/issues/2722)).
- **Phase 3 — differential check, dual-run** ([#2723](https://github.com/open-gsd/gsd-core/issues/2723)). Runs beside `golden-install-parity.test.cjs`, both green, fixtures untouched.
- **Phase 4 — cutover** ([#2724](https://github.com/open-gsd/gsd-core/issues/2724)). Delete the fixtures, generators and bridge driver; flip this ADR to `Accepted`.

## Acceptance criteria (must-haves)

1. Editing the content of a copied shipped file (for example a `gsd-core/workflows/*.md`) requires **zero** manual fixture regeneration and the parity gate still passes. *(This is ADR-2264 AC1, satisfied rather than reworded.)*
2. A simulated ripple — edit one source file, corrupt an unrelated emitted file — fails with the unattributable paths named.
3. A simulated converter change fails without an acknowledgment entry and passes with one.
4. Every emitted path across all 19 runtime manifests matches exactly one provenance rule; removing a rule fails the totality guard naming the unmatched paths.
5. A stale cache key is detected rather than silently used as the baseline.
6. Growth in a workflow or agent file is reported with its exact byte delta and requires an acknowledgment entry.
7. After Phase 4, no committed path→hash manifest or per-file size baseline remains, and the two checks agreed throughout the Phase 3 dual-run window.

## Consequences

- **Positive.** The conflict class ends rather than being automated around: 140 of 143 conflicted-file instances disappear. The propagation catch becomes a computed statement instead of a reviewer noticing an anomaly in hex. ~520 KB of committed derived state is deleted, along with the duplicate generator, `UPDATE_GOLDEN`, and `npm run gen:golden`. The artifact family finally has a name in `CONTEXT.md`.
- **Negative — one-time migration.** Deleting the fixtures converts existing conflicts into delete/modify conflicts on the same 20 files, affecting 16 PRs. Verified by simulating the deletion with `git commit-tree` and re-running `git merge-tree`. The resolution is one identical command per PR and it is terminal; today's is regenerate-rebase-repush, recurring on every merge to `next`.
- **Negative — new residual risks, accepted.** A provenance rule can map to the *wrong* source and still pass the totality guard: false attribution, not a false alarm. The Phase 3 dual-run window exists to surface exactly this, and spot-check tests on known pairs reduce it further. Separately, the relative chain holds only while the check runs on every merging PR — that is CI configuration rather than design, and if the selection rules narrow later it breaks silently.
- **Neutral.** During Phase 1–3, github.com still reports `CONFLICTING`. Merge drivers live in `.git/config`, so forks lack them and GitHub's own merge never runs them. The driver removes the labour, not the label, and is retired in Phase 4.

## References

- `tests/helpers/install-shared.cjs` — `buildParityManifest` and the exclusion constants (ADR-2264 Phase 1, retained)
- `tests/golden-install-parity.test.cjs`, `scripts/gen-golden-install-parity-zcode.cjs` — removed in Phase 4
- `src/runtime-artifact-install-plan.cts` — `createRuntimeArtifactInstallPlan`; the long-term provenance home
- `scripts/ci-test-scope.cjs:148-178` — the anti-staleness selection rule from ADR-2264 Phase 2
- `scripts/ci-rebase-check.cjs:108` — merges base into HEAD before tests, which is why the baseline is `next` HEAD rather than the merge-base
- `scripts/lib/allowlist-ratchet.cjs:157-230` — `assertFileBaseline`, the size ratchet being replaced
- ADR-1239 (Phase-B safety net), ADR-2264 (superseded by this ADR), ADR-3660 / ADR-1508 (Runtime Artifact family)
