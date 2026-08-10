// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('explore command', () => {
  test('command file exists', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    assert.ok(fs.existsSync(p), 'commands/gsd/explore.md should exist');
  });

  test('command file has required frontmatter', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('name: gsd:explore'), 'Command must have name frontmatter');
    assert.ok(content.includes('description:'), 'Command must have description frontmatter');
    assert.ok(content.includes('allowed-tools:'), 'Command must have allowed-tools frontmatter');
  });

  test('workflow file exists', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    assert.ok(fs.existsSync(p), 'workflows/explore.md should exist');
  });

  test('workflow references questioning.md and domain-probes.md', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('questioning.md'), 'Workflow must reference questioning.md');
    assert.ok(content.includes('domain-probes.md'), 'Workflow must reference domain-probes.md');
  });

  test('workflow documents all 6 output types', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('Note'), 'Workflow must document Note output type');
    assert.ok(content.includes('Todo'), 'Workflow must document Todo output type');
    assert.ok(content.includes('Seed'), 'Workflow must document Seed output type');
    assert.ok(content.includes('Research question'), 'Workflow must document Research question output type');
    assert.ok(content.includes('Requirement'), 'Workflow must document Requirement output type');
    assert.ok(content.includes('New phase') || content.includes('phase'), 'Workflow must document New phase output type');
  });

  test('workflow enforces one question at a time principle', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('one question at a time'), 'Workflow must mention "one question at a time" principle');
  });

  test('workflow requires user confirmation before writing artifacts', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(
      content.includes('explicit user selection') || content.includes('Never write artifacts without'),
      'Workflow must require user confirmation before writing artifacts'
    );
  });

  test('workflow respects commit_docs config', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('commit_docs'), 'Workflow must respect commit_docs configuration');
  });

  test('command references the workflow via execution_context', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(
      content.includes('workflows/explore.md'),
      'Command must reference workflows/explore.md in execution_context'
    );
  });
});

