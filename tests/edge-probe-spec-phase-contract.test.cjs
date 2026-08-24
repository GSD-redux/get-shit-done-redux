// allow-test-rule: source-text-is-the-product
// spec-phase.md Step 5.5 is the deployed workflow runtime contract under assertion
// spec-phase.md is the deployed spec workflow contract; these checks lock
// the Step 5.5 wiring so the edge-probe.cjs runtime invocation cannot
// silently rot the way the original plan-phase no-op did (reviewer finding RR-11).
// Assertions scope to the extracted Step 5.5 block to avoid false positives
// from incidental mentions elsewhere in the file.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const SPEC_PHASE_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'spec-phase.md');
const EDGE_PROBE_REF_PATH = path.join(__dirname, '..', 'gsd-core', 'references', 'edge-probe.md');
const { classifyShape, applicableCategories } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'edge-probe.cjs'),
);

function readSpecPhase() {
  return fs.readFileSync(SPEC_PHASE_PATH, 'utf8');
}

// Slice the Step 5.5 block: from the "Step 5.5" heading to the next "## " or "Step " heading.
// This scopes assertions to Step 5.5 only, preventing false positives from mentions elsewhere.
function extractStep55Block(content) {
  const startIdx = content.indexOf('## Step 5.5');
  if (startIdx === -1) {
    // Also try without the ## prefix
    const altIdx = content.indexOf('Step 5.5');
    if (altIdx === -1) return '';
    // Find end: next heading starting with ## or Step N (not Step 5.5)
    const rest = content.slice(altIdx + 'Step 5.5'.length);
    const nextHeading = rest.search(/\n## |\nStep \d/);
    if (nextHeading === -1) return content.slice(altIdx);
    return content.slice(altIdx, altIdx + 'Step 5.5'.length + nextHeading);
  }
  const rest = content.slice(startIdx + '## Step 5.5'.length);
  const nextHeading = rest.search(/\n## /);
  if (nextHeading === -1) return content.slice(startIdx);
  return content.slice(startIdx, startIdx + '## Step 5.5'.length + nextHeading);
}

// Test A (RR-11): Step 5.5 resolves and invokes edge-probe.cjs via node.
// MUST FAIL before the RR-04 wire (Step 5.5 is prose-only today — no CLI invocation).
test('RR-11: spec-phase Step 5.5 resolves edge-probe.cjs via path-fallback loop', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);

  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Assert the path-fallback resolution loop for edge-probe.cjs is present in Step 5.5.
  // The token "edge-probe.cjs" must appear inside the block (the artifact being resolved).
  assert.match(
    block,
    /edge-probe\.cjs/,
    'Step 5.5 must reference edge-probe.cjs as the artifact being resolved'
  );

  // Assert node invocation of edge-probe.cjs in Step 5.5.
  // Matches: node "$EDGE_PROBE_JS" or node ... edge-probe.cjs
  assert.match(
    block,
    /node\s+["$].*[Ee][Dd][Gg][Ee][-_][Pp][Rr][Oo][Bb][Ee]/,
    'Step 5.5 must invoke edge-probe.cjs via node (e.g. node "$EDGE_PROBE_JS" ...)'
  );
});

// Test C (RR-11 FUNCTION — the assertion that catches "decorative bash"):
// Token presence is not enough. The invocation is a no-op unless $REQS_JSON is actually
// POPULATED before the engine runs (the original block only mktemp'd it + left a comment,
// so the CLI parsed an empty file). Assert the block (a) writes $REQS_JSON via a redirect,
// (b) does so BEFORE the node invocation, and (c) guards against an empty/invalid file.
test('RR-11 function: Step 5.5 writes $REQS_JSON before invoking, and guards against empty input', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // (a) A redirect that writes the requirements into $REQS_JSON (e.g. `cat > "$REQS_JSON"`).
  const writeIdx = block.search(/>\s*"\$REQS_JSON"/);
  assert.ok(
    writeIdx !== -1,
    'Step 5.5 must WRITE requirements into $REQS_JSON (a redirect like `cat > "$REQS_JSON"`), not just mktemp it — an empty file makes the probe a silent no-op'
  );

  // (b) The write must precede the node invocation of the engine.
  const invokeIdx = block.search(/node\s+["$].*[Ee][Dd][Gg][Ee][-_][Pp][Rr][Oo][Bb][Ee]/);
  assert.ok(invokeIdx !== -1, 'Step 5.5 must invoke the engine via node');
  assert.ok(
    writeIdx < invokeIdx,
    'Step 5.5 must populate $REQS_JSON BEFORE invoking edge-probe.cjs (write precedes the node call)'
  );

  // (c) A guard that refuses to run on an empty/invalid requirements array.
  assert.match(
    block,
    /Array\.isArray|empty\/invalid|empty or invalid|REQS_JSON[^\n]*empty/i,
    'Step 5.5 must guard against an empty/invalid $REQS_JSON before invoking (fail loud, not silent no-op)'
  );
});

// Test B (RR-11): Step 5.5 has an explicit not-found branch — build:lib or error token.
// MUST FAIL before the RR-04 wire (no not-found handling today).
test('RR-11: spec-phase Step 5.5 has an explicit not-found branch (build:lib or blocking error)', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);

  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Assert either a build:lib invocation or an explicit "not found" / error message exists.
  // This prevents the wire from being added as a silent-skip with no fallback.
  assert.match(
    block,
    /build:lib|not found|ERROR.*edge-probe|edge-probe.*not found/i,
    'Step 5.5 must have an explicit not-found branch (build:lib attempt or clear blocking error)'
  );
});

