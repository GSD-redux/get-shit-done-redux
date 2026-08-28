# Why the ack-fragment sweep (#3875) is not "fully automatic": PR #3927 case study

**Status:** research note — grounded in the repo's own source, workflow YAML, ADRs, and live `gh`/GitHub API data for [PR #3927](https://github.com/open-gsd/gsd-core/pull/3927), pulled 2026-08-27.

## Summary

`ack-fragment-sweep.yml` (cron `30 */6 * * *`) correctly *detects* and *plans* the deletion of spent `tests/emitted-drift-acks/*.json` fragments, and correctly *opens* a PR. It does not, and structurally cannot, get that PR merged unattended:

1. Its hardcoded PR title (`ack-fragment-sweep.yml:266`) never satisfies the repo's own title-validator regex (`scripts/release-notes/conventional-title.cjs:28,84-93`) — a self-inflicted, deterministic failure on every run.
2. Its freeform PR body fails the typed-template check, but that check only **warns** (not fails) because the sweep authenticates as a `MEMBER` account, not because the body is compliant (`scripts/pr-template-policy.cjs:167-240`).
3. Its diff — one or more `tests/emitted-drift-acks/*.json` deletions — matches **no** rule in `scripts/ci-test-scope.cjs`'s `RULES` table, so `classify()` falls through the `#408` empty-match fallback and selects the `'unit'` suite sentinel for the **unsharded, 15-minute-capped** "targeted/fast-signal" matrix lane (`scripts/ci-test-scope.cjs:520-563`, `.github/workflows/test.yml:155,166-172`). That lane then runs effectively the whole 827-file corpus and is killed by its own job timeout — verified directly in the run log (below). This is not flaky; it will recur on every future sweep PR whose diff is exactly the kind the sweep workflow always produces.
4. There is no auto-merge path for this PR anywhere in the workflow set. It sat open 2h38m and was merged by a human maintainer (`trek-e`, `MEMBER`) via a merge that landed **while `validate-title` and `Required tests` were still red** — an override, not an automatic pass.

## A. The model itself

### A1. What an emitted-drift-ack fragment is, and its lifecycle

Read in full: `scripts/lint-emitted-drift-ack.cjs` (937 lines) and `tests/emitted-drift-acks/README.md`.

- **Purpose** (`scripts/lint-emitted-drift-ack.cjs:1-31`): the differential-attribution gate (`tests/emitted-attribution.test.cjs`, ADR-2719) requires every emitted-artifact byte or size delta between `next` and a PR's HEAD to be attributable to that PR's own diff. When it legitimately cannot be (a converter change, a deliberate size grow), the escape hatch is a committed acknowledgment fragment under `tests/emitted-drift-acks/<name>.json`, one file per PR (`#2914`), never the legacy single `tests/emitted-drift-ack.json`.
- **Two key spaces** (`tests/emitted-drift-acks/README.md:20-23`): an unattributable hash ripple is keyed on the emitted path; workflow/agent-file growth is keyed on the bare filename.
- **Creation**: the differential check's own failure output prints the exact fragment name/shape to paste (`CONTRIBUTING.md:1074-1076`, `docs/TESTING-SUITES.md:139-145`) — a human authors it as part of the PR that needs it.
- **"Spent"** (`scripts/lint-emitted-drift-ack.cjs:304-322`, function `assertNoAllSpentFragments`): every entry's prose in the fragment is compared, byte-for-byte after invisible-character/whitespace normalization (`ackProse`, line 261), against the copy of the same fragment at the **pre-push tip of `next`** (`readFragmentAtRef`, line 538). If every surviving entry matches its base-ref copy, the whole fragment is "all-spent" — its ripple is now baked into `next`, so it can no longer clear anything, yet it still **owns its path keys** (a second source declaring the same key is a hard duplicate-key error, lines 872-885).
- **Red on `next`**: the `guard-no-ack-on-next` job (`.github/workflows/test.yml:865-920`) runs on every push to `next` and calls `--guard-next --base-ref <before> --defer-to-open-prs`. It fails when (a) the legacy `tests/emitted-drift-ack.json` is present at all (`assertAbsentOnNext`, line 449), or (b) any fragment is fully spent and not held by an open PR that still touches it (`#3842` deferral, line 363).
- **Remedy**: `git rm` the fragment. Since `#3875`, `ack-fragment-sweep.yml` automates exactly this `git rm`, computed via `--sweep-plan` (lines 815-833), which asks the guard for the identical set it reasoned about rather than re-deriving it.

