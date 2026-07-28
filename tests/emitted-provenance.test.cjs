'use strict';

/**
 * emitted-provenance.test.cjs — provenance table + totality guard (#2722,
 * ADR-2719 §2, epic #2719 Phase 2).
 *
 * Asserts that every emitted path in every committed golden-parity manifest is
 * attributable, through the declarative table in tests/helpers/emitted-provenance.cjs,
 * to the repo source path(s) that can legitimately explain a change to it.
 *
 * Three failure modes are all hard failures, because a hand-maintained table's
 * characteristic risk is rotting into a silent gap:
 *   - unmatched: an emitted path no rule claims  (the installer grew a family)
 *   - ambiguous: an emitted path two rules claim (rules overlap)
 *   - dead:      a rule nothing matches          (the table drifted from reality)
 *
 * The residual this does NOT close is false attribution — a rule can point at the
 * WRONG source and still be total. The spot-checks below pin the pairs where that
 * is most likely, and ADR-2719 designates the Phase 3 (#2723) dual-run as the
 * mitigation for the rest. Three real instances of that class were caught while
 * building this table (Copilot's `<name>.agent.md` rename, Kimi's `agents/gsd.md`
 * root agent, and Copilot's `hooks/gsd-session.json`), all of which passed totality
 * while resolving to repo files that do not exist — which is why the
 * "every attributed source exists" test below is a first-class gate, not a nicety.
 *
 * Phase 2 scope only: nothing here reads a git diff, builds a live manifest, or
 * touches a fixture. The differential check, drift-ack file, and size ratchet are
 * #2723.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');
const {
  EXPECTED_MANIFEST_COUNT,
  PROVENANCE_RULES,
  COMMANDS_SRC,
  CLINE_BODY_SRC,
  KIMI_ROOT_AGENT_SRC,
  stripSkillPrefix,
  matchRules,
  attributeEmittedPath,
  loadManifests,
  assertTotality,
} = require('./helpers/emitted-provenance.cjs');

const REPO_ROOT = path.join(__dirname, '..');

/** Manifests are loaded once — reading 19 fixtures per test is pure waste. */
const MANIFESTS = loadManifests();

// ─── Totality (issue #2722's headline acceptance criterion) ──────────────────

test('totality: every emitted path across all 19 manifests matches exactly one rule', () => {
  // Assert the COUNT, not just "some files": a glob that silently matched fewer
  // fixtures would otherwise report a vacuous pass over a shrunken universe.
  assert.equal(
    MANIFESTS.length,
    EXPECTED_MANIFEST_COUNT,
    `expected ${EXPECTED_MANIFEST_COUNT} runtime manifests, found ${MANIFESTS.length}`,
  );

  const { checked, byRule } = assertTotality(MANIFESTS);

  assert.ok(checked > 8000, `expected the full emitted corpus, only checked ${checked}`);
  // No dead rules — assertTotality already throws on one; this pins the contract
  // so a future refactor cannot quietly downgrade it to a warning.
  for (const [ruleId, count] of byRule) {
    assert.ok(count > 0, `rule "${ruleId}" matched nothing`);
  }
});

test('totality covers all 19 runtimes, asserted by count', () => {
  const runtimes = new Set(MANIFESTS.map((m) => m.file));
  assert.equal(runtimes.size, EXPECTED_MANIFEST_COUNT);
  for (const m of MANIFESTS) {
    assert.ok(m.keys.length > 0, `manifest ${m.file} has no keys`);
  }
});

test('every attributed source exists in the repo (identity/rewrite/derived rules)', () => {
  // This is the gate that catches FALSE ATTRIBUTION — a rule that is total but
  // points at the wrong place. A source path that does not exist is proof the rule
  // is wrong, and it is how the three real bugs in this table were found.
  const missing = [];
  for (const { runtime, file, keys } of MANIFESTS) {
    for (const rel of keys) {
      const { ruleId, kind, sources } = attributeEmittedPath(rel, runtime);
      if (kind === 'synthesized') {
        assert.equal(sources.length, 0, `synthesized rule "${ruleId}" must have no sources`);
        continue;
      }
      assert.ok(sources.length > 0, `rule "${ruleId}" produced no sources for ${rel}`);
      for (const src of sources) {
        // A `descriptor` source may legitimately be absent — the installer itself
        // fs.existsSync-guards it and no-ops (design negative-space). Identity,
        // rewrite, derived and code-derived sources must exist.
        if (kind === 'descriptor') continue;
        const full = path.join(REPO_ROOT, src);
        if (!fs.existsSync(full)) missing.push(`${file}: ${rel} -> ${src} (rule ${ruleId})`);
      }
    }
  }
  assert.deepEqual(missing, [], `attributed sources that do not exist:\n  ${missing.slice(0, 10).join('\n  ')}`);
});

