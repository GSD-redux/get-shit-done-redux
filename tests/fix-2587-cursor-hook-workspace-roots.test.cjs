/**
 * #2587 — Cursor sessionStart/stop hooks resolved .planning/ from process.cwd().
 *
 * Under the cursor-agent CLI, hooks are invoked with cwd set to the Cursor
 * config dir (~/.cursor), NOT the workspace. Both hooks did:
 *
 *     path.join(process.cwd(), '.planning', 'STATE.md')
 *
 * so the lookup always missed: gsd-cursor-session-start.js could only ever emit
 * the "no .planning/ workflow found" nudge, and gsd-cursor-stop.js's verify-work
 * reminder could never fire — even with .planning/STATE.md right there in the
 * workspace. Both hooks already buffered stdin into `raw` but never parsed it;
 * the payload's `workspace_roots` carries the real path.
 *
 * These are BEHAVIORAL tests: each spawns the real hook script as a child
 * process with a cwd that does NOT contain .planning/ and a stdin payload whose
 * workspace_roots does — exactly the CLI invocation shape from the report — and
 * asserts on the emitted JSON contract. They fail against the pre-fix scripts.
 */

// allow-test-rule: source-text-is-the-product #2587 — the parity check (T8) compares the shared
// resolver text across the two standalone hook scripts, which is what Cursor loads.

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const HOOKS = path.join(__dirname, '..', 'hooks');
const SESSION_START = path.join(HOOKS, 'gsd-cursor-session-start.js');
const STOP = path.join(HOOKS, 'gsd-cursor-stop.js');
// subagentStart carried the identical defect — it was not named in the report
// but its cwd lookup meant every Cursor subagent (planner, executor, verifier)
// started without phase context under the CLI.
const SUBAGENT_START = path.join(HOOKS, 'gsd-cursor-subagent-start.js');
// Every cursor hook that resolves .planning/ from the payload. Kept as one list
// so a future hook added to this family is not silently left on the old path.
const RESOLVING_HOOKS = [SESSION_START, STOP, SUBAGENT_START];

const MSG_PRESENT_FRAGMENT = '.planning/STATE.md is present';
const MSG_ABSENT_FRAGMENT = 'no .planning/ workflow found';
const STOP_REMINDER_FRAGMENT = 'Agent stopping';

/** Run a hook script with an explicit cwd and stdin payload; return parsed stdout JSON. */
function runHook(script, { cwd, payload }) {
  const stdout = execFileSync(process.execPath, [script], {
    cwd,
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 20000,
  });
  return JSON.parse(stdout || '{}');
}

/** A directory containing .planning/STATE.md. */
function makeWorkspace(withPlanning) {
  const dir = createTempDir('gsd-2587-');
  if (withPlanning) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), '# Project State\n');
  }
  return dir;
}

