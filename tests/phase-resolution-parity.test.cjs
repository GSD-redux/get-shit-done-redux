'use strict';
/**
 * phase-resolution-parity.test.cjs — #2528 resolution-path parity gate
 *
 * The phase-directory matching logic historically existed in three independent
 * copies that had already diverged (different scan idioms, different ambiguity
 * handling): the shared locator (`phase-locator.cjs :: searchPhaseInDir`, used
 * by `findPhaseInternal` and the `init.*` queries), the `find-phase` command
 * scan, and the `phase-plan-index` command scan. #2043/#2232 fixed the shared
 * tokenizer, but any fix needing resolution-level context had to be applied
 * per copy — which is how this bug class kept resurfacing (#2528 is the third
 * instance).
 *
 * A FOURTH copy survived the first pass of that consolidation and was caught in
 * review: `smart-entry.cjs :: detectVerifyFailed`, which resolves the current
 * phase's directory to decide whether its verification failed. It is the worst
 * of the four to get wrong — an unresolved directory reports "not failed",
 * which is indistinguishable from a healthy phase, so the bug is silent by
 * construction. Its absence from this gate is exactly why it was missed.
 *
 * The selection now delegates to one owner (`phase-id.cjs :: matchPhaseDirs`).
 * This gate is the durable guard the #2528 triage asked for: for every corpus
 * scenario, the four resolution paths MUST agree on the same directory for
 * the same bare input — found, not-found, and ambiguous alike. It fails the
 * moment any path re-implements selection and drifts.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const { findPhaseInternal } = require('../gsd-core/bin/lib/phase-locator.cjs');
const { detectSignals } = require('../gsd-core/bin/lib/smart-entry.cjs');

// Path 4 has no JSON resolution surface to read: `detectVerifyFailed` resolves a
// directory and then reports a boolean about its contents. So selection is
// observed indirectly — plant the failing verification artifact in exactly one
// directory and see whether the signal fires. `verify_failed === true` means
// that directory is the one smart-entry chose; `false` means it chose another
// or resolved nothing.
const FAILED_SUMMARY = '# Summary\n\nSTATUS: failed\n';
const PASSED_SUMMARY = '# Summary\n\nSTATUS: passed\n';

function writeState(tmpDir, currentPhase) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nstatus: executing\ntotal_phases: 99\ncurrent_phase: ${currentPhase}\n---\n\n# State\n\n**Status:** executing\n`,
  );
}

function smartEntrySeesFailureIn(tmpDir, dirs, failingDirs) {
  for (const d of dirs) {
    // Every directory always gets a summary — a passing one where the failure
    // is not planted. Deleting instead would let "resolved a dir with no
    // artifact" pass for the same reason as "resolved the right dir".
    const summary = path.join(tmpDir, '.planning', 'phases', d, 'SUMMARY.md');
    fs.writeFileSync(summary, failingDirs.includes(d) ? FAILED_SUMMARY : PASSED_SUMMARY);
  }
  return detectSignals(tmpDir).verify_failed;
}

// Each scenario: phase dirs on disk, the user's bare input, and the expected
// resolution ('10-24-7-autonomy' → that dir; null → not found; 'AMBIGUOUS' →
// every path must surface the ambiguity instead of silently picking one).
const SCENARIOS = [
  {
    name: '#2528 tokenizer fix: 2-digit slug word + 1-digit word ("24/7 Autonomy")',
    dirs: ['10-24-7-autonomy', '11-other'],
    query: '10',
    expect: '10-24-7-autonomy',
  },
  {
    name: '#2528 bare-integer fallback: 2-digit slug run with non-digit tail ("80/20 Cleanup")',
    dirs: ['05-80-20-cleanup', '11-other'],
    query: '5',
    expect: '05-80-20-cleanup',
  },
  {
    name: '#2528 bare-integer fallback: "12-Factor Refactor"',
    dirs: ['30-12-factor-refactor'],
    query: '30',
    expect: '30-12-factor-refactor',
  },
  {
    name: '#2528 prefixed fallback preserves phase number and phase name boundaries',
    dirs: ['MEM-05-80-20-cleanup'],
    query: '5',
    expect: 'MEM-05-80-20-cleanup',
    expectPhaseNumber: 'MEM-05',
    expectPhaseName: '80-20-cleanup',
  },
  {
    name: '#2232 regression stays green: year-leading slug',
    dirs: ['14-2026-photos-performance'],
    query: '14',
    expect: '14-2026-photos-performance',
  },
  {
    name: '#2043 regression stays green: 1-digit slug word',
    dirs: ['46-6-rs-pipeline-orchestrator'],
    query: '46',
    expect: '46-6-rs-pipeline-orchestrator',
  },
  {
    name: 'genuine sub-phase is still resolvable by its full id',
    dirs: ['10-24-setup'],
    query: '10-24',
    expect: '10-24-setup',
  },
  {
    // #2528 re-review: the regression pin. A genuine sub-phase whose slug starts
    // with a bare digit ("7-Zip Integration") is string-identical to a phase
    // named "24/7 Autonomy", and must stay resolvable by its OWN id on every
    // path — the property an earlier tokenizer-side rewind silently broke.
    name: 'a sub-phase with a digit-leading slug resolves by its full id',
    dirs: ['10-24-7-zip'],
    query: '10-24',
    expect: '10-24-7-zip',
  },
  {
    // The fallback is strictly second: a directory that carries the number in
    // its token wins outright, and the digit-leading NAME is not a rival
    // candidate for it. (Fallback-vs-fallback collisions DO go ambiguous — see
    // the next scenario.)
    name: 'a primary token match is never shadowed by a digit-leading phase name',
    dirs: ['10-24-7-autonomy', '10-second'],
    query: '10',
    expect: '10-second',
  },
  {
    name: 'fallback collisions are ambiguous, never a silent first match',
    dirs: ['05-80-20-a', '05-90-till-late'],
    query: '5',
    expect: 'AMBIGUOUS',
  },
  {
    name: 'a missing phase stays not-found on every path',
    dirs: ['10-24-7-autonomy'],
    query: '99',
    expect: null,
  },
];

describe('#2528 resolution-path parity — locator / find-phase / phase-plan-index / smart-entry', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
    tmpDir = null;
  });

  for (const { name, dirs, query, expect, expectPhaseNumber, expectPhaseName } of SCENARIOS) {
    test(name, () => {
      const phasesDir = path.join(tmpDir, '.planning', 'phases');
      for (const d of dirs) {
        const dir = path.join(phasesDir, d);
        fs.mkdirSync(dir, { recursive: true });
        // One canonical plan per dir so a resolved phase-plan-index proves it
        // actually read the directory (plans: [] was the reported symptom).
        const leadingDigits = d.match(/^\d+/);
        const padded = leadingDigits ? leadingDigits[0] : '01';
        fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '---\nwave: 1\n---\n');
      }

      // ── Path 1: the shared locator (findPhaseInternal → searchPhaseInDir) ─
      const located = findPhaseInternal(tmpDir, query);
      const locatorDir =
        located && located.found ? path.basename(located.directory) : null;
      const locatorAmbiguous = Boolean(located && located.ambiguous_matches);

      // ── Path 2: find-phase ────────────────────────────────────────────────
      const findRes = runGsdTools(`find-phase ${query}`, tmpDir);
      assert.ok(findRes.success, `find-phase failed: ${findRes.error}`);
      const findOut = JSON.parse(findRes.output);
      const findDir = findOut.found ? path.basename(findOut.directory) : null;
      const findAmbiguous = Boolean(findOut.ambiguous_matches);

      // ── Path 3: phase-plan-index ──────────────────────────────────────────
      const idxRes = runGsdTools(`phase-plan-index ${query}`, tmpDir);
      assert.ok(idxRes.success, `phase-plan-index failed: ${idxRes.error}`);
      const idxOut = JSON.parse(idxRes.output);
      const idxAmbiguous = Boolean(idxOut.ambiguous_matches);
      const idxResolved = !idxOut.error && idxOut.plans.length > 0;

      // ── Path 4: smart-entry (detectSignals → detectVerifyFailed) ──────────
      // Not a resolution API — it answers "did the current phase fail
      // verification". But it resolves the same directory from the same bare
      // input, and a miss here is SILENT: an unresolved phase reports
      // "not failed", which is byte-identical to a healthy phase. That is why
      // it belongs in this gate and not merely in its own unit test.
      writeState(tmpDir, query);

      if (expect === 'AMBIGUOUS') {
        assert.ok(locatorAmbiguous, 'locator must surface ambiguity');
        assert.ok(findAmbiguous, 'find-phase must surface ambiguity');
        assert.ok(idxAmbiguous, 'phase-plan-index must surface ambiguity');
        assert.deepStrictEqual(
          [...(located.ambiguous_matches || [])].sort(),
          [...(findOut.ambiguous_matches || [])].sort(),
          'locator and find-phase must list the same candidates',
        );
        assert.deepStrictEqual(
          [...(findOut.ambiguous_matches || [])].sort(),
          [...(idxOut.ambiguous_matches || [])].sort(),
          'find-phase and phase-plan-index must list the same candidates',
        );
        // Path 4 deliberately does NOT fail loud on ambiguity: it is a routing
        // signal with no way to ask the user, so it keeps the first candidate
        // in the already-sorted list, exactly as its prior `.find()` did. What
        // parity still requires is that it picks from the SAME candidate set —
        // so a failure in any ambiguous candidate must be reachable, and a
        // failure outside the set must not be.
        const candidates = [...(located.ambiguous_matches || [])].map((c) => path.basename(c));
        assert.ok(
          smartEntrySeesFailureIn(tmpDir, dirs, candidates),
          'smart-entry must resolve into the ambiguous candidate set',
        );
        const outsiders = dirs.filter((d) => !candidates.includes(d));
        if (outsiders.length > 0) {
          assert.ok(
            !smartEntrySeesFailureIn(tmpDir, dirs, outsiders),
            'smart-entry must not resolve to a directory outside the candidate set',
          );
        }
      } else if (expect === null) {
        assert.strictEqual(locatorDir, null, 'locator must report not-found');
        assert.strictEqual(findDir, null, 'find-phase must report not-found');
        assert.strictEqual(idxOut.error, 'Phase not found', 'phase-plan-index must report not-found');
        assert.ok(
          !smartEntrySeesFailureIn(tmpDir, dirs, dirs),
          'smart-entry must report not-found too — a failing artifact in every '
          + 'directory must still not be attributed to an unresolvable phase',
        );
      } else {
        assert.strictEqual(locatorDir, expect, 'locator resolved the wrong dir');
        if (expectPhaseNumber) {
          assert.strictEqual(located.phase_number, expectPhaseNumber);
          assert.strictEqual(located.phase_name, expectPhaseName);
        }
        assert.strictEqual(findDir, expect, 'find-phase resolved the wrong dir');
        assert.ok(
          idxResolved,
          `phase-plan-index must resolve and index plans, got: ${idxRes.output}`,
        );
        assert.ok(
          smartEntrySeesFailureIn(tmpDir, dirs, [expect]),
          `smart-entry resolved a different dir — it did not see the failure planted in ${expect}`,
        );
        for (const other of dirs.filter((d) => d !== expect)) {
          assert.ok(
            !smartEntrySeesFailureIn(tmpDir, dirs, [other]),
            `smart-entry resolved ${other} instead of ${expect}`,
          );
        }
      }
    });
  }
});

// ─── #2528 consumer parity ───────────────────────────────────────────────────
/**
 * The four paths above are the resolution APIs. Review found eight further call
 * sites that had each re-implemented the same "resolve a phase directory from a
 * bare number" step by hand — `dirs.find/some(d => phaseTokenMatches(d, n))` —
 * and so reproduced the #2528 symptom in full even after the owner existed.
 *
 * They are covered here rather than in their own files because the failure this
 * gate exists to catch is not "command X is broken" but "a consumer stopped
 * agreeing with the owner". Splitting them up is how the first four drifted.
 *
 * Every path is observed through the surface a user actually sees, never
 * through the matcher:
 *
 *   1. `phases list --phase N`     → `error: 'Phase not found'` vs listed files
 *   2. `phase next-decimal N`      → `found`
 *   3. `phase remove N --force`    → `directory_deleted`
 *   4. `verify schema-drift N`     → `Phase directory not found` message
 *   5. `validate health`  (W021)   → milestone-complete-vs-roadmap consistency
 *   6. `init manager`              → the overview table's `disk_status`
 *   7. `milestone complete vX`     → the unstarted-phase completion guard
 *   8. `roadmap analyze`           → per-phase `disk_status`
 *
 * Paths 1-4 take the phase as a query. Paths 5-8 never see one: they walk the
 * ROADMAP and ask the disk about each phase in turn, so their "query" is the
 * roadmap heading and their answer is whether the phase looks started.
 */