// ─── Spot-checks: known emitted/source pairs (#2722 "add spot-check tests") ──

test('spot-check: flat skill attributes to commands/gsd, NOT the generated repo skills/ dir', () => {
  const got = attributeEmittedPath('skills/gsd-add-tests/SKILL.md', 'claude');

  assert.equal(got.ruleId, 'skills-from-commands');
  assert.deepEqual(got.sources, [`${COMMANDS_SRC}/add-tests.md`]);

  // The trap, asserted explicitly. The repo DOES contain
  // skills/gsd-add-tests/SKILL.md, but scripts/gen-plugin-skills.cjs generates it
  // from commands/gsd/add-tests.md — attributing to it would be false attribution
  // that still passes totality.
  assert.ok(
    !got.sources.includes('skills/gsd-add-tests/SKILL.md'),
    'emitted skills must never attribute to the generated repo skills/ directory',
  );
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'skills', 'gsd-add-tests', 'SKILL.md')),
    'precondition: the generated repo skills/ dir exists, which is why the trap is live',
  );
});

test('spot-check: nested skill attributes to its child stem, not its router', () => {
  // augment is a real nested-layout host (#69); the key below is verbatim from
  // tests/fixtures/golden-install-parity/augment.json, not a constructed path.
  const nested = attributeEmittedPath('skills/gsd-ns-manage/skills/config/SKILL.md', 'augment');
  assert.equal(nested.ruleId, 'skills-nested-from-commands');
  assert.deepEqual(nested.sources, [`${COMMANDS_SRC}/config.md`]);
  assert.ok(
    !nested.sources.includes(`${COMMANDS_SRC}/ns-manage.md`),
    'a nested skill must attribute to the CHILD stem, not the routing ns-* parent',
  );

  // The router itself is a normal flat skill and resolves to its own stem.
  const router = attributeEmittedPath('skills/gsd-ns-manage/SKILL.md', 'augment');
  assert.equal(router.ruleId, 'skills-from-commands');
  assert.deepEqual(router.sources, [`${COMMANDS_SRC}/ns-manage.md`]);
});

test('spot-check: alternate skills roots (hermes category, codex .agents) strip correctly', () => {
  // Every key here is verbatim from the named runtime's committed manifest.
  assert.deepEqual(
    attributeEmittedPath('skills/gsd/gsd-ns-context/SKILL.md', 'hermes').sources,
    [`${COMMANDS_SRC}/ns-context.md`],
  );
  assert.deepEqual(
    attributeEmittedPath('skills/gsd/gsd-ns-context/skills/docs-update/SKILL.md', 'hermes').sources,
    [`${COMMANDS_SRC}/docs-update.md`],
  );
  // codex — NOT antigravity: codex's skills kind carries a `home` override to
  // $HOME/.agents/skills (ADR-1239 upgrade 3 / #2088), which is why its emitted
  // skills sit under `.agents/skills/` rather than `skills/`.
  assert.deepEqual(
    attributeEmittedPath('.agents/skills/gsd-add-tests/SKILL.md', 'codex').sources,
    [`${COMMANDS_SRC}/add-tests.md`],
  );
});

test('spot-check: nativePlugin source is per-runtime, read from the descriptor', () => {
  const opencode = attributeEmittedPath('plugins/gsd-core.js', 'opencode');
  const kilo = attributeEmittedPath('plugins/gsd-core.js', 'kilo');
  const pi = attributeEmittedPath('extensions/gsd.js', 'pi');

  assert.equal(opencode.ruleId, 'native-plugin');
  assert.deepEqual(opencode.sources, ['.opencode/plugins/gsd-core.js']);
  assert.deepEqual(kilo.sources, ['.kilo/plugins/gsd-core.js']);
  assert.deepEqual(pi.sources, ['pi/gsd.cjs']);

  // Independence: the SAME emitted key resolves differently per host. A design
  // keyed on `rel` alone would silently give kilo opencode's source.
  assert.notDeepEqual(
    opencode.sources,
    kilo.sources,
    'attribution must be a function of (rel, runtime), not rel alone',
  );
});

