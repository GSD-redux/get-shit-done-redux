<purpose>
Clarify WHAT a phase delivers through a Socratic interview loop with quantitative ambiguity scoring.
Produces a SPEC.md with falsifiable requirements that discuss-phase treats as locked decisions.

This workflow handles "what" and "why" — discuss-phase handles "how".
</purpose>

<ambiguity_model>
Score each dimension 0.0 (completely unclear) to 1.0 (crystal clear):

| Dimension         | Weight | Minimum | What it measures                                  |
|-------------------|--------|---------|---------------------------------------------------|
| Goal Clarity      | 35%    | 0.75    | Is the outcome specific and measurable?           |
| Boundary Clarity  | 25%    | 0.70    | What's in scope vs out of scope?                  |
| Constraint Clarity| 20%    | 0.65    | Performance, compatibility, data requirements?    |
| Acceptance Criteria| 20%   | 0.70    | How do we know it's done?                         |

**Ambiguity score** = 1.0 − (0.35×goal + 0.25×boundary + 0.20×constraint + 0.20×acceptance)

**Gate:** ambiguity ≤ 0.20 AND all dimensions ≥ their minimums → ready to write SPEC.md.

A score of 0.20 means 80% weighted clarity — enough precision that the planner won't silently make wrong assumptions.
</ambiguity_model>

<interview_perspectives>
Rotate through these perspectives — each naturally surfaces different blindspots:

**Researcher (rounds 1–2):** Ground the discussion in current reality.
- "What exists in the codebase today related to this phase?"
- "What's the delta between today and the target state?"
- "What triggers this work — what's broken or missing?"

**Simplifier (round 2):** Surface minimum viable scope.
- "What's the simplest version that solves the core problem?"
- "If you had to cut 50%, what's the irreducible core?"
- "What would make this phase a success even without the nice-to-haves?"

**Boundary Keeper (round 3):** Lock the perimeter.
- "What explicitly will NOT be done in this phase?"
- "What adjacent problems is it tempting to solve but shouldn't?"
- "What does 'done' look like — what's the final deliverable?"

**Failure Analyst (round 4):** Find the edge cases that invalidate requirements.
- "What's the worst thing that could go wrong if we get the requirements wrong?"
- "What does a broken version of this look like?"
- "What would cause a verifier to reject the output?"

**Seed Closer (rounds 5–6):** Lock remaining undecided territory.
- "We have [dimension] at [score] — what would make it completely clear?"
- "The remaining ambiguity is in [area] — can we make a decision now?"
- "Is there anything you'd regret not specifying before planning starts?"
</interview_perspectives>

<process>