// Test D (review High): the build fallback must NEVER run the CONSUMING project's package
// scripts. Every executable `build:lib` invocation must be pinned to the GSD dir with
// `npm --prefix`, and the build must be gated behind a verified GSD source checkout. A bare
// `npm run build:lib` (no --prefix) uses cwd — which, under the git-toplevel fallback, is the
// consumer repo — and would execute its codegen/migrations during a spec workflow.
test('review High: Step 5.5 build:lib is --prefix-pinned to the GSD dir and gated on a source checkout', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Collect lines that actually INVOKE npm (trimmed start === "npm"), excluding echo/comment
  // mentions (e.g. the error message that quotes `npm run build:lib` for the user).
  const buildInvocations = block
    .split('\n')
    .filter((l) => l.trim().startsWith('npm') && l.includes('build:lib'));

  assert.ok(
    buildInvocations.length > 0,
    'Step 5.5 must contain at least one npm build:lib invocation (the dev-checkout fallback)'
  );
  for (const line of buildInvocations) {
    assert.match(
      line,
      /npm\s+--prefix\s+"?\$?\{?_?GSD_RT/,
      `build:lib must be pinned with \`npm --prefix "$_GSD_RT"\` so it never runs the consuming project's scripts — offending line: ${line.trim()}`
    );
  }

  // The build must be gated behind a verified GSD source checkout (tsconfig.build.json present),
  // so it cannot fire inside a plain consumer repo where the artifact merely happens to be absent.
  assert.match(
    block,
    /tsconfig\.build\.json/,
    'Step 5.5 must gate the build behind a GSD source checkout (e.g. test -f "$_GSD_RT/tsconfig.build.json")'
  );
});

// Test E (review #4 High): the engine's fail-closed exit(2) must NOT be swallowed by command
// substitution. A bare `COVERAGE=$(node "$EDGE_PROBE_JS" ...)` discards the exit status, leaves
// $COVERAGE empty on an invalid-shapes failure, and lets the workflow proceed into prose
// re-derivation — fail-OPEN at the very boundary the engine validation exists to protect.
test('review #4 High: Step 5.5 exit-checks the engine capture and validates the report (no fail-open)', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // The engine capture must be FATAL — guarded by `if ! COVERAGE=$(node "$EDGE_PROBE_JS" …)`
  // (or an explicit exit-status check) that exits non-zero on failure.
  assert.match(
    block,
    /if\s+!\s+COVERAGE=\$\(node\s+"\$EDGE_PROBE_JS"/,
    'Step 5.5 must exit-check the engine invocation (e.g. `if ! COVERAGE=$(node "$EDGE_PROBE_JS" …)`) — a bare command substitution swallows the engine exit code and fails open'
  );

  // And the captured report must be validated as JSON before the resolution loop consumes it
  // (guards against an exit-0-but-garbage capture).
  assert.match(
    block,
    /(COVERAGE[\s\S]{0,500}JSON\.parse)|(JSON\.parse[\s\S]{0,500}\$COVERAGE)/,
    'Step 5.5 must validate $COVERAGE parses as JSON before use (guard against exit-0-but-malformed output)'
  );
});

