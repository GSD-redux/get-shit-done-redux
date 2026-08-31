# Executor Extended Examples

> Reference file for gsd-executor agent. Loaded on-demand via `@` reference.
> For sub-200K context windows, this content is stripped from the agent prompt and available here for on-demand loading.

## Deviation Rule Examples

### Rule 1 — Auto-fix bugs

**Examples of Rule 1 triggers:**
- Wrong queries returning incorrect data
- Logic errors in conditionals
- Type errors and type mismatches
- Null pointer exceptions / undefined access
- Broken validation (accepts invalid input)
- Security vulnerabilities (XSS, SQL injection)
- Race conditions in async code
- Memory leaks from uncleaned resources

### Rule 2 — Auto-add missing critical functionality

**Examples of Rule 2 triggers:**
- Missing error handling (unhandled promise rejections, no try/catch on I/O)
- No input validation on user-facing endpoints
- Missing null checks before property access
- No auth on protected routes
- Missing authorization checks (user can access other users' data)
- No CSRF/CORS configuration
- No rate limiting on public endpoints
- Missing DB indexes on frequently queried columns
- No error logging (failures silently swallowed)

### Rule 3 — Auto-fix blocking issues

**Examples of Rule 3 triggers:**
- Missing dependency not in package.json
- Wrong types preventing compilation
- Broken imports (wrong path, wrong export name)
- Missing env var required at runtime
- DB connection error (wrong URL, missing credentials)
- Build config error (wrong entry point, missing loader)
- Missing referenced file (import points to non-existent module)
- Circular dependency preventing module load

### Rule 4 — Ask about architectural changes

**Examples of Rule 4 triggers:**
- New DB table (not just adding a column)
- Major schema changes (renaming tables, changing relationships)
- New service layer (adding a queue, cache, or message bus)
- Switching libraries/frameworks (e.g., replacing Express with Fastify)
- Changing auth approach (switching from session to JWT)
- New infrastructure (adding Redis, S3, etc.)
- Breaking API changes (removing or renaming endpoints)

## Edge Case Decision Guide

| Scenario | Rule | Rationale |
|----------|------|-----------|
| Missing validation on input | Rule 2 | Security requirement |
| Crashes on null input | Rule 1 | Bug — incorrect behavior |
| Need new database table | Rule 4 | Architectural decision |
| Need new column on existing table | Rule 1 or 2 | Depends on context |
| Pre-existing linting warnings | Out of scope | Not caused by current task |
| Unrelated test failures | Out of scope | Not caused by current task |

**Decision heuristic:** "Does this affect correctness, security, or ability to complete the current task?"
- YES → Rules 1-3 (fix automatically)
- MAYBE → Rule 4 (ask the user)
- NO → Out of scope (log to deferred-items.md)

### Writing `deferred-items.md`

The file has no template — write it by hand, as a Markdown list under a
`## Deferred Items` heading. What counts as one entry:

- One entry per top-level list item. `-`, `*` and `+` all count, and so does a
  dot-terminated ordered marker (`1.`) when the list starts at `0.` or `1.`, or
  continues a list already open at that level — a sentence that merely opens
  with a number (`2026. was a bad year`) is prose, not an item, and so is a
  list numbered from `2.` upward until its first `0.`/`1.` line. `1)` is not a
  marker here, and neither is an ordinal past nine digits (`999999999.`
  counts, `1234567890.` does not).
- Continuation lines indent beneath their entry. Fields go on those lines:
  `status: resolved`, or the bolded `**Status:** resolved` convention. **The
  BARE key is lower-case only** — write `Status: resolved` without the bold and
  the field is not read, so the entry stays open with no warning. Bold it or
  lower-case it. The bolded form matches the key case-insensitively, and the
  VALUE is case-insensitive in both forms.
- A `* * *` or `- - -` separator closes the list rather than opening an entry,
  and nothing inside a fenced code block is an entry or a field — at any indent,
  including one deeper than CommonMark's three-space cap, which is what a fence
  written under a nested bullet looks like. A fence that is never closed runs to
  the end of its own entry and no further, so an unclosed delimiter cannot hide
  the entries after it — a closed pair of delimiters is a fence, whatever sits
  between them.

An entry is RESOLVED only if it carries an explicit `status: resolved`. Anything
else — including an entry with no `status:` at all — stays open and will surface
in `audit-open`, `audit-uat` and `complete-milestone`. That is deliberate: the
scanner never silently drops a possibly-open item. What it reads as something
other than an item is the short list above — a fenced line, a separator, and an
ordered list numbered from `2.` upward at a paragraph position — and nothing
else.

```markdown
## Deferred Items

- Retry budget is hardcoded at 3
  status: open
  **What:** `fetchWithRetry` ignores the configured budget.
```

## Checkpoint Examples

### Good checkpoint placement

```xml
<!-- Automate everything, then verify at the end -->
<task type="auto">Create database schema</task>
<task type="auto">Create API endpoints</task>
<task type="auto">Create UI components</task>
<task type="checkpoint:human-verify">
  <what-built>Complete auth flow (schema + API + UI)</what-built>
  <how-to-verify>
    1. Visit http://localhost:3000/register
    2. Create account with test@example.com
    3. Log in with those credentials
    4. Verify dashboard loads with user name
  </how-to-verify>
</task>
```

### Bad checkpoint placement

```xml
<!-- Too many checkpoints — causes verification fatigue -->
<task type="auto">Create schema</task>
<task type="checkpoint:human-verify">Check schema</task>
<task type="auto">Create API</task>
<task type="checkpoint:human-verify">Check API</task>
<task type="auto">Create UI</task>
<task type="checkpoint:human-verify">Check UI</task>
```

### Auth gate handling

When an auth error occurs during `type="auto"` execution:
1. Recognize it as an auth gate (not a bug) — indicators: "Not authenticated", "401", "403", "Please run X login"
2. STOP the current task
3. Return a `checkpoint:human-action` with exact auth steps
4. In SUMMARY.md, document auth gates as normal flow, not deviations
