<step name="forensic_audit">
**Forensic Integrity Audit** — only runs when `--forensic` is present in ARGUMENTS.

If `--forensic` is NOT present in ARGUMENTS: skip this step entirely. Default progress behavior (standard report + routing) is unchanged.

If `--forensic` IS present: after the standard report and routing suggestion have been displayed, append the following audit section.

---

## Forensic Integrity Audit

Running 7 deep checks against project state...

Run each check in order. For each check, emit ✓ (pass) or ⚠ (warning) with concrete evidence when a problem is found.

**Check 1 — STATE vs artifact consistency**

Read STATE.md `status` / `stopped_at` fields (from the STATE snapshot already loaded). Compare against the artifact count from the roadmap analysis. If STATE.md claims the current phase is pending/mid-flight but the artifact count shows it as complete (all PLAN.md files have matching SUMMARY.md files), flag inconsistency. Emit:
- ✓ `STATE.md consistent with artifact count` — if both agree
- ⚠ `STATE.md claims [status] but artifact count shows phase complete` — with the specific values

**Check 2 — Orphaned handoff files**

Check for existence of:
```bash
ls .planning/HANDOFF.json .planning/phases/*/.continue-here.md .planning/phases/*/*HANDOFF*.md 2>/dev/null || true
```
Also check `.planning/continue-here.md`.

Emit:
- ✓ `No orphaned handoff files` — if none found
- ⚠ `Orphaned handoff files found` — list each file path, add: `→ Work was paused mid-flight. Read the handoff before continuing.`

**Check 3 — Deferred scope drift**

Search phase artifacts (CONTEXT.md, DISCUSSION-LOG.md, BUG-BRIEF.md, VERIFICATION.md, SUMMARY.md, HANDOFF.md files under `.planning/phases/`) for patterns:
```bash
grep -rl "defer to Phase\|future phase\|out of scope Phase\|deferred to Phase" .planning/phases/ 2>/dev/null || true
```

For each match, extract the referenced phase number. Cross-reference against ROADMAP.md phase list. If the referenced phase number is NOT in ROADMAP.md, flag as deferred scope not captured.

Emit:
- ✓ `All deferred scope captured in ROADMAP` — if no mismatches
- ⚠ `Deferred scope references phase(s) not in ROADMAP` — list: file, reference text, missing phase number

**Check 4 — Memory-flagged pending work**

Check if `.planning/MEMORY.md` or `.planning/memory/` exists:
```bash
ls .planning/MEMORY.md .planning/memory/*.md 2>/dev/null || true
```

If found, grep for entries containing: `pending`, `status`, `deferred`, `not yet run`, `backfill`, `blocking`.

Emit:
- ✓ `No memory entries flagging pending work` — if none found or no MEMORY.md
- ⚠ `Memory entries flag pending/deferred work` — list the matching lines (max 5, truncated at 80 chars)

**Check 5 — Blocking operational todos**

Check for pending todos:
```bash
ls .planning/todos/pending/*.md 2>/dev/null || true
```

For files found, scan for keywords indicating operational blockers: `script`, `credential`, `API key`, `manual`, `verification`, `setup`, `configure`, `run `.

Emit:
- ✓ `No blocking operational todos` — if no pending todos or none match operational keywords
- ⚠ `Blocking operational todos found` — list the file names and matching keywords (max 5)

**Check 6 — Uncommitted code**

```bash
git status --porcelain 2>/dev/null | grep -v "^??" | grep -v "^.planning\/" | grep -v "^\.\." | head -10
```

If output is non-empty (modified/staged files outside `.planning/`), flag as uncommitted code.

Emit:
- ✓ `Working tree clean` — if no modified files outside `.planning/`
- ⚠ `Uncommitted changes in source files` — list up to 10 file paths

**Check 7 — Unresolved deferred items**

Glob every phase directory's SCOPE BOUNDARY log (executor writes out-of-scope discoveries here per `agents/gsd-executor.md`):
```bash
ls .planning/phases/*/deferred-items.md 2>/dev/null || true
```

For each `deferred-items.md` found, read its entries (bullet list, one entry per top-level `- ` line, continuation lines indented beneath it). An entry is RESOLVED only if it carries an explicit `status: resolved` field (case-insensitive) on one of its lines; every other entry — including one with no `status:` field at all — is UNRESOLVED and must be surfaced (fail-safe: never silently drop a possibly-open item).

Emit:
- ✓ `No unresolved deferred items` — if no `deferred-items.md` files exist, or every entry in every file is `status: resolved`
- ⚠ `Unresolved deferred items found` — list each file's phase directory and its unresolved entry text (max 5 per file, truncated at 80 chars)

---

After all 7 checks, display the verdict:

**If all 7 checks passed:**
```
### Verdict: CLEAN

The standard progress report is trustworthy — proceed with the routing suggestion above.
```

**If 1 or more checks failed:**
```
### Verdict: N INTEGRITY ISSUE(S) FOUND

The standard progress report may not reflect true project state.
Review the flagged items above before acting on the routing suggestion.
```

Then for each failed check, add a concrete next action:
- Check 2 (orphaned handoff): `Read the handoff file(s) and resume from where work was paused: /gsd:resume-work ${GSD_WS}`
- Check 3 (deferred scope): `Add the missing phases to ROADMAP.md or update the deferred references`
- Check 4 (memory pending): `Review the flagged memory entries and resolve or clear them`
- Check 5 (blocking todos): `Complete the operational steps in .planning/todos/pending/ before continuing`
- Check 6 (uncommitted code): `Commit or stash the uncommitted changes before advancing`
- Check 7 (unresolved deferred items): `Address each deferred item and mark it status: resolved in its deferred-items.md, or fold it into the roadmap`
- Check 1 (STATE inconsistency): `Run /gsd:verify-work ${PHASE} ${GSD_WS} to reconcile state`
</step>
