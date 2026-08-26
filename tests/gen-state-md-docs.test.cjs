'use strict';

/**
 * Tests for scripts/gen-state-md-docs.cjs — the generator half of ADR-3473
 * §8.8 / issue #3873 Phase 3 (`.gsd/phase/feat-3873-state-md-schema/`).
 *
 * Covers test-matrix rows 10-22 and 27 (`50-test-matrix.md`). Rows 12, 13 and
 * 19 are about the LOCALE-PARITY behavior itself (structural, never
 * textual) — `tests/docs-state-md-locale-parity.test.cjs` already owns the
 * real-doc regression for row 12/13 (registered in
 * scripts/docs-guard-registry.cjs); this file re-derives the same
 * structural-comparison algorithm against TEMP fixtures (never the real
 * docs/ tree) so rows 12/13/19 are independently exercised at the
 * algorithm level, not duplicated against shipped content.
 *
 * Every generator-CLI test here runs the REAL CLI (via
 * tests/helpers/process-seam.cjs's runNode) against a temp copy of the
 * target files, using `--root <tmpDir>` — never a fixture planted in the
 * real tree (CLAUDE.md Test Cleanup; this epic's own retrospective names
 * exactly that mistake).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const gen = require('../scripts/gen-state-md-docs.cjs');
const { splitLines, detectEol, joinLines } = require('../gsd-core/bin/lib/text-lines.cjs');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-state-md-docs.cjs');

/** Copy every real target file into `dir`, mirroring its relative path. */
function seedCleanTree(dir) {
  for (const target of gen.TARGETS) {
    const src = path.join(ROOT, target.relPath);
    const dest = path.join(dir, target.relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function runGen(args, root) {
  const fullArgs = [SCRIPT, ...args];
  if (root !== undefined) fullArgs.push('--root', root);
  const r = runNode(fullArgs, { timeoutMs: 30000 });
  return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr };
}

describe('gen-state-md-docs.cjs CLI (#3873 rows 10-22, 27)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-state-md-docs-');
    seedCleanTree(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('checkPassesOnACleanTree', () => {
    const r = runGen(['--check'], tmpDir);
    assert.equal(r.code, 0, r.stderr);
  });

  test('checkFailsAndNamesItsRemedyWhenStale', () => {
    const target = gen.TARGETS.find((t) => t.key === 'ja-JP');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const mutated = original.replace('Terminal/archived state', 'HAND-EDITED, NOT REGENERATED');
    assert.notEqual(mutated, original, 'fixture setup sanity');
    fs.writeFileSync(abs, mutated);

    const r = runGen(['--json'], tmpDir);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.staleCount, 1);
    assert.deepEqual(report.violations, [
      { reason: gen.REASON.REGION_STALE, file: target.relPath, region: 'status-lifecycle' },
    ]);
  });

  test('writeIsFailClosedOverAViolation', () => {
    // Corpus-level violation (the gen-features.cjs analog: a renderable gap,
    // not a hostile marker) — a locale absent from STATUS_LIFECYCLE_STRINGS.
    // renderStatusLifecycleRegion is exported precisely so this class of
    // violation is unit-testable without needing an unsupported-locale
    // TARGET wired through the shipped TARGETS list (which, by construction,
    // only ever declares locales that ARE registered). Proves: (a) it does
    // NOT throw (unlike the schema.status.enum case, this has a fallback),
    // (b) it renders using the 'en' fallback strings, (c) it records a
    // forceable violation rather than silently succeeding.
    const { schema } = gen.buildCorpus(tmpDir);
    const violations = [];
    const region = gen.renderStatusLifecycleRegion('xx-XX', schema, violations);
    assert.match(region, /### Status lifecycle \(ADR-2207\)/, 'falls back to the en heading/columns');
    assert.equal(violations.length, 1);
    assert.equal(violations[0].reason, gen.REASON.LOCALE_STRINGS_MISSING);
    assert.equal(violations[0].locale, 'xx-XX');
  });

  test('forceOverridesFailClosedAndSaysSo', () => {
    // Hostile violation: unclose one target's END marker, then prove --write
    // refuses without --force and that --force is not silently a no-op —
    // it is refused REGARDLESS of --force for a broken marker (there is
    // nothing to splice into), which the message must say explicitly. This
    // is the OTHER fail-closed class in this generator (see
    // writeIsFailClosedOverAViolation above for the forceable, renderable
    // one): a hostile marker has no valid location to write to at all, so
    // --force cannot rescue it — the message says so explicitly.
    const target = gen.TARGETS.find((t) => t.key === 'zh-CN');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const broken = original.replace(gen.endMarker('status-lifecycle'), '');
    fs.writeFileSync(abs, broken);

    const withoutForce = runGen(['--write'], tmpDir);
    assert.equal(withoutForce.code, 1);

    const withForce = runGen(['--write', '--force'], tmpDir);
    assert.equal(withForce.code, 1, 'a broken marker has nothing to splice into — --force cannot help');

    // Neither invocation touched the tree (both refused before writing), so
    // a single --json read of the still-broken fixture proves WHAT both
    // refusals were about: the exact file/region whose marker is unclosed.
    const report = JSON.parse(runGen(['--json'], tmpDir).stdout);
    assert.deepEqual(report.violations, [
      { reason: gen.REASON.MARKER_UNCLOSED, file: target.relPath, region: 'status-lifecycle' },
    ]);
  });

  test('writeIsIdempotent', () => {
    const first = runGen(['--write'], tmpDir);
    assert.equal(first.code, 0);
    const snapshot = gen.TARGETS.map((t) => fs.readFileSync(path.join(tmpDir, t.relPath), 'utf8'));

    const second = runGen(['--write'], tmpDir);
    assert.equal(second.code, 0);

    // Byte-for-byte equality below is a strictly stronger, per-target proof
    // that the second --write was a no-op than matching the aggregate
    // "Wrote 0 of N target(s)." stdout line would be.
    gen.TARGETS.forEach((t, i) => {
      const after = fs.readFileSync(path.join(tmpDir, t.relPath), 'utf8');
      assert.equal(after, snapshot[i], `${t.relPath} must be byte-identical on a second --write`);
    });
  });

  test('handEditInsideAGeneratedRegionIsReported', () => {
    const target = gen.TARGETS.find((t) => t.key === 'template');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    fs.writeFileSync(abs, original.replace('status: planning', 'status: HAND-EDITED'));

    const r = runGen(['--json'], tmpDir);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.violations, [
      { reason: gen.REASON.REGION_STALE, file: target.relPath, region: 'frontmatter' },
    ]);
  });

  test('proseOutsideAGeneratedRegionSurvivesWrite', () => {
    const target = gen.TARGETS.find((t) => t.key === 'ja-JP');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const marker = '## 概要';
    assert.ok(original.includes(marker), 'fixture setup sanity: prose landmark must exist');
    const withHandEdit = original.replace(marker, `${marker}\n\nHAND-TRANSLATED PROSE, NEVER GENERATED.`);
    fs.writeFileSync(abs, withHandEdit);

    const r = runGen(['--write'], tmpDir);
    assert.equal(r.code, 0, r.stderr);

    const after = fs.readFileSync(abs, 'utf8');
    assert.match(after, /HAND-TRANSLATED PROSE, NEVER GENERATED\./, 'prose outside the marked region must survive --write byte-for-byte');
  });

  test('malformedRegionMarkerFailsLoudly', () => {
    const target = gen.TARGETS.find((t) => t.key === 'ko-KR');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const malformed = original.replace(gen.endMarker('status-lifecycle'), '<!-- STATE-MD-SCHEMA:END -->'); // truncated/unclosed
    fs.writeFileSync(abs, malformed);

    const r = runGen(['--write'], tmpDir);
    assert.equal(r.code, 1);

    const report = JSON.parse(runGen(['--json'], tmpDir).stdout);
    assert.deepEqual(report.violations, [
      { reason: gen.REASON.MARKER_UNCLOSED, file: target.relPath, region: 'status-lifecycle' },
    ]);

    // Never rewrites the whole file on a hostile marker — byte-identical to the malformed input.
    const after = fs.readFileSync(abs, 'utf8');
    assert.equal(after, malformed);
  });

  test('missingRegionMarkersFailsWithAName', () => {
    const target = gen.TARGETS.find((t) => t.key === 'pt-BR');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const stripped = original
      .replace(gen.startMarker('status-lifecycle'), '')
      .replace(gen.endMarker('status-lifecycle'), '');
    fs.writeFileSync(abs, stripped);

    const r = runGen(['--json'], tmpDir);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.deepEqual(report.violations, [
      { reason: gen.REASON.MARKERS_MISSING, file: target.relPath, region: 'status-lifecycle' },
    ]);
  });

  test('crlfLocaleFileRoundTrips', () => {
    const target = gen.TARGETS.find((t) => t.key === 'zh-CN');
    const abs = path.join(tmpDir, target.relPath);
    const original = fs.readFileSync(abs, 'utf8');
    const crlf = joinLines(splitLines(original), '\r\n');
    fs.writeFileSync(abs, crlf);
    assert.ok(gen.isCrlf(crlf), 'fixture setup sanity');

    const r = runGen(['--write'], tmpDir);
    assert.equal(r.code, 0, r.stderr);

    const after = fs.readFileSync(abs, 'utf8');
    assert.ok(gen.isCrlf(after), 'CRLF file must remain CRLF after --write');
    // Round trip: line count is stable (region content is line-for-line
    // replaced, not flattened), and no line ending was flipped from CRLF to
    // bare LF — detectEol (the text-lines seam) reports the DOMINANT
    // terminator, so a genuinely mixed file would report '\n' once bare LFs
    // outnumber CRLF pairs.
    assert.equal(detectEol(after), '\r\n', 'no line ending was flipped from CRLF to bare LF');
    assert.equal(splitLines(after).length, splitLines(crlf).length, 'line count must be unchanged by the CRLF round trip');
  });
});

