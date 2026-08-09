// allow-test-rule: source-text-is-the-product (see #3149)
// gsd-core/workflows/debug.md is shipped prompt content: the text IS what the
// runtime loads, so its Step 0 contract can only be asserted against the text.
// The behavioral half of this change lives in tests/init-debug.test.cjs, which
// carries no exemption.

'use strict';

/**
 * `debug.md` Step 0 contract after the `init.debug` consolidation (#3149).
 *
 * Matrix: `.gsd/phase/feat-3149-cmdinitdebug/50-test-matrix.md` group F.
 *
 * Guards the four ways this consolidation can silently regress:
 *   F1/F2 — a replaced round-trip creeping back, or the new one being lost.
 *   F3    — reading `config.response_language` (the nested state.load shape)
 *           instead of the flat top-level field withProjectRoot injects. This
 *           is the #2402 defect class: the workflow silently stays English.
 *   F4    — losing the `@file:` unwrap, which large init payloads still need.
 *   F5    — dropping the `section_manifest: null` -> read-everything rule,
 *           without which a null manifest reads as "read nothing".
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

/** Every `gsd_run query <name>` invocation in the workflow, in document order. */
function queryInvocations(text) {
  return [...text.matchAll(/gsd_run query ([\w.-]+)/g)].map((m) => m[1]);
}

describe('debug.md Step 0 init contract (#3149, matrix §F)', () => {
  test('calls init.debug exactly once (row F1)', () => {
    const initDebugCalls = queryInvocations(workflow).filter((q) => q === 'init.debug');
    assert.equal(initDebugCalls.length, 1, 'exactly one init.debug round-trip');
  });

  test('no longer makes the three replaced calls (row F2)', () => {
    const queries = queryInvocations(workflow);

    assert.equal(queries.includes('state.load'), false, 'state.load is replaced by init.debug');
    assert.equal(
      workflow.includes('resolve-model gsd-debugger'),
      false,
      'debugger_model now rides the init bundle'
    );
    assert.equal(
      workflow.includes('config-get workflow.tdd_mode'),
      false,
      'tdd_mode now rides the init bundle'
    );
  });

  test('reads the flat response_language, not the nested state.load shape (row F3)', () => {
    assert.equal(
      workflow.includes('config.response_language'),
      false,
      'withProjectRoot injects response_language at the TOP level; reading config.response_language ' +
      'against an init bundle resolves undefined and silently drops translated output (#2402)'
    );
    assert.ok(
      workflow.includes('`response_language`'),
      'the field is still documented, just at its new location'
    );
  });

  test('still unwraps an @file: payload (row F4)', () => {
    assert.ok(
      workflow.includes('@file:'),
      'init payloads can spill to a file; dropping the unwrap leaves INIT holding a path, not JSON'
    );
  });

  test('documents the null-manifest read-everything fallback (row F5)', () => {
    assert.ok(workflow.includes('section_manifest'), 'the field is documented');
    assert.ok(
      /`null`[^\r\n]*read this workflow in full/i.test(workflow),
      'a null section_manifest must be documented as "read everything" — without the rule, ' +
      'a null manifest reads as an empty selection and the workflow reads nothing'
    );
  });
});
