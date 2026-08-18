# Spec-less Probe Fallback — protocol

Lazy-loaded by `workflows/plan-phase.md` step 7.95 (the gate) and the `<specless_probe_fallback>`
planner block. When a phase SPEC did NOT supply `## Edge Coverage` / `## Prohibitions`, plan-phase
runs the same probe protocol the SPEC path uses and authors the predicates into PLAN.md `must_haves`
(ADR-857 Phase 6 — the *else branch* of the `<downstream_consumer>` SPEC-conditional lift). This is
core workflow-body substrate — NOT the `PLAN_PRE_HOOKS_JSON contribution into planner` capability rail
(D-03). Section absence is detected by the shared `spec-section` helper in the gate; this file holds the
*run-the-probe* half so the capped plan-phase.md stays lean (#717/#1074 budget).

## 0. Gate — toggle + per-section absence (run first, in the orchestrator)

Reads the default-ON toggle and computes `EDGE_ABSENT` / `PROHIB_ABSENT` via the shared `spec-section`
helper; records a VISIBLE skip when disabled or when the phase has no requirement IDs (never a silent
skip, never a hard-fail). Sets `SPECLESS_FALLBACK`, `EDGE_ABSENT`, `PROHIB_ABSENT`, and
`SPECLESS_FALLBACK_DISABLED` for §A and the planner prompt.

```bash
# Toggle defaults ON (D-04 / RAIL-05): any value other than literal "false" enables.
SPECLESS_CFG=$(gsd_run query config-get workflow.specless_probe_fallback 2>/dev/null || echo "true")
SPECLESS_FALLBACK=true; [[ "$SPECLESS_CFG" == "false" ]] && SPECLESS_FALLBACK=false

# Per-section absence (D-05 / RAIL-03): "not supplied" = header absent OR present-but-empty. The
# shared, tested `spec-section` helper (src/spec-section.cts -> bin/lib/spec-section.cjs) is the SINGLE
# source of truth for the canonical SPEC headings (suffix-tolerant) and table-row counting, replacing
# ad-hoc awk (contract pinned by tests/spec-section.test.cjs). Resolve via the edge-probe install-dir
# idiom; build only in a source checkout, else fail loud (never silently mis-detect).
_GSD_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
_gsd_lib() { for _d in "$_GSD_RT/gsd-core/bin/lib" "$_GSD_RT/bin/lib" "$_GSD_RT/.claude/bin/lib" "$HOME/.claude/gsd-core/bin/lib" "$HOME/.claude/bin/lib"; do [ -f "$_d/$1" ] && { echo "$_d/$1"; return; }; done; }
SPEC_SECTION_JS=$(_gsd_lib spec-section.cjs)
if [ -z "$SPEC_SECTION_JS" ] && [ -f "$_GSD_RT/tsconfig.build.json" ] && [ -f "$_GSD_RT/src/spec-section.cts" ]; then
  npm --prefix "$_GSD_RT" run build:lib 2>/dev/null || true; SPEC_SECTION_JS=$(_gsd_lib spec-section.cjs)
fi
[ -n "$SPEC_SECTION_JS" ] || { echo "ERROR: spec-section.cjs not found - reinstall GSD or run build:lib." >&2; exit 1; }
# supplied => header present AND >=1 row; missing $SPEC_FILE => supplied:false => fallback fires.
EDGE_ABSENT=1;   node "$SPEC_SECTION_JS" "$SPEC_FILE" edges       2>/dev/null | grep -q '"supplied":true' && EDGE_ABSENT=0
PROHIB_ABSENT=1; node "$SPEC_SECTION_JS" "$SPEC_FILE" prohibitions 2>/dev/null | grep -q '"supplied":true' && PROHIB_ABSENT=0

# Disabled path - record the skip VISIBLY, never silently (RAIL-05 / PROH-4); the note rides into the
# planner prompt (Step 8) so the plan records that no probe predicates were generated.
SPECLESS_FALLBACK_DISABLED=""
if [[ "$SPECLESS_FALLBACK" != "true" ]]; then
  echo "WARNING: probe fallback disabled (workflow.specless_probe_fallback=false); skip recorded, not silent." >&2
  SPECLESS_FALLBACK_DISABLED="probe fallback disabled (workflow.specless_probe_fallback=false): no probe-derived predicates generated for SPEC-absent sections this run."
fi

# Nothing-to-probe guard: the fallback derives predicates from requirement TEXT, so zero requirement
# IDs => nothing to probe => skip VISIBLY (like the disabled path), NOT a hard-fail. Prevents a
# no-SPEC + no-requirements phase from aborting under the default-ON fallback. The orchestrator
# substitutes {phase_req_ids}; empty/whitespace/TBD => no requirements. (A still-literal token is
# non-empty, so an unsubstituted run correctly hits the reference's fail-loud guard instead.)
SPECLESS_REQ_IDS="{phase_req_ids}"
if [[ "$SPECLESS_FALLBACK" == "true" ]] && { [ -z "${SPECLESS_REQ_IDS// /}" ] || [ "${SPECLESS_REQ_IDS}" = "TBD" ]; }; then
  echo "info: spec-less probe fallback: phase has no requirement IDs - nothing to probe; skipping (visible skip)." >&2
  SPECLESS_FALLBACK=false
  SPECLESS_FALLBACK_DISABLED="spec-less probe fallback skipped: phase has no requirement IDs to probe (visible skip)."
fi
```

## A. Edge probe (deterministic) — run when `SPECLESS_FALLBACK=true` AND `EDGE_ABSENT=1`

Mirrors spec-phase Step 5.5 verbatim; the ONLY divergence (D-02) is sourcing `$REQS_JSON` from the
phase requirement IDs (`{phase_req_ids}`) instead of a SPEC interview. Leave `$COVERAGE` empty when
`EDGE_ABSENT=0` — a SPEC-supplied section is never re-run (section-level precedence).

```bash
# Resolve the compiled edge-probe.cjs against the GSD install dir via RUNTIME_DIR (#448) — NOT the
# consuming project's git root — falling back to git toplevel / $HOME/.claude (spec-phase.md:198 idiom).
_GSD_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
EDGE_PROBE_JS=$(for _c in \
  "$_GSD_RT/gsd-core/bin/lib/edge-probe.cjs" "$_GSD_RT/bin/lib/edge-probe.cjs" \
  "$_GSD_RT/.claude/bin/lib/edge-probe.cjs" "$HOME/.claude/gsd-core/bin/lib/edge-probe.cjs" \
  "$HOME/.claude/bin/lib/edge-probe.cjs"; do [ -f "$_c" ] && { echo "$_c"; break; }; done)
# Build ONLY inside a verified GSD source checkout; --prefix pins npm so we never trigger the
# consuming project's build:lib. Never silent-skip (RR-04) — fail loud if unresolvable.
if [ -z "$EDGE_PROBE_JS" ]; then
  if [ -f "$_GSD_RT/tsconfig.build.json" ] && [ -f "$_GSD_RT/src/edge-probe.cts" ]; then
    npm --prefix "$_GSD_RT" run build:lib 2>/dev/null || true
    EDGE_PROBE_JS=$(for _c in \
      "$_GSD_RT/gsd-core/bin/lib/edge-probe.cjs" "$_GSD_RT/bin/lib/edge-probe.cjs" \
      "$_GSD_RT/.claude/bin/lib/edge-probe.cjs" "$HOME/.claude/gsd-core/bin/lib/edge-probe.cjs" \
      "$HOME/.claude/bin/lib/edge-probe.cjs"; do [ -f "$_c" ] && { echo "$_c"; break; }; done)
  fi
  [ -n "$EDGE_PROBE_JS" ] || { echo "ERROR: edge-probe.cjs not found — reinstall GSD or run \`npm run build:lib\`." >&2; exit 1; }
fi

# THE ONE DIVERGENCE (D-02): source requirements from THIS phase. Populate the heredoc from
# {phase_req_ids}, pulling each requirement's text from REQUIREMENTS.md: {"id","text","shapes"?}.
# mktemp suffix trick is BSD/GNU portable (#1520).
REQS_JSON=$(mktemp "${TMPDIR:-/tmp}/edge-probe-reqs-XXXXXX") && mv "$REQS_JSON" "${REQS_JSON}.json" && REQS_JSON="${REQS_JSON}.json" || exit 1
cat > "$REQS_JSON" <<'JSON'
[
  { "id": "R1", "text": "<replace: requirement text from REQUIREMENTS.md for each {phase_req_ids} id>" }
]
JSON
# Guard — fail loud on empty/invalid array OR a still-present `<replace:>` placeholder (forgotten
# substitution would yield a bogus report). Never a silent no-op.
if ! node -e 'const a=require(process.argv[1]);if(!Array.isArray(a)||a.length===0)process.exit(1);if(a.some(r=>typeof r.text!=="string"||!r.text.trim()||r.text.includes("<replace:")))process.exit(1)' "$REQS_JSON" 2>/dev/null; then
  echo "ERROR: edge-probe requirements JSON is empty/invalid or still holds the <replace: …> placeholder — populate \$REQS_JSON from {phase_req_ids} before running." >&2
  exit 1
fi
# Invoke + CAPTURE, exit-checked (engine FAILS CLOSED exit 2 on bad shape; a bare COVERAGE=$(node …)
# would swallow it and fall through to prose re-derivation = fail-OPEN).
if ! COVERAGE=$(node "$EDGE_PROBE_JS" "$REQS_JSON"); then
  rm -f "$REQS_JSON"
  echo "ERROR: edge-probe engine failed (invalid shapes or bad input) — fix the requirement(s); never proceed with empty coverage." >&2
  exit 1
fi
rm -f "$REQS_JSON"
# Exit-0-but-garbage guard: report must parse as JSON with { items[], coverage{} }.
if ! printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{process.exit(1)}if(!r||!Array.isArray(r.items)||typeof r.coverage!=="object"||r.coverage===null)process.exit(1)})'; then
  echo "ERROR: edge-probe produced an unparseable/malformed coverage report — refusing to proceed." >&2
  exit 1
fi
# Zero-applicable guard: surface a likely classification miss loudly (spec-phase 5.5:277 shape).
APPLICABLE=$(printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n=0;try{n=JSON.parse(s).coverage.applicable}catch{n=0}process.stdout.write(String(n))})')
if [ "$APPLICABLE" = "0" ]; then
  echo "WARNING: edge-probe proposed ZERO applicable edges across all phase requirements — likely a classification miss, not a genuinely edge-free phase. Do NOT silently write an empty fallback Edge Coverage." >&2
fi
```

**Edge `--auto` resolution rules (reuse spec-phase 5.5 verbatim, D-06):** auto-`resolved`
(verification: explicit) where a defensible acceptance criterion can be written (→ a plain
`must_haves.truths` string); else auto-`resolved` (verification: backstop) → author it as a
**structured flat-scalar marker** `{ statement: <the check>,
verification: backstop }` in `must_haves.truths`, NOT a prose note (the verifier branches
deterministically on the `verification: backstop` field; a parenthetical is unparseable — the #1110
fragility; flat scalar `verification:` key, never a nested object, ADR-550 #1278). A `backstop` truth
the verifier cannot confirm with explicit evidence abstains → `human_needed` (reason
`insufficient_spec`), never a silent pass (#1154; `gsd-core/references/honest-verifier.md`). **Never
auto-dismiss** (a wrong dismissal is the exact silent failure this eliminates). An `unclassified` row
stays **`unresolved`** (#1110) — never auto-resolved with backstop — and is surfaced to the planner as a flagged
assumption. Pass `$COVERAGE` (+ the gate's `$SPECLESS_FALLBACK_DISABLED` note) into the gsd-planner
prompt (Step 8). When `EDGE_ABSENT=0`, `$COVERAGE` is empty and this does not run.

## B. Prohibition recall (LLM prose pass) — run when `PROHIB_ABSENT=1`

There is NO compiled prohibition engine and NO `node` invocation (ADR-550 D7b) — the gsd-planner runs
this in-prompt. Full two-stage protocol, canon-referral rule, and status×verification schema live in
`~/.claude/gsd-core/references/prohibition-probe.md` (do not inline it). Summary:

- **Stage 1 — Recall (adversarial).** Per requirement: *"What could this feature silently become that
  the author would NOT want, but the spec does not forbid?"* Over-produce (~10 raw must-NOT candidates).
- **Stage 2 — Precision.** DROP routine-engineering (normal correctness/hygiene — owned by the edge
  probe or code review); KEEP values / safety / ethics (~2–3 survive).
- **Canon-referral drop (ADR-550 D6).** A kept candidate that is canon security/compliance (OWASP /
  prototype-pollution / path-traversal / injection / GDPR / generic fairness) is NOT minted — emit a
  one-line breadcrumb and DROP it.

**Fallback `--auto` divergence (D-06 / RAIL-04 / PROH-1):** author each kept prohibition as
**flagged-unverified with NO wired-check descriptor**. NEVER write `check_kind` / `check_target` /
`check_rule` / `check_violation_fixture` / `check_clean_fixture` — there is no human to wire/verify a
check, and a descriptor-less item is what keeps it fail-closed (it disposes
`{status:'unverified', flagged:true}` downstream via the reused `dispositionForProhibition`). **Never
auto-dismiss**; never fabricate a check path. Surface any `unresolved` prohibition as a flagged
assumption — never a silent drop.

## C. Authoring (the `<downstream_consumer>` else-branch)

Author the fallback report into `must_haves` with the SAME lift the SPEC path uses — only the source
changes (the fallback report, not the SPEC):

- **Edges →** every resolved (verification: explicit) edge's acceptance criterion → `must_haves.truths` as a plain string;
  every resolved (verification: backstop) edge → `must_haves.truths` as a structured `{ statement, verification: backstop }`
  marker (NOT prose; #1110/#1278), which abstains → `human_needed` at verify time when unconfirmed
  (#1154); every `unresolved`/`unclassified` row → an explicit flagged assumption (never a silent drop).
- **Prohibitions →** every kept prohibition → the `must_haves.prohibitions:` sibling block (NOT
  `truths`, ADR-550 D3) via the single `projectProhibitions` serializer (Hyrum — no second
  serializer), authored **descriptor-less** (no `check_*` scalar) so each disposes flagged-unverified.
- **Section-level precedence:** a SPEC-supplied section is never re-run or overwritten — exactly one
  producer per section.
- **No-silent-drop equality:** for each section, (# probe-surfaced items) == (# authored into
  `must_haves` + # surfaced as flagged assumptions).
