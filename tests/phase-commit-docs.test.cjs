'use strict';

/**
 * #3587 (epic #2292 Phase 3) — per-phase `commit_docs` override.
 *
 * A tech lead can mark a single phase's docs to be committed (or suppressed)
 * independently of the project-wide `commit_docs` setting, via the dynamic
 * config key `phase_commit_docs.<phase-id>`. See
 * `.gsd/phase/feat-3587-per-phase-commit-docs/40-design.md` for the
 * precedence chain (phase > config > gitignore > default) and
 * `50-test-matrix.md` for the matrix this file implements (A/B/C/D/F —
 * E lives in tests/phase-commit-docs-manifest-parity.test.cjs).
 *
 * All assertions are on STRUCTURED values (`resolved`, `source`, `reason`),
 * never on rendered/prose text (CONTRIBUTING.md — Prohibited: Raw Text
 * Matching on Test Outputs).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, createTempGitProject } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const commands = require('../gsd-core/bin/lib/commands.cjs');
const configCli = require('../gsd-core/bin/lib/config.cjs');
const { loadConfigResolved, CONFIG_DEFAULTS } = require('../gsd-core/bin/lib/config-loader.cjs');
const io = require('../gsd-core/bin/lib/io.cjs');
const { PHASE_NUMBER_TOKEN_SOURCE } = require('../gsd-core/bin/lib/phase-id.cjs');
const { DYNAMIC_KEY_PATTERNS } = require('../gsd-core/bin/lib/config-schema.cjs');

const {
  detectPhaseNumberFromFiles,
  resolvePhaseCommitDocsOverride,
  resolveCommitDocsPolicy,
  COMMIT_DOCS_SKIP_REASON,
  cmdCommit,
} = commands;

function git(args, cwd) {
  return gitOrThrow(args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
}

function writeConfig(tmpDir, config) {
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * bin/lib/io.cjs's output()/error() write directly to the raw fd via
 * fs.writeSync (bypassing console), so console-capture helpers cannot see
 * them. Monkeypatch fs.writeSync, save/restore in a finally — mirrors
 * tests/config-get-default.test.cjs's captureFdWrite.
 */
function captureFdWrite(fd, fn) {
  const orig = fs.writeSync;
  let captured = Buffer.alloc(0);
  fs.writeSync = (writeFd, ...rest) => {
    if (writeFd !== fd) return orig.call(fs, writeFd, ...rest);
    const [data, offset = 0, length] = rest;
    const chunk = Buffer.isBuffer(data)
      ? data.subarray(offset, offset + (length ?? data.length - offset))
      : Buffer.from(String(data), 'utf8');
    captured = Buffer.concat([captured, chunk]);
    return chunk.length;
  };
  try {
    fn();
  } finally {
    fs.writeSync = orig;
  }
  return captured.toString('utf-8');
}

function runCommit(tmpDir, message, files) {
  const out = captureFdWrite(1, () => {
    cmdCommit(tmpDir, message, files, false, false, false);
  });
  return JSON.parse(out);
}

/** Drives cmdConfigSet in-process, sentinel-exit style (mirrors
 * tests/config-get-default.test.cjs's runExpectError) for the one negative
 * (A4) case that must exercise error()'s process.exit(1) path. */
function runConfigSetExpectError(tmpDir, keyPath, value) {
  const origExit = process.exit;
  const origWriteSync = fs.writeSync;
  io.setJsonErrorMode(true);
  let stderr = '';
  fs.writeSync = (fd, ...rest) => {
    if (fd !== 2) return origWriteSync.call(fs, fd, ...rest);
    const [data, offset = 0, length] = rest;
    const chunk = Buffer.isBuffer(data)
      ? data.subarray(offset, offset + (length ?? data.length - offset)).toString('utf8')
      : String(data);
    stderr += chunk;
    return Buffer.byteLength(chunk);
  };
  class _ExitSignal extends Error {}
  process.exit = () => { throw new _ExitSignal('exit'); };
  try {
    configCli.cmdConfigSet(tmpDir, keyPath, value, true);
  } catch (e) {
    if (!(e instanceof _ExitSignal)) throw e;
  } finally {
    process.exit = origExit;
    fs.writeSync = origWriteSync;
    io.setJsonErrorMode(false);
  }
  const parts = stderr.split('\n').filter(Boolean);
  let payload = {};
  try { payload = JSON.parse(parts[parts.length - 1]); } catch { /* leave {} */ }
  return payload;
}