## Step 1: Initialize

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
INIT=$(gsd_run init phase-op "${PHASE}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

Parse JSON for: `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `phase_slug`, `padded_phase`, `state_path`, `requirements_path`, `roadmap_path`, `planning_path`, `response_language`, `commit_docs`.

**If `response_language` is set:** All user-facing text in this workflow — narration between tool calls, status updates, progress notes, findings, questions, and report prose — MUST be in `{response_language}`. Technical terms, code, and file paths stay in English.

**If `phase_found` is false:**
```
Phase [X] not found in roadmap.
Use /gsd:progress to see available phases.
```
Exit.

**Check for existing SPEC.md:**
```bash
ls ${phase_dir}/*-SPEC.md 2>/dev/null | grep -v AI-SPEC | head -1 || true
```

If SPEC.md already exists:

**If `--auto`:** Auto-select "Update it". Log: `[auto] SPEC.md exists — updating.`

**Otherwise:** Use AskUserQuestion:
- header: "Spec"
- question: "Phase [X] already has a SPEC.md. What do you want to do?"
- options:
  - "Update it" — Revise and re-score
  - "View it" — Show current spec
  - "Skip" — Exit (use existing spec as-is)

If "View": Display SPEC.md, then offer Update/Skip.
If "Skip": Exit with message: "Existing SPEC.md unchanged. Run /gsd:discuss-phase [X] to continue."
If "Update": Load existing SPEC.md, continue to Step 3.

## Step 2: Scout Codebase

**Read these files before any questions:**
- `{requirements_path}` — Project requirements
- `{state_path}` — Decisions already made, current phase, blockers
- ROADMAP.md phase entry — Phase description, goals, canonical refs

**Grep the codebase** for code/files relevant to this phase goal. Look for:
- Existing implementations of similar functionality
- Integration points where new code will connect
- Test coverage gaps relevant to the phase
- Prior phase artifacts (SUMMARY.md, VERIFICATION.md) that inform current state

**Synthesize current state** — the grounded baseline for the interview:
- What exists today related to this phase
- The gap between current state and the phase goal
- The primary deliverable: what file/behavior/capability does NOT exist yet?

Confirm your current state synthesis internally. Do not present it to the user yet — you'll use it to ask precise, grounded questions.

## Step 3: First Ambiguity Assessment

Before questioning begins, score the phase's current ambiguity based only on what ROADMAP.md and REQUIREMENTS.md say:

```
Goal Clarity:       [score 0.0–1.0]
Boundary Clarity:   [score 0.0–1.0]
Constraint Clarity: [score 0.0–1.0]
Acceptance Criteria:[score 0.0–1.0]

Ambiguity: [score] ([calculate])
```

**If `--auto` and initial ambiguity already ≤ 0.20 with all minimums met:** Skip interview — derive SPEC.md directly from roadmap + requirements. Log: `[auto] Phase requirements are already sufficiently clear — generating SPEC.md from existing context.` Jump to Step 5.5.

**Otherwise:** Continue to Step 4.

## Step 4: Socratic Interview Loop

**Max 6 rounds.** Each round: 2–3 questions max. End round after user responds.

**Round selection by perspective:**
- Round 1: Researcher
- Round 2: Researcher + Simplifier
- Round 3: Boundary Keeper
- Round 4: Failure Analyst
- Rounds 5–6: Seed Closer (focus on lowest-scoring dimensions)

**After each round:**
1. Update all 4 dimension scores from the user's answers
2. Calculate new ambiguity score
3. Display the updated scoring:

```
After round [N]:
  Goal Clarity:       [score] (min 0.75) [✓ or ↑ needed]
  Boundary Clarity:   [score] (min 0.70) [✓ or ↑ needed]
  Constraint Clarity: [score] (min 0.65) [✓ or ↑ needed]
  Acceptance Criteria:[score] (min 0.70) [✓ or ↑ needed]
  Ambiguity: [score] (gate: ≤ 0.20)
```

**Gate check after each round:**

If gate passes (ambiguity ≤ 0.20 AND all minimums met):

**If `--auto`:** Jump to Step 5.5.

**Otherwise:** AskUserQuestion:
- header: "Spec Gate Passed"
- question: "Ambiguity is [score] — requirements are clear enough to write SPEC.md. Proceed?"
- options:
  - "Yes — write SPEC.md" → Jump to Step 5.5
  - "One more round" → Continue interview
  - "Done talking — write it" → Jump to Step 5.5

**If max rounds reached (6) and gate not passed:**

**If `--auto`:** Write SPEC.md anyway — flag unresolved dimensions. Log: `[auto] Max rounds reached. Writing SPEC.md with [N] dimensions below minimum. Planner will need to treat these as assumptions.`

**Otherwise:** AskUserQuestion:
- header: "Max Rounds"
- question: "After 6 rounds, ambiguity is [score]. [List dimensions still below minimum.] What would you like to do?"
- options:
  - "Write SPEC.md anyway — flag gaps" → Write SPEC.md, mark unresolved dimensions in Ambiguity Report
  - "Keep talking" → Continue (no round limit from here)
  - "Abandon" → Exit without writing

**If `--auto` mode throughout:** Replace all AskUserQuestion calls above with Claude's recommended choice. Log decisions inline. Apply the same logic as `--auto` in discuss-phase.

**Text mode (`workflow.text_mode: true` or `--text` flag):** Use plain-text numbered lists instead of AskUserQuestion TUI menus.

## Step 5: (covered inline — ambiguity scoring is per-round)

## Step 5.5: Edge-Completeness Probe

Run AFTER the ambiguity gate passes (you probe edges of clear requirements, not vague
ones). Reference: @~/.claude/gsd-core/references/edge-probe.md.

**Non-English projects — `text_en` carries the classifier-facing translation; the SPEC is
not.** The shape cues the classifier matches are **English** word-boundary patterns, so
requirement prose written in another language matches nothing, classifies to zero shapes, and
lands every row in `unclassified` (#1110) — the taxonomy contributes nothing and `--auto`
leaves it all `unresolved`. When this project has `response_language` set, add an optional
`text_en` key to each `$REQS_JSON` entry: a faithful **English** translation of that
requirement's `text`. `text_en` is **engine input, never user-facing output**, so the
`response_language` rule at the top of this workflow does not govern it — but `text` itself is
NOT translated: write it as the requirement's own text, exactly as it appears in the SPEC.
The SPEC keeps the original language — only `text_en` is translated, and requirement
`id`s are never translated or renumbered (coverage rows join back on `id`, and any Acceptance
Criteria you write from the resolved edges go into the SPEC in `response_language`). Populate
`text_en` for **every** requirement, not only the ones that look edge-relevant: the
`$APPLICABLE = 0` warning below fires only when *all* requirements are unclassified, so a
partly-classified spec slips through with no signal at all. When `response_language` is unset
(an English-language project), omit `text_en` — `text` is already English and the engine
falls back to it automatically (`text_en ?? text`).
If a requirement still classifies to zero shapes with `text_en` populated, it carries no cue in
any language (the recorded recall gap — ADR-857 §98 / ADR-550 D7b, not a translation failure);
author an explicit `shapes` array on that requirement instead of relying on the prose
classifier.

**Runtime coverage compute — resolve and invoke edge-probe.cjs:**

```bash
# Resolve the compiled edge-probe.cjs against the GSD install dir via RUNTIME_DIR (#448)
# — NOT the consuming project's git root — falling back to git toplevel / $HOME/.claude.
# Mirrors the ui-safety-gate.cjs resolution idiom at autonomous.md:290 / plan-phase.md:631.
_GSD_RT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
EDGE_PROBE_JS=$(for _c in \
  "$_GSD_RT/gsd-core/bin/lib/edge-probe.cjs" \
  "$_GSD_RT/bin/lib/edge-probe.cjs" \
  "$_GSD_RT/.claude/bin/lib/edge-probe.cjs" \
  "$HOME/.claude/gsd-core/bin/lib/edge-probe.cjs" \
  "$HOME/.claude/bin/lib/edge-probe.cjs"; do
  [ -f "$_c" ] && { echo "$_c"; break; }
done)

# Graceful degradation — never silent skip (RR-04). Build ONLY when $_GSD_RT is a verified
# GSD source checkout (has tsconfig.build.json + src/edge-probe.cts), and pin npm to it with
# --prefix so we never trigger the CONSUMING project's own build:lib (its cwd package scripts:
# codegen/migrations/writes) during a spec workflow. Real installs ship the compiled .cjs via
# prepublishOnly, so this build path only matters in a GSD dev checkout (review High).
if [ -z "$EDGE_PROBE_JS" ]; then
  if [ -f "$_GSD_RT/tsconfig.build.json" ] && [ -f "$_GSD_RT/src/edge-probe.cts" ]; then
    npm --prefix "$_GSD_RT" run build:lib 2>/dev/null || true
    EDGE_PROBE_JS=$(for _c in \
      "$_GSD_RT/gsd-core/bin/lib/edge-probe.cjs" \
      "$_GSD_RT/bin/lib/edge-probe.cjs" \
      "$_GSD_RT/.claude/bin/lib/edge-probe.cjs" \
      "$HOME/.claude/gsd-core/bin/lib/edge-probe.cjs" \
      "$HOME/.claude/bin/lib/edge-probe.cjs"; do
      [ -f "$_c" ] && { echo "$_c"; break; }
    done)
  fi
  if [ -z "$EDGE_PROBE_JS" ]; then
    echo "ERROR: edge-probe.cjs not found — reinstall GSD or run \`npm run build:lib\` in your GSD checkout." >&2
    exit 1
  fi
fi

# Write the Requirements gathered in THIS spec session to a temp JSON, then invoke the
# canonical coverage compute. Populate the heredoc from the SPEC's Requirements — one object
# per requirement: {"id","text","text_en"?,"shapes"?}. This is the load-bearing step: an empty
# file makes the probe a no-op, so the guard below fails loud rather than silently skipping
# (RR-04). When `response_language` is set, ALSO add `text_en` — a faithful ENGLISH
# translation of `text` (see above) — the shape cues are English-only, so original-language
# `text` alone classifies to zero shapes; `text` itself stays the SPEC's own requirement text
# and is never translated. Keep every `id` exactly as it appears in the SPEC.
# BSD/macOS mktemp only randomizes XXXXXX when it is the final path component, so make a
# suffixless temp then append the extension — portable across BSD + GNU (#1520).
REQS_JSON=$(mktemp "${TMPDIR:-/tmp}/edge-probe-reqs-XXXXXX") && mv "$REQS_JSON" "${REQS_JSON}.json" && REQS_JSON="${REQS_JSON}.json" || exit 1
cat > "$REQS_JSON" <<'JSON'
[
  { "id": "R1", "text": "<replace: requirement text from the SPEC>" }
]
JSON
# Guard — never invoke on an empty/invalid array, OR one still holding the heredoc
# `<replace: …>` placeholder (a forgotten substitution would otherwise yield a
# meaningful-looking but bogus coverage report). Fail loud, not silent no-op.
if ! node -e 'const a=require(process.argv[1]);if(!Array.isArray(a)||a.length===0)process.exit(1);if(a.some(r=>typeof r.text!=="string"||!r.text.trim()||r.text.includes("<replace:")))process.exit(1)' "$REQS_JSON" 2>/dev/null; then
  rm -f "$REQS_JSON"
  echo "ERROR: edge-probe requirements JSON is empty/invalid or still holds the <replace: …> placeholder — populate \$REQS_JSON from the SPEC Requirements before Step 5.5 runs." >&2
  exit 1
fi
# Invoke the compiled engine and CAPTURE its report — it computes which categories apply per
# requirement. The report is RENDERED into context below (#3102); its resolved/dismissed/
# unresolved rows (resolved items carry verification: explicit|backstop) are the deterministic
# FLOOR the resolution loop consumes and unions with its own classification — the loop no longer
# re-derives the taxonomy from prose unaided. Floor, never ceiling: the classifier has a measured
# recall gap (ADR-857 §98 / ADR-550 D7b), so the model still ADDS any category the engine missed.
# The engine FAILS CLOSED (exit 2) on an invalid authored shape or bad input — so the capture
# MUST be exit-checked. A bare `COVERAGE=$(node …)` swallows that exit code, leaves $COVERAGE
# empty, and lets the workflow fall through to prose re-derivation: fail-OPEN at the boundary
# the engine validation exists to protect. Make the run fatal, then validate the captured
# report is well-formed JSON before the resolution loop consumes it.
if ! COVERAGE=$(node "$EDGE_PROBE_JS" "$REQS_JSON"); then
  rm -f "$REQS_JSON"
  echo "ERROR: edge-probe engine failed (invalid shapes or bad input) — fix the requirement(s) and re-run; never proceed with empty coverage." >&2
  exit 1
fi
rm -f "$REQS_JSON"
# Exit-0-but-garbage guard: the report must parse as JSON with the expected { items[], coverage{} } shape.
if ! printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let r;try{r=JSON.parse(s)}catch{process.exit(1)}if(!r||!Array.isArray(r.items)||typeof r.coverage!=="object"||r.coverage===null)process.exit(1)})'; then
  echo "ERROR: edge-probe produced an unparseable or malformed coverage report — refusing to proceed with the resolution loop." >&2
  exit 1
fi
# Render the validated report into the model's visible context (#3102). Until here $COVERAGE was
# captured, shape-checked, and reduced to coverage.applicable — the engine's per-requirement
# items[] never reached the model, so the resolution loop below re-derived edge categories from
# requirement PROSE (the data-flow twin of #2733's control-flow discard). These rows are the
# deterministic FLOOR the resolution loop consumes. Printed RAW (not a bespoke table) so this
# step holds NO knowledge of the item schema: an ADR-550 D7a-style re-cut of the item/coverage
# shape cannot silently desync a hand-rolled renderer here — the engine stays the single source.
echo "### Edge-probe coverage report (deterministic proposals — the FLOOR for the resolution loop below):"
printf '%s\n' "$COVERAGE"
echo "### (end edge-probe coverage report)"
# Zero-applicable guard: a report where the engine proposed NO applicable edge across ANY
# requirement is far more likely a shape-classification miss (or malformed requirements) than
# a genuinely edge-free spec — the same fail-open shape as an invalid shape yielding
# applicable:0. Surface it loudly; the author must explicitly confirm "no applicable edges"
# below rather than silently emitting a green empty ## Edge Coverage section.
APPLICABLE=$(printf '%s' "$COVERAGE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let n=0;try{n=JSON.parse(s).coverage.applicable}catch{n=0}process.stdout.write(String(n))})')
if [ "$APPLICABLE" = "0" ]; then
  echo "WARNING: edge-probe proposed ZERO applicable edges across all requirements — likely a classification miss or malformed requirements, not a genuinely edge-free spec. Do NOT silently write an empty Edge Coverage section." >&2
fi
```

If `$APPLICABLE` is `0`, do NOT proceed silently: ask the author to confirm via AskUserQuestion
("The edge probe found no applicable edges for any requirement — is this genuinely an
edge-free spec, or should we revisit the requirement wording / authored shapes?"). Only write
an empty `## Edge Coverage` section after explicit confirmation.

For each Requirement gathered so far:
1. Start from the edge-probe rows RENDERED above — the deterministic `items[]` are the FLOOR:
   every proposed `(requirement_id, category)` MUST be resolved below (Specify / Dismiss-with-
   reason / Backstop / Defer), none silently dropped. Then raise any applicable category the
   engine MISSED — the rows are a floor, never a ceiling: the classifier has a measured recall
   gap on terse prose (ADR-857 §98 / ADR-550 D7b), e.g. a CSV-export requirement whose
   `encoding` edge the shape cue under-fires. Union the engine's rows with your own
   classification (relevance filter — see the taxonomy in the reference); do not narrow to them.
   Reuse any edges the Round-4 Failure Analyst already surfaced as pre-resolved.
2. For each raised category, propose a CONCRETE candidate edge (not "consider
   boundaries" — e.g. "R2 merges intervals; what about `[[1,2],[2,3]]` that only touch?").
3. Resolve each with the user (AskUserQuestion; text mode → numbered list):
   - **Specify it** → write a new pass/fail line into Acceptance Criteria AND mark the
     edge `resolved` with `verification: explicit`.
   - **Dismiss (reason)** → mark `dismissed` with a required non-empty reason.
   - **Backstop with a test** → mark `resolved` with `verification: backstop`; note
     "held-out edge test" for plan-phase.
   - **Defer** → leave `unresolved`.
   - An `unclassified` row (probe `unclassified — review manually`) means the requirement's
     prose matched no shape cue (#1110) — treat it like any other candidate (**Specify**,
     **Dismiss (reason)**, or **Defer**). A manual-review nudge, not a hard block.

**Soft gate (after resolving):**
- All applicable edges resolved → proceed to Step 5.6.
- Any `unresolved` → AskUserQuestion:
  - header: "Edge Coverage"
  - question: "[N] edge(s) are unresolved: [list]. What do you want to do?"
  - options: "Resolve now" (loop back) / "Write SPEC.md anyway — flag unresolved" /
    "Keep probing"
  - On "anyway": write SPEC.md with those rows marked `⚠ Edge unresolved — planner must
    treat as assumption`.

**`--auto` mode:** resolve over the **same rendered floor** (#3102) — every engine-proposed row
from Step 5.5's report (step 1) plus any category the classifier missed, never a narrower set.
For each: auto-`resolved` (verification: explicit) where a defensible acceptance criterion can be
written; otherwise auto-`resolved` (verification: backstop) (never auto-dismiss — a wrong
dismissal is the exact silent failure being eliminated). Log:
`[auto] edge coverage: E explicit, B backstop, U unresolved`.

**`unclassified` exception (#1110):** `--auto` leaves an `unclassified` candidate
**`unresolved`** (the soft gate surfaces it as a flagged planner assumption) — it never
auto-resolves it with `verification: backstop`. A missing shape is not evidence an edge exists, so minting a held-out
edge obligation on a requirement that may be genuinely edge-free would be a false claim and
risks a vacuous edge test. Leaving it `unresolved` keeps the zero-cue requirement visible
(never a silent drop) without fabricating an edge — which is exactly #1110's purpose: surface
it for review, do not auto-handle it.

Populate the `## Edge Coverage` section of SPEC.md from the resolved edges.

## Step 5.6: Prohibition-Completeness Probe (must-NOT)

Run AFTER Step 5.5 (you probe the must-NOT axis of clear requirements, over the same
requirement list). Reference: @~/.claude/gsd-core/references/prohibition-probe.md — the
portable two-stage protocol, the canon-referral rule, and the status×verification schema
live there (size-cap discipline; keep this step lean).

**D1 — no compiled engine (ADR-550 D7b).** Unlike Step 5.5, the prohibition probe has NO
compiled recall engine and runs NO `node` invocation here. The recall stage is an LLM prose
pass: the closed eight-category edge taxonomy a classifier can apply does not exist for the
open values/safety/ethics must-NOT axis. Do NOT copy the Step 5.5 engine-resolution block.
Only the schema/projection layer is real code; the recall is prose.

For each Requirement gathered so far, run the two-stage recall→precision pass:

1. **Stage 1 — Recall (adversarial prose probe).** Ask the single adversarial question of the
   requirement: *"What could this feature silently become that the author would NOT want, but
   the spec does not forbid?"* Over-produce (~10 raw must-NOT candidates) — recall first.
2. **Stage 2 — Precision (one-pass classifier).** Filter the raw list in a single pass:
   **DROP routine-engineering** items (normal correctness/hygiene — "must not mutate input",
   "must not throw on empty" — owned by the edge probe or code review); **KEEP
   values / safety / ethics** items (manipulative framing, protected-attribute proxies, raw
   PII in plaintext). This collapses ~10 → ~2–3 genuine prohibitions.
3. **Canon-referral (ADR-550 D6, PROB-13).** A kept candidate that is canon security/compliance
   (OWASP / prototype-pollution / path-traversal / injection / GDPR / generic fairness) is
   NOT minted here — emit a one-line breadcrumb (*"prototype-pollution is canon — owned by
   /gsd:secure-phase + eslint; not minted here"*) and DROP it. Minting canon items duplicates
   /gsd:secure-phase and drowns the bespoke signal.
4. **Resolve each surfaced (non-canon) prohibition** (AskUserQuestion; text mode → numbered list):
   - **Keep it** → write a NEGATIVE acceptance criterion (a must-NOT line) into Acceptance
     Criteria AND mark the prohibition `resolved` with a verification tier: `test` (a
     mechanical negative test/lint/assertion exists) or `judgment` (real but not mechanically
     checkable — routes to judgment review).
     - **Capture the wired-check descriptor on `test`-tier (#1278, SOFT).** When a prohibition is
       resolved `verification: test`, ALSO capture the descriptor of the wired check so
       `verify-phase` can LOCATE it deterministically (no verifier invention at verify time).
       Capture the flat scalars — persisted into SPEC and projected onto the
       `must_haves.prohibitions` item by `projectProhibitions`:
       - `check_kind` — `node-test` | `lint-rule`.
       - `check_target` — the negative-test file path (for `node-test`), or the path to lint
         (for `lint-rule`).
       - `check_rule` — the eslint rule id (e.g. `local/no-source-grep`); `lint-rule` only.
       - `check_violation_fixture` (#1279) — path to a KNOWN-BAD subject the wired check is run
         against to **machine-prove fail-first**; rides BOTH kinds. Capture it to let the item green
         end-to-end with zero hand-authoring at verify time; for `node-test` the negative test should
         read its subject from the `GSD_PROHIB_SUBJECT` env var so the prover can inject this fixture.
       - `check_clean_fixture` (#1346; **REQUIRED for `node-test` as of #1906**) — path to a
         KNOWN-CLEAN control subject. The `node-test` prover runs the check against it and requires
         GREEN — proving the violation's RED is caused by the subject's *content*, not by
         `GSD_PROHIB_SUBJECT` merely being set. For a `node-test` this is **mandatory**: omit it and
         the check is un-provable (fail-closed), never proven on the violation alone — so a deceptive
         content-independent test cannot pass. (`lint-rule` needs no clean fixture: its subject IS the
         linted file, no `GSD_PROHIB_SUBJECT` indirection.)
       This is a **SOFT capture (CHK-04): a `test`-tier prohibition WITHOUT a descriptor is still
       allowed** — if the author cannot yet name the wired check, leave the descriptor empty and
       proceed. It is NOT a hard authoring block; the item simply stays fail-closed/flagged
       downstream (an absent/partial descriptor — or one with no `check_violation_fixture` —
       → `descriptorFromProjection` null/under-specified/fixture-less → producer fail-closed
       locate-or-unprovable, never green). Do NOT capture `failFirst` here — it is a
       verify-time caller attestation, not a spec-authored field (#1279).
   - **Dismiss (reason)** → mark `dismissed` with a REQUIRED non-empty reason (PROB-05). The
     reason string is the audit trail; silence is not a valid dismissal.
   - **Defer** → leave `unresolved`.

**Soft gate (after resolving) — PROB-06:**
- All applicable prohibitions resolved → proceed to Step 6.
- Any `unresolved` → AskUserQuestion:
  - header: "Prohibitions"
  - question: "[N] prohibition(s) are unresolved: [list]. What do you want to do?"
  - options: "Resolve now" (loop back) / "Write SPEC.md anyway — flag unresolved" /
    "Keep probing"
  - On "anyway": write SPEC.md with those rows marked `⚠ Prohibition unresolved — planner
    must treat as assumption`. This is a soft gate (write-anyway-with-flags), never a silent
    skip — the soft gate IS the control.

**`--auto` mode:** auto-`resolved` where a defensible negative acceptance criterion can be
written (test or judgment tier); otherwise leave `unresolved`. **`--auto` NEVER auto-dismisses
a prohibition** — a wrong dismissal is the exact silent failure this probe eliminates (PROB-06,
the load-bearing safety property). On a `test`-tier auto-resolution, capture the `check_kind` /
`check_target` / `check_rule` / `check_violation_fixture` / `check_clean_fixture` descriptor **only when a wired check is unambiguous**; otherwise
leave it empty — `--auto` NEVER fabricates a check path or fixture (a wrong locate is re-validated and
fails closed at the producer, but a fabricated path is still noise to avoid). Log:
`[auto] prohibitions: R resolved, U unresolved`.

**Text mode (PROB-09):** per Step 5's text-mode rule, replace the AskUserQuestion menus above
with plain-text numbered lists — there is NO hard AskUserQuestion dependency, so the probe
runs identically for non-Claude / text-mode hosts.

Populate the `## Prohibitions` section of SPEC.md from the resolved prohibitions (each
`resolved`/`test` row is a checkable negative acceptance criterion; `resolved`/`judgment`
rows route to judgment review; `⚠ UNRESOLVED` rows are flagged as assumptions). A
`resolved`/`test` row ALSO carries its captured `check_kind` / `check_target` / `check_rule` /
`check_violation_fixture` / `check_clean_fixture` descriptor when present (so the projection feeds `verify-phase`'s deterministic locate + machine-proof + causation control, #1278 + #1279 + #1346);
a `test` row with no captured descriptor is still valid — it stays fail-closed/flagged
downstream rather than blocking authoring.

## Step 6: Generate SPEC.md

Use the SPEC.md template from @~/.claude/gsd-core/templates/spec.md.

- Populate the **Edge Coverage** section from Step 5.5 (resolved/dismissed/unresolved rows; resolved items carry `verification: explicit|backstop`).
- Populate the **Prohibitions** section from Step 5.6 (resolved/dismissed/unresolved rows with the test|judgment tier).

**Requirements for every requirement entry:**
- One specific, testable statement
- Current state (what exists now)
- Target state (what it should become)
- Acceptance criterion (how to verify it was met)

**Vague requirements are rejected:**
- ✗ "The system should be fast"
- ✗ "Improve user experience"
- ✓ "API endpoint responds in < 200ms at p95 under 100 concurrent requests"
- ✓ "CLI command exits with code 1 and prints to stderr on invalid input"

**Count requirements.** The display in discuss-phase reads: "Found SPEC.md — {N} requirements locked."

**Boundaries must be explicit lists:**
- "In scope" — what this phase produces
- "Out of scope" — what it explicitly does NOT do (with brief reasoning)

**Acceptance criteria must be pass/fail checkboxes** — no "should feel good" or "looks reasonable."

**If any dimensions are below minimum**, mark them in the Ambiguity Report with: `⚠ Below minimum — planner must treat as assumption`.

Write to: `{phase_dir}/{padded_phase}-SPEC.md`

## Step 7: Commit

```bash
gsd_run query commit "spec(phase-${phase_number}): add SPEC.md for ${phase_name} — ${requirement_count} requirements (#2213)" --files "${phase_dir}/${padded_phase}-SPEC.md"
```

If `commit_docs` is false the CLI returns `skipped`; SPEC.md is written, not committed.

## Step 8: Wrap Up

Display:

```
SPEC.md written — {N} requirements locked.

  Phase {X}: {name}
  Ambiguity: {final_score} (gate: ≤ 0.20)

Next: /gsd:discuss-phase {X}
  discuss-phase will detect SPEC.md and focus on implementation decisions only.
```

</process>

<critical_rules>
- Every requirement MUST have current state, target state, and acceptance criterion
- Boundaries section is MANDATORY — cannot be empty
- "In scope" and "Out of scope" must be explicit lists, not narrative prose
- Acceptance criteria must be pass/fail — no subjective criteria
- SPEC.md is NEVER written if the user selects "Abandon"
- Do NOT ask about HOW to implement — that is discuss-phase territory
- Scout the codebase BEFORE the first question — grounded questions only
- Max 2–3 questions per round — do not frontload all questions at once
- Step 5.5 edge probe runs after the ambiguity gate; dismissals require a reason; --auto never auto-dismisses
- Step 5.6 prohibition probe runs after the edge probe; dismissals require a reason; --auto never auto-dismisses a prohibition
</critical_rules>

<success_criteria>
- Codebase scouted and current state understood before questioning
- All 4 dimensions scored after every round
- Gate passed OR user explicitly chose to write despite gaps
- SPEC.md contains only falsifiable requirements
- Boundaries are explicit (in scope / out of scope with reasoning)
- Acceptance criteria are pass/fail checkboxes
- SPEC.md committed atomically (when commit_docs is true)
- User directed to /gsd:discuss-phase as next step
- Edge-completeness probe run; Edge Coverage section populated; unresolved edges flagged as assumptions
- Prohibition-completeness probe run; Prohibitions section populated; unresolved prohibitions flagged as assumptions
</success_criteria>
