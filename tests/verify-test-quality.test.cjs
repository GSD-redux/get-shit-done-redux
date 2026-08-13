// allow-test-rule: source-text-is-the-product
// Structural guard: reads gsd-core/references/verifier-phase-gates.md (the
// gsd-verifier agent's eagerly-imported gate reference, migrated from the
// retired workflows/verifier-phase-gates.md in #1892) and asserts that
// the audit_test_quality step contains the skip-pattern marker, circular-detection
// marker, provenance-classification contract, and assertion-strength table markers.
// Goes red if that guidance is removed or the step is renamed/deleted.

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'references',
  'verifier-phase-gates.md'
);

// Locate the audit_test_quality step boundaries so sub-assertions are scoped
// to that step only, not the full file.
const STEP_OPEN = '<step name="audit_test_quality">';
const STEP_CLOSE = '</step>';

function extractAuditStep(src) {
  const start = src.indexOf(STEP_OPEN);
  if (start === -1) return null;
  const end = src.indexOf(STEP_CLOSE, start + STEP_OPEN.length);
  if (end === -1) return null;
  return src.slice(start, end + STEP_CLOSE.length);
}

// workflowSrc and auditStepSrc are populated in the before() hook so that a
// missing or renamed verifier-phase-gates.md produces a descriptive test FAILURE rather
// than a module-load crash that prevents any test from registering.
let workflowSrc = null;
let auditStepSrc = null;

before(() => {
  assert.ok(
    fs.existsSync(WORKFLOW_PATH),
    `verifier-phase-gates.md not found at expected path: ${WORKFLOW_PATH} — ` +
      'the file may have been renamed or moved'
  );
  workflowSrc = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  auditStepSrc = extractAuditStep(workflowSrc);
});