### A2. Governing ADRs/docs (verbatim quotes)

- **ADR-2719** (`docs/adr/2719-emitted-artifact-attribution.md:1-11`): "Emitted-artifact attribution — replace the committed parity fixtures with a computed conservation law." Accepted 2026-07-27, supersedes ADR-2264 §2-4.
- **`CONTEXT.md:625`** (`RULESET.EMITTED_ATTRIBUTION`): "...`#2914` replaced the single shared ack file with per-PR fragments...exactly the shape `.changeset/` already uses for the identical 'every PR rewrites one shared document' conflict problem...`#3078` REVERSED that [premise] — fragments do not share a FILE but they DO share a PATH KEY SPACE...`#3875` automated the REMEDY that alert asks for, because detection without an executable remedy is what actually failed: `#3823` shipped the guard together with a static 45-fragment sweep computed at its own branch point, `#3809`'s fragment merged to `next` while it was in flight, and the guard reddened on its own merge commit and stayed red for 24 consecutive pushes over two days."
- **`CONTRIBUTING.md:1086-1094`**: "every PR needing an acknowledgment used to rewrite `tests/emitted-drift-ack.json`'s `paths` map wholesale — a single shared mutable file every such PR touches guarantees a merge conflict between any two of them (5 of 6 conflicting PRs in one open queue collided on this file and nothing else)."
- **`tests/emitted-drift-acks/README.md:37-41`**: "The sweep is automated because the manual remedy could not keep up. The guard evaluates at MERGE time; a hand-authored `git rm` is fixed at BRANCH time...`#3823` lost exactly that race to `#3809` on its own merge commit and left `next` red for 24 consecutive pushes."

### A3. Every CI surface referencing the ack model

- `.github/workflows/test.yml:865-920` — `guard-no-ack-on-next` job (push-to-`next` trigger; the "next-lane guard"). Also referenced at `test.yml:842-864` (comment block explaining scope/limits) and `test.yml:127` (the `lint-tests` step runs `node scripts/lint-emitted-drift-ack.cjs` as part of `lint:ci`, see `CONTRIBUTING.md` cross-ref and the raw log line captured in this session: `lint-tests` step at 2026-08-27T09:38:55Z runs the full chained lint including `node scripts/lint-emitted-drift-ack.cjs`).
- `.github/workflows/ack-fragment-sweep.yml` — the entire file (237 lines); scheduled sweep, `sweep` job, calls `--guard-next --sweep-plan --defer-to-open-prs` (line 90-92) and `--guard-next --sweep-plan` unheld variant (line 115-116).
- `scripts/lint-emitted-drift-ack.cjs` — the validator/guard/sweep-plan CLI itself (937 lines; exports `validateAckText`, `assertAbsentOnNext`, `assertNoAllSpentFragments`, `runGuardNext`, `main`, `fetchOpenPrTouchedAckPaths`, etc.).
- `tests/helpers/emitted-diff.cjs` and `tests/helpers/emitted-runtime.cjs` — the "ships"-side duplicate of the same constants/logic (`ACK_INVISIBLE`, `MAX_ACK_FRAGMENTS`, `RESERVED_ACK_KEYS`, `readAckFileAtRef`), held to parity by `tests/emitted-attribution.test.cjs` (per `scripts/lint-emitted-drift-ack.cjs:19-23,58-63,77-81,94-99`).
- No `eslint-rules/*` or `.claude/hooks/*` file references `emitted-drift`/ack fragments (grepped both directories; zero hits).
- `docs/TESTING-SUITES.md:130-160` and `CONTRIBUTING.md:1055-1124` — the human-facing "Editing shipped content" / TESTING-SUITES how-to sections.

### A4. Design-history issues (via `gh issue view`)

