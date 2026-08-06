# Verifier wiring and data-flow patterns

Full pattern bodies for `agents/gsd-verifier.md`, extracted per
`DEFECT.AGENT-FILE-SIZE-CAP-BREACH` (issue #2995, epic #1671 Phase 6.4). The agent
keeps the step and its checklist; the per-pattern detail and shell recipes live here.

Artifacts that pass Levels 1-3 (exist, substantive, wired) can still be hollow if their data source produces empty or hardcoded values. Level 4 traces upstream from the artifact to verify real data flows through the wiring.

**When to run:** For each artifact that passes Level 3 (WIRED) and renders dynamic data (components, pages, dashboards — not utilities or configs).

**How:**

1. **Identify the data variable** — what state/prop does the artifact render?

```bash
# Find state variables that are rendered in JSX/TSX
grep -n -E "useState|useQuery|useSWR|useStore|props\." "$artifact" 2>/dev/null
```

2. **Trace the data source** — where does that variable get populated?

```bash
# Find the fetch/query that populates the state
grep -n -A 5 "set${STATE_VAR}\|${STATE_VAR}\s*=" "$artifact" 2>/dev/null | grep -E "fetch|axios|query|store|dispatch|props\."
```

3. **Verify the source produces real data** — does the API/store return actual data or static/empty values?

```bash
# Check the API route or data source for real DB queries vs static returns
grep -n -E "prisma\.|db\.|query\(|findMany|findOne|select|FROM" "$source_file" 2>/dev/null
# Flag: static returns with no query
grep -n -E "return.*json\(\s*\[\]|return.*json\(\s*\{\}" "$source_file" 2>/dev/null
```

4. **Check for disconnected props** — props passed to child components that are hardcoded empty at the call site

```bash
# Find where the component is used and check prop values
grep -r -A 3 "<${COMPONENT_NAME}" "${search_path:-src/}" --include="*.tsx" 2>/dev/null | grep -E "=\{(\[\]|\{\}|null|''|\"\")\}"
```

> These two status tables are intentionally mirrored in `agents/gsd-verifier.md`.
> The status vocabulary is load-bearing verifier output and must remain in the
> agent body (#2995); this copy is here so the procedure below reads standalone.

**Data-flow status:**

| Data Source | Produces Real Data | Status |
| ---------- | ------------------ | ------ |
| DB query found | Yes | ✓ FLOWING |
| Fetch exists, static fallback only | No | ⚠️ STATIC |
| No data source found | N/A | ✗ DISCONNECTED |
| Props hardcoded empty at call site | No | ✗ HOLLOW_PROP |

**Final Artifact Status (updated with Level 4):**

| Exists | Substantive | Wired | Data Flows | Status |
| ------ | ----------- | ----- | ---------- | ------ |
| ✓ | ✓ | ✓ | ✓ | ✓ VERIFIED |
| ✓ | ✓ | ✓ | ✗ | ⚠️ HOLLOW — wired but data disconnected |
| ✓ | ✓ | ✗ | - | ⚠️ ORPHANED |
| ✓ | ✗ | - | - | ✗ STUB |
| ✗ | - | - | - | ✗ MISSING |

### Pattern: Component → API

```bash
grep -E "fetch\(['\"].*$api_path|axios\.(get|post).*$api_path" "$component" 2>/dev/null
grep -A 5 "fetch\|axios" "$component" | grep -E "await|\.then|setData|setState" 2>/dev/null
```

Status: WIRED (call + response handling) | PARTIAL (call, no response use) | NOT_WIRED (no call)

### Pattern: API → Database

```bash
grep -E "prisma\.$model|db\.$model|$model\.(find|create|update|delete)" "$route" 2>/dev/null
grep -E "return.*json.*\w+|res\.json\(\w+" "$route" 2>/dev/null
```

Status: WIRED (query + result returned) | PARTIAL (query, static return) | NOT_WIRED (no query)

### Pattern: Form → Handler

```bash
grep -E "onSubmit=\{|handleSubmit" "$component" 2>/dev/null
grep -A 10 "onSubmit.*=" "$component" | grep -E "fetch|axios|mutate|dispatch" 2>/dev/null
```

Status: WIRED (handler + API call) | STUB (only logs/preventDefault) | NOT_WIRED (no handler)

### Pattern: State → Render

```bash
grep -E "useState.*$state_var|\[$state_var," "$component" 2>/dev/null
grep -E "\{.*$state_var.*\}|\{$state_var\." "$component" 2>/dev/null
```

Status: WIRED (state displayed) | NOT_WIRED (state exists, not rendered)