describe('#3587 per-phase commit_docs override', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempGitProject(); });
  afterEach(() => cleanup(tmpDir));

  // ── A: registration — the key must actually exist ──────────────────────
  describe('A: registration', () => {
    test('A1: perPhaseKeyRoundTripsThroughCli — config-set phase_commit_docs.03 true persists to config.json', () => {
      captureFdWrite(1, () => configCli.cmdConfigSet(tmpDir, 'phase_commit_docs.03', 'true', true));
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
      assert.deepStrictEqual(onDisk.phase_commit_docs, { '03': true });
    });

    test('A2: perPhaseKeyReadsBack — config-get phase_commit_docs.03 returns the value', () => {
      writeConfig(tmpDir, { phase_commit_docs: { '03': true } });
      const out = captureFdWrite(1, () => configCli.cmdConfigGet(tmpDir, 'phase_commit_docs.03', true, undefined));
      assert.strictEqual(out.trim(), 'true');
    });

    test('A3: perPhaseKeySurvivesLoadConfig — present in schema but absent from defaults manifest is NOT silently dropped', () => {
      writeConfig(tmpDir, { phase_commit_docs: { '03': true, '07': false } });
      const { config } = loadConfigResolved(tmpDir, { workstream: null });
      assert.deepStrictEqual(config.phase_commit_docs, { '03': true, '07': false });
    });

    test('A3b: with no phase_commit_docs key at all, loadConfig projects an empty object (never undefined)', () => {
      writeConfig(tmpDir, { commit_docs: true });
      const { config } = loadConfigResolved(tmpDir, { workstream: null });
      assert.deepStrictEqual(config.phase_commit_docs, {});
    });

    test('A4: malformedPhaseKeyIsRejectedNotFatal — phase_commit_docs.<malformed> is rejected as unknown, not fatal', () => {
      const payload = runConfigSetExpectError(tmpDir, 'phase_commit_docs.not-a-phase-number', 'true');
      assert.strictEqual(payload.reason, io.ERROR_REASON.CONFIG_INVALID_KEY);
      // Non-fatal to the process itself: no exception escaped runConfigSetExpectError,
      // i.e. error() was reached and returned control via the sentinel exit only.
    });

    test('A5: configDefaultsProjectionParity — the CONFIG_DEFAULTS flat projection needs no entry, matching the agent_skills/features dynamic-key precedent', () => {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, 'phase_commit_docs'),
        false,
        'phase_commit_docs is an object-shaped dynamic-key family (like agent_skills/features); ' +
        'the flat CONFIG_DEFAULTS projection in config-loader.cjs carries no entry for either ' +
        'precedent, and phase_commit_docs is read purely from parsed config, never from defaults.phase_commit_docs',
      );
    });
  });

  // ── B: resolution — the precedence chain (pure function, no I/O) ───────
  describe('B: resolution', () => {
    const noGitIgnore = () => false;
    const gitIgnored = () => true;

    test('B1: perPhaseBeatsConfig — P=true, C=false resolves true, source phase', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B2: perPhaseSuppressesAgainstConfig — P=false, C=true resolves false, source phase', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': false } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'phase' });
    });

    test('B3: perPhaseBeatsGitignoreAutoDetect — P=true, G=true resolves true, source phase', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, '03', gitIgnored);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B4: phaseIdNormalizesAcrossForms — P set as "3", phase committed is "03"', () => {
      const config = { commit_docs: false, phase_commit_docs: { '3': true } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B4b: phaseIdNormalizesAcrossForms — a project-code-prefixed committed phase ("PROJ-03") hits the bare "03" entry', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, 'PROJ-03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' });
    });

    test('B5: perPhaseDoesNotLeakAcrossPhases — P set for phase 04, committing phase 03 falls to tier 2', () => {
      const config = { commit_docs: true, phase_commit_docs: { '04': false } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'default' });
    });

    test('B6: nonBooleanPerPhaseValueIsNotCoerced — string "true" is not coerced, falls through to config', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': 'true' } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('B6b: nonBooleanPerPhaseValueIsNotCoerced — numeric 1 is not coerced', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': 1 } };
      const r = resolveCommitDocsPolicy(config, '03', gitIgnored);
      assert.deepStrictEqual(r, { resolved: false, source: 'gitignore' });
    });

    test('B6c: nonBooleanPerPhaseValueIsNotCoerced — null is not coerced', () => {
      const config = { commit_docs: true, phase_commit_docs: { '03': null } };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'default' });
    });

    test('B7: noPhaseFallsToProjectSetting — commit names no phase-scoped file, tier 1 inapplicable', () => {
      const config = { commit_docs: false, phase_commit_docs: { '03': true } };
      const r = resolveCommitDocsPolicy(config, null, noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('B8: projectCodeDigitDoesNotMisresolvePhase — a project code ending in a digit resolves phase 07, not 2 (#2539 shape)', () => {
      const files = ['.planning/phases/PROJECT_V2-07-widgets/07-PLAN.md'];
      const phaseNum = detectPhaseNumberFromFiles(files);
      assert.strictEqual(phaseNum, 'PROJECT_V2-07');
      const config = { commit_docs: false, phase_commit_docs: { '07': true } };
      const r = resolveCommitDocsPolicy(config, phaseNum, noGitIgnore);
      assert.deepStrictEqual(r, { resolved: true, source: 'phase' },
        'must resolve against phase 07 (the real phase), never phase 2 (the digit inside "V2-")');
    });

    test('B9: an override map that is not an object is inert, not thrown', () => {
      const config = { commit_docs: false, phase_commit_docs: 'not-an-object' };
      const r = resolveCommitDocsPolicy(config, '03', noGitIgnore);
      assert.deepStrictEqual(r, { resolved: false, source: 'config' });
    });

    test('resolvePhaseCommitDocsOverride returns undefined for a null phase', () => {
      assert.strictEqual(resolvePhaseCommitDocsOverride({ phase_commit_docs: { '03': true } }, null), undefined);
    });
  });

  // ── C: AC4 — regression, the release blocker ────────────────────────────
  // C1-C3 assert the byte-identical-to-`next` behavior using ONLY pre-existing
  // surfaces (cmdCommit's envelope, loadConfigResolved) — no #3587 API — so
  // this exact test code is valid evidence run against the unmodified tree
  // too (see the dispatch's VERIFY step 1: these were run against `next`
  // first, before the tier-1 change landed, and passed identically).
  describe('C: AC4 regression (must hold identically with no per-phase key set)', () => {
    test('C1: unsetPerPhaseIsByteIdenticalConfigFalse — no per-phase key, C=false skips with the pre-existing reason', () => {
      writeConfig(tmpDir, { commit_docs: false });
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, 'skipped_commit_docs_false');
    });

    test('C2: unsetPerPhaseIsByteIdenticalGitignored — no per-phase key, C unset, G=true skips with the pre-existing reason', () => {
      fs.writeFileSync(path.join(tmpDir, '.gitignore'), '.planning/\n');
      git(['add', '.gitignore'], tmpDir);
      git(['commit', '-m', 'chore: gitignore'], tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, 'skipped_gitignored');
    });

    test('C3: unsetPerPhaseIsByteIdenticalDefault — no per-phase key, C unset, G=false commits as today', () => {
      writeConfig(tmpDir, {});
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      fs.writeFileSync(statePath, '# State\n');
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/STATE.md']);
      assert.strictEqual(envelope.committed, true);
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.notStrictEqual(headAfter, headBefore, 'a real commit must have been made');
    });

    test('C5: loadConfigUnchangedWithoutPerPhaseKey — loadConfigResolved output is unchanged in shape/values with no per-phase key', () => {
      writeConfig(tmpDir, { commit_docs: true, model_profile: 'balanced' });
      const { config, source, degraded, reason } = loadConfigResolved(tmpDir, { workstream: null });
      assert.strictEqual(config.commit_docs, true);
      assert.strictEqual(config.model_profile, 'balanced');
      assert.strictEqual(source, 'root');
      assert.strictEqual(degraded, false);
      assert.strictEqual(reason, 'resolved');
      // The universal seam gained a harmless empty-object projection (A3b) —
      // additive, never a behavior change for a caller that never reads the key.
      assert.deepStrictEqual(config.phase_commit_docs, {});
    });
  });

  // ── D: envelope contract ─────────────────────────────────────────────────
  describe('D: envelope contract', () => {
    test('D1: perPhaseSuppressionHasOwnReason — per-phase suppression gets a reason distinct from skipped_commit_docs_false', () => {
      writeConfig(tmpDir, { commit_docs: true, phase_commit_docs: { '03': false } });
      seedPhase(tmpDir, '03-widgets', { '03-PLAN.md': '# Plan\n' });
      const envelope = runCommit(tmpDir, 'docs(test): noop', ['.planning/phases/03-widgets/03-PLAN.md']);
      assert.strictEqual(envelope.committed, false);
      assert.strictEqual(envelope.skipped, true);
      assert.strictEqual(envelope.reason, COMMIT_DOCS_SKIP_REASON.phase);
      assert.notStrictEqual(envelope.reason, 'skipped_commit_docs_false');
    });

    test('D2: existingReasonStringsUnchanged — the two pre-existing reason strings are unchanged (agents/gsd-executor.md pattern-matches on them)', () => {
      assert.strictEqual(COMMIT_DOCS_SKIP_REASON.config, 'skipped_commit_docs_false');
      assert.strictEqual(COMMIT_DOCS_SKIP_REASON.gitignore, 'skipped_gitignored');
    });

    test('D3: perPhaseEnableActuallyCommits — per-phase override ENABLES a commit under project commit_docs:false; the file lands', () => {
      writeConfig(tmpDir, { commit_docs: false, phase_commit_docs: { '03': true } });
      seedPhase(tmpDir, '03-widgets', { '03-PLAN.md': '# Plan\n' });
      const headBefore = git(['rev-parse', 'HEAD'], tmpDir).trim();
      const envelope = runCommit(tmpDir, 'docs(test): plan', ['.planning/phases/03-widgets/03-PLAN.md']);
      assert.strictEqual(envelope.committed, true);
      const headAfter = git(['rev-parse', 'HEAD'], tmpDir).trim();
      assert.notStrictEqual(headAfter, headBefore);
      const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD'], tmpDir)
        .split('\n').map((s) => s.trim()).filter(Boolean);
      assert.ok(
        committedFiles.includes('.planning/phases/03-widgets/03-PLAN.md'),
        `expected the per-phase-enabled file to land in the commit; got: ${committedFiles.join(', ')}`,
      );
    });
  });

  // ── E: parity — the divergence the design named ─────────────────────────
  // config-schema.manifest.json is hand-maintained JSON, so its
  // phase_commit_docs.<phase-id> pattern is necessarily a SECOND, hand-copied
  // statement of the canonical PHASE_NUMBER_TOKEN_SOURCE grammar
  // (src/phase-id.cts, #2128) — this repo's "Generative Fix Divergence" class
  // (CLAUDE.md). BEHAVIORAL over a shared shape list — not a source-grep of
  // the regex text — because the point is that the two surfaces agree on
  // INPUTS, not that they share characters.
  describe('E: manifest/canonical-grammar parity for phase_commit_docs.<phase-id>', () => {
    const manifestEntry = DYNAMIC_KEY_PATTERNS.find((p) => p.topLevel === 'phase_commit_docs');

    // No 'i' flag: PHASE_NUMBER_TOKEN_SOURCE's own default reading is
    // case-sensitive (uppercase-only `[A-Z]` letter suffix), and the
    // manifest's regex (recompiled via `new RegExp(p.source)` in
    // src/configuration.cts, no flags) is built from the same case-sensitive
    // source string. Parity must hold at that same case sensitivity, or a
    // divergence in flags would go undetected.
    const canonicalPhaseIdRe = new RegExp(`^${PHASE_NUMBER_TOKEN_SOURCE}$`);
    const canonicalAccepts = (shape) => canonicalPhaseIdRe.test(shape);
    const manifestAccepts = (shape) => manifestEntry.test(`phase_commit_docs.${shape}`);

    test('the dynamicKeyPatterns entry for phase_commit_docs exists', () => {
      assert.ok(manifestEntry, 'config-schema.manifest.json must carry a phase_commit_docs dynamicKeyPatterns entry');
    });

    const acceptedShapes = [
      '0', '1', '01', '003', '12A', '1.2', '12.34', '1.2.3', '999', '12A.3', '0.0.0',
    ];

    describe('E1: manifestPhasePatternMatchesCanonicalGrammar', () => {
      for (const shape of acceptedShapes) {
        test(`accepted shape "${shape}" is accepted by both surfaces`, () => {
          assert.strictEqual(canonicalAccepts(shape), true, `test fixture bug: canonical grammar must accept "${shape}"`);
          assert.strictEqual(manifestAccepts(shape), true, `manifest pattern rejected canonical-accepted shape "${shape}"`);
        });
      }
    });

    const rejectedShapes = [
      '', 'a', '1a', '01-a', '.1', '1.', '1..2', 'PROJ-01', '01 02', '1_2', '12AB', '1.a', '-1', '1-2', 'AB',
    ];

    describe('E2: manifestPhasePatternRejectsSameShapes', () => {
      for (const shape of rejectedShapes) {
        test(`rejected shape "${JSON.stringify(shape)}" is rejected by both surfaces`, () => {
          assert.strictEqual(canonicalAccepts(shape), false, `test fixture bug: canonical grammar must reject "${shape}"`);
          assert.strictEqual(manifestAccepts(shape), false, `manifest pattern accepted canonical-rejected shape "${shape}"`);
        });
      }
    });

    // Bonus robustness: over a bounded, seeded fuzz of arbitrary short
    // strings, the two surfaces must never disagree — catches a shape
    // neither hand-picked list happened to cover.
    test('property: manifest and canonical grammar agree on arbitrary short strings', () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 8 }),
          (shape) => {
            assert.strictEqual(
              manifestAccepts(shape),
              canonicalAccepts(shape),
              `disagreement on shape ${JSON.stringify(shape)}`,
            );
          },
        ),
      );
    });
  });

  // ── F: property — resolution is total, and source is honest ────────────
  describe('F: property', () => {
    const phaseArb = fc.constantFrom(null, '03', '3', '04', 'PROJ-03', '12A', '3.2');
    const overrideValueArb = fc.oneof(
      fc.boolean(),
      fc.constant('true'),
      fc.constant(1),
      fc.constant(null),
      fc.string({ maxLength: 5 }),
    );
    const overridesArb = fc.dictionary(
      fc.constantFrom('03', '3', '04', '12A', '3.2', 'not-a-phase'),
      overrideValueArb,
      { maxKeys: 4 },
    );
    const commitDocsArb = fc.boolean();
    const gitIgnoredArb = fc.boolean();

    test('F1: resolutionIsTotalAndSourceIsHonest — resolution is total (boolean + a valid source), and the reported source names the tier that actually decided', () => {
      fc.assert(
        fc.property(
          phaseArb, overridesArb, commitDocsArb, gitIgnoredArb,
          (phaseNum, overrides, commitDocs, gitIgnored) => {
            const config = { commit_docs: commitDocs, phase_commit_docs: overrides };
            const r = resolveCommitDocsPolicy(config, phaseNum, () => gitIgnored);

            // Totality: always a boolean resolution and a known source.
            assert.strictEqual(typeof r.resolved, 'boolean');
            assert.ok(['phase', 'config', 'gitignore', 'default'].includes(r.source));

            // Honesty: recompute independently what SHOULD have decided it, and
            // require the reported source to match.
            const override = resolvePhaseCommitDocsOverride(config, phaseNum);
            if (override !== undefined) {
              assert.strictEqual(r.source, 'phase');
              assert.strictEqual(r.resolved, override);
              return;
            }
            if (!commitDocs) {
              assert.strictEqual(r.source, 'config');
              assert.strictEqual(r.resolved, false);
              return;
            }
            if (gitIgnored) {
              assert.strictEqual(r.source, 'gitignore');
              assert.strictEqual(r.resolved, false);
              return;
            }
            assert.strictEqual(r.source, 'default');
            assert.strictEqual(r.resolved, true);
          },
        ),
      );
    });
  });
});