- **#2789** — root-caused why merging an ack reddened `next`: the ack set was the one input read *absolutely* (working tree only) in an otherwise base-relative differential machine, so a spent ack (already at base) still looked live to `staleAcks`. Fixed by scoping every ack to the diff that introduced it.
- **#3078** — proved #2914's premise wrong. #2914 exempted the fragment directory from the next-lane guard on the theory that independently-named fragments "cannot conflict with any other PR." #3078 measured 45 fragments owning 403 paths on `next` and showed fragments share a *path key space* even without sharing a file, so a spent fragment left in place still walls off the next PR that grows the same path. Extended `guard-no-ack-on-next` to cover fragments (implemented in PR **#3823**, "Closes #3078," merge commit `a84f75630`).
- **#3842** — the #3078 sweep, once it started deleting fragments, handed three outside-contributor open PRs (#3330, #3774, #3648) a `modify/delete` git conflict apiece, each on the exact fragment it was the PR's only conflicting path. Added the `--defer-to-open-prs` hold (`fetchOpenPrTouchedAckPaths`).
- **#3823** (a PR, not a separate issue — `gh issue view 3823` resolves to the PR body) — implemented the fragment half of `guard-no-ack-on-next`, closing #3078.
- **#3875** — root-caused the 24-consecutive-push red streak: `#3823` computed its sweep as a *static* list at branch time; `#3809`'s fragment merged to `next` *while #3823 was in flight* and was therefore never in that list. Proposed the scheduled sweeper (`ack-fragment-sweep.yml`) that recomputes the plan from the guard itself, on a timer, "honouring the existing `--defer-to-open-prs` hold." This issue is exactly what PR #3927 is discharging.

### A5. Blast radius of removing the model entirely

Files/jobs/tests that would need to change if `emitted-drift-ack` fragments were removed outright:

- `scripts/lint-emitted-drift-ack.cjs` — deleted (or gutted to a no-op).
- `.github/workflows/test.yml:865-920` (`guard-no-ack-on-next` job) and its two checkout/fetch steps (`test.yml:875-895`) — deleted.
- `.github/workflows/ack-fragment-sweep.yml` — deleted entirely (237 lines).
- `tests/emitted-drift-acks/` directory and its `README.md` — deleted.
- `tests/helpers/emitted-diff.cjs`, `tests/helpers/emitted-runtime.cjs` — the ack-reading halves (`readAckFileAtRef`, `mergeAckSources`, `readAckSources`, `readAckSourcesAtRef`, `isSpent`, `staleAcks`, `spentAcks`) removed; `tests/emitted-attribution.test.cjs`'s differential check would then need a different escape hatch for legitimate unattributable ripples, or none at all (making every ripple a hard failure).
- `tests/emitted-attribution.test.cjs` — its ack-consuming assertions and the "#2914 migration pins" mentioned in `tests/emitted-drift-acks/README.md:64-69` removed.
- `tests/pr-template-policy.test.cjs`, `scripts/pr-template-policy.cjs` — unaffected directly, but the sweep PR's body text (which cites the ack model) would need rewriting if the workflow itself survives in some other form.
- `CONTEXT.md`'s `RULESET.EMITTED_ATTRIBUTION` entry (`CONTEXT.md:625`) and the `### Emitted Artifact Provenance` section it cross-references — rewritten.
- `CONTRIBUTING.md:1055-1124` ("Editing shipped content" ack sections) — rewritten.
- `docs/TESTING-SUITES.md:130-160` (the "workflow or agent grew" how-to) — rewritten.
- `docs/adr/2719-emitted-artifact-attribution.md` — would need a superseding ADR documenting the new escape hatch (or its removal), per this repo's own convention that architectural reversals get a new ADR rather than a silent edit.
- Any lint/test referencing `tests/emitted-drift-ack.json` or `tests/emitted-drift-acks/` by path (`grep -rl` across `.github/workflows/`, `scripts/`, `tests/` returns `test.yml`, `ack-fragment-sweep.yml`, `lint-emitted-drift-ack.cjs`, `docs/TESTING-SUITES.md`, `CONTRIBUTING.md`, `CONTEXT.md`, and the `tests/emitted-drift-acks/README.md` itself — all of the above).
- Issues #2789, #2914, #3078, #3842, #3875, #3823 would all become historical/moot context requiring a note that the model they describe no longer exists.