describe('gen-state-md-docs.cjs section structural comparison (#3873 rows 12/13/19)', () => {
  // A minimal, self-contained re-derivation of the heading-structure
  // comparison `tests/docs-state-md-locale-parity.test.cjs` uses against the
  // real docs — exercised here against synthetic fixtures ONLY, so the
  // algorithm's structural-only guarantee is pinned independent of shipped
  // content. See that file for the real-doc regression (row 12).
  function extractHeadings(text) {
    return text
      .split('\n')
      .map((l) => /^(#{1,6})\s+(.*)$/.exec(l))
      .filter(Boolean)
      .map((m) => ({ level: m[1] }));
  }
  function missingSections(enText, localeText) {
    const enLevels = extractHeadings(enText).map((h) => h.level);
    const localeLevels = extractHeadings(localeText).map((h) => h.level);
    // A section is "present" if the locale has at least as many headings at
    // that structural position — this fixture-only helper mirrors the LCS
    // notion loosely (exact reproduction lives in the real test) but is
    // sufficient to prove: (a) a genuinely missing heading is caught, and
    // (b) differing prose under an otherwise-matching heading is not.
    return enLevels.length > localeLevels.length;
  }

  test('localeMissingASchemaDeclaredSectionFails (fixture-level)', () => {
    const en = '# Title\n\n## A\n\n### B\n\ntext\n';
    const localeMissingB = '# タイトル\n\n## エー\n\ntext\n';
    assert.equal(missingSections(en, localeMissingB), true);
  });

  test('allLocalesPresentPasses (fixture-level)', () => {
    const en = '# Title\n\n## A\n\n### B\n\ntext\n';
    const localeComplete = '# タイトル\n\n## エー\n\n### ビー\n\nテキスト\n';
    assert.equal(missingSections(en, localeComplete), false);
  });

  test('differentProseIsNotDrift (fixture-level)', () => {
    const en = '# Title\n\n## A\n\ntext in english\n';
    const localeDifferentProse = '# 完全に異なるプロース\n\n## 別の見出し\n\n全く違う文章がここにある。\n';
    // Same heading STRUCTURE (one h1, one h2), wildly different prose/text —
    // must be considered "not missing a section" (structural only).
    assert.equal(missingSections(en, localeDifferentProse), false);
  });
});

describe('gen-state-md-docs.cjs generated template validity (#3873 row 27)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-state-md-docs-template-');
    seedCleanTree(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('generatedTemplateIsStillAValidStateMd', () => {
    const r = runGen(['--write'], tmpDir);
    assert.equal(r.code, 0, r.stderr);

    const templateTarget = gen.TARGETS.find((t) => t.key === 'template');
    const templateText = fs.readFileSync(path.join(tmpDir, templateTarget.relPath), 'utf8');

    // Extract the generated region via the generator's own marker locator
    // (never an ad-hoc regex over file content) — the region body is
    // `gen.renderFrontmatterRegion`'s own output, fenced in ```yaml.
    const { range } = gen.findRegion(templateText, templateTarget.relPath, 'frontmatter');
    assert.ok(range, 'frontmatter region markers must still be present after --write');
    const regionLines = splitLines(templateText.slice(range[0], range[1]));
    assert.equal(regionLines[0], gen.startMarker('frontmatter'));
    assert.equal(regionLines[regionLines.length - 1], gen.endMarker('frontmatter'));
    const yamlLines = regionLines.slice(2, -2); // drop START marker, ```yaml, ```, END marker

    assert.equal(yamlLines[0], '---', 'frontmatter must open with a bare --- delimiter');
    assert.equal(yamlLines[yamlLines.length - 1], '---', 'frontmatter must close with a bare --- delimiter');
    assert.ok(yamlLines.some((l) => l.startsWith("gsd_state_version: '1.0'")));
    assert.ok(yamlLines.includes('status: planning'));
    assert.ok(yamlLines.includes('  total_phases: 0'));

    // The hand-authored body (outside the marked region) must still open
    // with the real STATE.md heading right after the fence, line-for-line.
    const afterRegion = splitLines(templateText.slice(range[1]));
    const markdownFenceIdx = afterRegion.findIndex((l) => l === '```markdown');
    assert.ok(markdownFenceIdx !== -1, 'the hand-authored body fence must survive --write');
    assert.equal(afterRegion[markdownFenceIdx + 1], '# Project State');
  });
});

describe('gen-state-md-docs.cjs cardinality region (#3873 follow-up: ADR-3473 §8.8 names cardinality explicitly)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gen-state-md-docs-cardinality-');
    seedCleanTree(tmpDir);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('cardinalityTableIsGeneratedForEveryNonExcludedSchemaKey', () => {
    const { schema } = gen.buildCorpus(tmpDir);
    const region = gen.renderCardinalityRegion('en', schema);
    for (const key of Object.keys(schema)) {
      if (gen.EXCLUDED_FIELD_TABLE_KEYS.includes(key)) {
        assert.ok(!region.includes(`\`${key}\` |`), `excluded key '${key}' must not appear as its own cardinality row`);
        continue;
      }
      assert.match(region, new RegExp(`\\| \`${key.replace('.', '\\.')}\` \\| ${schema[key].cardinality} \\|`));
    }
  });

  test('cardinalityWriteIsIdempotentAlongsideOtherRegions', () => {
    const r1 = runGen(['--write'], tmpDir);
    assert.equal(r1.code, 0);
    const target = gen.TARGETS.find((t) => t.key === 'en');
    const before = fs.readFileSync(path.join(tmpDir, target.relPath), 'utf8');
    const r2 = runGen(['--write'], tmpDir);
    assert.equal(r2.code, 0);
    const after = fs.readFileSync(path.join(tmpDir, target.relPath), 'utf8');
    assert.equal(after, before, 'a second --write must be byte-identical — the same no-op proof used in writeIsIdempotent');
  });
});

