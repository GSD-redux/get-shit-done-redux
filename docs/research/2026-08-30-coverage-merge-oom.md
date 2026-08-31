# Coverage-merge OOM in `test:coverage:unit` — research memo

**Date:** 2026-08-30
**Trigger:** `release.yml` `finalize` job dry-run of `1.12.0` failed with a JavaScript heap OOM (exit 134, SIGABRT) inside `npm run test:coverage:unit`.
**Status:** Research input for a follow-up fix task. No code changed by this memo.
**Reading time:** ~10 min

---

## 1. Problem summary

`test:coverage:unit` runs `c8 … --all node scripts/run-tests.cjs --suite unit && node scripts/check-coverage-gate.cjs` (`package.json:152`). `scripts/run-tests.cjs` already fans the 1785-file unit suite out into 15 short-lived child processes (LPT-packed by measured duration; see `scripts/run-tests.cjs:394-497`), each with `NODE_V8_COVERAGE` propagated so V8 writes one raw-coverage JSON file per process. In the failed `finalize` run, all 15 chunks completed (0 test failures) at 00:19:36; the `FATAL ERROR: Ineffective mark-compacts near heap limit … JavaScript heap out of memory` crash happened 76s later, at 00:20:52 — after test execution, during whatever c8 does next. The job already sets `NODE_OPTIONS: --max-old-space-size=6144` (`.github/workflows/release.yml:587`), raised once before for this exact step, and it is still not enough. `--all` is load-bearing: `scripts/check-coverage-gate.cjs:28-34` reads `overall.lines.pct` / `overall.branches.pct` straight from `coverage-summary.json`'s `.total`, and without `--all` any of the ~235 `gsd-core/bin/lib/**/*.cjs` files untouched by the unit suite would silently drop out of that denominator, inflating the reported percentage — dropping `--all` is not an acceptable fix on its own.

## 2. Root cause, sourced

Confirmed: **this is the report/merge phase, not test execution**, both by the timing gap above and by c8's own source. `getCoverageMapFromAllCoverageFiles()` (`lib/report.js`, current `main`) is the method that turns raw V8 JSON into the final Istanbul `CoverageMap`, and it has two code paths:

- **Sync (default):** `_getMergedProcessCov()` calls `_loadReports()` to read every raw V8 coverage file for the whole run into memory as one array, then passes the *entire array* to `mergeProcessCovs()` in a single call.
- **Async (`--merge-async`):** `_getMergedProcessCovAsync()` reads files from `tempDirectory` one at a time and folds each into a running merged result incrementally.

This matches c8's own changelog for the feature that added the async path: v7.14.0 (2023-05-26) — *"added a new CLI arg `--merge-async` to asynchronously and incrementally merge process coverage files to avoid OOM due to heap exhaustion"* ([bcoe/c8 CHANGELOG](https://github.com/bcoe/c8/blob/main/CHANGELOG.md), [PR #469](https://github.com/bcoe/c8/pull/469)). PR #469 itself was filed against a real GitHub Actions OOM failure during coverage merging (screenshot referenced in the PR discussion) — the same failure class we hit, just in a different repo. `--all`'s zero-coverage-file inclusion (`_includeUncoveredFiles()`) runs *after* the merge in both the sync and async paths and is prepended into the same `mergeProcessCovs()` call, so it does not change which path is chosen and is compatible with either.

Exit code 134 = 128 + SIGABRT (signal 6). V8 emits `FATAL ERROR: Ineffective mark-compacts near heap limit` and then calls `abort()` itself when it cannot free enough heap after repeated mark-compact GC passes at the configured `--max-old-space-size` ceiling — this is V8's own graceful (if fatal) response to hitting *its own* configured limit, distinct from the Linux OOM-killer sending SIGKILL (exit 137) when the *container/host* runs out of physical memory. That the crash is SIGABRT/134, not SIGKILL/137, means we are hitting the 6144 MB `--max-old-space-size` ceiling V8 was told to respect, not (yet) the runner's physical RAM ceiling.

## 3. Runner headroom