const CONSUMER_SCENARIOS = [
  {
    name: '#2528 bare-integer fallback ("80/20 Cleanup")',
    dirs: ['05-80-20-cleanup', '11-other'],
    query: '5',
    resolvesTo: '05-80-20-cleanup',
  },
  {
    name: '#2528 tokenizer fix ("24/7 Autonomy")',
    dirs: ['10-24-7-autonomy', '11-other'],
    query: '10',
    resolvesTo: '10-24-7-autonomy',
  },
  {
    name: '#2528 bare-integer fallback ("12-Factor Refactor")',
    dirs: ['30-12-factor-refactor'],
    query: '30',
    resolvesTo: '30-12-factor-refactor',
  },
  {
    // Control. Without it every assertion below could be satisfied by a
    // consumer that resolves unconditionally.
    name: 'a phase with no directory stays unresolved on every consumer',
    dirs: ['11-other'],
    query: '99',
    resolvesTo: null,
  },
];

/**
 * #2528 re-review: the AMBIGUOUS row the rows above cannot express.
 *
 * Every scenario in CONSUMER_SCENARIOS is binary — a query either resolves to
 * one directory or to none — so a query that resolves to TWO fell through the
 * gate entirely. That gap is what let the destructive path regress unseen:
 * `phase remove` took `matches[0]` while every guarded sibling refuses, turning
 * "resolve nothing, delete nothing" at base into "delete one of two candidates,
 * and renumber every phase after it".
 *
 * This is a fallback ambiguity specifically: neither directory's TOKEN is `05`
 * (`05-80-20-a` tokenizes to `05-80-20`), so both are reached only by the
 * bare-integer fallback this PR adds — i.e. the ambiguity is one this PR
 * created, which is why the PR owes it a guard.
 */
