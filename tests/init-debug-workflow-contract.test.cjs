// allow-test-rule: source-text-is-the-product (see #3149)
// gsd-core/workflows/debug.md is shipped prompt content: the text IS what the
// runtime loads, so its static Step 0 contract must be asserted against the
// text. This file also executes that shipped fence; init-debug.test.cjs covers
// the underlying CLI projection without an exemption.

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
const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, TEST_ENV_BASE } = require('./helpers.cjs');
const { runHook, OUTCOME } = require('./helpers/process-seam.cjs');
const {
  convertClaudeToCodexMarkdown,
} = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', 'gsd-core', 'workflows', 'debug.md');
const ROOT = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

/** Every `gsd_run query <name>` invocation in the workflow, in document order. */
function queryInvocations(text) {
  return [...text.matchAll(/gsd_run query ([\w.-]+)/g)].map((m) => m[1]);
}

function stepZeroBash() {
  const heading = workflow.indexOf('## 0. Initialize Context');
  assert.notEqual(heading, -1, 'debug workflow must ship Step 0');
  const fence = workflow.indexOf('```bash\n', heading);
  assert.notEqual(fence, -1, 'Step 0 must ship an executable bash fence');
  const bodyStart = fence + '```bash\n'.length;
  const bodyEnd = workflow.indexOf('\n```', bodyStart);
  assert.notEqual(bodyEnd, -1, 'Step 0 bash fence must be closed');
  return workflow.slice(bodyStart, bodyEnd);
}

function tokenizeDebugArguments(value) {
  return value.split(/[ \t\r\n\f\v]+/).filter((token) => token.length > 0);
}