`finalize` runs on plain `runs-on: ubuntu-latest` (`.github/workflows/release.yml:547`, no `runs-on:` overrides), which is `open-gsd/gsd-core` — a public repo — so it gets GitHub's **public-repo standard Linux runner: 4 vCPU, 16 GB RAM, 14 GB SSD** ([GitHub Docs: Supported runners and hardware resources](https://docs.github.com/en/actions/reference/github-hosted-runners-reference)). Against 16 GB physical RAM, the current `--max-old-space-size=6144` (6 GB) leaves meaningful headroom before an OS-level OOM-kill — raising the flag further (e.g. to 10-12 GB) is a viable stopgap purely on paper, but it is treating the symptom: the underlying `_loadReports()` call still holds every raw V8 file for the whole 1785-test run in memory simultaneously before merging, so the ceiling will eventually be hit again as the suite grows, same as it was hit after the *first* raise from whatever the previous default was to 6144. GitHub-hosted "larger runners" (paid, up to 64 GB) are available as a deferred escape hatch if a real fix is not shipped, but they cost money and still only delay the same unbounded-memory-shape problem.

## 4. Options considered

### Option A — `c8 --merge-async`

**What it is:** Add `--merge-async` to the `test:coverage:unit` (and `test:coverage:report`) npm scripts. Switches the merge from `_getMergedProcessCov()` (load-all-then-merge) to `_getMergedProcessCovAsync()` (read-one/merge-one/discard, repeat).