## B. Why #3927 hung — one root cause per red signal

### B6. `validate-title` — the sweep's own hardcoded title cannot pass its own gate

The sweep hardcodes: `--title "chore: sweep spent ack fragments from next (${SHORT_SHA})"` (`ack-fragment-sweep.yml:266`), producing the literal title `chore: sweep spent ack fragments from next (929e02cb)` for PR #3927.

The gate (`.github/workflows/pr-title-validator.yml`) delegates to `evaluatePrTitle()` in `scripts/release-notes/conventional-title.cjs:81-97`, which requires a header matching `HEADER_RE = /^([a-z]+)(\([^)]*\))?(!)?:/i` (line 28) **and** a scope group containing `#\d+` (`ISSUE_REF_IN_SCOPE_RE`, line 31; checked at line 92).

Against `chore: sweep spent ack fragments from next (929e02cb)`: `HEADER_RE` matches with `type="chore"` and scope-group `undefined` (there is no `(...)` immediately after `chore` — the colon follows directly). Since `!scope` is true, `evaluatePrTitle` returns `{ valid: false, reason: 'missing-issue-ref' }` (line 92-93) — confirmed as the actual CI failure (`gh pr checks 3927`: `validate-title  fail  8s`).

Two independent defects in the hardcoded string, either one sufficient to fail: (1) the parenthetical `(${SHORT_SHA})` sits at the *end* of the title, not immediately after the type, so it is never read as the "scope" group at all; (2) even if repositioned, a short git SHA (`929e02cb`) contains no `#`, so it would still fail `ISSUE_REF_IN_SCOPE_RE`.

A title that **would** pass: `chore(#3875): sweep spent ack fragments from next (929e02cb)` — matches the repo's own worked example in `conventional-title.cjs:71` (`enhance(#1549): add PR-title validator`) and correctly attributes the sweep to the issue it closes toward (#3875), which the current PR body already does in prose but the title does not.

### B7. `Pull request template format` — passed, but only because the account is trusted, not because the body complies

Contrary to the initial framing, this check **passed** (`gh pr checks 3927`: `Pull request template format  pass  12s`). The mechanism, read in full from `scripts/pr-template-policy.cjs`:

- The sweep's PR body (`ack-fragment-sweep.yml:243-261`) is freeform prose — no `## Fix PR` / `## Enhancement PR` / `## Feature PR` heading, none of the required headings in `TEMPLATES` (`pr-template-policy.cjs:55-97`).
- The changed-files carve-out does not apply: `tests/emitted-drift-acks/*.json` is not in `TOOLING_PATH_ALLOWLIST` (`pr-template-policy.cjs:24-43`), so `allPathsAreTooling` returns `false`.
- `matchingTemplate()` finds no heading match → `template: null` → falls to `reason = 'PR body does not match the fix, enhancement, or feature template.'`, `valid: false` (`pr-template-policy.cjs:217-223`).
- The consequence is gated on **author trust**, not template compliance (`pr-template-policy.cjs:226-229`): `action = trusted ? 'warn' : 'close'`. `TRUSTED_AUTHOR_ASSOCIATIONS` includes `MEMBER` (line 6-11). The PR's actual author association is `MEMBER` (`gh api repos/open-gsd/gsd-core/pulls/3927 --jq '.author_association'` → `MEMBER`), because the workflow authenticates `gh pr create` with `GSD_BOT_PR_TOKEN` — a personal-access token belonging to a real maintainer account (`trek-e`), not a GitHub App/bot identity. So `action: warn`: the `gsd-pr-template-policy` bot comment fires (`core.warning`, `pr-template-format.yml`'s "Warn trusted contributor" step), but the workflow only `core.setFailed`s on `action == 'close'` — never reached. The template body is objectively wrong; the check is objectively green.

### B8. `Required tests` / `test (ubuntu-latest, 24)` — the fast-signal lane ran the WHOLE suite and hit its own 15-minute cap

`gh run view 33059472019 --repo open-gsd/gsd-core --log-failed` and the per-job API (`jobs/98474440239`, `jobs/98478252101`) show:

- `test (ubuntu-latest, 24)` — the **unsharded** matrix entry (`.github/workflows/test.yml:198-200`: `{os: ubuntu-latest, node-version: 24, scope: targeted}`, no `shard` key, hence the bare job name per the `name:` template at `test.yml:130`) — started `09:38:38Z`, its "Run scoped tests" step ran from `09:39:10Z` to `09:53:51Z` (14m41s), and the whole job was marked `cancelled` at `09:53:56Z`, total **15m18s** — exactly the job's `timeout-minutes: 15` cap (`test.yml:155`).
- The raw log for that job shows `run-tests: suite="all" files=827` at `09:39:11Z`, and the job reached only `chunk 13/14` before being killed (`chunk 13/14 — 61 files` at `09:52:37Z`) — i.e. it was running virtually the entire test corpus (827 files) in one unsharded process, not a narrow "targeted/fast-signal" subset. The three actually-sharded ubuntu `scope: full` jobs (which exist precisely to spread this same corpus across 3 runners, per the `#2952`/`#3057` comments at `test.yml:141-164`) all finished successfully in 6-9 minutes each.
- Root cause, traced through the scope classifier: `scripts/ci-test-scope.cjs`'s `RULES` array (lines 71-324) has **no entry** matching `tests/emitted-drift-acks/*.json`. In `classify()` (lines 483-591), the changed path starts with `tests/` so `productOrPipelineChanged = true` (line 502), but it is not a `.test.cjs` file so it is not added to `targeted`/`windows` (line 520 requires `endsWith('.test.cjs')`), and no `RULES[].match` fires for it. The `#408` fallback then fires: `if (codeChanged && targetedTests.length === 0) targetedTests.push('unit')` (lines 561-563). `scripts/ci-prepare-test-scope.cjs`'s `resolveSelection()` (lines 49-71) passes that non-empty `['unit']` list through **verbatim** to `.ci-selected-tests.txt`, and `'unit'` is a `SUITE_SENTINEL` (`ci-prepare-test-scope.cjs:22`) that `run-tests.cjs` resolves live to (effectively) the whole non-integration/security/install/slow corpus — 827 files, matching the observed log.
- `Required tests` (`.github/workflows/test.yml:702-703`) then reads `TEST_RESULT: cancelled` (its own job log, captured verbatim above) and fails with `##[error]test matrix did not pass` — a mechanical propagation of the canceled test job, not an independent finding.
- **This is deterministic, not flaky.** Every sweep PR's diff is, by construction, one or more deletions under `tests/emitted-drift-acks/` — a path class the scope-classification table has never had a rule for. Any future run of `ack-fragment-sweep.yml` will hit the identical fallback and the identical 15-minute cliff, for the same reason PR #3094 (referenced in `test.yml:151-153`) hit it on the `scope: windows` lane before that lane was sharded — except the `scope: targeted` lane was never sharded because nothing was expected to widen it to "all."

### B9. How #3927 was actually merged despite red required checks

`gh api repos/open-gsd/gsd-core/pulls/3927 --jq '.merged_by.login, .merge_commit_sha, .author_association'` → `trek-e`, `ad6abc896...`, `MEMBER`. The PR was opened `09:38:15Z` and merged `12:16:49Z` (2h38m later) by the same account, `trek-e` (a human maintainer, `is_bot: false` per `gh pr list ... --json mergedBy`). The timeline (`gh api .../issues/3927/timeline`) shows only `review_requested` → two bot `commented` events → `merged`/`closed`/`head_ref_deleted`, all attributed to `trek-e` or `github-actions[bot]`; no re-run or re-triggered check event appears between open and merge. `gh pr checks 3927` (queried post-merge) still reports `validate-title fail` and `Required tests fail` as the latest, final state of those checks — they were never turned green. The merge therefore landed with required checks still red: a maintainer override (admin merge / branch-protection bypass), not an automatic pass triggered by the automation.

### B10. No auto-merge path exists for the sweep PR

