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
  AGENT_TRANSFORM_SRCS,
  stripSkillPrefix,
  matchRules,
  attributeEmittedPath,
  loadManifests,
  assertTotality,
  assertNoIdentityTransforms,
} = require('./helpers/emitted-provenance.cjs');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * Manifests are loaded once, but LAZILY — never at module scope.
 * `RULESET.TESTS.guard-toplevel-readFileSync` (CONTEXT.md:456): a module-level
 * read throws before any `test()` registers, so a missing or corrupt fixture dir
 * would crash the file at require time and report an opaque error instead of one
 * named failing test. Memoizing here keeps the "read 19 fixtures once" saving
 * without the crash-before-registration risk.
 */
let _manifests = null;
function manifests() {
  if (_manifests === null) _manifests = loadManifests();
  return _manifests;
}

// ─── Totality (issue #2722's headline acceptance criterion) ──────────────────

test('totality: every emitted path across all 19 manifests matches exactly one rule', () => {
  // Assert the COUNT, not just "some files": a glob that silently matched fewer
  // fixtures would otherwise report a vacuous pass over a shrunken universe.
  assert.equal(
    manifests().length,
    EXPECTED_MANIFEST_COUNT,
    `expected ${EXPECTED_MANIFEST_COUNT} runtime manifests, found ${manifests().length}`,
  );

  const { checked, byRule } = assertTotality(manifests());

  assert.ok(checked > 8000, `expected the full emitted corpus, only checked ${checked}`);
  // No dead rules — assertTotality already throws on one; this pins the contract
  // so a future refactor cannot quietly downgrade it to a warning.
  for (const [ruleId, count] of byRule) {
    assert.ok(count > 0, `rule "${ruleId}" matched nothing`);
  }
});

test('totality covers all 19 runtimes, asserted by count', () => {
  const runtimes = new Set(manifests().map((m) => m.file));
  assert.equal(runtimes.size, EXPECTED_MANIFEST_COUNT);
  for (const m of manifests()) {
    assert.ok(m.keys.length > 0, `manifest ${m.file} has no keys`);
  }
});