// Test F (adversarial review): a report with ZERO applicable edges across all requirements is
// the likely-classification-miss fail-open (same shape as an invalid shape yielding applicable:0).
// Step 5.5 must surface it, not silently emit a green empty ## Edge Coverage section.
test('adversarial review: Step 5.5 guards a zero-applicable coverage report', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');
  assert.match(
    block,
    /coverage\.applicable/,
    'Step 5.5 must read coverage.applicable and guard the zero-applicable case (warn/confirm, not silently proceed)'
  );
});

// #3102 (data-flow reachability): the validated $COVERAGE report must be RENDERED into the
// model's visible context, not merely captured and reduced to `coverage.applicable`. Before
// #3102, every emission of $COVERAGE on the success path piped it into a `node -e` consumer
// (the shape guard, the count extract) whose output the model never sees — so the engine's
// items[] were computed, validated, then discarded, and the resolution loop re-derived edge
// categories from requirement prose (the sibling of #2733's control-flow discard, one layer
// down). This asserts a BARE render: $COVERAGE emitted to stdout as the leading command, not
// captured into a variable (`=$(`) and not piped into a consumer (`| node`).
test('#3102: Step 5.5 renders the $COVERAGE report to stdout (not only the applicable count)', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  const rendersReport = block.split('\n').some((raw) => {
    const line = raw.trim();
    if (!/\$COVERAGE\b/.test(line)) return false; // must reference the captured report
    if (line.startsWith('#')) return false; // not a comment mention
    if (!/^(printf|echo|cat)\b/.test(line)) return false; // emitted as the leading command
    if (/=\s*\$\(/.test(line)) return false; // a capture reaches a variable, not the model
    if (/\|\s*node\b/.test(line)) return false; // piped into a consumer (shape guard / count extract)
    return true;
  });

  assert.ok(
    rendersReport,
    'Step 5.5 must RENDER $COVERAGE to the model context — a bare `printf`/`echo`/`cat` of $COVERAGE that is not captured (`=$(`) and not piped into `node` — so the engine items[] reach the resolution loop (#3102 data-flow discard)'
  );
});

// #3102: rendering without binding leaves the rows decorative. The resolution loop must
// consume the rendered engine rows as a deterministic FLOOR — every proposed (requirement_id,
// category) is resolved, and the model ADDS any category the classifier missed (floor, never
// ceiling — the classifier has a measured recall gap: ADR-857 §98 / ADR-550 D7b). This guards
// a future edit that renders the report but leaves the loop re-deriving categories from prose.
test('#3102: Step 5.5 resolution loop binds the engine rows as a floor, not a ceiling', () => {
  const content = readSpecPhase();
  const block = extractStep55Block(content);
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');
  assert.match(
    block,
    /floor/i,
    'Step 5.5 resolution loop must describe the rendered engine rows as a FLOOR the model unions with its own classification (ADR-550 D7b) — surfacing the report without binding it leaves it decorative'
  );
  assert.match(
    block,
    /recall gap|never a ceiling|not a ceiling|add(?:ing)? (?:any|the missed|categor)/i,
    'the floor must NOT be a ceiling — the loop must instruct the model to add categories the classifier missed (ADR-857 §98 recall gap), not narrow to the engine rows'
  );
});

