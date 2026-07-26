'use strict';

/**
 * #2589 — config-get / resolve-model / verification.status lookups must not
 * depend on jq.
 *
 * The workflows resolved configured scalars / model ids / verify status with a
 * `gsd_run query <cmd> … | jq … 2>/dev/null || <default>` shape. On any machine
 * without jq (the default on Windows / Git-Bash) the jq stage fails with exit
 * 127, that failure is swallowed by `2>/dev/null` and the trailing `|| default`,
 * so the variable comes back EMPTY — the configured value is silently dropped
 * and the lane falls back to CLI defaults with no diagnostic.
 *
 * gsd-tools ships native flags that do the same job with no external dep:
 *   config-get <key> --raw          (strips JSON quotes off a scalar)
 *   resolve-model <id> --pick model (descends an object)
 *   verification.status <dir> --pick status
 *
 * This is a SOURCE-INVARIANT test over the shipped workflow documents: the bug
 * lives in the workflow text, so the regression guard asserts the jq-dependent
 * shapes never return. Workflow .md files are runtime-loaded config documents,
 * so reading them with readFileSync + regex is the sanctioned seam here (the
 * no-source-grep lint targets src/ + bin/lib/, not config/state docs).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WF = path.join(ROOT, 'gsd-core', 'workflows');

// The workflows that #2589 audited. Scoped explicitly so a new workflow
// introducing the same smell is caught by the general guard below, while these
// known-fixed files are checked for the exact offending shapes.
const AUDITED = [
  'review.md',
  'plan-phase.md',
  'ship.md',
  'debug.md',
  'autonomous.md',
  'ai-integration-phase.md',
  'eval-review.md',
];

function readWorkflow(name) {
  const p = path.join(WF, name);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}

describe('#2589: config/model/verify lookups do not depend on jq', () => {
  test('config-get lookups use --raw, not a jq pipe', () => {
    // Matches: config-get <key> ... | jq   (any key, any jq program).
    // The native --raw flag strips JSON quotes off a scalar with no jq.
    const re = /config-get\b[^|\n]*\|\s*jq\b/;
    for (const name of AUDITED) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const matches = content.match(new RegExp(re.source, 'g'));
      assert.deepEqual(
        matches || [],
        [],
        `${name}: config-get lookups must use --raw, not a jq pipe (found ${JSON.stringify(matches)})`,
      );
    }
  });

  test('resolve-model lookups use --pick, not a jq pipe', () => {
    // resolve-model returns an object; the native --pick <field> descends it.
    const re = /resolve-model\b[^|\n]*\|\s*jq\b/;
    for (const name of AUDITED) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const matches = content.match(new RegExp(re.source, 'g'));
      assert.deepEqual(
        matches || [],
        [],
        `${name}: resolve-model lookups must use --pick, not a jq pipe (found ${JSON.stringify(matches)})`,
      );
    }
  });

  test('verification.status lookups use --pick, not a jq pipe', () => {
    const re = /verification\.status\b[^|\n]*\|\s*jq\b/;
    for (const name of AUDITED) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const matches = content.match(new RegExp(re.source, 'g'));
      assert.deepEqual(
        matches || [],
        [],
        `${name}: verification.status lookups must use --pick, not a jq pipe (found ${JSON.stringify(matches)})`,
      );
    }
  });

  test('general guard: no audited workflow pipes any gsd_run query to jq', () => {
    // Belt-and-suspenders: the jq-replaceable query command families. This
    // catches a future regression on any of them (or a sibling like
    // resolve-execution, which also supports --pick) without enumerating keys.
    const re = /gsd_run\s+query\s+(config-get|resolve-model|resolve-execution|verification\.status\b)[^|\n]*\|\s*jq\b/;
    for (const name of AUDITED) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const matches = content.match(new RegExp(re.source, 'g'));
      assert.deepEqual(
        matches || [],
        [],
        `${name}: no gsd_run query (config-get|resolve-model|resolve-execution|verification.status) may pipe to jq (found ${JSON.stringify(matches)})`,
      );
    }
  });

  test('resolve-execution lookups use --pick, not a jq pipe (sibling of resolve-model)', () => {
    // resolve-execution returns an object (model/profile/effort/effort_argv_string);
    // the native --pick <field> descends it — same defect class as resolve-model.
    const re = /resolve-execution\b[^|\n]*\|\s*jq\b/;
    for (const name of AUDITED) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const matches = content.match(new RegExp(re.source, 'g'));
      assert.deepEqual(
        matches || [],
        [],
        `${name}: resolve-execution lookups must use --pick, not a jq pipe (found ${JSON.stringify(matches)})`,
      );
    }
  });
});