function quoteBashArrayElement(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function materializeDebugArgv(step, argumentsValue) {
  const readyAssignments = step.match(/^DEBUG_ARGV_READY=false$/gm) || [];
  const arrayAssignments = step.match(/^DEBUG_ARGV=\(\)$/gm) || [];
  assert.equal(readyAssignments.length, 1, 'Step 0 must ship one fail-loud readiness assignment');
  assert.equal(arrayAssignments.length, 1, 'Step 0 must ship one empty argv assignment');

  const elements = tokenizeDebugArguments(argumentsValue).map(quoteBashArrayElement);
  return step
    .replace(/^DEBUG_ARGV_READY=false$/m, 'DEBUG_ARGV_READY=true')
    .replace(/^DEBUG_ARGV=\(\)$/m, `DEBUG_ARGV=(${elements.join(' ')})`);
}

function executeStepZero(step, cwd) {
  const script = `${step}\nprintf '%s' "$INIT"\n`;
  const result = runHook('-c', [script], {
    interpreter: 'bash',
    cwd,
    env: {
      ...process.env,
      ...TEST_ENV_BASE,
      RUNTIME_DIR: ROOT,
      CLAUDE_ENV_FILE: '',
    },
    timeoutMs: 30_000,
  });
  return {
    ...result,
    init: result.outcome === OUTCOME.EXITED && result.exitCode === 0 && result.stdout.length > 0
      ? JSON.parse(result.stdout)
      : null,
  };
}

function runStepZero(argumentsValue, cwd, { codex = false } = {}) {
  const sourceStep = stepZeroBash();
  const runtimeStep = codex ? convertClaudeToCodexMarkdown(sourceStep) : sourceStep;
  return executeStepZero(materializeDebugArgv(runtimeStep, argumentsValue), cwd);
}

function writeSession(projectDir, slug, policy) {
  const debugDir = path.join(projectDir, '.planning', 'debug');
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(path.join(debugDir, `${slug}.md`), [
    '---',
    'status: investigating',
    '---',
    '',
    '## Runtime Evidence',
    '',
    'schema_version: 1',
    `policy: ${policy}`,
    'state: not_used',
    '',
  ].join('\n'));
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
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored workflow markdown, bounded prose, not adversarial input
      /`null`[^\r\n]*read this workflow in full/i.test(workflow),
      'a null section_manifest must be documented as "read everything" — without the rule, ' +
      'a null manifest reads as an empty selection and the workflow reads nothing'
    );
  });

  test('the executable fence contains no raw host placeholder before or after runtime conversion', () => {
    const source = stepZeroBash();
    const converted = convertClaudeToCodexMarkdown(stepZeroBash());
    for (const step of [source, converted]) {
      assert.equal(step.includes('$ARGUMENTS'), false);
      assert.equal(step.includes('{{GSD_ARGS}}'), false);
    }
  });

  test('untouched Step 0 fails loud before invoking init.debug in source and converted forms', () => {
    const projectDir = createTempProject('debug-workflow-unmaterialized-');
    try {
      for (const step of [stepZeroBash(), convertClaudeToCodexMarkdown(stepZeroBash())]) {
        const result = executeStepZero(step, projectDir);
        assert.equal(result.outcome, OUTCOME.EXITED);
        assert.notEqual(result.exitCode, 0);
        assert.equal(result.init, null);
      }
    } finally {
      cleanup(projectDir);
    }
  });

  test('Step 0 forwards the real invocation to init.debug and reuses saved policy', () => {
    const projectDir = createTempProject('debug-workflow-handoff-');
    try {
      writeSession(projectDir, 'saved-off', 'off');
      writeSession(projectDir, 'saved-adaptive', 'adaptive');

      const forced = runStepZero('--runtime-probes continue saved-off', projectDir);
      assert.equal(forced.outcome, OUTCOME.EXITED);
      assert.equal(forced.exitCode, 0);
      assert.equal(forced.init.subcommand, 'continue');
      assert.equal(forced.init.slug, 'saved-off');
      assert.equal(forced.init.runtime_evidence_override, 'adaptive');
      assert.equal(forced.init.runtime_evidence_policy, 'adaptive');

      const retained = runStepZero('continue saved-adaptive', projectDir);
      assert.equal(retained.outcome, OUTCOME.EXITED);
      assert.equal(retained.exitCode, 0);
      assert.equal(retained.init.subcommand, 'continue');
      assert.equal(retained.init.slug, 'saved-adaptive');
      assert.equal(retained.init.runtime_evidence_override, null);
      assert.equal(retained.init.runtime_evidence_policy, 'adaptive');

      const diagnosis = runStepZero('--no-runtime-probes investigate cache miss --diagnose', projectDir);
      assert.equal(diagnosis.outcome, OUTCOME.EXITED);
      assert.equal(diagnosis.exitCode, 0);
      assert.equal(diagnosis.init.subcommand, 'debug');
      assert.equal(diagnosis.init.description, 'investigate cache miss');
      assert.equal(diagnosis.init.diagnose, true);
      assert.equal(diagnosis.init.runtime_evidence_override, 'off');

      const lookalike = runStepZero('--runtime-probes=true investigate cache', projectDir);
      assert.equal(lookalike.outcome, OUTCOME.EXITED);
      assert.equal(lookalike.exitCode, 0);
      assert.equal(lookalike.init.description, '--runtime-probes=true investigate cache');
      assert.equal(lookalike.init.runtime_evidence_policy, 'off');

      const multiline = runStepZero('investigate\ncache', projectDir);
      assert.equal(multiline.outcome, OUTCOME.EXITED);
      assert.equal(multiline.exitCode, 0);
      assert.equal(multiline.init.description, 'investigate cache');
    } finally {
      cleanup(projectDir);
    }
  });

  test('fc: materialized argv stays inert and byte-preserving in source and Codex forms', { timeout: 60_000 }, () => {
    const projectDir = createTempProject('debug-workflow-hostile-');
    const canary = path.join(projectDir, 'shell-handoff-canary');
    const hostileToken = fc.constantFrom(
      `$(touch\${IFS}${canary})`,
      `\`touch\${IFS}${canary}\``,
      `"$(touch\${IFS}${canary})"`,
      `';touch\${IFS}${canary};#`,
      '$HOME',
      '${PATH}',
      'semi;colon',
      'back\\slash',
      '"double-quote"',
      "'single-quote'",
      '--runtime-probes=true',
    );

    try {
      fc.assert(
        fc.property(
          fc.array(hostileToken, { minLength: 1, maxLength: 4 }),
          (hostileTokens) => {
            const invocation = ['investigate', ...hostileTokens].join(' ');
            for (const codex of [false, true]) {
              const result = runStepZero(invocation, projectDir, { codex });
              assert.equal(result.outcome, OUTCOME.EXITED);
              assert.equal(result.exitCode, 0);
              assert.equal(result.init.description, invocation);
              assert.equal(fs.existsSync(canary), false, 'argv data must never execute');
            }
          },
        ),
        { seed: 3128, numRuns: 30 },
      );
    } finally {
      cleanup(projectDir);
    }
  });

  test('Step 0 fails closed for invalid flag and subcommand combinations', () => {
    const projectDir = createTempProject('debug-workflow-reject-');
    try {
      for (const invocation of [
        '--runtime-probes --no-runtime-probes investigate cache',
        '--diagnose --runtime-probes investigate cache',
        'list --runtime-probes',
        'status cache-miss --no-runtime-probes',
        '--diagnose continue cache-miss',
      ]) {
        const result = runStepZero(invocation, projectDir);
        assert.equal(result.outcome, OUTCOME.EXITED, `must exit normally: ${invocation}`);
        assert.notEqual(result.exitCode, 0, `must reject: ${invocation}`);
        assert.equal(result.init, null, `invalid invocation must not produce init JSON: ${invocation}`);
      }
    } finally {
      cleanup(projectDir);
    }
  });
});