test('spot-check: agents identity, Copilot rename, Codex toml, and Kimi subagent derivation', () => {
  assert.deepEqual(
    attributeEmittedPath('agents/gsd-planner.md', 'claude').sources,
    ['agents/gsd-planner.md'],
  );
  // Copilot renames to <name>.agent.md — attributing that as identity resolved to
  // a file that does not exist (real bug found by the source-existence gate).
  assert.deepEqual(
    attributeEmittedPath('agents/gsd-planner.agent.md', 'copilot').sources,
    ['agents/gsd-planner.md'],
  );
  assert.deepEqual(
    attributeEmittedPath('agents/gsd-planner.toml', 'codex').sources,
    ['agents/gsd-planner.md'],
  );
  // Two emitted paths sharing one source is legal; one path matching two rules is not.
  const yaml = attributeEmittedPath('agents/subagents/gsd-planner.yaml', 'kimi');
  const md = attributeEmittedPath('agents/subagents/gsd-planner.md', 'kimi');
  assert.deepEqual(yaml.sources, ['agents/gsd-planner.md']);
  assert.deepEqual(md.sources, yaml.sources);
});

test('spot-check: Kimi root agent is code-derived, not a repo agent file', () => {
  const rootYaml = attributeEmittedPath('agents/gsd.yaml', 'kimi');
  assert.equal(rootYaml.ruleId, 'kimi-root-agent');
  assert.equal(rootYaml.kind, 'code-derived');
  // Built from a literal AND an enumeration of every staged agent, so both are
  // declared; the trailing-slash entry is a prefix, not a file.
  assert.ok(rootYaml.sources.includes(KIMI_ROOT_AGENT_SRC));
  assert.ok(rootYaml.sources.includes('agents/'));
  assert.deepEqual(attributeEmittedPath('agents/gsd.md', 'kimi').ruleId, 'kimi-root-agent');
});

test('spot-check: hooks attribute to repo source, not the dist build artifact', () => {
  assert.deepEqual(
    attributeEmittedPath('hooks/gsd-statusline.js', 'claude').sources,
    ['hooks/gsd-statusline.js'],
  );
  assert.deepEqual(
    attributeEmittedPath('hooks/lib/git-cmd.js', 'claude').sources,
    ['hooks/lib/git-cmd.js'],
  );
  // Kimi installs the same bundle under its own hooks root.
  assert.deepEqual(
    attributeEmittedPath('.kimi/hooks/gsd-statusline.js', 'kimi').sources,
    ['hooks/gsd-statusline.js'],
  );
  // Copilot's hook REGISTRATION json is a code literal, not a built script.
  const reg = attributeEmittedPath('hooks/gsd-session.json', 'copilot');
  assert.equal(reg.ruleId, 'copilot-hook-registration');
  assert.deepEqual(reg.sources, [CLINE_BODY_SRC]);
});

test('spot-check: cline rules are code-derived (attributable), not exempt', () => {
  for (const rel of ['.clinerules/gsd.md', '.clinerules/hooks/PreToolUse']) {
    const got = attributeEmittedPath(rel, 'cline');
    assert.equal(got.kind, 'code-derived', `${rel} must stay attributable`);
    assert.deepEqual(got.sources, [CLINE_BODY_SRC]);
  }
  const agentsMd = attributeEmittedPath('.agents/AGENTS.md', 'cline');
  assert.equal(agentsMd.kind, 'code-derived');
  assert.deepEqual(agentsMd.sources, [CLINE_BODY_SRC]);
});

test('spot-check: install-time state is exempt with an empty source list', () => {
  for (const [rel, rt] of [
    ['.gsd-profile', 'claude'],
    ['gsd-core/VERSION', 'claude'],
    ['gsd-core/.gsd-runtime', 'claude'],
    ['package.json', 'opencode'],
    ['.gsd/defaults.json', 'opencode'],
    ['opencode.json', 'opencode'],
  ]) {
    const got = attributeEmittedPath(rel, rt);
    assert.equal(got.kind, 'synthesized', `${rel} should be synthesized`);
    assert.deepEqual(got.sources, [], `${rel} is exempt and must declare no sources`);
  }
});

// ─── Negative space: the guard must fail loud ────────────────────────────────

test('unmatched path fails loud and names the path', () => {
  assert.throws(
    () => attributeEmittedPath('totally/unknown/path.md', 'claude'),
    (err) => err.message.includes('totally/unknown/path.md') && err.message.includes('claude'),
    'an unattributed path must name itself and its runtime',
  );
});

test('ambiguous match fails loud and names both rules', () => {
  const duplicate = { ...PROVENANCE_RULES.find((r) => r.id === 'scripts-verbatim'), id: 'scripts-verbatim-copy' };
  const rules = [...PROVENANCE_RULES, duplicate];
  assert.throws(
    () => assertTotality(MANIFESTS, rules),
    (err) => err.message.includes('more than one rule')
      && err.message.includes('scripts-verbatim')
      && err.message.includes('scripts-verbatim-copy'),
    'an ambiguous path must name every rule that claimed it',
  );
});