**Primary source:** [bcoe/c8 CHANGELOG v7.14.0](https://github.com/bcoe/c8/blob/main/CHANGELOG.md), [PR #469](https://github.com/bcoe/c8/pull/469), confirmed present and unchanged in current `main` (`lib/report.js`) and available since v7.14.0 — well inside the `^11.0.0` range already pinned in `package.json:71`, so no dependency bump is required.

**Memory-reduction mechanism:** Peak resident memory during merge drops from O(all 15 raw-coverage files at once) to O(1 raw-coverage file + the accumulated merged map), because files are read, merged into the running result, and released one at a time instead of all being held in an array simultaneously.

**Accuracy/correctness risk:** None found. `mergeProcessCovs()` is the same aggregation function in both paths — the async path only changes *when* each file is merged, not the arithmetic. `--all`'s `_includeUncoveredFiles()` step runs after either merge path and behaves identically. c8's own test suite covers both paths, per the PR summary; no open correctness issues against `--merge-async` were found in c8's issue tracker as of this research.

**Implementation cost:** Trivial — a one-flag change to two npm script strings (`test:coverage:unit`, `test:coverage:report`) in `package.json`, no code, no new dependency.

**Real fix or stopgap:** Real fix. It targets the actual root cause (all-at-once merge) rather than papering over it with more heap.

### Option B — Manual two-phase group-then-aggregate (`nyc merge` / hand-rolled `coverage-summary.json` arithmetic)

**What it is:** Run c8 separately over disjoint groups of the 15 chunks (e.g. 3 groups of 5), each producing its own `coverage-summary.json` via `c8 report`, then cheaply aggregate the ~235-file summaries arithmetically (sum `covered`/`total` counts per file, recompute `pct`) instead of re-merging raw V8 coverage.

**Primary source:** `istanbul-lib-coverage`'s `CoverageMap.merge()` does exist and is safe for this shape of problem — from source (`coverage-map.js`, istanbuljs/istanbuljs): `merge()` iterates the incoming map's files and calls `addFileCoverage()`, which merges counts for a file that already exists in the target map and adds it fresh otherwise. A file touched only in group A and untouched in group B is not double-counted or dropped, because each group's `--all` pass already emits a zero-coverage entry for it, and `addFileCoverage` sums those zero-entries against the real ones from the other group correctly (adding zero to a count is a no-op). `nyc merge` is the CLI-level equivalent (istanbuljs/nyc), but note the sibling regression this class of design has already hit in that codebase: [`nyc report` loads all reports in tempDirectory into memory before merging, issue #805](https://github.com/istanbuljs/nyc/issues/805) — the exact same all-at-once-load defect as c8's sync path, just one layer up. A hand-rolled aggregator over `coverage-summary.json`-shaped objects (not raw V8 JSON) sidesteps that specific defect because summary objects are tiny (counts, not per-statement/branch position data).

**Memory-reduction mechanism:** Each c8 invocation only ever merges 5 chunks' raw coverage instead of 15, cutting peak memory by ~3x per invocation; the final aggregation step operates on tiny summary JSON, not raw coverage.

**Accuracy/correctness risk:** Low but non-zero and self-built: correctness depends on every group using the identical `--include`/`--exclude`/`--all` file set (so each group's summary enumerates the same ~235 files with the same keys) and on writing the aggregation arithmetic correctly (sum `covered` and `total`/`skipped` per metric per file, not average the `pct` fields — averaging percentages across groups of different size is a classic and easy-to-introduce accuracy bug). This is exactly the "generative fix divergence" hazard called out in this repo's own conventions: a hand-rolled aggregator is a second implementation of merge arithmetic that can drift from `mergeProcessCovs()`'s semantics over time with no shared test.

**Implementation cost:** Medium — new grouping logic in `run-tests.cjs` or a new wrapper script, a new aggregation script, and either a new test asserting the aggregator's output is byte-identical to a single ungrouped `c8` run on a fixture, or acceptance of the drift risk above.

**Real fix or stopgap:** Real fix for memory, but a self-maintained one — it re-implements a subset of what `--merge-async` gets for free from upstream, so it only makes sense if `--merge-async` alone proves insufficient (see §5).

### Option C — Switch to Node's native `--experimental-test-coverage`

**What it is:** Drop c8/istanbul entirely; let `node --test --experimental-test-coverage` (or the `run()` API's `coverage: true`) collect and report coverage natively per Node's own test runner.

**Primary source:** [Node.js Learn: Collecting code coverage in Node.js](https://nodejs.org/learn/test-runner/collecting-code-coverage), [Node.js `node:test` API docs](https://nodejs.org/api/test.html#collecting-code-coverage). Confirmed via docs: reporters are `spec`/`tap` (stdout summary) and `lcov` (`--test-reporter=lcov --test-reporter-destination=lcov.info`); the `run()` API exposes `coverageIncludeAll: true` as the direct equivalent of c8's `--all` (includes untouched source files as zero-coverage). **Not documented anywhere**: any `coverage-summary.json` output, or an Istanbul/c8-compatible JSON shape. The only structured outputs are stdout summary text and an `lcov.info` file — neither is `{ total: { lines: { pct }, branches: { pct } } }`, the exact shape `scripts/check-coverage-gate.cjs:15,28-34` parses.

**What gsd-core would lose/gain:** Gain — no dependency on c8/istanbul's merge-phase memory behavior at all, since coverage is collected and reported natively per test-runner process. Lose — `check-coverage-gate.cjs` would need a full rewrite to either (a) parse `lcov.info` (a different, line-oriented text format, no branch-pct field out of the box — would need an lcov parser or a switch to line/statement-only gating) or (b) shell out to something that converts native coverage into a `coverage-summary.json`-shaped object, which likely means keeping c8/istanbul in the pipeline anyway just for the JSON conversion (c8 itself is explicitly compatible with Istanbul's reporter set and can consume raw V8 files from any source — this is not a clean full removal, more a reshuffle). Per-file branch-coverage gating for the four hardened files (`state.cjs`, `phase.cjs`, `verify.cjs`, `init.cjs` — `scripts/check-coverage-gate.cjs:21-26`) is not confirmed reproducible from `lcov.info` without extra parsing work.

**Implementation cost:** High — rewrite of `check-coverage-gate.cjs`'s parsing, likely also of `scripts/run-tests.cjs`'s chunk/shard orchestration (native coverage's multi-process merge story is not documented at all — the docs are silent on "memory characteristics for large test suites across many processes"), and re-validation of every one of the four per-file branch gates against the new format's data.

**Real fix or stopgap:** Not a targeted fix at all for the OOM — it changes tools for reasons unrelated to the specific defect, and does not remove the eventual need to run *something* through the merge/report step at this file count if `check-coverage-gate.cjs`'s shape is kept. High cost, uncertain benefit for this specific problem; would need its own research pass on the lcov/summary gap before being actionable.

### Option D — Batch groups + raise `--max-old-space-size` further (pure stopgap)

**What it is:** Do nothing structural; just raise the heap ceiling again (e.g. 6144 → 10240 or 12288) since 16 GB of physical RAM is available on the public-repo standard runner (§3).

**Memory-reduction mechanism:** None — defers the same failure to a larger N.

**Accuracy/correctness risk:** None.

**Implementation cost:** Trivial (one number in `release.yml`).

**Real fix or stopgap:** Pure stopgap — this is literally the same lever that was already pulled once for this exact step (the `NODE_OPTIONS: --max-old-space-size=6144` comment in the workflow already documents that prior raise) and it has now failed a second time. Nothing about the merge's memory *shape* (O(all files at once)) changes; the suite will grow past whatever new ceiling is picked, same as it grew past 6144.

## 5. Recommendation

**Adopt Option A (`c8 --merge-async`)** as the fix. Add `--merge-async` to the `test:coverage:unit` and `test:coverage:report` script strings in `package.json` (lines 152 and 154) — both already run `c8` with `--all` and multiple `--include`/`--exclude` filters, and `--merge-async` composes with those unmodified per the source-level analysis in §2/§4A. No change needed to `test:coverage` (line 150, whole-suite non-CI convenience script) or `test:coverage:unit:raw` (line 153, already uses `--reporter none` and skips the merge/report step this fix targets) unless they are later found to hit the same ceiling.

Why this over the alternatives:

1. **It is the documented, upstream-maintained fix for exactly this failure mode**, shipped by c8's own maintainers in response to another user's GitHub Actions OOM during coverage merge (§2, PR #469) — not a novel workaround this repo would have to maintain.
2. **Zero correctness risk to the coverage gate.** The merge arithmetic (`mergeProcessCovs()`) is unchanged; only the *order and batching* of when files are read and merged changes. `--all`'s zero-coverage inclusion is unaffected (runs after either merge path). This directly satisfies the constraint that whatever fix ships must preserve gate accuracy for all ~235 included files.
3. **Trivial implementation and rollback cost** — a one-flag change with no new dependency (already inside the pinned `^11.0.0` c8 range) and no new code paths in this repo to test-maintain, versus Option B's self-built aggregator (new drift-prone code) or Option C's high-cost tool swap.
4. **Composes with the existing chunking, not against it.** `scripts/run-tests.cjs`'s 15-chunk process split already reduces per-process test-execution memory; `--merge-async` is the matching fix for the *separate* merge-phase memory problem, so both layers of the pipeline become O(1)-ish in peak memory rather than one being chunked and the other not.

**Fallback if `--merge-async` alone is insufficient:** if a future dry-run still OOMs with `--merge-async` in place (e.g. because the per-file conversion step, `v8toIstanbul`, still holds one file's *entire* raw coverage plus its accumulated `CoverageMap` in memory, and either grows large on its own), the next lever is Option D as a short-term bridge (raise `--max-old-space-size` again — there is headroom to ~14 GB before approaching the 16 GB physical ceiling per §3) while Option B (grouped `c8 report` + summary-shaped aggregation) is built as the next real-fix layer. Do not skip straight to Option C (native Node coverage) without a dedicated research pass on the `lcov.info`-to-`coverage-summary.json` gap identified in §4C — that gap is unresolved and blocks `check-coverage-gate.cjs` compatibility today.

## 6. Sources

- [bcoe/c8 CHANGELOG.md](https://github.com/bcoe/c8/blob/main/CHANGELOG.md) — v7.14.0 entry introducing `--merge-async`
- [bcoe/c8 PR #469](https://github.com/bcoe/c8/pull/469) — implementation, motivation (real-world GH Actions OOM), and caveats
- [bcoe/c8 `lib/report.js` (main branch)](https://raw.githubusercontent.com/bcoe/c8/main/lib/report.js) — `getCoverageMapFromAllCoverageFiles()`, sync vs. async merge paths, `--all`/`_includeUncoveredFiles()` timing
- [bcoe/c8 README.md (main branch)](https://raw.githubusercontent.com/bcoe/c8/main/README.md) — `--merge-async`, `--temp-directory`, `--reports-dir`, `Report` class programmatic API
- [Context7: /bcoe/c8 docs](https://context7.com/bcoe/c8/llms.txt) — `--merge-async` description, `c8 report` regeneration, `Report.getCoverageMapFromAllCoverageFiles()`
- [istanbuljs/istanbuljs `istanbul-lib-coverage` `coverage-map.js`](https://raw.githubusercontent.com/istanbuljs/istanbuljs/master/packages/istanbul-lib-coverage/lib/coverage-map.js) — `CoverageMap.merge()` / `addFileCoverage()` semantics for non-overlapping-file-group merges
- [istanbuljs/nyc issue #805 — "nyc report" loads all reports in tempDirectory into memory](https://github.com/istanbuljs/nyc/issues/805) — sibling precedent for the same all-at-once-load defect class
- [GitHub Docs: Supported runners and hardware resources](https://docs.github.com/en/actions/reference/github-hosted-runners-reference) — public-repo standard Linux runner: 4 vCPU / 16 GB RAM / 14 GB SSD
- [Node.js Learn: Collecting code coverage in Node.js](https://nodejs.org/learn/test-runner/collecting-code-coverage) — `--experimental-test-coverage`, reporter formats
- [Node.js `node:test` API docs, coverage section](https://nodejs.org/api/test.html#collecting-code-coverage) — `coverageIncludeAll`, `run()` coverage options
- Local: `package.json:71,150-155` (c8 pin, coverage scripts), `scripts/run-tests.cjs:394-497` (LPT chunk packing), `scripts/check-coverage-gate.cjs:15,21-34` (gate shape, per-file branch floors), `.github/workflows/release.yml:547,585-591` (finalize job runner/env)
