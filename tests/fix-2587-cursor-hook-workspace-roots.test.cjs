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

  test('parity: the resolver is identical in both hook scripts', () => {
    // The two hooks ship as standalone scripts, so the resolver is duplicated
    // rather than shared via hooks/lib/ (which would require registering a new
    // file in the generated installer's GSD_HOOK_LIB_FILES allowlist). Per
    // CLAUDE.md "Generative Fix Divergence", the duplication carries a parity
    // assertion so the two copies cannot silently drift apart.
    const extract = (file) => {
      const src = fs.readFileSync(file, 'utf8');
      const start = src.indexOf('function resolveWorkspaceRoot(');
      assert.notEqual(start, -1, `${path.basename(file)} must define resolveWorkspaceRoot`);
      const end = src.indexOf('\n}', start);
      assert.notEqual(end, -1, `${path.basename(file)} resolveWorkspaceRoot must be terminated`);
      return src.slice(start, end + 2);
    };
    assert.equal(
      extract(SESSION_START),
      extract(STOP),
      'resolveWorkspaceRoot must be byte-identical across the two cursor hooks',
    );
  });

  test('neither hook resolves .planning from process.cwd() directly', () => {
    for (const file of [SESSION_START, STOP]) {
      const src = fs.readFileSync(file, 'utf8');
      assert.ok(
        !/path\.join\(\s*process\.cwd\(\)\s*,\s*'\.planning'/.test(src),
        `${path.basename(file)}: must not resolve .planning from cwd (#2587)`,
      );
    }
  });
});
