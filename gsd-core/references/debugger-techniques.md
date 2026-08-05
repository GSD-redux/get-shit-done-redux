# Debugger technique catalog

Full technique bodies for `agents/gsd-debugger.md`, extracted per
`DEFECT.AGENT-FILE-SIZE-CAP-BREACH` (issue #2995, epic #1671 Phase 6.4). The agent
keeps each technique's name and routing entry; the step-by-step detail lives here.

## Binary Search / Divide and Conquer

**When:** Large codebase, long execution path, many possible failure points.

**How:** Cut problem space in half repeatedly until you isolate the issue.

1. Identify boundaries (where works, where fails)
2. Add logging/testing at midpoint
3. Determine which half contains the bug
4. Repeat until you find exact line

**Example:** API returns wrong data
- Test: Data leaves database correctly? YES
- Test: Data reaches frontend correctly? NO
- Test: Data leaves API route correctly? YES
- Test: Data survives serialization? NO
- **Found:** Bug in serialization layer (4 tests eliminated 90% of code)

## Rubber Duck Debugging

**When:** Stuck, confused, mental model doesn't match reality.

**How:** Explain the problem out loud in complete detail.

Write or say:
1. "The system should do X"
2. "Instead it does Y"
3. "I think this is because Z"
4. "The code path is: A -> B -> C -> D"
5. "I've verified that..." (list what you tested)
6. "I'm assuming that..." (list assumptions)

Often you'll spot the bug mid-explanation: "Wait, I never verified that B returns what I think it does."

## Delta Debugging

**When:** Large change set is suspected (many commits, a big refactor, or a complex feature that broke something). Also when "comment out everything" is too slow.

**How:** Binary search over the change space — not just the code, but the commits, configs, and inputs.

**Over commits (use git bisect):**
Already covered under Git Bisect. But delta debugging extends it: after finding the breaking commit, delta-debug the commit itself — identify which of its N changed files/lines actually causes the failure.

**Over code (systematic elimination):**
1. Identify the boundary: a known-good state (commit, config, input) vs the broken state
2. List all differences between good and bad states
3. Split the differences in half. Apply only half to the good state.
4. If broken: bug is in the applied half. If not: bug is in the other half.
5. Repeat until you have the minimal change set that causes the failure.

**Over inputs:**
1. Find a minimal input that triggers the bug (strip out unrelated data fields)
2. The minimal input reveals which code path is exercised

**When to use:**
- "This worked yesterday, something changed" → delta debug commits
- "Works with small data, fails with real data" → delta debug inputs
- "Works without this config change, fails with it" → delta debug config diff

**Example:** 40-file commit introduces bug
```
Split into two 20-file halves.
Apply first 20: still works → bug in second half.
Split second half into 10+10.
Apply first 10: broken → bug in first 10.
... 6 splits later: single file isolated.
```

## Minimal Reproduction

**When:** Complex system, many moving parts, unclear which part fails.

**How:** Strip away everything until smallest possible code reproduces the bug.

1. Copy failing code to new file
2. Remove one piece (dependency, function, feature)
3. Test: Does it still reproduce? YES = keep removed. NO = put back.
4. Repeat until bare minimum
5. Bug is now obvious in stripped-down code
6. **Shrinking (input-space bugs)** — when the bug triggers on a class of inputs, wrap it in a property (fast-check for JS/TS, Hypothesis for Python) and let the shrinker auto-minimize the counterexample; store the **minimized** input as the regression seed. See `gsd-core/references/debugger-repro-hardening.md`.

**Example:**
```jsx
// Start: 500-line React component with 15 props, 8 hooks, 3 contexts
// End after stripping:
function MinimalRepro() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(count + 1); // Bug: infinite loop, missing dependency array
  });

  return <div>{count}</div>;
}
// The bug was hidden in complexity. Minimal reproduction made it obvious.
```

## Working Backwards

**When:** You know correct output, don't know why you're not getting it.

**How:** Start from desired end state, trace backwards.

1. Define desired output precisely
2. What function produces this output?
3. Test that function with expected input - does it produce correct output?
   - YES: Bug is earlier (wrong input)
   - NO: Bug is here
4. Repeat backwards through call stack
5. Find divergence point (where expected vs actual first differ)

**Example:** UI shows "User not found" when user exists
```
Trace backwards:
1. UI displays: user.error → Is this the right value to display? YES
2. Component receives: user.error = "User not found" → Correct? NO, should be null
3. API returns: { error: "User not found" } → Why?
4. Database query: SELECT * FROM users WHERE id = 'undefined' → AH!
5. FOUND: User ID is 'undefined' (string) instead of a number
```

## Differential Debugging

**When:** Something used to work and now doesn't. Works in one environment but not another.

**Time-based (worked, now doesn't):**
- What changed in code since it worked?
- What changed in environment? (Node version, OS, dependencies)
- What changed in data?
- What changed in configuration?

**Environment-based (works in dev, fails in prod):**
- Configuration values
- Environment variables
- Network conditions (latency, reliability)
- Data volume
- Third-party service behavior

**Process:** List differences, test each in isolation, find the difference that causes failure.

**Example:** Works locally, fails in CI
```
Differences:
- Node version: Same ✓
- Environment variables: Same ✓
- Timezone: Different! ✗

Test: Set local timezone to UTC (like CI)
Result: Now fails locally too
FOUND: Date comparison logic assumes local timezone
```

## Observability First

**When:** Always. Before making any fix.

**Add visibility before changing behavior:**

```javascript
// Strategic logging (useful):
console.log('[handleSubmit] Input:', { email, password: '***' });
console.log('[handleSubmit] Validation result:', validationResult);
console.log('[handleSubmit] API response:', response);

// Assertion checks:
console.assert(user !== null, 'User is null!');
console.assert(user.id !== undefined, 'User ID is undefined!');

// Timing measurements:
console.time('Database query');
const result = await db.query(sql);
console.timeEnd('Database query');

// Stack traces at key points:
console.log('[updateUser] Called from:', new Error().stack);
```

**Workflow:** Add logging -> Run code -> Observe output -> Form hypothesis -> Then make changes.

## Comment Out Everything

**When:** Many possible interactions, unclear which code causes issue.

**How:**
1. Comment out everything in function/file
2. Verify bug is gone
3. Uncomment one piece at a time
4. After each uncomment, test
5. When bug returns, you found the culprit

**Example:** Some middleware breaks requests, but you have 8 middleware functions
```javascript
app.use(helmet()); // Uncomment, test → works
app.use(cors()); // Uncomment, test → works
app.use(compression()); // Uncomment, test → works
app.use(bodyParser.json({ limit: '50mb' })); // Uncomment, test → BREAKS
// FOUND: Body size limit too high causes memory issues
```

## Git Bisect

**When:** Feature worked in past, broke at unknown commit.

**How:** Binary search through git history.

```bash
git bisect start
git bisect bad              # Current commit is broken
git bisect good abc123      # This commit worked
# Git checks out middle commit
git bisect bad              # or good, based on testing
# Repeat until culprit found
```

100 commits between working and broken: ~7 tests to find exact breaking commit.

## Follow the Indirection

**When:** Code constructs paths, URLs, keys, or references from variables — and the constructed value might not point where you expect.

**The trap:** You read code that builds a path like `path.join(configDir, 'hooks')` and assume it's correct because it looks reasonable. But you never verified that the constructed path matches where another part of the system actually writes/reads.

**How:**
1. Find the code that **produces** the value (writer/installer/creator)
2. Find the code that **consumes** the value (reader/checker/validator)
3. Trace the actual resolved value in both — do they agree?
4. Check every variable in the path construction — where does each come from? What's its actual value at runtime?

**Common indirection bugs:**
- Path A writes to `dir/sub/hooks/` but Path B checks `dir/hooks/` (directory mismatch)
- Config value comes from cache/template that wasn't updated
- Variable is derived differently in two places (e.g., one adds a subdirectory, the other doesn't)
- Template placeholder (`{{VERSION}}`) not substituted in all code paths

**Example:** Stale hook warning persists after update
```
Check code says:  hooksDir = path.join(configDir, 'hooks')
                  configDir = ~/.claude
                  → checks ~/.claude/hooks/

Installer says:   hooksDest = path.join(targetDir, 'hooks')
                  targetDir = ~/.claude/gsd-core
                  → writes to ~/.claude/gsd-core/hooks/

MISMATCH: Checker looks in wrong directory → hooks "not found" → reported as stale
```

**The discipline:** Never assume a constructed path is correct. Resolve it to its actual value and verify the other side agrees. When two systems share a resource (file, directory, key), trace the full path in both.

