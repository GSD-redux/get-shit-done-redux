# Branch Protection Rollout

## Rulesets

Three ruleset specs live under `.github/rulesets/`. All are committed with
`enforcement: disabled` and activated in stages via the 3-PR rollout below.

### `main-protection`
Targets `~DEFAULT_BRANCH` (main). Enforces:
- No deletions or force pushes
- Required linear history (no merge commits)
- All changes via pull request (0 required approvals, stale-review dismissal, thread resolution required, squash/rebase only)
- Required status checks: the aggregate `Required tests` gate plus PR policy
  checks for size, branch name, changeset, docs, target branch, issue link, and
  PR template format

### `release-branches`
Targets `refs/heads/release/**` and `refs/heads/hotfix/**`. Same rules as
`main-protection` except `required_linear_history` is omitted (merge commits
are permitted on release/hotfix branches).

### `tag-immutability`
Targets all tags (`~ALL`). Blocks tag updates and deletions — tags are
immutable once created. Tag creation is unrestricted.

## 4-PR Rollout Plan

| PR | Branch | Action |
|----|--------|--------|
| PR-1 | `chore/branch-protection-specs` | Check in spec files; `enforcement: disabled` — no effect on repo |
| PR-2 | `chore/tiered-ci-gate` | Add tiered test scope detection to `test.yml`; doc-only PRs satisfy `Required tests` without macOS/Windows noop queues |
| PR-3 | `chore/branch-protection-evaluate` | Run `sync-rulesets.sh` with `ENFORCEMENT=evaluate`; 1-week dry-run via rule-suite logs |
| PR-4 | `chore/branch-protection-active` | Run `sync-rulesets.sh` with `ENFORCEMENT=active`; protection live |

## Running `sync-rulesets.sh`

**Prerequisites:** `gh` authenticated with repo-admin scope, `jq` installed.

```bash
# Dry-run (evaluate mode — logs violations, does not block)
REPO=open-gsd/gsd-core ENFORCEMENT=evaluate bash scripts/sync-rulesets.sh

# Activate protection
REPO=open-gsd/gsd-core ENFORCEMENT=active bash scripts/sync-rulesets.sh

# Roll back to disabled
REPO=open-gsd/gsd-core ENFORCEMENT=disabled bash scripts/sync-rulesets.sh
```

The script is idempotent: running it twice with the same `ENFORCEMENT` value
is a no-op semantically (PUT with identical body).

## Reading evaluate-mode logs

After applying with `evaluate`, check which PRs/pushes would have been blocked:

```bash
REPO=open-gsd/gsd-core
RULESET_ID=$(gh api repos/$REPO/rulesets --jq '.[] | select(.name=="main-protection") | .id')
gh api repos/$REPO/rulesets/$RULESET_ID/rule-suites
```

Each entry shows the actor, ref, result (`pass`/`fail`), and which rules
triggered. Use this to validate no legitimate workflows are broken before
flipping to `active` in PR-3.


## Test scope detection

The `test.yml` workflow always runs, but its `changes` job classifies the PR
with `scripts/ci-test-scope.cjs` before starting expensive runners. The required
branch-protection context is the single aggregate `Required tests` job.

Doc-only PRs run the lightweight lint and aggregate jobs only. Code-touching PRs
run the default required matrix:

- Ubuntu / Node 24 scoped tests
- Ubuntu / Node 24 unit, integration, and security suites
- Windows / Node 24 scoped Windows/path/shell tests
- Ubuntu / Node 24 coverage

PRs that touch workflow, package, test-runner, install, release, or Windows
sensitive surfaces also run install/slow on the primary Ubuntu lane and the full
parity matrix:

- Windows / Node 24
- macOS / Node 24

### Canonical code-paths list

The `changes` job treats these paths as code-touching:

```
bin/**
gsd-core/**
agents/**
commands/**
hooks/**
tests/**
scripts/**
package.json
package-lock.json
tsconfig*.json
.github/workflows/**
.github/rulesets/**
```

This list should stay aligned with changeset/docs policy where those gates care
about the same user-facing surfaces.

### Adding a new code path

When adding a directory or file that should trigger real tests:

1. Add the path classifier to `scripts/ci-test-scope.cjs`.
2. Add targeted tests for that surface in the same classifier.
3. If it requires macOS/extra-Windows coverage, mark the classifier rule
   `fullMatrix: true`.
4. Add the same glob to `changeset-required.yml` if changesets should be required
   for that path

The old `test-skip.yml` inverse-path workflow was removed. Do not add required
checks for individual matrix jobs; require the aggregate `Required tests` context
instead.

## Phase-2 TODO

Enable the `required_signatures` rule (signed commits) once agent commits sign
uniformly. As of PR-1 this rule is intentionally omitted — unsigned agent
commits would be blocked by it. Track readiness in the issue linked to PR-3.