test('dead rule is reported as drift', () => {
  const deadRule = {
    id: 'never-matches-anything',
    kind: 'identity',
    roots: ['definitely-not-an-emitted-root'],
    pattern: /^.+$/,
    sources: () => ['nope'],
  };
  assert.throws(
    () => assertTotality(MANIFESTS, [...PROVENANCE_RULES, deadRule]),
    (err) => err.message.includes('never-matches-anything') && err.message.includes('drifted'),
    'a rule matching nothing is table rot and must be reported',
  );
});

test('removing a rule fails the guard with the unmatched paths named', () => {
  // #2722 acceptance criterion, verbatim: "Removing any rule fails the guard with
  // the unmatched paths named."
  const without = PROVENANCE_RULES.filter((r) => r.id !== 'gsd-core-verbatim');
  assert.throws(
    () => assertTotality(MANIFESTS, without),
    (err) => {
      assert.match(err.message, /match no provenance rule/);
      // A count is reported, and it is the real one — 5,510 gsd-core paths across
      // 19 manifests, not the 10 the message samples.
      const m = err.message.match(/(\d+) emitted path\(s\) match no provenance rule/);
      assert.ok(m, 'the failure must report how many paths went unattributed');
      assert.ok(Number(m[1]) > 5000, `expected the full gsd-core corpus, got ${m[1]}`);
      // Named samples are real emitted paths from the removed rule's family.
      assert.match(err.message, /gsd-core\//);
      return true;
    },
    'removing a rule must name the now-unmatched paths and report a count',
  );
});

test('wrong-source rule is caught by the spot-check, not by totality', () => {
  // #2722 acceptance criterion: "add a rule that maps to a wrong source, assert
  // the spot-check catches it." This is the failing-first demonstration that
  // totality alone CANNOT catch false attribution — the corrupted table is still
  // perfectly total; only the source assertion fails.
  const corrupted = PROVENANCE_RULES.map((r) => (
    r.id === 'skills-from-commands'
      // The exact mistake a reader would make: point at the repo skills/ dir.
      ? { ...r, sources: (m) => [`skills/${m[1]}/SKILL.md`] }
      : r
  ));

  // Totality still passes — proving totality is not a correctness check.
  assert.doesNotThrow(() => assertTotality(MANIFESTS, corrupted));

  // The spot-check property is what fails.
  const rule = corrupted.find((r) => r.id === 'skills-from-commands');
  const m = 'gsd-add-tests/SKILL.md'.match(rule.pattern);
  const wrongSources = rule.sources(m, { rel: 'skills/gsd-add-tests/SKILL.md', runtime: 'claude' });
  assert.notDeepEqual(
    wrongSources,
    [`${COMMANDS_SRC}/add-tests.md`],
    'precondition: the corrupted rule really does produce a wrong source',
  );
  assert.deepEqual(wrongSources, ['skills/gsd-add-tests/SKILL.md']);
});

test('rules match POSIX separators only', () => {
  // Manifest keys are POSIX by construction (buildParityManifest joins on '/').
  // A backslash key must NOT match — rules must never reach for path.sep.
  assert.throws(
    () => attributeEmittedPath('gsd-core\\workflows\\plan-phase.md', 'claude'),
    /no rule matches/,
  );
});

// ─── Boundary coverage: limit-1 / limit / limit+1 ────────────────────────────

test('empty manifest still reports dead rules (limit-1) and a single key works (limit)', () => {
  // An empty universe makes EVERY rule dead — the guard must say so rather than
  // pass vacuously.
  assert.throws(
    () => assertTotality([{ file: 'empty.json', runtime: 'claude', keys: [] }]),
    /match nothing|drifted/,
  );

  // Exactly one key, matching one rule: only the other rules are dead.
  const single = [{ file: 'one.json', runtime: 'claude', keys: ['scripts/lib/cli-exit.cjs'] }];
  assert.throws(() => assertTotality(single), (err) => {
    assert.ok(!err.message.includes('match no provenance rule'), 'the single key should have matched');
    assert.ok(err.message.includes('drifted'));
    return true;
  });
});

test('partial failure names only the offending key (limit+1)', () => {
  const two = [{
    file: 'two.json',
    runtime: 'claude',
    keys: ['scripts/lib/cli-exit.cjs', 'bogus/path.md'],
  }];
  assert.throws(() => assertTotality(two), (err) => {
    assert.ok(err.message.includes('bogus/path.md'), 'the bad key must be named');
    assert.ok(!err.message.includes('scripts/lib/cli-exit.cjs'), 'the good key must NOT be named');
    return true;
  });
});

// ─── Hostile input ───────────────────────────────────────────────────────────

test('non-object manifest JSON is rejected, not silently treated as empty', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-prov-'));
  try {
    // Each of these parses cleanly but has no keys — treating them as "no paths"
    // would let the entire guard pass vacuously on a corrupt fixture.
    for (const [name, body] of [
      ['zero.json', '0'],
      ['str.json', '"a string"'],
      ['arr.json', '[]'],
      ['null.json', 'null'],
      ['bool.json', 'true'],
    ]) {
      fs.writeFileSync(path.join(tmp, name), body);
      assert.throws(
        () => loadManifests(tmp),
        (err) => err.message.includes(name) && err.message.includes('path->hash'),
        `${name} must be rejected with a message naming the file`,
      );
      fs.unlinkSync(path.join(tmp, name));
    }

    // Present but empty.
    fs.writeFileSync(path.join(tmp, 'empty.json'), '');
    assert.throws(() => loadManifests(tmp), /empty\.json is empty/);
    fs.unlinkSync(path.join(tmp, 'empty.json'));

    // Valid JSON object is accepted.
    fs.writeFileSync(path.join(tmp, 'ok.json'), '{"scripts/lib/cli-exit.cjs":"deadbeef"}');
    assert.equal(loadManifests(tmp).length, 1);
  } finally {
    cleanup(tmp);
  }
});