describe('verifier-phase-gates.md audit_test_quality structural guard', () => {
  test('verifier-phase-gates.md exists at gsd-core/references/verifier-phase-gates.md', () => {
    assert.ok(
      fs.existsSync(WORKFLOW_PATH),
      `missing workflow file: ${WORKFLOW_PATH}`
    );
  });

  test('audit_test_quality step is present in verifier-phase-gates.md', () => {
    assert.ok(
      auditStepSrc !== null,
      `<step name="audit_test_quality"> not found in ${WORKFLOW_PATH} — the step ` +
        'may have been renamed or removed'
    );
  });

  describe('skip-pattern marker', () => {
    test('audit_test_quality step contains the disabled-test grep pattern', () => {
      // The step must instruct the verifier to search for skip patterns such as
      // it\.skip / describe\.skip / test\.skip (regex-escaped, as used in the bash grep).
      // Removing this guidance would mean skipped requirement tests are no longer flagged.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check skip-pattern marker: audit_test_quality step not found'
      );
      // The markdown shows a bash grep -E pattern, so dots are backslash-escaped:
      // 'it\\.skip' in JS is the string  it\.skip  (backslash + dot).
      const hasSkipPattern =
        auditStepSrc.includes('it\\.skip') &&
        auditStepSrc.includes('describe\\.skip') &&
        auditStepSrc.includes('test\\.skip');
      assert.ok(
        hasSkipPattern,
        'audit_test_quality step must reference it\\.skip, describe\\.skip, and test\\.skip ' +
          'as the disabled-test grep pattern — one or more are missing'
      );
    });

    test('audit_test_quality step references todo variants alongside skip variants', () => {
      // it\.todo / test\.todo are also considered disabled patterns by the step.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check todo marker: audit_test_quality step not found'
      );
      const hasTodo =
        auditStepSrc.includes('it\\.todo') || auditStepSrc.includes('test\\.todo');
      assert.ok(
        hasTodo,
        'audit_test_quality step must reference it\\.todo or test\\.todo as a disabled pattern'
      );
    });
  });

  describe('circular-detection marker', () => {
    test('audit_test_quality step contains writeFileSync in the circular file-write grep pattern', () => {
      // The step must tell the verifier to grep for writeFileSync in the circular
      // detection pattern. Removing writeFileSync from the pattern would miss the
      // most common Node.js synchronous file-write idiom.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check circular-detection marker: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('writeFileSync'),
        'audit_test_quality step must include writeFileSync in the circular-detection grep pattern'
      );
    });

    test('audit_test_quality step contains standalone writeFile (not just as part of writeFileSync) in the circular file-write grep pattern', () => {
      // The pattern must also catch the async fs.writeFile variant, not just the
      // synchronous writeFileSync.  A plain includes('writeFile') check is satisfied
      // by the 'writeFileSync' substring and would pass even if the standalone
      // 'writeFile' alternative were removed.  Use a word-boundary / non-Sync regex
      // to detect the standalone form specifically.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check writeFile marker: audit_test_quality step not found'
      );
      // Match 'writeFile' that is NOT followed by 'Sync' — i.e. the standalone form.
      const standaloneWriteFile = /writeFile(?!Sync)/.test(auditStepSrc);
      assert.ok(
        standaloneWriteFile,
        'audit_test_quality step must reference standalone writeFile (not just writeFileSync) ' +
          'in the circular-detection grep pattern — narrowing the pattern to writeFileSync only ' +
          'would be caught by this test'
      );
    });

    test('audit_test_quality step contains fs\\.write in the circular file-write grep pattern', () => {
      // The fs\.write pattern (dot backslash-escaped) covers lower-level write calls.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check fs\\.write marker: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('fs\\.write'),
        'audit_test_quality step must include fs\\.write in the circular-detection grep pattern'
      );
    });

    test('audit_test_quality step defines CIRCULAR as a blocker verdict', () => {
      // The step must explicitly name CIRCULAR as an outcome and mark it as a blocker.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check CIRCULAR verdict: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('CIRCULAR'),
        'audit_test_quality step must define CIRCULAR as a verdict for circular tests'
      );
    });
  });

  describe('provenance-classification contract', () => {
    // Finding #5: the redesign dropped all coverage of the provenance-classification
    // contract.  These tests assert that the audit_test_quality step still defines the
    // provenance keywords and classification tiers so that removing them goes RED.

    test('audit_test_quality step defines the VALID provenance classification', () => {
      assert.ok(
        auditStepSrc !== null,
        'Cannot check provenance classifications: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('VALID'),
        'audit_test_quality step must define VALID as a provenance classification'
      );
    });

    test('audit_test_quality step defines the UNKNOWN provenance classification', () => {
      assert.ok(
        auditStepSrc !== null,
        'Cannot check provenance classifications: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('UNKNOWN'),
        'audit_test_quality step must define UNKNOWN as a provenance classification'
      );
    });

    test('audit_test_quality step maps UNKNOWN to SUSPECT treatment', () => {
      // The contract requires "UNKNOWN: No provenance information — treat as SUSPECT"
      // so consumers know UNKNOWN is handled the same as SUSPECT.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check SUSPECT treatment: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('SUSPECT'),
        'audit_test_quality step must mention SUSPECT (UNKNOWN must map to treat as SUSPECT)'
      );
    });

    test('audit_test_quality step names "legacy" as a VALID provenance keyword', () => {
      // VALID is defined as "Expected value from external/legacy system output,
      // manual capture, or independent oracle".  The word "legacy" is load-bearing:
      // it clarifies that values captured from a superseded system are authoritative.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check "legacy" keyword: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('legacy'),
        'audit_test_quality step must name "legacy" as a VALID provenance source ' +
          '(e.g. "external/legacy system output")'
      );
    });

    test('audit_test_quality step names "manual" as a VALID provenance keyword', () => {
      // "manual capture" is the second example of a VALID provenance source and
      // distinguishes human-curated expected values from machine-generated ones.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check "manual" keyword: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('manual'),
        'audit_test_quality step must name "manual" as a VALID provenance source ' +
          '(e.g. "manual capture")'
      );
    });

    test('audit_test_quality step names "computed" as a SUSPECT provenance indicator', () => {
      // The circular indicator comments list "computed from engine" as an example
      // of a SUSPECT expected-value comment.  Removing it would mean verifiers no
      // longer know to flag tests whose fixtures declare computed provenance.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check "computed" indicator: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('computed'),
        'audit_test_quality step must name "computed" as a SUSPECT provenance indicator ' +
          '(e.g. "computed from engine" comment example)'
      );
    });

    test('audit_test_quality step names "baseline" as a SUSPECT provenance indicator', () => {
      // "captured from baseline" is the other canonical SUSPECT comment example.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check "baseline" indicator: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('baseline'),
        'audit_test_quality step must name "baseline" as a SUSPECT provenance indicator ' +
          '(e.g. "captured from baseline" comment example)'
      );
    });
  });

  describe('assertion-strength table markers', () => {
    test('audit_test_quality step contains the assertion-strength section header', () => {
      // The "5. Assertion strength" section heading anchors the classification table.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check assertion-strength header: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('Assertion strength'),
        'audit_test_quality step must contain the "Assertion strength" section header'
      );
    });

    test('audit_test_quality step lists existence-only examples in the assertion table', () => {
      // The table must include toBeDefined as an example of an existence-level assertion.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check assertion table: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('toBeDefined'),
        'audit_test_quality step must include toBeDefined as an existence-level assertion example'
      );
    });

    test('audit_test_quality step lists value-level examples in the assertion table', () => {
      // The table must include toBeCloseTo as an example of a value-level assertion.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check value assertion example: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('toBeCloseTo'),
        'audit_test_quality step must include toBeCloseTo as a value-level assertion example'
      );
    });

    test('audit_test_quality step defines INSUFFICIENT verdict for weak assertions', () => {
      // The step must explicitly name INSUFFICIENT as the verdict when assertion strength
      // is below what the requirement demands.
      assert.ok(
        auditStepSrc !== null,
        'Cannot check INSUFFICIENT verdict: audit_test_quality step not found'
      );
      assert.ok(
        auditStepSrc.includes('INSUFFICIENT'),
        'audit_test_quality step must define INSUFFICIENT as a verdict for weak assertions'
      );
    });
  });
});