describe('#2587: cursor hooks resolve the workspace from workspace_roots, not cwd', () => {
  test('sessionStart: cwd is the Cursor config dir, workspace_roots carries the project', () => {
    const workspace = makeWorkspace(true);
    const cursorConfigDir = makeWorkspace(false); // stands in for ~/.cursor
    try {
      const out = runHook(SESSION_START, {
        cwd: cursorConfigDir,
        payload: {
          hook_event_name: 'sessionStart',
          cursor_version: '2026.07.23-e383d2b',
          is_background_agent: false,
          workspace_roots: [workspace],
          transcript_path: null,
        },
      });
      assert.match(
        out.additional_context || '',
        new RegExp(MSG_PRESENT_FRAGMENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        'must report STATE.md present when workspace_roots points at the project',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  test('stop: verify-work reminder fires when workspace_roots carries the project', () => {
    const workspace = makeWorkspace(true);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(STOP, {
        cwd: cursorConfigDir,
        payload: { hook_event_name: 'stop', workspace_roots: [workspace] },
      });
      assert.ok(
        (out.additional_context || '').includes(STOP_REMINDER_FRAGMENT),
        'stop hook must emit its verify-work reminder for the real workspace',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  // Boundary coverage on the workspace_roots array: 0, 1, and 2 entries.

  test('zero roots: falls back to cwd (preserves IDE behavior)', () => {
    const workspace = makeWorkspace(true);
    try {
      const out = runHook(SESSION_START, {
        cwd: workspace,
        payload: { hook_event_name: 'sessionStart', workspace_roots: [] },
      });
      assert.ok(
        (out.additional_context || '').includes(MSG_PRESENT_FRAGMENT),
        'an empty workspace_roots must fall back to cwd, not break the IDE path',
      );
    } finally {
      cleanup(workspace);
    }
  });

  test('one root, no .planning anywhere: reports absent', () => {
    const workspace = makeWorkspace(false);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(SESSION_START, {
        cwd: cursorConfigDir,
        payload: { hook_event_name: 'sessionStart', workspace_roots: [workspace] },
      });
      assert.ok(
        (out.additional_context || '').includes(MSG_ABSENT_FRAGMENT),
        'a genuinely project-less workspace must still nudge toward new-project',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  test('two roots: resolves the one that actually carries .planning/', () => {
    const plain = makeWorkspace(false);
    const withPlanning = makeWorkspace(true);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(SESSION_START, {
        cwd: cursorConfigDir,
        // GSD project is NOT the first root — first-root-only would miss it.
        payload: { hook_event_name: 'sessionStart', workspace_roots: [plain, withPlanning] },
      });
      assert.ok(
        (out.additional_context || '').includes(MSG_PRESENT_FRAGMENT),
        'multi-root: the root carrying .planning/ must win over mere ordering',
      );
    } finally {
      cleanup(plain);
      cleanup(withPlanning);
      cleanup(cursorConfigDir);
    }
  });

  test('malformed stdin JSON: fails open to cwd instead of crashing', () => {
    const workspace = makeWorkspace(true);
    try {
      const out = runHook(SESSION_START, { cwd: workspace, payload: '{not valid json' });
      assert.ok(
        (out.additional_context || '').includes(MSG_PRESENT_FRAGMENT),
        'a malformed payload must degrade to cwd, never wedge the session',
      );
    } finally {
      cleanup(workspace);
    }
  });

  test('non-string and empty root entries are ignored', () => {
    const workspace = makeWorkspace(true);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(SESSION_START, {
        cwd: cursorConfigDir,
        payload: {
          hook_event_name: 'sessionStart',
          workspace_roots: [null, '', 42, workspace],
        },
      });
      assert.ok(
        (out.additional_context || '').includes(MSG_PRESENT_FRAGMENT),
        'junk entries must be filtered rather than resolved as paths',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  test('subagentStart: reminder resolves via workspace_roots (missed site)', () => {
    const workspace = makeWorkspace(true);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(SUBAGENT_START, {
        cwd: cursorConfigDir,
        payload: { hook_event_name: 'subagentStart', workspace_roots: [workspace] },
      });
      assert.match(
        out.additional_context || '',
        /review \.planning\/STATE\.md/,
        'subagents must receive phase context, not the absent nudge',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  test('stop: absent branch still emits {} when no root and no cwd has .planning', () => {
    const workspace = makeWorkspace(false);
    const cursorConfigDir = makeWorkspace(false);
    try {
      const out = runHook(STOP, {
        cwd: cursorConfigDir,
        payload: { hook_event_name: 'stop', workspace_roots: [workspace] },
      });
      assert.deepEqual(
        out,
        {},
        'stop must stay silent when there is genuinely no GSD project',
      );
    } finally {
      cleanup(workspace);
      cleanup(cursorConfigDir);
    }
  });

  test('cwd is a candidate, not just the empty-roots fallback', () => {
    // Regression guard: resolving ONLY over workspace_roots would report absent
    // whenever roots are supplied but the project actually sits at cwd — a
    // NARROWING versus the pre-fix behavior, which always consulted cwd.
    const projectAtCwd = makeWorkspace(true);
    const unrelatedRoot = makeWorkspace(false);
    try {
      for (const hook of RESOLVING_HOOKS) {
        const out = runHook(hook, {
          cwd: projectAtCwd,
          payload: { hook_event_name: 'sessionStart', workspace_roots: [unrelatedRoot] },
        });
        // stop's present-branch is its verify-work reminder, not a STATE.md phrase.
        const ctx = out.additional_context || '';
        assert.ok(
          /STATE\.md is present|review \.planning\/STATE\.md|Agent stopping/.test(ctx),
          `${path.basename(hook)}: a project at cwd must still be found when roots miss`,
        );
      }
    } finally {
      cleanup(projectAtCwd);
      cleanup(unrelatedRoot);
    }
  });

  test('single source: every hook requires the shared resolver, none redefines it', () => {
    // The resolver lives in hooks/lib/cursor-workspace.js. Divergence is
    // prevented structurally (one implementation) rather than by a parity
    // assertion over copies, so this guards the structure: no hook may grow a
    // local copy back.
    for (const file of RESOLVING_HOOKS) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(
        src.includes("require('./lib/cursor-workspace.js')"),
        `${path.basename(file)} must use the shared resolver`,
      );
      assert.ok(
        !src.includes('function resolveWorkspaceRoot('),
        `${path.basename(file)} must not redefine resolveWorkspaceRoot locally`,
      );
    }
  });

  test('staging fails loudly if a required lib source is missing', () => {
    // Previously this path did `continue`, so a helper missing from source
    // (typo, bad rebase, accidental delete) produced an install that exits 0 and
    // ships hooks whose top-level require() throws MODULE_NOT_FOUND at load —
    // before their own try/catch — wedging every session, with nothing to
    // indicate why. Packaging bugs must surface at install, not at the user.
    const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');
    const fakeSrc = createTempDir('gsd-2587-src-');
    const target = createTempDir('gsd-2587-tgt-');
    try {
      // A source tree with the hook scripts but NO hooks/lib/ backing them.
      const srcHooks = path.join(fakeSrc, 'hooks');
      fs.mkdirSync(srcHooks, { recursive: true });
      for (const hook of RESOLVING_HOOKS) {
        fs.copyFileSync(hook, path.join(srcHooks, path.basename(hook)));
      }
      assert.throws(
        () => hooksSurface.writeCursorHooksJson(target, fakeSrc, {}),
        /cursor-workspace\.js.*missing|missing.*cursor-workspace\.js/s,
        'a missing lib source must abort the install, not ship a broken hook',
      );
    } finally {
      cleanup(fakeSrc);
      cleanup(target);
    }
  });

  test('the shared resolver is staged next to the hooks that require it', () => {
    // The MODULE_NOT_FOUND guard. Cursor sets skipSharedHooksInstall, so it
    // never reaches the installer's bulk hooks/lib copy — every other runtime
    // that ships these hooks does. If writeCursorHooksJson stopped staging the
    // helper, each hook would throw at require time, BEFORE its own try/catch,
    // and wedge every Cursor session on the one runtime this fix exists for.
    const { runMinimalInstall } = require('./helpers/install-shared.cjs');
    const { configDir, root } = runMinimalInstall({ runtime: 'cursor', scope: 'global' });
    try {
      const staged = path.join(configDir, 'hooks', 'lib', 'cursor-workspace.js');
      assert.ok(
        fs.existsSync(staged),
        'cursor install must stage hooks/lib/cursor-workspace.js next to the hook scripts',
      );
      // And the staged hook must actually load against it.
      const hook = path.join(configDir, 'hooks', 'gsd-cursor-session-start.js');
      assert.ok(fs.existsSync(hook), 'cursor install must stage the sessionStart hook');
      const ws = makeWorkspace(true);
      try {
        const out = JSON.parse(execFileSync(process.execPath, [hook], {
          cwd: root,
          input: JSON.stringify({ workspace_roots: [ws] }),
          encoding: 'utf8',
          timeout: 20000,
        }) || '{}');
        assert.ok(
          (out.additional_context || '').includes('STATE.md is present'),
          'the INSTALLED hook must resolve the workspace, not crash on a missing helper',
        );
      } finally {
        cleanup(ws);
      }
    } finally {
      cleanup(root);
    }
  });

  test('no cursor hook resolves .planning from process.cwd() directly', () => {
    for (const file of RESOLVING_HOOKS) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/path\.join\(\s*process\.cwd\(\)\s*,\s*'\.planning'/.test(src),
        `${path.basename(file)}: must not resolve .planning from cwd (#2587)`,
      );
    }
  });
});