// Enhancement #2229 — three-way claim disposition (admit / refute / abstain) in the
// /gsd-explore Step 3 research pass. The research pass is pure prompt orchestration (it
// spawns gsd-phase-researcher and folds prose back), so the disposition contract lives in
// the workflow text itself — asserting the text asserts the deployed contract (the
// source-text-is-the-product exemption at the top of this file). This mirrors the #1154
// honest-verifier abstention PATTERN (never a silent pass; abstain-and-flag), not the
// verify-time probe-core code path (which sits on the verifier↔predicate rail, ADR-857).
describe('explore research-pass claim disposition (#2229)', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
  const readWorkflow = () => fs.readFileSync(workflowPath, 'utf-8');

  test('#2543 B1: ledger discipline is stated WITHIN the Step-3 disposition region, not merely somewhere in the file', () => {
    // Replaces the deleted vacuous "abstained claims route to an unresolved ledger"
    // test, which grepped the whole file for /unresolved/ and /ledger/ independently —
    // it could not fail even if the sentence tying them together were deleted from
    // Step 3 and moved somewhere unrelated. This is region-scoped AND falsifiable:
    // the self-check below proves the anchor actually depends on the sentence it names.
    const explore = readWorkflow();
    const step3 = explore.indexOf('## Step 3');
    const step4 = explore.indexOf('## Step 4');
    assert.ok(step3 !== -1 && step4 !== -1 && step3 < step4, 'Steps 3 and 4 must exist in order');
    const disposition = explore.slice(step3, step4);

    const LEDGER_ANCHOR = 'put it in the **Unresolved ledger**, **never smoothed into the narrative**';
    assert.ok(
      disposition.includes(LEDGER_ANCHOR),
      'the Step-3 region must state that an abstained claim is routed to the Unresolved ledger and never smoothed into prose'
    );

    // Falsifiability self-check: prove the anchor is unique to the ledger-routing
    // sentence by stripping it and confirming the assertion above would then fail.
    const stripped = disposition.split(LEDGER_ANCHOR).join('');
    assert.ok(
      !stripped.includes(LEDGER_ANCHOR),
      'sanity check: removing the ledger-routing sentence must make the anchor disappear'
    );
  });

  test('#2543 M1: the researcher agent is taught the disposition enum, so admit is reachable', () => {
    // The admit arm only fires if the spawned researcher actually emits
    // [admit/refute/abstain] tags. explore.md's spawn prompt asks for them, but
    // gsd-phase-researcher is a SHARED agent carrying its own [VERIFIED]/[CITED]/
    // [ASSUMED] contract — if it never learned the disposition enum it follows its
    // own template, every finding returns untagged, and the three-way disposition
    // degenerates to all-abstain. Assert BOTH ends of the contract (the spawn
    // prompt asks for the tags AND the agent defines them), not a bare
    // word-presence grep — the two vacuous checks that did that were deleted (#2543 B1).
    const explore = readWorkflow();
    const spawn = explore.slice(
      explore.indexOf('Agent('),
      explore.indexOf('subagent_type="gsd-phase-researcher"'),
    );
    for (const tag of ['[admit:', '[refute:', '[abstain:']) {
      assert.ok(spawn.includes(tag), `the spawn prompt must ask the researcher for ${tag} …] tags`);
    }
    const agent = fs.readFileSync(
      path.join(__dirname, '..', 'agents', 'gsd-phase-researcher.md'),
      'utf-8',
    );
    assert.match(
      agent,
      /claim-disposition mode/i,
      'gsd-phase-researcher.md must document the claim-disposition mode; without it the shared agent ' +
        'follows its own [VERIFIED]/[CITED]/[ASSUMED] template and the admit arm never fires (#2543 M1)',
    );
    for (const tag of ['[admit:', '[refute:', '[abstain:']) {
      assert.ok(agent.includes(tag), `the researcher agent must define the ${tag} …] disposition tag`);
    }
  });

  test('#2543 M4: the ledger-reason enum is identical across every copy in explore.md and CONTEXT.md', () => {
    // The prior extractor used text.match() with no /g — it only ever inspected the
    // FIRST copy, so a second explore.md copy (or the CONTEXT.md copy) could drift
    // unnoticed. Use matchAll so every occurrence is checked, not just one.
    const ENUM_RE = /[{(][^{}()]*\bunverifiable\b[^{}()]*untagged — disposition not reported[^{}()]*[})]/g;
    const extractAll = (text, label) => {
      const normalized = text.replace(/\s+/g, ' ');
      const matches = [...normalized.matchAll(ENUM_RE)].map((m) =>
        m[0].slice(1, -1).replace(/`/g, '').split('|').map((s) => s.trim()),
      );
      assert.ok(matches.length > 0, `${label} must carry at least one copy of the 5-value ledger-reason enum`);
      return matches;
    };

    const exploreCopies = extractAll(readWorkflow(), 'explore.md');
    // Measured: explore.md currently carries 2 copies (the Step-3 share template and
    // the Step-4 carry-forward instruction) and CONTEXT.md carries a 3rd — matching
    // this PR's "all three ledger-enum copies now end `untagged — disposition not
    // reported`" note. Assert >=2 in explore.md so a future removal of either copy
    // is caught, without hardcoding a count this test can't independently justify.
    assert.ok(
      exploreCopies.length >= 2,
      `explore.md must carry at least 2 copies of the 5-value ledger-reason enum; found ${exploreCopies.length}`,
    );
    for (const copy of exploreCopies) {
      assert.deepStrictEqual(
        copy,
        exploreCopies[0],
        'every ledger-enum copy within explore.md must be byte-identical to every other',
      );
    }

    const contextCopies = extractAll(
      fs.readFileSync(path.join(__dirname, '..', 'CONTEXT.md'), 'utf-8'),
      'CONTEXT.md',
    );
    assert.deepStrictEqual(
      contextCopies[0],
      exploreCopies[0],
      'the Unresolved-Ledger abstention reasons in explore.md and CONTEXT.md have drifted; keep them identical (#2543 M4)',
    );
  });

  test('conflict-abstention guard: a source-vs-prior conflict routes to the ledger', () => {
    const content = readWorkflow().toLowerCase();
    // Require the disposition-specific phrasing, not an incidental "conflicting edits" mention
    // elsewhere in the workflow — this must be load-bearing for the abstain arm.
    assert.ok(
      content.includes('source-vs-prior') || content.includes('conflict-abstention') ||
        /conflict[^.]*\bledger\b|\bledger\b[^.]*conflict/.test(content),
      'the abstain arm must cover a source-vs-prior conflict (conflict-abstention), routing to the ledger — not a silent pick-a-side'
    );
  });

  // The tier floor is only real if the orchestrator can OBSERVE its tier. Asserting
  // that the guard's prose exists is the vacuous version of this test — it passed
  // while the Agent() spawn bound no model and no profile, so nothing could ever
  // evaluate "am I on the lowest tier?". These assert the mechanism instead.
  test('tier-floor guard: the workflow RESOLVES the researcher tier, not just describes a floor', () => {
    const content = readWorkflow();
    assert.match(
      content,
      /resolve-model\s+gsd-phase-researcher\s+--pick\s+tier/,
      'the tier floor needs the resolved tier as its trigger; without a ' +
        '`resolve-model … --pick tier` binding the guard has no operative input'
    );
    assert.match(
      content,
      /resolve-model\s+gsd-phase-researcher\s+--pick\s+model/,
      'the spawn must bind the researcher model per model-profile-resolution.md'
    );
  });

  test('tier-floor guard: the Agent() spawn passes the bound model', () => {
    const content = readWorkflow();
    const spawn = content.slice(content.indexOf('Agent('), content.indexOf('subagent_type="gsd-phase-researcher"'));
    assert.match(
      spawn + content.slice(content.indexOf('subagent_type="gsd-phase-researcher"'), content.indexOf('subagent_type="gsd-phase-researcher"') + 200),
      /model="\{RESEARCHER_MODEL\}"/,
      'omitting model= makes the agent inherit the orchestrator model rather than ' +
        'the catalog-resolved tier, which is what left the floor unenforceable'
    );
    assert.match(
      content,
      /omit `model=` entirely when `RESEARCHER_MODEL` is `inherit` or empty/i,
      '#2517 requires the omit-on-inherit/empty rule to ride with any model= binding'
    );
  });

  // Keying the floor on the RESOLVED TIER (not the model id or a profile config key)
  // is the design this PR moved to. Slice the Tier-floor bullet itself rather than
  // searching the whole document: a whole-file proximity match is satisfied by ANY
  // sentence that merely mentions RESEARCHER_TIER near "haiku", including a purely
  // descriptive one sitting beside a floor that keys on something else. Asserting on
  // the guard's own text is what makes this a barrier instead of a word-search.
  //
  // Hardened per #2543 3.1: anchor on the literal bullet marker (not a position),
  // and self-verify the slice is non-empty and actually names the floor, so a decoy
  // bullet inserted ABOVE the real one cannot silently change what gets sliced.
  const tierFloorClause = (content) => {
    const marker = '- **Tier floor**';
    const start = content.indexOf(marker);
    assert.notStrictEqual(start, -1, 'the Tier floor bullet must exist');
    const rest = content.slice(start + 1);
    const end = rest.indexOf('\n- **');
    const clause = (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
    assert.ok(clause.length > 0, 'the sliced Tier-floor clause must be non-empty');
    assert.ok(clause.includes('Tier floor'), 'the sliced clause must actually contain the floor marker');
    return clause;
  };

  test('tier-floor guard: the clause slicer is anchored, not positional', () => {
    const original = readWorkflow();
    const insertionPoint = original.indexOf('- **Tier floor**');
    assert.notStrictEqual(insertionPoint, -1, 'the Tier floor bullet must exist in the real file');
    const decoy = '- **Something else** — an unrelated guard bullet that must not leak into the slice.\n';
    // Prepend a decoy bullet directly above the real one, on an in-memory COPY only.
    const withDecoy = original.slice(0, insertionPoint) + decoy + original.slice(insertionPoint);
    const clause = tierFloorClause(withDecoy);
    assert.ok(clause.includes('Tier floor'), 'the slicer must still find the real Tier-floor clause with a decoy bullet prepended above it');
    assert.ok(!clause.includes('Something else'), 'the slicer must not swallow the decoy bullet into the Tier-floor clause');
  });

  test('tier-floor guard: the floor keys on RESEARCHER_TIER and names haiku as the budget tier', () => {
    const clause = tierFloorClause(readWorkflow());
    assert.match(clause, /\bRESEARCHER_TIER\b/,
      'the floor must reference RESEARCHER_TIER — the single signal now, replacing RESEARCHER_PROFILE');
    assert.match(clause, /RESEARCHER_TIER[^.]*\bhaiku\b/,
      'the floor must name `haiku` as the budget tier for gsd-phase-researcher');
  });

  test('tier-floor guard: an unreadable tier (unknown/inherit/empty) is also floored', () => {
    const clause = tierFloorClause(readWorkflow());
    assert.match(clause, /\bunknown\b/i, 'the floor must cover an `unknown` tier');
    assert.match(clause, /\binherit\b/i, 'the floor must cover an `inherit` tier');
    assert.match(clause, /\bempty\b/i, 'the floor must cover an empty (unreadable) tier');
  });

  test('tier-floor guard: the floor SUPPRESSES an admit — polarity, not just vocabulary', () => {
    const clause = tierFloorClause(readWorkflow());

    // Without this, a clause saying "present every would-be admit as an admit, unchanged;
    // do NOT suppress merely because RESEARCHER_TIER names a haiku-tier model" passes
    // every keyword check above. Verified: that exact inversion passed the prior test 20/20.
    assert.match(clause, /would-be \*\*admit\*\* as an \*\*abstain\*\*/,
      'the floor must state that a would-be admit is presented as an abstain; a clause ' +
      'that merely NAMES admit and abstain does not establish which way it converts');
    assert.doesNotMatch(clause, /\bdo not suppress\b|as an \*\*admit\*\*, unchanged/i,
      'an inverted floor must fail this test');
  });

  test('tier-floor guard: the floor suppresses only unearned confidence, sparing refute/abstain', () => {
    const content = readWorkflow();
    assert.match(
      content,
      /`refute` and `abstain` are unaffected/,
      'the floor suppresses unearned confidence only — it must not also suppress corrections'
    );
  });

  test('refute and abstain are distinguishable by a stated decision procedure', () => {
    // Whitespace-collapsed: these are multi-word prose claims and markdown wraps
    // lines, so a literal-space regex would break the moment a paragraph re-flows.
    const content = readWorkflow().toLowerCase().replace(/\s+/g, ' ');
    assert.ok(
      content.includes('authoritative'),
      'refute vs abstain needs a discriminator; source authority for the claim is it'
    );
    assert.ok(
      /strong prior[^.]*never authoritative|never authoritative[^.]*prior/.test(content),
      'a "strong prior" must be stated as never authoritative alone, or it can be ' +
        'read as grounds for a refute'
    );
  });

  test('spawn prompt: the refute arm requires a source AUTHORITATIVE for the claim, not merely any contradiction', () => {
    // This is the assertion that would have caught the blocker: a spawn prompt whose
    // refute arm reads "a source contradicts it" (no authority qualifier) lets any
    // disagreeing source — wrong version, adjacent subject, secondary/derivative —
    // trigger a refute instead of an abstain.
    const explore = readWorkflow();
    const spawn = explore.slice(explore.indexOf('Agent('), explore.indexOf('subagent_type="gsd-phase-researcher"'));
    assert.match(
      spawn,
      /\[refute:[^\]]*\]\s*\([^)]*authoritative[^)]*\)/i,
      'the spawn prompt\'s refute arm must require the contradicting source be AUTHORITATIVE for the claim'
    );
  });

  test('#2543 B2: the research pass reaches a gsd_run bootstrapped ahead of Step 3', () => {
    // The tier floor abstains EVERY claim when both resolve-model probes come back
    // empty because gsd_run is undefined. The launcher preamble now lives once,
    // unconditionally, at the end of Step 1 (not re-inlined per bash block) — so this
    // only needs to confirm the bootstrap precedes the probe, not that it is duplicated
    // into the Step-3 fence.
    const explore = readWorkflow();
    const preamble = explore.indexOf('_GSD_SHIM_NAME="gsd-tools.cjs"');
    const probe = explore.indexOf('resolve-model gsd-phase-researcher --pick tier');
    assert.notStrictEqual(preamble, -1, 'the gsd_run bootstrap preamble must exist in the file');
    assert.notStrictEqual(probe, -1, 'the research pass must call resolve-model to arm the tier floor');
    assert.ok(
      preamble < probe,
      'gsd_run must be bootstrapped before the tier-floor probe runs, otherwise both probes ' +
        'return empty and the tier floor abstains every claim (#2543 B2)'
    );
  });

  test('#2543 B3: the crystallize step carries the disposition into durable artifacts', () => {
    // An abstained claim must not be laundered into a flat Note/Requirement/phase.
    // Assert Steps 4-5 (the durable-write surface) forbid crystallizing an
    // unresolved-ledger claim as a flat assertion and mandate carrying the
    // disposition — keyed on that region, not a generic earlier mention.
    const explore = readWorkflow();
    const step4 = explore.indexOf('## Step 4');
    const step6 = explore.indexOf('## Step 6');
    assert.ok(step4 !== -1 && step6 !== -1 && step4 < step6, 'Steps 4 and 6 must exist in order');
    const crystallize = explore.slice(step4, step6).toLowerCase();
    assert.ok(
      /unresolved[^.]{0,60}never[^.]{0,60}crystalliz/.test(crystallize),
      'Steps 4-5 must forbid crystallizing an unresolved-ledger claim as a flat assertion (#2543 B3)',
    );
    assert.ok(
      /carry[^.]{0,60}disposition/.test(crystallize),
      'Steps 4-5 must carry the research disposition into the durable artifact (#2543 B3)',
    );
  });

  test('Step 4 sink fences untrusted research text before writing it into durable artifacts', () => {
    const explore = readWorkflow();
    const step4 = explore.indexOf('## Step 4');
    const step6 = explore.indexOf('## Step 6');
    assert.ok(step4 !== -1 && step6 !== -1 && step4 < step6, 'Steps 4 and 6 must exist in order');
    const region = explore.slice(step4, step6);
    assert.match(
      region,
      /untrusted-input-boundary/,
      'Step 4 must reference @gsd-core/references/untrusted-input-boundary.md when quoting research text into a durable file'
    );
    assert.match(
      region,
      /fresh random|DATA_/i,
      'Step 4 must require a fresh/random per-wrap delimiter (not a fixed marker) when fencing quoted research text'
    );
  });

  test('exactly two guards are documented; "Three guards" no longer appears', () => {
    const content = readWorkflow();
    assert.match(content, /Two guards ride with it:/, 'the guard-list intro must read "Two guards ride with it:"');
    assert.doesNotMatch(
      content,
      /Three guards/,
      '"Three guards" must not appear — the untagged-findings rule moved out of the guard list into its own paragraph'
    );

    const start = content.indexOf('Two guards ride with it:');
    const end = content.indexOf('**Untagged findings.**', start);
    assert.ok(start !== -1 && end !== -1 && start < end, 'the guard list and the untagged-findings paragraph must both exist, in order');
    const guardRegion = content.slice(start, end);
    // Only TOP-LEVEL bullets (no leading indent) count as guards; the Tier-floor
    // bullet's own nested `  - ` sub-bullets must not be double-counted.
    const topLevelBullets = guardRegion.match(/^- \*\*/gm) || [];
    assert.strictEqual(topLevelBullets.length, 2, `expected exactly 2 top-level guard bullets, found ${topLevelBullets.length}`);
  });

  test('the launcher preamble is bootstrapped once, unconditionally, ahead of Step 3', () => {
    const explore = readWorkflow();
    const marker = '_GSD_SHIM_NAME="gsd-tools.cjs"';
    const firstMarker = explore.indexOf(marker);
    const lastMarker = explore.lastIndexOf(marker);
    assert.notStrictEqual(firstMarker, -1, 'the canonical preamble marker must exist');
    assert.strictEqual(firstMarker, lastMarker, 'the preamble must be inlined exactly once in the file');

    const firstGsdRun = explore.indexOf('gsd_run');
    assert.notStrictEqual(firstGsdRun, -1, 'gsd_run must be used somewhere in the file');
    assert.ok(
      firstMarker < firstGsdRun,
      'the preamble that DEFINES gsd_run must appear before the first USE of gsd_run anywhere in the file'
    );

    const step3 = explore.indexOf('## Step 3');
    assert.notStrictEqual(step3, -1, 'Step 3 heading must exist');
    // Must sit in Step 1, not inside Step 3's optional research-offer branch:
    // declining the research offer must not leave Step 5's commit call unbootstrapped,
    // since gsd_run is only ever defined at this one call site.
    assert.ok(
      firstMarker < step3,
      'the launcher preamble must be bootstrapped before Step 3, not gated behind the optional research offer'
    );
  });
});