// #3132: the retired covered/backstop-as-status vocabulary must not appear in
// the workflow prose. probe-core.cts locks Status to resolved|dismissed|unresolved;
// backstop survives only as a verification tier on a resolved item.
test('#3132: spec-phase.md uses resolved/dismissed/unresolved — not covered/backstop as status', () => {
  const content = readSpecPhase();
  // "mark the edge `covered`" or "mark `backstop`" would indicate the retired vocab
  assert.doesNotMatch(content, /mark the edge `covered`/,
    'spec-phase.md must not instruct agents to mark edges as "covered" (retired status)');
  assert.doesNotMatch(content, /mark `backstop`[^;]/,
    'spec-phase.md must not instruct agents to mark edges as "backstop" (retired status; backstop is a verification tier only)');
  // The resolution options should reference resolved+verification
  assert.match(content, /resolved.*verification: explicit/,
    'spec-phase.md must use "resolved" with "verification: explicit" for specified edges');
  assert.match(content, /resolved.*verification: backstop/,
    'spec-phase.md must use "resolved" with "verification: backstop" for backstopped edges');
});

test('#3132: plan-phase.md lift rule uses resolved+verification — not covered/backstop', () => {
  const planPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-phase.md');
  const content = fs.readFileSync(planPath, 'utf8');
  // The lift rule should not reference "covered edge" or "backstop edge" as statuses
  assert.doesNotMatch(content, /`covered` edge/,
    'plan-phase.md must not reference "covered" edges as a status');
  assert.doesNotMatch(content, /`backstop` edge/,
    'plan-phase.md must not reference "backstop" edges as a status');
  // It should use "resolved (verification: ...)"
  assert.match(content, /resolved \(verification: explicit\)/,
    'plan-phase.md lift rule must use "resolved (verification: explicit)"');
});

test('#3132: ui-phase.md resolution loop uses resolved+verification — not covered/backstop', () => {
  const uiPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-phase.md');
  const content = fs.readFileSync(uiPath, 'utf8');
  // The resolution options should not use covered/backstop as status values
  assert.doesNotMatch(content, /→ `covered`/,
    'ui-phase.md must not use "covered" as a resolution status');
  // It should use resolved+verification
  assert.match(content, /→ `resolved`.*verification: explicit/,
    'ui-phase.md resolution must use "resolved" with "verification: explicit"');
});

test('#3132: specless-probe-fallback.md uses resolved+verification — not covered/backstop', () => {
  const fallbackPath = path.join(__dirname, '..', 'gsd-core', 'references', 'specless-probe-fallback.md');
  const content = fs.readFileSync(fallbackPath, 'utf8');
  // The fallback reference is @-loaded by plan-phase.md when EDGE_ABSENT
  assert.doesNotMatch(content, /auto-`covered`/,
    'specless-probe-fallback.md must not use auto-"covered" (retired status)');
  assert.doesNotMatch(content, /auto-`backstop`/,
    'specless-probe-fallback.md must not use auto-"backstop" as a status (backstop is a verification tier only)');
  assert.doesNotMatch(content, /`covered` edge/,
    'specless-probe-fallback.md must not reference "covered" edges as a status');
  assert.match(content, /auto-`resolved`/,
    'specless-probe-fallback.md must use auto-"resolved" (not auto-"covered"/"backstop")');
  assert.match(content, /verification: explicit/,
    'specless-probe-fallback.md must reference "verification: explicit"');
});

// ─── #2773: non-English requirements and the English-only shape cues ──────────
//
// `SHAPE_CUES` (src/edge-probe.cts) are English word-boundary regexes. A project that sets
// `response_language` writes its SPEC Requirements in that language, so transcribing them
// verbatim into the Step 5.5 `$REQS_JSON` heredoc classifies every requirement to zero shapes
// -> every row becomes the `unclassified` sentinel (#1110) and the 8-category taxonomy
// contributes nothing. Approved scope for #2773 is doc-only: Step 5.5 must instruct that the
// probe's `text` field carries a faithful English translation (engine input, never
// user-facing), while the SPEC itself stays in the original language.

