# How to verify and ship a phase

**Goal:** Walk executed work through user acceptance testing, diagnose and fix any failures, then open a pull request with an auto-generated body.

**Prerequisites:** The phase has been executed and has `SUMMARY.md` files. If execution is not yet done, see [Execute a phase](execute-a-phase.md).

---

## Run user acceptance testing

```bash
/gsd-verify-work 1
```

GSD reads the phase's `SUMMARY.md` files, extracts user-observable deliverables, and walks you through them one at a time. For each checkpoint it presents what *should* happen and asks whether reality matches.

- `yes` / `y` / empty → pass, move to next test
- Anything else → recorded as an issue, severity inferred from your description

You never need to categorise severity — GSD infers it from your words ("crashes" → blocker, "doesn't work" → major, "looks off" → cosmetic).

Progress is written to `.planning/phases/01-<name>/01-UAT.md` and survives a `/clear`. If a session is interrupted, re-run `/gsd-verify-work 1` and GSD offers to resume from the last checkpoint.

---

## When failures are found: auto-diagnose and fix planning

If any tests report issues, GSD proceeds automatically:

1. **Diagnoses root causes** — spawns parallel debug agents, one per issue, and updates `UAT.md` with root causes.
2. **Plans gap closure** — spawns a `gsd-planner` in gap-closure mode, which reads `UAT.md` (with diagnoses) and writes new `PLAN.md` files.
3. **Verifies the fix plans** — spawns a `gsd-plan-checker` to ensure the plans are executable. If issues are found, the planner and checker iterate up to three times.
4. **Presents next step** — when plans pass the checker:

```
Plans verified and ready for execution.

`/clear` then `/gsd-execute-phase 1 --gaps-only`
```

Run the suggested command to apply fixes, then re-run `/gsd-verify-work 1` to confirm everything passes.

---

## When all tests pass: ship the phase

Once all UAT tests pass (or if this is your first run and no issues are found), the phase is marked complete in `ROADMAP.md` and `STATE.md` automatically.

```bash
/gsd-ship 1
```

GSD runs preflight checks (verification status, clean working tree, branch, remote, `gh` CLI authentication), pushes the branch, and creates a PR:

```bash
/gsd-ship 1          # Ready-for-review PR
/gsd-ship 1 --draft  # Draft PR — useful when more phases will follow
```

The PR body is assembled from planning artefacts automatically:

- Phase goal from `ROADMAP.md`
- Per-plan summaries from `SUMMARY.md` files and their key files
- Requirements addressed (REQ-IDs)
- Verification status from `VERIFICATION.md`
- Key decisions from `STATE.md`

No manual body writing required.

---

## Optional: code review before or after shipping

`/gsd-ship` does not run a code review automatically, but you can slot one in at any point:

**Before verification** (catches issues before UAT):

```bash
/gsd-code-review 1          # Standard review
/gsd-code-review 1 --fix    # Review then auto-fix Critical + Warning findings
```

**After the PR is open** (to gate on quality before merge):

```bash
/gsd-code-review 1 --depth=deep  # Cross-file analysis including import graphs
```

See [Set up cross-AI review](set-up-cross-ai-review.md) to configure Gemini, Codex, or other reviewers for plan review earlier in the cycle.

---

## Optional: create a clean PR branch

If your branch contains `.planning/` commits that you do not want reviewers to see:

```bash
/gsd-pr-branch          # Filter against main
/gsd-pr-branch develop  # Filter against develop
```

`/gsd-pr-branch` creates a new branch with only code changes — planning artefact commits are excluded. Run this before `/gsd-ship` if your team's review policy excludes planning noise.

---

## Why a passing verification can turn stale

A `*-VERIFICATION.md` reporting `status: passed` is re-checked, not cached, every time a completion gate reads it. Two ways it can flip to `status: stale`:

- **Content fingerprint (default for new reports).** The verifier records a digest of every input its verdict covers — the phase's `PLAN.md`/`SUMMARY.md` files, mapped requirements, and implementation files in the change set. If any of those files changes, disappears, or becomes unreadable after verification, the gate recomputes the digest, finds a mismatch, and reports `stale`. This catches drift even when nothing touches `SUMMARY.md` itself — an implementation file edited after verification is enough.
- **Legacy SUMMARY-mtime check.** A `*-VERIFICATION.md` written before this fingerprint existed has no digest to check, so it keeps the older rule: `stale` when a `SUMMARY.md` is newer than the verification report.

Either way, `stale` routes the same as any other incomplete state: re-run `/gsd-verify-work 1` before shipping.

The content fingerprint hashes covered files exactly as they sit on disk, including line endings. A checkout without a `.gitattributes` `eol=lf` rule pinning text files to LF (a Windows checkout with `core.autocrlf=true`, for example) can report `stale` on unchanged content — fix with a `.gitattributes` `eol=lf` rule, not by treating it as drift.

---

## Closing a milestone

If this was the last phase in the milestone, run the milestone audit and archive it:

```bash
/gsd-audit-milestone      # Verify all requirements shipped
/gsd-complete-milestone   # Archive, create git tag
```

`/gsd-complete-milestone` is the natural next step after the PR merges. See the [The phase loop](../explanation/the-phase-loop.md) for how verification and shipping fit into the full project lifecycle.

---

## Related

- [Execute a phase](execute-a-phase.md)
- [Set up cross-AI review](set-up-cross-ai-review.md)
- [The phase loop](../explanation/the-phase-loop.md)
- [Commands](../COMMANDS.md)
