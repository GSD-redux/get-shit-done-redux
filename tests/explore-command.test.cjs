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

  test('abstained claims route to an unresolved ledger, never smoothed into prose', () => {
    const content = readWorkflow();
    assert.ok(
      /unresolved/i.test(content) && /ledger/i.test(content),
      'research pass must route abstained claims to an "unresolved" ledger'
    );
    assert.ok(
      /never.*(smooth|prose|assert)|not.*smoothed/i.test(content),
      'ledger discipline must state abstained claims are never smoothed into the narrative'
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

  test('#2543 M4: the ledger-reason enum is identical in explore.md and CONTEXT.md', () => {
    // The 5 abstention reasons are duplicated verbatim across the workflow and the
    // CONTEXT glossary with no coupling. Extract the enum from BOTH (no third hardcoded
    // copy) and assert equality, so a drift fails CI (CLAUDE.md: shared constants across
    // parallel surfaces need a parity assertion).
    const pull = (text, label) => {
      const m = text.match(
        /[{(][^{}()]*\bunverifiable\b[^{}()]*untagged — disposition not reported[^{}()]*[})]/,
      );
      assert.ok(m, `${label} must carry the 5-value ledger-reason enum in one {…}/(…) group`);
      return m[0].slice(1, -1).replace(/`/g, '').split('|').map((s) => s.trim());
    };
    const fromExplore = pull(readWorkflow(), 'explore.md');
    const fromContext = pull(
      fs.readFileSync(path.join(__dirname, '..', 'CONTEXT.md'), 'utf-8'),
      'CONTEXT.md',
    );
    assert.deepStrictEqual(
      fromContext,
      fromExplore,
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
      /resolve-model\s+gsd-phase-researcher\s+--pick\s+profile/,
      'the tier floor needs the resolved profile as its trigger; without a ' +
        '`resolve-model … --pick profile` binding the guard has no operative input'
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

  test('tier-floor guard: the floor keys on the budget profile and spares refute/abstain', () => {
    const content = readWorkflow().replace(/\s+/g, ' ');
    assert.match(
      content,
      /RESEARCHER_PROFILE[^.]*\bbudget\b/,
      'the floor must key on the resolved RESEARCHER_PROFILE being `budget`'
    );
    assert.match(
      content,
      /`refute` and `abstain` are unaffected/,
      'the floor suppresses unearned confidence only — it must not also suppress corrections'
    );
  });

  // Keying the floor on the profile ALONE is bypassable by a documented config.
  // `model_overrides[<agent>]` and `models.research` sit ABOVE the profile lookup in
  // resolveModelInternal, while `--pick profile` reports config.model_profile verbatim —
  // so `model_profile: balanced` + `models.research: haiku` dispatches haiku while the
  // profile still reads `balanced`, and a profile-only floor never fires. Measured:
  // `query resolve-model gsd-phase-researcher` returns {model: haiku, profile: balanced}
  // for that config. These assert the floor also keys on the RESOLVED MODEL.
  // Slice the Tier-floor bullet itself rather than searching the whole document:
  // a whole-file proximity match is satisfied by ANY sentence that merely mentions
  // RESEARCHER_MODEL near "haiku", including a purely descriptive one sitting beside
  // a floor that still keys on the profile alone. Asserting on the guard's own text,
  // and on its POLARITY, is what makes this a barrier instead of a word-search.
  const tierFloorClause = (content) => {
    const start = content.indexOf('- **Tier floor**');
    assert.notStrictEqual(start, -1, 'the Tier floor bullet must exist');
    const rest = content.slice(start + 1);
    const end = rest.indexOf('\n- **');
    return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
  };

  test('tier-floor guard: the floor keys on the resolved model AND the profile, as a disjunction', () => {
    const clause = tierFloorClause(readWorkflow());

    assert.match(clause, /\bRESEARCHER_MODEL\b/,
      'the floor itself must reference the resolved model; keying on RESEARCHER_PROFILE ' +
      'alone is bypassed by models.research / model_overrides, which sit ABOVE the ' +
      'profile lookup in resolveModelInternal (measured: model_profile balanced + ' +
      'models.research haiku resolves {model: haiku, profile: balanced})');
    assert.match(clause, /\bRESEARCHER_PROFILE\b/,
      'the profile signal must stay — codex and qwen have non-haiku budget models, so a ' +
      'model-only check would fail open there');
    assert.match(clause, /\beither\b/i,
      'the two signals must be a disjunction; requiring both would re-open the bypass');
  });

  test('tier-floor guard: the floor SUPPRESSES an admit — polarity, not just vocabulary', () => {
    const clause = tierFloorClause(readWorkflow());

    // Without this, a clause saying "present every would-be admit as an admit, unchanged;
    // do NOT suppress merely because RESEARCHER_MODEL names a haiku-tier model" passes
    // every keyword check above. Verified: that exact inversion passed the prior test 20/20.
    assert.match(clause, /would-be \*\*admit\*\* as an \*\*abstain\*\*/,
      'the floor must state that a would-be admit is presented as an abstain; a clause ' +
      'that merely NAMES admit and abstain does not establish which way it converts');
    assert.doesNotMatch(clause, /\bdo not suppress\b|as an \*\*admit\*\*, unchanged/i,
      'an inverted floor must fail this test');
  });

  test('an untagged finding has a defined destination, not a silent drop', () => {
    const content = readWorkflow().toLowerCase().replace(/\s+/g, ' ');
    assert.ok(
      content.includes('untagged'),
      'a finding returned with no disposition tag must have a defined fallback'
    );
    assert.ok(
      /untagged[^.]*abstain|abstain[^.]*untagged/.test(content),
      'the untagged fallback must resolve to abstain (ledger), never flat prose'
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

  test('cites the #1154 honest-verifier abstention precedent (pattern reuse)', () => {
    const content = readWorkflow();
    assert.ok(
      content.includes('#1154'),
      'the disposition must cite its #1154 honest-verifier precedent so the reuse is traceable'
    );
  });

  test('#2543 B2: the research pass bootstraps gsd_run before the tier-floor probes', () => {
    // The tier floor abstains EVERY claim when both resolve-model probes come back
    // empty. On a fresh shell that happens unless gsd_run is defined IN the same
    // bash block — a required_reading @-ref does not put a shell function in scope.
    // Assert the resolver shim is inlined ahead of the FIRST resolve-model probe,
    // not only in the later commit block, so the admit arm is actually reachable.
    const explore = readWorkflow();
    const probe = explore.indexOf('resolve-model gsd-phase-researcher --pick model');
    assert.ok(probe !== -1, 'the research pass must call resolve-model to arm the tier floor');
    const fenceStart = explore.lastIndexOf('```bash', probe);
    assert.ok(fenceStart !== -1 && fenceStart < probe, 'the probe must sit inside a bash fence');
    const block = explore.slice(fenceStart, probe);
    assert.ok(
      block.includes('_GSD_SHIM_NAME="gsd-tools.cjs"') || /gsd_run\(\)\s*\{/.test(block),
      'the gsd_run resolver shim must be bootstrapped inside the research bash block, before ' +
        'the resolve-model probe — otherwise gsd_run is undefined, both probes return empty, ' +
        'and the tier floor abstains every claim (#2543 B2)',
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
});
