'use strict';

/**
 * require-full-tmpdir-triad
 *
 * Flag a `TMPDIR` environment override — direct `process.env.TMPDIR = …`
 * assignment, or a `TMPDIR` property inside a child-process `env:` object
 * literal — that is not accompanied by `TEMP` and `TMP` in the same scope.
 *
 * ## Why (DEFECT.WINDOWS-TEST-PORTABILITY — the #4220 masked child-env bug)
 *
 * Per Node's own `os.tmpdir()` docs: on Windows, only the `TEMP` and `TMP`
 * environment variables are consulted (`TEMP` first) — `TMPDIR` is never
 * read there at all. On every other platform, `TMPDIR` is checked first,
 * then `TMP`, then `TEMP`. Code that redirects a child process's temp
 * directory by setting only `TMPDIR` in that child's `env` therefore does
 * nothing on Windows: the child inherits the parent's ambient `TEMP`/`TMP`
 * and its own `os.tmpdir()` resolves to the wrong place — silently, with no
 * error, so the redirect just doesn't take effect. This exact shape shipped
 * in `tests/run-tests-temp-root.test.cjs`'s own regression test for #4020:
 * `env: { ...process.env, TMPDIR: outer }` on a `runNode(...)` child-process
 * helper call, masked because Windows CI died in the unrelated #4020
 * dirname-walk hang before ever reaching this test (see #4220).
 *
 * ## What this enforces
 *
 * Two independent shapes are covered:
 *
 * 1. Direct assignment: `process.env.TMPDIR = X` (or bracket form) in a
 *    file, without a `process.env.TEMP = …` AND a `process.env.TMP = …`
 *    assignment also present anywhere in that file (`Program:exit`
 *    collection, same pattern as `require-userprofile-with-home.cjs`).
 * 2. Object-literal env override: an object literal with a `TMPDIR`
 *    property, passed as the `env` option to a child-process-spawning call
 *    (`child_process.spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/
 *    `execFileSync`/`fork`, or a bare-named local helper that forwards to
 *    one, e.g. this repo's `runNode(...)` test helper) — flagged unless
 *    that SAME object literal also carries `TEMP` and `TMP` properties.
 *
 * Fix: set all three — `TMPDIR`, `TEMP`, and `TMP` — to the same value.
 *
 * ## Zero escape hatches (ADR-1703)
 *
 * This rule joins the ADR-1703 `DEFECT.WINDOWS-TEST-PORTABILITY` catalog,
 * which deliberately carries no comment-based opt-out: a legitimately
 * POSIX-only TMPDIR override must be structured so the rule never sees it
 * (e.g. behind a `process.platform !== 'win32'` guard that also sets
 * TEMP/TMP for the Windows branch), not annotated around. A false positive
 * is a rule bug, fixed in the rule — see `tests/portability-rule-disable-ban.test.cjs`,
 * which independently bans `eslint-disable` of this rule too.
 */

const ENV_CHILD_PROCESS_METHODS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);

// Local helpers in this repo that wrap a child-process call and forward an
// `env` option through unchanged — recognized by bare call name.
const ENV_LOCAL_HELPER_NAMES = new Set(['runNode']);