test('unreadable fixture surfaces an error', () => {
  // Deterministic fs monkeypatch restored in `finally` — NEVER chmod 0o000, which
  // root bypasses (the test would silently pass with zero coverage in root CI).
  const orig = fs.readFileSync;
  try {
    fs.readFileSync = () => { throw new Error('injected read failure'); };
    assert.throws(() => loadManifests(), /injected read failure/);
  } finally {
    fs.readFileSync = orig;
  }
  // Restoration is real, not assumed.
  assert.equal(loadManifests().length, EXPECTED_MANIFEST_COUNT);
});

// ─── Table invariants ────────────────────────────────────────────────────────

test('rule ids are unique', () => {
  const ids = PROVENANCE_RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate rule ids: ${ids.join(', ')}`);
});

test('attribution is pure and repeatable on a second call', () => {
  const first = attributeEmittedPath('skills/gsd-add-tests/SKILL.md', 'claude');
  const second = attributeEmittedPath('skills/gsd-add-tests/SKILL.md', 'claude');
  assert.deepEqual(second, first);
  // The rule table itself must not have been mutated by matching.
  assert.equal(PROVENANCE_RULES.length, new Set(PROVENANCE_RULES.map((r) => r.id)).size);
});

test('stripSkillPrefix handles prefixed and bare stems', () => {
  assert.equal(stripSkillPrefix('gsd-add-tests'), 'add-tests');
  assert.equal(stripSkillPrefix('config'), 'config', 'nested child dirs are bare stems');
});

// ─── Property: rule order carries no semantics ───────────────────────────────

test('property: rule order carries no semantics', () => {
  // The exactly-one design's core safety property. If order ever mattered, adding
  // a rule at the wrong index would silently change existing attributions — the
  // failure mode first-match-wins tables die of.
  const corpus = [];
  for (const { runtime, keys } of MANIFESTS) {
    // A deterministic spread across each manifest keeps the property fast without
    // biasing toward one family.
    for (let i = 0; i < keys.length; i += 47) corpus.push({ rel: keys[i], runtime });
  }
  assert.ok(corpus.length > 100, `corpus too small: ${corpus.length}`);

  fc.assert(
    fc.property(
      fc.constantFrom(...corpus),
      fc.shuffledSubarray(PROVENANCE_RULES, {
        minLength: PROVENANCE_RULES.length,
        maxLength: PROVENANCE_RULES.length,
      }),
      ({ rel, runtime }, shuffled) => {
        const baseline = matchRules(rel, runtime);
        const hits = [];
        for (const rule of shuffled) {
          if (rule.runtimes && !rule.runtimes.has(runtime)) continue;
          const m = require('./helpers/emitted-provenance.cjs').matchOne(rule, rel);
          if (m) hits.push(rule.id);
        }
        return hits.length === 1
          && baseline.length === 1
          && hits[0] === baseline[0].rule.id;
      },
    ),
    { numRuns: 300 },
  );
});
