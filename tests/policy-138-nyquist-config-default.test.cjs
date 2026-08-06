// allow-test-rule: source-text-is-the-product — asserts GSD workflow/template markdown prose, the executable contract (#138, #2117)
'use strict';

// Policy regression test for issue #138:
// Nyquist activation must be absent-safe. ADR-857 phase 6 moved that defaulting
// into `loop render-hooks verify:post`, so workflows must consume the capability
// hook instead of calling config-get directly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function readWorkflow(name) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8');
}

function assertNyquistCapabilityGate(name) {
  const content = readWorkflow(name);
  assert.ok(
    content.includes('loop render-hooks verify:post'),
    `${name} must resolve Nyquist activation through verify:post capability hooks`
  );
  assert.ok(
    content.includes('ref.skill == "validate-phase"'),
    `${name} must identify the validate-phase capability hook`
  );
  assert.ok(
    !content.includes('config-get workflow.nyquist_validation'),
    `${name} must not read workflow.nyquist_validation directly after capability cutover`
  );
}

function findNyquistConfigLine(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('config-get workflow.nyquist_validation')) {
      return { lineNumber: i + 1, line: lines[i] };
    }
  }
  return null;
}

test('validate-phase.md: Nyquist activation uses verify:post capability hook', () => {
  assertNyquistCapabilityGate('validate-phase.md');
});

test('audit-milestone.md: Nyquist activation uses verify:post capability hook', () => {
  assertNyquistCapabilityGate('audit-milestone.md');
});

test('legacy Nyquist config helper still detects unsafe direct reads', () => {
  const tmp = path.join(os.tmpdir(), `policy-138-synthetic-${process.pid}.md`);
  try {
    fs.writeFileSync(tmp, 'NYQUIST_CFG=$(gsd_run query config-get workflow.nyquist_validation --raw)\n');
    const result = findNyquistConfigLine(tmp);
    assert.ok(result, 'synthetic direct config read should be detected');
    assert.ok(!result.line.includes('--default'), 'synthetic unsafe read intentionally lacks --default');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup for synthetic file.
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Issue #2117: audit-milestone could not distinguish a not-yet-validated phase
// from a validated-but-failing one — both read Nyquist PARTIAL. The fix makes the
// dead `status` field live (validate-phase §6 promotes draft → validated) and has
// audit-milestone §5.5 bucket `status: draft` as a distinct NOT-VALIDATED state.
// These assertions fail-first if either half of that two-workflow contract is
// reverted, silently re-collapsing "not validated" and "validation failed".
// ─────────────────────────────────────────────────────────────────────────────

test('#2117 validate-phase.md promotes status: draft → validated when it reconciles VALIDATION.md', () => {
  const content = readWorkflow('validate-phase.md');
  // Both the create (State B) and update (State A) paths in §6 must set the
  // terminal marker, otherwise `status` stays `draft` for the life of the file
  // and audit-milestone cannot tell an unvalidated phase from a failing one.
  const occurrences = content.match(/status: validated/g) || [];
  assert.ok(
    occurrences.length >= 2,
    'validate-phase.md must set `status: validated` in both the create (State B) and update (State A) VALIDATION.md paths',
  );
});

test('#2117 audit-milestone.md buckets status: draft as NOT-VALIDATED, never PARTIAL', () => {
  const content = readWorkflow('audit-milestone.md');
  assert.ok(
    content.includes('`status`'),
    'audit-milestone.md must parse the `status` frontmatter field to detect not-yet-validated phases',
  );
  assert.ok(
    content.includes('| NOT-VALIDATED | `status: draft`'),
    'audit-milestone.md must define a NOT-VALIDATED bucket keyed on `status: draft`',
  );
  assert.ok(
    content.includes('| COMPLIANT | `status: validated`'),
    'COMPLIANT must require `status: validated` so a draft file can never be scored compliant',
  );
  assert.ok(
    content.includes('| PARTIAL | `status: validated`'),
    'PARTIAL must require `status: validated`; a `status: draft` file is NOT-VALIDATED, not PARTIAL',
  );
  assert.ok(
    content.includes('not_validated_phases'),
    'audit-milestone.md must report not_validated_phases in the nyquist audit YAML aggregate',
  );
});

test('#2117 VALIDATION.md template seeds status: draft (the pre-validation state)', () => {
  const template = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'templates', 'VALIDATION.md'),
    'utf8',
  );
  assert.ok(
    /^status: draft$/m.test(template),
    'VALIDATION.md template must seed `status: draft`; validate-phase promotes it to validated',
  );
});