`ack-fragment-sweep.yml` ends at `gh pr create` + `gh pr edit --add-label automation --add-label no-changelog` (lines 263-280) — no `gh pr merge`, no `enableAutoMerge` call, nothing. Grepping every workflow for `automerge`/`auto-merge` finds only `auto-backmerge.yml` (an unrelated `main`→`next` release-engineering workflow, gated on `push: branches: [main]`, using `-s ours` merges — nothing about ack fragments) and a comment in `release.yml:729` about release→main PRs. `pr-mergeable-preflight.yml` is a reusable merge-conflict early-exit gate shared by eight caller workflows; it applies no label and performs no merge (`pr-mergeable-preflight.yml:1-40`). There is no maintainer-facing auto-merge wired to `ack-fragment-sweep.yml`'s PRs at all — every one requires a human to notice it, review it, and merge it by hand (or override), exactly as `ack-fragment-sweep.yml:14-15`'s own top-of-file comment states: "a human still approves the deletion."

### B11. `GSD_BOT_PR_TOKEN` fallback warning did NOT fire — ruled out as a cause

`gh run view 33059445125 --repo open-gsd/gsd-core --log` (the sweep workflow's own run) shows the "Open the sweep PR" step's env block: `HAS_BOT_TOKEN: 1`. The step's guard is `if [ -z "${HAS_BOT_TOKEN:-}" ]; then echo '::warning::GSD_BOT_PR_TOKEN is unset...'; fi` (`ack-fragment-sweep.yml:191-193`) — with `HAS_BOT_TOKEN=1` this branch is skipped, and indeed no such warning line appears anywhere in the run log. `GSD_BOT_PR_TOKEN` **was** configured and used. This is corroborated independently by B7/B9: the PR's `author_association` is `MEMBER` (not the unauthenticated-fallback shape) and the title/template *required* checks did run and report real verdicts (`validate-title`, `Pull request template format` both executed) — under the `GITHUB_TOKEN` fallback the workflow's own comment (`ack-fragment-sweep.yml:189`) states "no required checks will run on it," which is not what happened. **The fallback-token hypothesis is not the cause of this hang.** (Git commit authorship on the branch itself still reads `github-actions[bot]` per `git config user.name` at `ack-fragment-sweep.yml:204-205` — a separate, cosmetic identity from the `gh` API actor, which is `trek-e` via the PAT.)

## C. Track record — is #3927 representative or a one-off?

`gh pr list --repo open-gsd/gsd-core --search "head:chore/ack-sweep" --state all --limit 30 --json number,title,state,createdAt,mergedAt,mergedBy` returns **exactly one PR**: #3927 itself (opened `09:38:15Z`, merged `12:16:49Z`, `mergedBy: trek-e`). There is no prior sweep PR to compare against — this is the automation's first (and so far only) production run that produced a non-empty plan and opened a PR. It cannot yet be called "systematically failing" by volume, but the failure mechanism identified in B8 is a property of the scope-classification table and the sweep's title-generation code, not of this specific run's data — so it will reproduce on the *next* sweep PR with high confidence, absent a fix to either `ack-fragment-sweep.yml`'s title format or `scripts/ci-test-scope.cjs`'s `RULES` table (or both).

## Open questions

- Should `scripts/ci-test-scope.cjs`'s `RULES` gain an explicit entry for `tests/emitted-drift-acks/` (mapping to a narrow, cheap test list — e.g. `tests/emitted-attribution.test.cjs`, `tests/lint-emitted-drift-ack.cjs`'s own test file if any) so a fragment-only diff no longer falls through the `#408` "unit" fallback onto the unsharded lane? This is the most direct fix for B8, and does not require sharding the `scope: targeted` lane.
- Should `ack-fragment-sweep.yml:266` be changed to `--title "chore(#3875): sweep ${COUNT} spent ack fragment(s) from next (${SHORT_SHA})"` (or similarly scoped) to satisfy `conventional-title.cjs` outright? This is a one-line fix for B6.
- Should the sweep PR body be reshaped to match one of the three typed templates (likely "Fix" or a new "chore" carve-out) so `Pull request template format` passes on its merits rather than on the author's trust level — closing the latent gap where an untrusted-token run of this same workflow (if `GSD_BOT_PR_TOKEN` ever lapses to a non-`MEMBER` identity) would hit `action: close` instead of `warn`?
- Given B10/B11, should the workflow (or a separate follow-up automation) add a bounded auto-merge step once its own required checks are green, so a correctly-titled, correctly-scoped sweep PR does not still require a human to notice and merge it by hand every six hours?