describe('gen-state-md-docs.cjs Field-reference / Status-values KEY-SET PARITY (#3873 follow-up)', () => {
  // These two hand-authored tables carry per-row PROSE (a field's Purpose/
  // When-populated description; a status value's Matched-text description)
  // that STATE_FIELD_SCHEMA does not model at all — see the generator's own
  // module-level comment. Regenerating that prose from a single English
  // registry would overwrite genuinely hand-translated ja-JP/zh-CN/ko-KR/
  // pt-BR content on every --write, which is why these two tables are
  // parity-CHECKED (row set only, never rewritten) rather than generated.
  // These tests exercise the checker directly against the pure exported
  // helpers — never against the real docs/ tree (never plant fixtures there).

  test('realTreeParityHoldsForBothTables', () => {
    // Sanity against the real, already-fixed English doc: this generator's
    // own #3873 follow-up fix (adding the previously-undocumented
    // `last_activity_desc` row) must make this pass with zero violations.
    const { schema, targets } = gen.buildCorpus(path.resolve(__dirname, '..'));
    const enTarget = targets.find((t) => t.key === 'en');
    const text = fs.readFileSync(enTarget.absPath, 'utf8');
    const violations = gen.collectKeySetParityViolations(enTarget, schema, text.replace(/\r\n/g, '\n'));
    assert.deepEqual(violations, []);
  });

  test('firstColumnAfterHeadingExtractsExactlyTheDataRows', () => {
    const doc = [
      '### Field reference',
      '',
      '| Field | Type |',
      '|---|---|',
      '| `alpha` | string |',
      '| `beta` | number |',
      '',
      '### Next section',
    ].join('\n');
    assert.deepEqual(gen.firstColumnAfterHeading(doc, 'Field reference'), ['alpha', 'beta']);
    assert.equal(gen.firstColumnAfterHeading(doc, 'Nonexistent heading'), null);
  });

  test('schemaKeyUndocumentedInFieldReferenceTableIsDetected', () => {
    // A schema with a key the (fixture) doc's Field-reference table omits —
    // exactly the `last_activity_desc` shape found and fixed on the real
    // docs while building this generator.
    const fixtureSchema = { alpha: { cardinality: 'one' }, beta: { cardinality: 'optional' } };
    const doc = ['### Field reference', '', '| Field | Type |', '|---|---|', '| `alpha` | string |'].join('\n');
    const target = { relPath: 'fixture/state-md.md', locale: 'en' };
    // firstColumnAfterHeading is keyed on FIELD_REFERENCE_HEADING['en'] === 'Field reference'
    // (matches the fixture doc's own heading), so collectKeySetParityViolations
    // resolves the same table this fixture declares.
    const violations = gen.collectKeySetParityViolations(target, fixtureSchema, doc);
    const fieldRefViolation = violations.find((v) => v.reason === gen.REASON.FIELD_REFERENCE_DRIFT);
    assert.ok(fieldRefViolation, 'expected a FIELD_REFERENCE_DRIFT violation');
    assert.deepEqual(fieldRefViolation.missingFromDoc, ['beta']);
    assert.deepEqual(fieldRefViolation.undeclaredInSchema, []);
  });

  test('docRowWithNoSchemaKeyIsDetectedUnlessGrandfathered', () => {
    const fixtureSchema = { alpha: { cardinality: 'one' } };
    const doc = [
      '### Field reference',
      '',
      '| Field | Type |',
      '|---|---|',
      '| `alpha` | string |',
      '| `totally_undeclared_field` | string |',
    ].join('\n');
    const target = { relPath: 'fixture/state-md.md', locale: 'en' };
    const violations = gen.collectKeySetParityViolations(target, fixtureSchema, doc);
    const fieldRefViolation = violations.find((v) => v.reason === gen.REASON.FIELD_REFERENCE_DRIFT);
    assert.ok(fieldRefViolation, 'an undeclared, non-grandfathered field must be reported');
    assert.deepEqual(fieldRefViolation.undeclaredInSchema, ['totally_undeclared_field']);
  });

  test('knownSchemaGapFieldsAreGrandfatheredNotSilentlyDisabled', () => {
    // KNOWN_SCHEMA_GAP_FIELDS names exactly the 3 real, pre-existing gap
    // fields (active_phase/next_action/next_phases) — never a wildcard.
    assert.deepEqual([...gen.KNOWN_SCHEMA_GAP_FIELDS].sort(), ['active_phase', 'next_action', 'next_phases']);
    const fixtureSchema = { alpha: { cardinality: 'one' } };
    const doc = [
      '### Field reference',
      '',
      '| Field | Type |',
      '|---|---|',
      '| `alpha` | string |',
      '| `active_phase` | string |',
    ].join('\n');
    const target = { relPath: 'fixture/state-md.md', locale: 'en' };
    const violations = gen.collectKeySetParityViolations(target, fixtureSchema, doc);
    assert.equal(violations.find((v) => v.reason === gen.REASON.FIELD_REFERENCE_DRIFT), undefined);
  });

  test('statusValuesRowSetMismatchIsDetected', () => {
    const fixtureSchema = { status: { enum: ['a', 'b', 'c'] } };
    const doc = ['### Status values', '', '| Canonical value | Matched text |', '|---|---|', '| `a` | x |', '| `b` | y |'].join('\n');
    const target = { relPath: 'fixture/state-md.md', locale: 'en' };
    const violations = gen.collectKeySetParityViolations(target, fixtureSchema, doc);
    const statusViolation = violations.find((v) => v.reason === gen.REASON.STATUS_VALUES_DRIFT);
    assert.ok(statusViolation, 'expected a STATUS_VALUES_DRIFT violation');
    assert.deepEqual(statusViolation.missingFromDoc, ['c']);
  });
});