const DIAGNOSTIC = 'missingTempTmp';

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require process.env.TEMP and process.env.TMP to be set alongside any TMPDIR override (Windows portability)',
      category: 'Portability',
    },
    schema: [],
    messages: {
      [DIAGNOSTIC]:
        'Setting TMPDIR without TEMP and TMP is not portable (DEFECT.WINDOWS-TEST-PORTABILITY): ' +
        "Node's os.tmpdir() never reads TMPDIR on Windows (only TEMP, then TMP) — this override " +
        'silently does nothing there. Set TEMP and TMP to the same value alongside TMPDIR.',
    },
  },

  create(context) {
    // ── Shape 1: process.env.TMPDIR = … direct assignment ──────────────────

    /** Collected TMPDIR assignment nodes (process.env.TMPDIR = / process.env['TMPDIR'] =). */
    const tmpdirAssignments = [];
    let tempAssigned = false;
    let tmpAssigned = false;

    function isProcessEnvAssignment(lhs, key) {
      if (!lhs || lhs.type !== 'MemberExpression') return false;
      const obj = lhs.object;
      if (!obj || obj.type !== 'MemberExpression') return false;
      if (
        obj.computed ||
        obj.object.type !== 'Identifier' ||
        obj.object.name !== 'process' ||
        obj.property.type !== 'Identifier' ||
        obj.property.name !== 'env'
      ) {
        return false;
      }
      if (!lhs.computed) {
        return lhs.property.type === 'Identifier' && lhs.property.name === key;
      }
      return lhs.property.type === 'Literal' && lhs.property.value === key;
    }

    // ── Shape 2: object literal with a TMPDIR property passed as `env` ─────

    function isSpawnLikeCallee(callee) {
      // child_process.spawn(...) / cp.spawnSync(...) / require('child_process').exec(...)
      if (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        ENV_CHILD_PROCESS_METHODS.has(callee.property.name)
      ) {
        return true;
      }
      // Bare identifier: either a destructured child_process method
      // (`const { spawnSync } = require('child_process'); spawnSync(...)`)
      // or a local helper known to wrap one (`runNode(...)`). Matched by
      // name only, same lightweight convention as this repo's other
      // eslint-rules/*.cjs (e.g. no-hardcoded-tmp.cjs's isFsMethodCall) —
      // no import/require data-flow tracing.
      if (
        callee.type === 'Identifier' &&
        (ENV_LOCAL_HELPER_NAMES.has(callee.name) || ENV_CHILD_PROCESS_METHODS.has(callee.name))
      ) {
        return true;
      }
      return false;
    }

    function objectHasKey(objExpr, key) {
      return objExpr.properties.some((p) => {
        if (p.type !== 'Property') return false;
        if (!p.computed) {
          return (
            (p.key.type === 'Identifier' && p.key.name === key) ||
            (p.key.type === 'Literal' && p.key.value === key)
          );
        }
        return p.key.type === 'Literal' && p.key.value === key;
      });
    }

    function checkCallExpression(node) {
      if (!isSpawnLikeCallee(node.callee)) return;

      for (const arg of node.arguments) {
        // opts is either the object literal directly, or nested in a later
        // positional options argument — only the literal shape is checked;
        // an options identifier passed by reference is out of scope (the
        // AST cannot see its shape here).
        if (arg.type !== 'ObjectExpression') continue;

        const envProp = arg.properties.find(
          (p) =>
            p.type === 'Property' &&
            !p.computed &&
            ((p.key.type === 'Identifier' && p.key.name === 'env') ||
              (p.key.type === 'Literal' && p.key.value === 'env')),
        );
        if (!envProp || envProp.value.type !== 'ObjectExpression') continue;

        const envObj = envProp.value;
        if (!objectHasKey(envObj, 'TMPDIR')) continue;
        if (objectHasKey(envObj, 'TEMP') && objectHasKey(envObj, 'TMP')) continue;

        context.report({ node: envObj, messageId: DIAGNOSTIC });
      }
    }

    return {
      AssignmentExpression(node) {
        if (isProcessEnvAssignment(node.left, 'TMPDIR')) {
          tmpdirAssignments.push(node);
        }
        if (isProcessEnvAssignment(node.left, 'TEMP')) tempAssigned = true;
        if (isProcessEnvAssignment(node.left, 'TMP')) tmpAssigned = true;
      },

      CallExpression(node) {
        checkCallExpression(node);
      },

      'Program:exit'() {
        if (tmpdirAssignments.length === 0) return;
        if (tempAssigned && tmpAssigned) return;

        for (const node of tmpdirAssignments) {
          context.report({ node, messageId: DIAGNOSTIC });
        }
      },
    };
  },
};

module.exports = rule;