test('#2773: Step 5.5 documents the English-translation step for response_language projects', () => {
  const block = extractStep55Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  assert.match(
    block,
    /response_language/,
    'Step 5.5 must name `response_language` — it is the setting that makes the requirement prose non-English',
  );
  assert.match(
    block,
    /translat/i,
    'Step 5.5 must instruct that the probe input carries a translation, not the original-language prose',
  );
  assert.match(
    block,
    /English/,
    'Step 5.5 must say the translation target is English (the cue set the classifier actually speaks)',
  );
  // The SPEC must NOT be anglicized — only the transient probe payload is translated.
  assert.match(
    block,
    /SPEC[^\n]*(original language|stays in|keeps)|(original language)[^\n]*SPEC/i,
    'Step 5.5 must state the SPEC keeps the original language — only the probe input is translated',
  );
  // Requirement ids are the join key for coverage rows; translating them breaks the mapping.
  assert.match(
    block,
    /`?id`?s?[^\n]*(unchanged|not translated|never translated|stable)/i,
    'Step 5.5 must state requirement ids are NOT translated or renumbered (coverage rows join on id)',
  );
});

test('#2773: Step 5.5 names the authored shapes override as the zero-cue fallback', () => {
  const block = extractStep55Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  // Translation is necessary but NOT sufficient: prose carrying no cue in ANY language still
  // classifies to []. The engine already accepts an authored `shapes` override for exactly
  // that case, so the instruction must point at it rather than over-promise.
  assert.match(
    block,
    /`shapes`/,
    'Step 5.5 must name the authored `shapes` override as the fallback for prose that still classifies to zero',
  );
});

test('#2773: the translation instruction precedes the $REQS_JSON write', () => {
  const block = extractStep55Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  const langIdx = block.search(/response_language/);
  const writeIdx = block.search(/>\s*"\$REQS_JSON"/);
  assert.ok(langIdx !== -1, 'Step 5.5 must mention response_language');
  assert.ok(writeIdx !== -1, 'Step 5.5 must write $REQS_JSON');
  assert.ok(
    langIdx < writeIdx,
    'the translation instruction must come BEFORE the $REQS_JSON write — the downstream `$APPLICABLE = 0` warning only fires when EVERY requirement is unclassified, so a partially-classified non-English spec would slip through silently',
  );
});

test('#2773: translating a non-English requirement is what makes the cue matcher apply', () => {
  // Same requirement, two languages. This is the premise the Step 5.5 instruction rests on;
  // if a future SHAPE_CUES edit breaks it, the documented advice becomes false and this fails.
  const pt = 'O sistema mescla intervalos sobrepostos em uma lista ordenada';
  const en = 'The system merges overlapping intervals in a sorted list';

  assert.deepEqual(classifyShape(pt), [], 'non-English prose matches no English cue — the silent no-op #2773 reports');
  assert.deepEqual(applicableCategories(classifyShape(pt)), [], 'zero shapes raise zero categories');

  const enShapes = classifyShape(en);
  assert.ok(enShapes.includes('collection'), 'the English rendering must classify as a collection');
  const enCategories = applicableCategories(enShapes);
  for (const expected of ['adjacency', 'empty', 'ordering']) {
    assert.ok(enCategories.includes(expected), `translated requirement must raise \`${expected}\``);
  }

  // A second shape, so the row is not a single-cue coincidence.
  const ptText = 'O nome do usuario e truncado em 50 caracteres';
  const enText = 'The user name is truncated at 50 characters';
  assert.deepEqual(classifyShape(ptText), [], 'non-English text-shape prose also matches nothing');
  assert.ok(classifyShape(enText).includes('text'), 'the English rendering must classify as text');

  // Multi-cue: a sentence carrying cues for two shapes yields the UNION, not one of them.
  const multi = 'The API request uploads a sorted list of items';
  const multiShapes = classifyShape(multi);
  assert.ok(multiShapes.includes('io'), 'multi-cue prose must include io');
  assert.ok(multiShapes.includes('collection'), 'multi-cue prose must include collection');
});

test('#2773: translation alone does not rescue genuinely zero-cue prose', () => {
  // The issue's own repro sentence classifies to [] in ENGLISH too — it carries no shape cue
  // in any language. That is the recorded recall gap (ADR-857 §98 / ADR-550 D7b), not a
  // language failure, which is why Step 5.5 must point at the `shapes` override rather than
  // promise that translation restores classification.
  const enZeroCue = 'The command exits with code 1 and prints to stderr on invalid input';
  assert.deepEqual(
    classifyShape(enZeroCue),
    [],
    'a genuinely zero-cue requirement stays unclassified even in English — the doc must not over-promise',
  );

  // The authored `shapes` override is the deterministic escape hatch for exactly this case.
  assert.deepEqual(
    applicableCategories(['stateful']),
    ['idempotency', 'concurrency'],
    'an authored `shapes` override raises categories with no dependence on prose cues',
  );
});

