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

  test('ship.md decides the verification gate on a single verification.status read', () => {
    // Pre-fix, ship.md captured verification.status ONCE and picked three fields
    // off the cached JSON with jq. --pick takes a single field, so a naive
    // conversion issues three queries up front — 3x the spawn cost on the common
    // passing path, and three reads that are not guaranteed to observe the same
    // state. The gate must read `status` once and decide; the two message-only
    // fields belong on the blocking path.
    const content = readWorkflow('ship.md');
    assert.ok(content, 'ship.md must exist');

    const statusIdx = content.indexOf('STATUS=$(gsd_run query verification.status');
    assert.notEqual(statusIdx, -1, 'ship.md must read verification.status --pick status');

    const picks = content.match(/gsd_run query verification\.status "\$\{PHASE_DIR\}" --pick (\w+)/g) || [];
    assert.deepEqual(
      picks.length,
      3,
      `ship.md should read status once plus the two message fields, found ${picks.length}`,
    );

    // The gate's own read must come first, and the message-only reads must both
    // sit after the blocking prose — i.e. they are not on the passing path.
    const blockIdx = content.indexOf('PHASE_VERIFICATION_INCOMPLETE');
    assert.ok(blockIdx > statusIdx, 'the block decision must follow the status read');
    for (const field of ['next_action', 'next_command']) {
      const idx = content.indexOf(`--pick ${field}`);
      assert.notEqual(idx, -1, `ship.md must still surface ${field}`);
      assert.ok(
        idx > blockIdx,
        `${field} must be read only on the blocking path, not before the gate decides`,
      );
    }
  });

  test('review.md still declares jq a prerequisite for the lanes that genuinely need it', () => {
    // Dropping the jq pipes from the CONFIG lookups must not drop the project's
    // jq-prerequisite declaration: the ollama / lm_studio / llama_cpp / opencode
    // / agy lanes parse HTTP + CLI JSON that gsd-tools does not emit, so they
    // still hard-require jq. Removing the declaration (as the first cut of this
    // fix did) leaves those lanes silently degrading on a jq-less host — the
    // exact defect class #2589 exists to close.
    const content = readWorkflow('review.md');
    assert.ok(content, 'review.md must exist');
    assert.match(
      content,
      /command -v jq >\/dev\/null 2>&1 && echo "jq:available" \|\| echo "jq:missing"/,
      'review.md detect_clis must probe jq alongside the other reviewer prerequisites',
    );
    for (const lane of ['ollama', 'lm_studio', 'llama_cpp', 'opencode', 'antigravity']) {
      assert.ok(
        new RegExp(`jq-dependent reviewer lanes[\\s\\S]*\\b${lane}\\b`).test(content),
        `review.md must name ${lane} as a jq-dependent lane`,
      );
    }
  });

  test('no workflow cites the jq prerequisite by a stale review.md line number', () => {
    // plan-review-convergence.md used to cite "review.md:244". That anchor moved
    // when the jq pipes were replaced, so cross-references must be by name.
    for (const name of fs.readdirSync(WF).filter((f) => f.endsWith('.md'))) {
      const content = readWorkflow(name);
      if (content == null) continue;
      const stale = content.match(/review\.md:\d+/g);
      assert.deepEqual(
        stale || [],
        [],
        `${name}: cite review.md by section name, not a line number (found ${JSON.stringify(stale)})`,
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
