// allow-test-rule: source-text-is-the-product #2337
//
// The add-todo.md workflow IS the runtime contract an agent follows when
// capturing a todo. #2337: it had no severity step and no severity frontmatter
// field, so severity discipline depended on an out-of-band convention the agent
// had to remember — and production todos landed with no `severity:` at all.
//
// These assertions guard the specific must-haves (issue #2337 acceptance
// criteria 1): a confirm-based `infer_severity` step positioned BEFORE the todo
// is written, and a `severity` field in the create_file frontmatter template.
// The golden-install-parity hash catches ANY change to this file, but not
// WHICH change — this test pins the two structural guarantees so a future edit
// can't silently drop the step while still updating the golden.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADD_TODO = path.join(__dirname, '..', 'gsd-core', 'workflows', 'add-todo.md');

describe('add-todo.md severity capture (#2337)', () => {
  const md = fs.readFileSync(ADD_TODO, 'utf8');

  test('defines an infer_severity step', () => {
    assert.match(md, /<step name="infer_severity">/,
      'add-todo.md must define an infer_severity step');
  });

  test('infer_severity runs before the file is written (create_file)', () => {
    const sev = md.indexOf('<step name="infer_severity">');
    const create = md.indexOf('<step name="create_file">');
    assert.ok(sev !== -1 && create !== -1, 'both steps must exist');
    assert.ok(sev < create,
      'infer_severity must precede create_file so severity is confirmed before write');
  });

  test('infer_severity confirms with the user — never a silent auto-assignment', () => {
    const stepStart = md.indexOf('<step name="infer_severity">');
    const stepEnd = md.indexOf('</step>', stepStart);
    const step = md.slice(stepStart, stepEnd);
    assert.match(step, /AskUserQuestion/,
      'severity must be confirmed via AskUserQuestion (with the TEXT_MODE fallback), not auto-assigned');
    assert.match(step, /TEXT_MODE/,
      'must provide the non-Claude-runtime numbered-list fallback');
  });

  test('the create_file frontmatter template carries a severity field', () => {
    assert.match(md, /^severity:\s*\[blocker\|major\|minor\|cosmetic/m,
      'create_file frontmatter template must include a severity field');
  });

  test('severity taxonomy matches verify-work.md (blocker/major/minor/cosmetic)', () => {
    const stepStart = md.indexOf('<step name="infer_severity">');
    const stepEnd = md.indexOf('</step>', stepStart);
    const step = md.slice(stepStart, stepEnd);
    for (const level of ['blocker', 'major', 'minor', 'cosmetic']) {
      assert.match(step, new RegExp(level),
        `severity taxonomy must include "${level}" to stay aligned with verify-work.md's severity_inference`);
    }
  });
});