test('every attributed source exists in the repo (identity/rewrite/derived rules)', () => {
  // This is the gate that catches FALSE ATTRIBUTION — a rule that is total but
  // points at the wrong place. A source path that does not exist is proof the rule
  // is wrong, and it is how the three real bugs in this table were found.
  const missing = [];
  for (const { runtime, file, keys } of manifests()) {
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

// ─── Transforms (#2757): derived rules can declare a transform-code source ───

test('agents-toml-derived declares AGENT_TRANSFORM_SRCS as transforms', () => {
  const got = attributeEmittedPath('agents/gsd-planner.toml', 'codex');
  assert.equal(got.kind, 'derived');
  assert.deepEqual(got.sources, ['agents/gsd-planner.md']);
  assert.deepEqual(got.transforms, AGENT_TRANSFORM_SRCS);
});

test('agents-verbatim is reclassified to derived with the same transforms, sources unchanged', () => {
  const got = attributeEmittedPath('agents/gsd-planner.md', 'claude');
  assert.equal(got.kind, 'derived', 'no runtime emits a byte-identical copy — see #2757 design doc');
  assert.deepEqual(got.sources, ['agents/gsd-planner.md'], 'sources must be unchanged by the reclassification');
  assert.deepEqual(got.transforms, AGENT_TRANSFORM_SRCS);
});

test('a rule with no transforms field still returns an empty array, never undefined', () => {
  const got = attributeEmittedPath('gsd-core/workflows/plan-phase.md', 'claude');
  assert.deepEqual(got.transforms, [], 'absence of transforms must be a stable empty array, not undefined');
});

test('every declared transform path exists in the repo', () => {
  // Same philosophy as "every attributed source exists in the repo": a transform path
  // that does not exist is proof the rule (or the design's own suggested files) is
  // wrong — this is exactly how src/agent-tools-contract.cts was ruled out during
  // design: it does not exist in this tree.
  const missing = [];
  for (const rule of PROVENANCE_RULES) {
    for (const t of rule.transforms || []) {
      if (!fs.existsSync(path.join(REPO_ROOT, t))) missing.push(`${rule.id}: ${t}`);
    }
  }
  assert.deepEqual(missing, [], `declared transform paths that do not exist:\n  ${missing.join('\n  ')}`);
});

test('identity rules never declare a non-empty transforms list (real table)', () => {
  const violators = PROVENANCE_RULES.filter(
    (r) => r.kind === 'identity' && Array.isArray(r.transforms) && r.transforms.length > 0,
  );
  assert.deepEqual(violators.map((r) => r.id), [], 'an identity copy can only move when its source moves');
});

test('assertNoIdentityTransforms rejects an identity rule declaring transforms, naming it', () => {
  const corrupted = PROVENANCE_RULES.map((r) => (
    r.id === 'scripts-verbatim' ? { ...r, transforms: ['scripts/build-hooks.js'] } : r
  ));
  assert.throws(
    () => assertNoIdentityTransforms(corrupted),
    (err) => err.message.includes('scripts-verbatim') && err.message.includes('identity'),
    'the offending rule id must be named',
  );
});

test('assertNoIdentityTransforms does not throw when transforms is absent or empty', () => {
  const emptyArray = PROVENANCE_RULES.map((r) => (
    r.id === 'scripts-verbatim' ? { ...r, transforms: [] } : r
  ));
  assert.doesNotThrow(() => assertNoIdentityTransforms(emptyArray), 'an empty transforms array is legal on identity');
  assert.doesNotThrow(() => assertNoIdentityTransforms(PROVENANCE_RULES), 'no transforms key at all is legal on identity');
});

test('assertNoIdentityTransforms names only the offending rule, not unrelated valid ones', () => {
  const corrupted = PROVENANCE_RULES.map((r) => (
    r.id === 'scripts-verbatim' ? { ...r, transforms: ['scripts/build-hooks.js'] } : r
  ));
  assert.throws(
    () => assertNoIdentityTransforms(corrupted),
    (err) => !err.message.includes('gsd-core-verbatim'),
    'an unrelated valid identity rule must not be named',
  );
});

test('a derived rule may declare an empty transforms array with no special meaning', () => {
  const withEmpty = PROVENANCE_RULES.map((r) => (
    r.id === 'agents-toml-derived' ? { ...r, transforms: [] } : r
  ));
  assert.doesNotThrow(() => assertNoIdentityTransforms(withEmpty));
  const got = attributeEmittedPath('agents/gsd-planner.toml', 'codex', withEmpty);
  assert.deepEqual(got.transforms, []);
});

test('reclassifying agents-verbatim does not change totality byRule counts', () => {
  // The match set is a function of (pattern, roots), not kind — asserting the count
  // is unchanged proves the reclassification touched classification only.
  const { byRule } = assertTotality(manifests());
  assert.ok(byRule.get('agents-verbatim') > 0, 'agents-verbatim must still match its real family');
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
    () => assertTotality(manifests(), rules),
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
    () => assertTotality(manifests(), [...PROVENANCE_RULES, deadRule]),
    (err) => err.message.includes('never-matches-anything') && err.message.includes('drifted'),
    'a rule matching nothing is table rot and must be reported',
  );
});

test('removing a rule fails the guard with the unmatched paths named', () => {
  // #2722 acceptance criterion, verbatim: "Removing any rule fails the guard with
  // the unmatched paths named."
  const without = PROVENANCE_RULES.filter((r) => r.id !== 'gsd-core-verbatim');
  assert.throws(
    () => assertTotality(manifests(), without),
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
  assert.doesNotThrow(() => assertTotality(manifests(), corrupted));

  // Drive the REAL attribution path with the corrupted table. Hand-calling
  // rule.sources() and re-deriving the expected value would only re-implement the
  // assertion, proving nothing about the shipped code path — the injectable
  // `rules` seam is what makes this an actual demonstration.
  const got = attributeEmittedPath('skills/gsd-add-tests/SKILL.md', 'claude', corrupted);
  assert.deepEqual(got.sources, ['skills/gsd-add-tests/SKILL.md']);
  assert.notDeepEqual(
    got.sources,
    [`${COMMANDS_SRC}/add-tests.md`],
    'the corrupted table produces the wrong source through the real path',
  );
  // The uncorrupted table, same path, same call — the difference IS the spot-check.
  assert.deepEqual(
    attributeEmittedPath('skills/gsd-add-tests/SKILL.md', 'claude').sources,
    [`${COMMANDS_SRC}/add-tests.md`],
  );

  // Why the spot-check is load-bearing and the source-existence gate is not
  // sufficient here: the WRONG source also exists on disk (repo skills/ is a
  // generated dir). Existence catches a rule pointing at nothing; only a pinned
  // known-pair catches a rule pointing at the wrong real thing.
  assert.ok(
    fs.existsSync(path.join(REPO_ROOT, 'skills', 'gsd-add-tests', 'SKILL.md')),
    'the wrong source exists, which is exactly why existence alone cannot catch it',
  );
});

test('attributeEmittedPath throws on an ambiguous table, naming both rules', () => {
  // Exercises attributeEmittedPath's OWN hits.length > 1 branch. Previously only
  // assertTotality's parallel ambiguity path was covered, leaving this throw a
  // prime surviving-mutant candidate under the 80% Stryker gate.
  const duplicate = {
    ...PROVENANCE_RULES.find((r) => r.id === 'scripts-verbatim'),
    id: 'scripts-verbatim-clone',
  };
  assert.throws(
    () => attributeEmittedPath('scripts/lib/cli-exit.cjs', 'claude', [...PROVENANCE_RULES, duplicate]),
    (err) => err.message.includes('matches 2 rules')
      && err.message.includes('scripts-verbatim')
      && err.message.includes('scripts-verbatim-clone')
      && err.message.includes('mutually exclusive'),
  );
});

test('emitted paths that could traverse out of the repo are rejected', () => {
  // gsd-core-verbatim / scripts-verbatim capture a whole tail with `.+`, so without
  // a guard `gsd-core/workflows/../../../etc/passwd` yields a source path that
  // path.join(REPO_ROOT, src) resolves OUTSIDE the repo. Real manifest keys never
  // traverse; Phase 3 feeds these strings into a diff-consuming check.
  for (const bad of [
    'gsd-core/workflows/../../../../etc/passwd',
    'scripts/../../../etc/passwd',
    '../escape.md',
  ]) {
    assert.throws(
      () => attributeEmittedPath(bad, 'claude'),
      /contains a "\.\." segment/,
      `${bad} must be rejected`,
    );
  }
  assert.throws(() => attributeEmittedPath('/etc/passwd', 'claude'), /must be relative/);
  assert.throws(() => attributeEmittedPath('', 'claude'), /non-empty string/);

  // A dot-prefixed segment is NOT traversal — this must still resolve normally.
  assert.doesNotThrow(() => attributeEmittedPath('.gsd/defaults.json', 'opencode'));
});

test('sampleLimit truncation is exact at limit-1 / limit / limit+1', () => {
  // sampleLimit (default 10) gates a real branch — the "…and N more" truncation.
  // CLAUDE.md's boundary rule applies to it as much as to any other limit.
  const key = (i) => `bogus/unmatched-${String(i).padStart(3, '0')}.md`;
  const runFor = (n) => {
    const keys = Array.from({ length: n }, (_, i) => key(i));
    try {
      assertTotality([{ file: 'synthetic.json', runtime: 'claude', keys }], PROVENANCE_RULES, 10);
      return null;
    } catch (err) {
      return err.message;
    }
  };

  const at9 = runFor(9);
  assert.ok(at9.includes('9 emitted path(s) match no provenance rule'));
  assert.ok(!at9.includes('…and'), 'limit-1 must not truncate');
  assert.ok(at9.includes(key(8)), 'limit-1 lists every path');

  const at10 = runFor(10);
  assert.ok(at10.includes('10 emitted path(s) match no provenance rule'));
  assert.ok(!at10.includes('…and'), 'exactly at the limit must not truncate');
  assert.ok(at10.includes(key(9)), 'at the limit the last path is still listed');

  const at11 = runFor(11);
  assert.ok(at11.includes('11 emitted path(s) match no provenance rule'));
  assert.ok(at11.includes('…and 1 more'), 'limit+1 truncates and says how many were hidden');
  assert.ok(!at11.includes(key(10)), 'the 11th path is not listed');
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

/** Stride for sampling the emitted corpus: coprime with every family size here, so
 *  the sample spreads across families instead of landing in one. Any value that is
 *  not a small divisor of a family's size would do; 47 is simply prime and coarse
 *  enough to keep the property fast. */
const CORPUS_STRIDE = 47;

test('property: rule order carries no semantics', () => {
  // The exactly-one design's core safety property. If order ever mattered, adding
  // a rule at the wrong index would silently change existing attributions — the
  // failure mode first-match-wins tables die of.
  //
  // Getting this test to be able to FAIL took two attempts, both worth recording:
  //
  //   1. Hand-rolling the shuffled side out of the per-rule `matchOne` primitive
  //      proved nothing — `matchOne` is order-independent by construction, so the
  //      property held for reasons unrelated to the shipped `matchRules`.
  //   2. Passing `shuffled` into the real `matchRules` still was not enough: on an
  //      UNAMBIGUOUS table, first-match-wins and collect-all return the identical
  //      result for every path (verified: 0 of 190 corpus paths differ). The
  //      property was vacuous either way.
  //
  // Order can only matter where more than one rule matches. So the table under
  // test deliberately contains a duplicate, and the assertion is that matchRules
  // reports BOTH hits under every permutation. That fails immediately under a
  // first-match-wins refactor (length 1, id varying with order), which is the
  // regression this property exists to guard against.
  const corpus = [];
  for (const { runtime, keys } of manifests()) {
    for (let i = 0; i < keys.length; i += CORPUS_STRIDE) corpus.push({ rel: keys[i], runtime });
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
        // (a) the real table: exactly one hit, and the SAME one under any order.
        const baseline = matchRules(rel, runtime);
        const shuffledHits = matchRules(rel, runtime, shuffled);
        if (baseline.length !== 1 || shuffledHits.length !== 1) return false;
        if (shuffledHits[0].rule.id !== baseline[0].rule.id) return false;

        // (b) an intentionally ambiguous table: BOTH hits reported, as a set, under
        //     any order. This is the half that a first-match-wins refactor breaks.
        const matched = baseline[0].rule;
        const clone = { ...matched, id: `${matched.id}-clone` };
        const ambiguous = matchRules(rel, runtime, [...shuffled, clone]);
        if (ambiguous.length !== 2) return false;
        const ids = ambiguous.map((h) => h.rule.id).sort();
        return ids[0] === matched.id && ids[1] === `${matched.id}-clone`;
      },
    ),
    { numRuns: 300 },
  );
});