test('#2773 property: a cue word classifies regardless of surrounding text', () => {
  // A translated sentence carries its cue word amid arbitrary other words. The Step 5.5
  // advice is only sound if classification is robust to that surrounding context rather than
  // anchored to a fixed sentence shape.
  const cueForShape = {
    'numeric-range': 'threshold',
    collection: 'items',
    text: 'unicode',
    stateful: 'persist',
    io: 'endpoints',
  };
  const filler = fc.string({ minLength: 0, maxLength: 24 }).filter((s) => !/[A-Za-z]/.test(s));

  fc.assert(
    fc.property(
      fc.constantFrom(...Object.keys(cueForShape)),
      filler,
      filler,
      (shape, before, after) => {
        const sentence = `${before} ${cueForShape[shape]} ${after}`;
        assert.ok(
          classifyShape(sentence).includes(shape),
          `cue "${cueForShape[shape]}" must classify as ${shape} inside ${JSON.stringify(sentence)}`,
        );
      },
    ),
    { numRuns: 100, seed: 2773 },
  );
});

test('#2773: the edge-probe reference documents the English-cue assumption', () => {
  const ref = fs.readFileSync(EDGE_PROBE_REF_PATH, 'utf8');
  assert.match(
    ref,
    /English/,
    'the edge-probe reference `## Inputs` contract must state that the heuristic classifier is English-cue based',
  );
  assert.match(
    ref,
    /response_language/,
    'the edge-probe reference must point non-English projects at the translated-input requirement',
  );
});

test('#2773: no Step 5.5 exit path leaks the $REQS_JSON temp file', () => {
  // The temp file holds the SPEC's requirement text. Every guard between its creation and
  // the unconditional cleanup must `rm -f` it before `exit 1`, or a failed spec run strands
  // requirement content in TMPDIR. The engine-failure guard always did; the empty/placeholder
  // guard directly above it did not, so the two siblings disagreed about their own invariant.
  const block = extractStep55Block(readSpecPhase());
  assert.ok(block.length > 0, 'Step 5.5 block must be extractable from spec-phase.md');

  const lines = block.split('\n');
  const createIdx = lines.findIndex((l) => /REQS_JSON=\$\(mktemp/.test(l));
  assert.ok(createIdx !== -1, 'Step 5.5 must create $REQS_JSON via mktemp');

  // The region ends at the first UNCONDITIONAL cleanup (a bare `rm -f "$REQS_JSON"` at column
  // zero); past that the file is already gone and later exits cannot leak it.
  const afterCreate = lines.slice(createIdx + 1);
  const endOffset = afterCreate.findIndex((l) => /^rm -f "\$REQS_JSON"/.test(l));
  assert.ok(endOffset !== -1, 'Step 5.5 must unconditionally rm -f "$REQS_JSON" after the engine run');
  const region = afterCreate.slice(0, endOffset);

  // Walk the region tracking whether the current guard branch has cleaned up. `then`/`else`
  // opens a fresh branch; a cleanup inside it arms the branch; an `exit` must find it armed.
  let cleanedInBranch = false;
  const leaks = [];
  for (const line of region) {
    if (/\bthen\b|^\s*else\b|^\s*elif\b/.test(line)) cleanedInBranch = false;
    if (/rm -f "\$REQS_JSON"/.test(line)) cleanedInBranch = true;
    if (/^\s*exit\s+\d+/.test(line) && !cleanedInBranch) leaks.push(line.trim());
  }

  assert.deepEqual(
    leaks,
    [],
    `every exit between the mktemp and the unconditional cleanup must rm -f "$REQS_JSON" first; leaking exits: ${JSON.stringify(leaks)}`,
  );
});