const AMBIGUOUS_SCENARIO = {
  dirs: ['05-80-20-a', '05-90-till-late'],
  query: '5',
};

/**
 * #2528 re-review: sub-phase-shaped directories, pinned in BOTH directions.
 *
 * `05-01-auth` is a genuine deep-decomposition directory for phase 5.1, and it
 * has the same `NN-NN-<slug>` shape as `30-12-factor-refactor` (phase 30 named
 * "12-Factor Refactor"). No rule over directory names alone separates them —
 * "is the second segment a valid decimal sub-phase" accepts `5.1` and `30.12`
 * equally — so the bare-integer fallback necessarily reaches both, and a bare
 * `5` now resolves a lone `05-01-auth` where base found nothing.
 *
 * Both halves are pinned here because the docblock's claim about scope is only
 * true of the QUERY side, and nothing previously observed the directory side:
 *   - one such directory  → resolves, and the display number is the leading run
 *   - two such directories → ambiguous, and the destructive path deletes nothing
 */
const SUBPHASE_DIRS = ['05-01-auth', '05-02-api'];

describe('#2528 consumer parity — the eight sites migrated to matchPhaseDirs', () => {
  const projects = [];

  afterEach(() => {
    for (const dir of projects.splice(0)) cleanup(dir);
  });

  // Each mutating path needs its own project: `phase remove` deletes and
  // renumbers, `milestone complete` archives the whole phases tree.
  function project(dirs, roadmapPhase, status = 'executing') {
    const tmpDir = createTempProject();
    projects.push(tmpDir);
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    for (const d of dirs) {
      const dir = path.join(phasesDir, d);
      fs.mkdirSync(dir, { recursive: true });
      const padded = (d.match(/^\d+/) || ['01'])[0];
      fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '---\nwave: 1\n---\n');
    }
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase ${roadmapPhase}: Target\n`,
    );
    // `milestone:` is load-bearing: milestone-complete only runs its
    // unstarted-phase guard when STATE names the version being completed.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\nstatus: ${status}\nmilestone: v1.0\ntotal_phases: 99\ncurrent_phase: ${roadmapPhase}\n---\n\n# State\n\n**Status:** ${status}\n`,
    );
    return tmpDir;
  }

  function json(cmd, cwd) {
    const res = runGsdTools(cmd, cwd);
    assert.ok(res.success, `${cmd} failed: ${res.error}`);
    return JSON.parse(res.output);
  }

  for (const { name, dirs, query, resolvesTo } of CONSUMER_SCENARIOS) {
    const resolves = resolvesTo !== null;

    test(`${name} — query-driven consumers`, () => {
      const tmpDir = project(dirs, query);

      // 1. phases list
      const listed = json(`phases list --phase ${query} --type plans`, tmpDir);
      if (resolves) {
        assert.ok(!listed.error, `phases list: ${listed.error}`);
        assert.deepStrictEqual(
          listed.files,
          [`${resolvesTo.match(/^\d+/)[0]}-01-PLAN.md`],
          'phases list resolved a different directory',
        );
      } else {
        assert.strictEqual(listed.error, 'Phase not found');
      }

      // 2. phase next-decimal — `found` is the base-phase existence check
      assert.strictEqual(
        json(`phase next-decimal ${query}`, tmpDir).found,
        resolves,
        'next-decimal disagreed on whether the base phase exists',
      );

      // 3. verify schema-drift
      const drift = json(`verify schema-drift ${query}`, tmpDir);
      assert.strictEqual(
        drift.message === `Phase directory not found: ${query}`,
        !resolves,
        `schema-drift disagreed: ${drift.message}`,
      );

      // 4. phase remove — mutating, so it runs last and on its own project
      const removeProject = project(dirs, query);
      assert.strictEqual(
        json(`phase remove ${query} --force`, removeProject).directory_deleted,
        resolvesTo,
        'phase remove deleted the wrong directory (or none)',
      );
    });

    test(`${name} — roadmap-driven consumers`, () => {
      // 5. validate health, W021: STATE must claim the milestone is done for
      //    the roadmap-vs-disk consistency check to run at all.
      const health = json('validate health', project(dirs, query, 'milestone complete'));
      const w021 = health.warnings.filter((w) => w.code === 'W021');
      assert.strictEqual(
        w021.length > 0,
        !resolves,
        `W021 disagreed on whether Phase ${query} is started: ${JSON.stringify(w021)}`,
      );

      const tmpDir = project(dirs, query);

      // 6. init manager overview table
      const manager = json('init manager', tmpDir);
      const managed = manager.phases.find((p) => p.number === query);
      assert.ok(managed, `init manager did not list Phase ${query}`);
      assert.strictEqual(
        managed.disk_status === 'no_directory',
        !resolves,
        'init manager disagreed on disk_status',
      );

      // 7. roadmap analyze
      const analyzed = json('roadmap analyze', tmpDir).phases.find((p) => p.number === query);
      assert.ok(analyzed, `roadmap analyze did not list Phase ${query}`);
      assert.strictEqual(
        analyzed.disk_status === 'no_directory',
        !resolves,
        'roadmap analyze disagreed on disk_status',
      );
      assert.strictEqual(
        analyzed.disk_status,
        managed.disk_status,
        'roadmap analyze and init manager disagreed with each other',
      );

      // 8. milestone complete — mutating, own project. The guard blocks
      //    completion while any roadmap phase has no directory.
      const completion = runGsdTools('milestone complete v1.0', project(dirs, query));
      assert.strictEqual(
        completion.success,
        resolves,
        `milestone-complete guard disagreed: ${completion.error || completion.output}`,
      );
      if (!resolves) {
        assert.match(completion.error, /Cannot mark milestone complete/);
      }
    });
  }

  test('two directories claiming one bare phase number — the destructive path deletes neither', () => {
    const { dirs, query } = AMBIGUOUS_SCENARIO;
    const tmpDir = project(dirs, query);
    const phasesDir = path.join(tmpDir, '.planning', 'phases');

    const removed = json(`phase remove ${query} --force`, tmpDir);

    assert.strictEqual(removed.directory_deleted, null, 'phase remove chose a directory');
    assert.deepStrictEqual(
      removed.ambiguous_matches,
      dirs,
      'phase remove did not surface both candidates',
    );
    assert.match(removed.error, /ambiguous/i);

    // The load-bearing assertion: the refusal is about the FILESYSTEM, not the
    // report. A `directory_deleted: null` printed after an `rmSync` would pass
    // every check above.
    assert.deepStrictEqual(
      fs.readdirSync(phasesDir).sort(),
      [...dirs].sort(),
      'phase remove deleted a directory it reported refusing to choose',
    );
    assert.deepStrictEqual(removed.renamed_directories, [], 'phase remove renumbered anyway');
  });

  test('a lone sub-phase-shaped directory resolves, and its two-directory twin does not', () => {
    const [first, second] = SUBPHASE_DIRS;

    // One directory: the fallback reaches it, and the displayed number is the
    // leading digit run — NOT the mis-absorbed `05-01` token.
    const lone = findPhaseInternal(project([first], '5'), '5');
    assert.ok(lone && lone.found, 'a lone sub-phase-shaped directory did not resolve');
    assert.strictEqual(lone.phase_number, '05');
    assert.strictEqual(lone.phase_name, '01-auth');
    assert.strictEqual(path.basename(lone.directory), first);

    // Two directories: the same shape is now ambiguous, and the destructive
    // path must delete neither — this is the case the reviewer measured as
    // "deletes 05-01-auth and renumbers 06-next → 05-next".
    const tmpDir = project(SUBPHASE_DIRS, '5');
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const removed = json('phase remove 5 --force', tmpDir);
    assert.strictEqual(removed.directory_deleted, null);
    assert.deepStrictEqual(removed.ambiguous_matches, [first, second]);
    assert.deepStrictEqual(fs.readdirSync(phasesDir).sort(), [...SUBPHASE_DIRS].sort());
  });

  test('validate health pairs a digit-leading directory with its roadmap phase (W006/W007)', () => {
    // #2528 re-review, the ninth site. W006/W007 resolve roadmap↔disk by
    // intersecting token SETS, which is a dir→token labelling rather than the
    // query→dir selection matchPhaseDirs owns — so the canonical fixture used
    // to emit BOTH halves of the contradiction at once: "Phase 5 … no directory
    // on disk" and "Phase 05-80-20 exists on disk but not in ROADMAP.md".
    const codes = (dirs, roadmapPhase) => json('validate health', project(dirs, roadmapPhase))
      .warnings.filter((w) => w.code === 'W006' || w.code === 'W007')
      .map((w) => w.code)
      .sort();

    assert.deepStrictEqual(
      codes(['05-80-20-cleanup'], '5'),
      [],
      'validate health still reports phase 5 as both missing and orphaned',
    );

    // Controls, so the assertion above cannot be satisfied by a check that
    // stopped reporting anything: a roadmap phase with no directory at all must
    // still raise W006, and a directory no roadmap phase resolves to must still
    // raise W007.
    assert.deepStrictEqual(codes(['07-orphan'], '5'), ['W006', 'W007']);
  });

  test('phase remove counts the surviving phases by identity, not by re-matching the query', () => {
    // #2640 (landed on `next` while this branch was open) resyncs STATE.md's
    // phase count after a removal by filtering `subdirs` for the directory that
    // was deleted. Re-deriving that directory from the QUERY is a tenth site of
    // the #2528 defect: the bare-integer fallback resolves `05-80-20-cleanup`
    // for query `5`, but `phaseTokenMatches` (whose token is the mis-absorbed
    // `05-80-20`) does not — so the just-deleted directory is counted as still
    // present and the written total is one too high. `targetDir` is already the
    // directory that was removed, so identity answers the question exactly.
    const total = (dirs, query) => {
      const tmpDir = project(dirs, query);
      json(`phase remove ${query} --force`, tmpDir);
      const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      const m = state.match(/^Total Phases:\s*(\d+)/m);
      assert.ok(m, 'phase remove did not resync a phase count into STATE.md');
      return Number(m[1]);
    };

    assert.strictEqual(total(['05-80-20-cleanup', '11-other'], '5'), 1);

    // Control: on a directory the tokenizer reads correctly, identity and token
    // re-derivation agree — so the assertion above is about the digit-leading
    // shape, not about the counting rule changing for everything.
    assert.strictEqual(total(['05-cleanup', '11-other'], '5'), 1);
  });
});
