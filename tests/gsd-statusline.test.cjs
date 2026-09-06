/**
 * Tests for gsd-statusline.js GSD state display helpers.
 *
 * Covers:
 * - parseStateMd across YAML-frontmatter, body-fallback, and partial formats
 * - formatGsdState graceful degradation when fields are missing
 * - readGsdState walk-up search with proper bounds
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseStateMd,
  formatGsdState,
  formatGsdStateCompact,
  readGsdState,
  isInstalledAheadOfLatest,
} = require('../hooks/gsd-statusline.js');
const { cleanup, saveSessionEnv, restoreSessionEnv, clearSessionEnv } = require('./helpers.cjs');

// ─── parseStateMd ───────────────────────────────────────────────────────────

describe('parseStateMd', () => {
  test('parses full YAML frontmatter', () => {
    const content = [
      '---',
      'status: executing',
      'milestone: v1.9',
      'milestone_name: Code Quality',
      '---',
      '',
      '# State',
      'Phase: 1 of 5 (fix-graphiti-deployment)',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, 'executing');
    assert.equal(s.milestone, 'v1.9');
    assert.equal(s.milestoneName, 'Code Quality');
    assert.equal(s.phaseNum, '1');
    assert.equal(s.phaseTotal, '5');
    assert.equal(s.phaseName, 'fix-graphiti-deployment');
  });

  test('treats literal "null" values as null', () => {
    const content = [
      '---',
      'status: null',
      'milestone: null',
      'milestone_name: null',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, null);
    assert.equal(s.milestone, null);
    assert.equal(s.milestoneName, null);
  });

  test('strips surrounding quotes from frontmatter values', () => {
    const content = [
      '---',
      'milestone_name: "Code Quality"',
      "milestone: 'v1.9'",
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.milestone, 'v1.9');
    assert.equal(s.milestoneName, 'Code Quality');
  });

  test('parses phase without name', () => {
    const content = [
      '---',
      'status: planning',
      '---',
      'Phase: 3 of 10',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.phaseNum, '3');
    assert.equal(s.phaseTotal, '10');
    assert.equal(s.phaseName, null);
  });

  test('falls back to body Status when frontmatter is missing', () => {
    const content = [
      '# State',
      'Status: Ready to plan',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.status, 'planning');
  });

  test('body fallback recognizes executing state', () => {
    const content = 'Status: Executing phase 2';
    assert.equal(parseStateMd(content).status, 'executing');
  });

  test('body fallback recognizes complete state', () => {
    const content = 'Status: Complete';
    assert.equal(parseStateMd(content).status, 'complete');
  });

  test('body fallback recognizes archived as complete', () => {
    const content = 'Status: Archived';
    assert.equal(parseStateMd(content).status, 'complete');
  });

  test('returns empty object for empty content', () => {
    const s = parseStateMd('');
    assert.deepEqual(s, {});
  });

  test('returns partial state when only some fields present', () => {
    const content = [
      '---',
      'milestone: v2.0',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.milestone, 'v2.0');
    assert.equal(s.status, undefined);
    assert.equal(s.phaseNum, undefined);
  });

  test('parses next_phases from YAML block-list form (#3153)', () => {
    const content = [
      '---',
      'next_action: execute',
      'next_phases:',
      '  - 4.5',
      '  - 4.6',
      '---',
    ].join('\n');

    const s = parseStateMd(content);
    assert.equal(s.nextAction, 'execute');
    assert.deepEqual(s.nextPhases, ['4.5', '4.6']);
  });

  // #2754 — the frontmatter fence regex and downstream splits used literal \n,
  // so a CRLF STATE.md dropped the ENTIRE frontmatter block (every field absent).
  // The invariant is CRLF/LF parity — parseStateMd must yield the same state for
  // the same content regardless of line endings, matching the canonical
  // extractFrontmatter parser (src/frontmatter.cts), which is CRLF-safe.
  const crlf = (lfContent) => lfContent.replace(/\n/g, '\r\n');

  test('parses full YAML frontmatter identically under CRLF (#2754)', () => {
    const lf = [
      '---',
      'status: executing',
      'milestone: v1.9',
      'milestone_name: Code Quality',
      'active_phase: 4',
      'next_action: execute',
      '---',
      '',
      '# State',
      'Phase: 1 of 5 (fix-graphiti-deployment)',
    ].join('\n');

    const lfState = parseStateMd(lf);
    const crlfState = parseStateMd(crlf(lf));
    assert.deepStrictEqual(crlfState, lfState,
      'CRLF STATE.md must parse identically to LF — pre-fix the entire frontmatter block was dropped (#2754)');
    // pin the specific fields the issue names so a vacuous deepEqual({},{}) can't pass:
    assert.equal(crlfState.status, 'executing');
    assert.equal(crlfState.milestone, 'v1.9');
    assert.equal(crlfState.milestoneName, 'Code Quality');
    assert.equal(crlfState.activePhase, '4');
    assert.equal(crlfState.nextAction, 'execute');
    assert.equal(crlfState.phaseNum, '1');
    assert.equal(crlfState.phaseTotal, '5');
  });

  test('parses next_phases flow-array form identically under CRLF (#2754)', () => {
    const lf = [
      '---',
      'next_phases: [4.5, 4.6]',
      '---',
    ].join('\n');

    assert.deepStrictEqual(parseStateMd(crlf(lf)), parseStateMd(lf));
    assert.deepEqual(parseStateMd(crlf(lf)).nextPhases, ['4.5', '4.6']);
  });

  test('parses next_phases block-list form identically under CRLF (#2754)', () => {
    const lf = [
      '---',
      'next_phases:',
      '  - 4.5',
      '  - 4.6',
      '---',
    ].join('\n');

    assert.deepStrictEqual(parseStateMd(crlf(lf)).nextPhases, parseStateMd(lf).nextPhases,
      'block-list regex used a literal \\n — CRLF must still parse the list');
    assert.deepEqual(parseStateMd(crlf(lf)).nextPhases, ['4.5', '4.6']);
  });

  test('parses the progress nested block identically under CRLF (#2754)', () => {
    const lf = [
      '---',
      'progress:',
      '  completed_phases: 3',
      '  total_phases: 5',
      '  percent: 60',
      '---',
    ].join('\n');

    assert.deepStrictEqual(parseStateMd(crlf(lf)), parseStateMd(lf),
      'progress block regex used a literal \\n — CRLF must still parse completed/total/percent');
    assert.equal(parseStateMd(crlf(lf)).completedPhases, '3');
    assert.equal(parseStateMd(crlf(lf)).totalPhases, '5');
    assert.equal(parseStateMd(crlf(lf)).percent, '60');
  });

  test('treats literal "null" values as null identically under CRLF (#2754)', () => {
    const lf = [
      '---',
      'status: null',
      'milestone: null',
      'milestone_name: null',
      '---',
    ].join('\n');

    assert.deepStrictEqual(parseStateMd(crlf(lf)), parseStateMd(lf));
    assert.equal(parseStateMd(crlf(lf)).status, null);
    assert.equal(parseStateMd(crlf(lf)).milestone, null);
  });

  // #2754 (Generative-Fix Divergence guard, CLAUDE.md "parallel surfaces sharing a
  // parser"): parseStateMd and the canonical extractFrontmatter both derive GSD
  // state from the same STATE.md frontmatter, and they diverged once already (this
  // very CRLF bug). Pin the overlap so a future divergence on a scalar shape or
  // line ending is caught here, not in a live Windows report.
  const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');

  test('parseStateMd frontmatter-derived fields agree with extractFrontmatter (LF + CRLF, #2754)', () => {
    const lf = [
      '---',
      'status: executing',
      'milestone: v1.9',
      'milestone_name: Code Quality',
      'active_phase: 4',
      'next_action: execute',
      '---',
      '',
      '# State',
      'Phase: 1 of 5 (fix-graphiti-deployment)',
    ].join('\n');

    for (const [label, content] of [['LF', lf], ['CRLF', crlf(lf)]]) {
      const fm = extractFrontmatter(content);
      const st = parseStateMd(content);
      // extractFrontmatter yields the raw frontmatter object; parseStateMd projects
      // a subset onto its own keys. Assert the projection matches the raw values.
      assert.equal(st.status, fm.status, `status mismatch (${label})`);
      assert.equal(st.milestone, fm.milestone, `milestone mismatch (${label})`);
      assert.equal(st.milestoneName, fm.milestone_name, `milestone_name mismatch (${label})`);
      assert.equal(st.activePhase, String(fm.active_phase), `active_phase mismatch (${label})`);
      assert.equal(st.nextAction, fm.next_action, `next_action mismatch (${label})`);
    }
  });
});

// ─── formatGsdState ─────────────────────────────────────────────────────────

describe('formatGsdState', () => {
  test('formats full state with milestone name, status, and phase name', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      milestoneName: 'Code Quality',
      status: 'executing',
      phaseNum: '1',
      phaseTotal: '5',
      phaseName: 'fix-graphiti-deployment',
    });
    assert.equal(out, 'v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)');
  });

  test('skips placeholder "milestone" value in milestoneName', () => {
    const out = formatGsdState({
      milestone: 'v1.0',
      milestoneName: 'milestone',
      status: 'planning',
    });
    assert.equal(out, 'v1.0 · planning');
  });

  test('uses short phase form when phase name is missing', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      status: 'executing',
      phaseNum: '3',
      phaseTotal: '7',
    });
    assert.equal(out, 'v2.0 · executing · ph 3/7');
  });

  test('omits phase entirely when phaseNum/phaseTotal missing', () => {
    const out = formatGsdState({
      milestone: 'v1.0',
      status: 'planning',
    });
    assert.equal(out, 'v1.0 · planning');
  });

  test('handles milestone version only (no name)', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      status: 'executing',
    });
    assert.equal(out, 'v1.9 · executing');
  });

  test('handles milestone name only (no version)', () => {
    const out = formatGsdState({
      milestoneName: 'Foundations',
      status: 'planning',
    });
    assert.equal(out, 'Foundations · planning');
  });

  test('treats numeric 100 percent as milestone complete (#3153)', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      percent: 100,
    });
    assert.equal(out, 'v2.0 [██████████] 100% · milestone complete');
  });

  test('returns empty string for empty state', () => {
    assert.equal(formatGsdState({}), '');
  });

  test('returns only available parts when everything else is missing', () => {
    assert.equal(formatGsdState({ status: 'planning' }), 'planning');
  });

  test('renders observable "no active workstream" signal for the #2850 sentinel', () => {
    assert.equal(formatGsdState({ noActiveWorkstream: true }), 'no active workstream');
  });
});

describe('formatGsdStateCompact — #2850 sentinel', () => {
  test('renders observable "no active workstream" signal', () => {
    assert.equal(formatGsdStateCompact({ noActiveWorkstream: true }), 'no active workstream');
  });
});

describe('isInstalledAheadOfLatest', () => {
  test('treats prerelease patch increment as ahead of prior stable', () => {
    assert.equal(isInstalledAheadOfLatest('1.2.1-beta.1', '1.2.0'), true);
  });

  test('treats equal base version prerelease as not ahead', () => {
    assert.equal(isInstalledAheadOfLatest('1.2.0-rc.1', '1.2.0'), false);
  });
});

// ─── readGsdState ───────────────────────────────────────────────────────────

describe('readGsdState', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-statusline-test-'));

  test('finds STATE.md in the starting directory', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'STATE.md'),
      '---\nstatus: executing\nmilestone: v1.0\n---\n'
    );

    const s = readGsdState(proj);
    assert.equal(s.status, 'executing');
    assert.equal(s.milestone, 'v1.0');
  });

  test('walks up to find STATE.md in a parent directory', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'STATE.md'),
      '---\nstatus: planning\n---\n'
    );

    const nested = path.join(proj, 'src', 'components', 'deep');
    fs.mkdirSync(nested, { recursive: true });

    const s = readGsdState(nested);
    assert.equal(s.status, 'planning');
  });

  test('returns null when no STATE.md exists in the walk-up chain', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    const nested = path.join(proj, 'src');
    fs.mkdirSync(nested, { recursive: true });

    assert.equal(readGsdState(nested), null);
  });

  test('returns null on malformed STATE.md without crashing', () => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    // Valid file (no content to crash on) — parseStateMd returns {}
    fs.writeFileSync(path.join(proj, '.planning', 'STATE.md'), '');

    const s = readGsdState(proj);
    // Empty file yields an empty state object, not null — the function
    // only returns null when no file is found.
    assert.deepEqual(s, {});
  });

  // ─── Workstream mode (#2850) ──────────────────────────────────────────────
  //
  // readGsdState previously only ever walked up looking for a flat
  // .planning/STATE.md — it never resolved an active workstream, so the
  // GSD-state segment silently disappeared for any workstream-mode project
  // without a root STATE.md (issue #2850). These cases exercise the fix,
  // which reuses resolveActiveWorkstream (CLI>env>store precedence,
  // active-workstream-store.cjs) and listAvailableWorkstreams/planningPaths
  // (planning-workspace.cjs) rather than re-implementing that resolution.
  //
  // saveSessionEnv/restoreSessionEnv/clearSessionEnv come from tests/helpers.cjs
  // (shared with tests/active-workstream-store.unit.test.cjs — see that file's
  // comment; #2850 code review caught the two local copies had diverged).

  test('resolves active workstream via GSD_WORKSTREAM env when no root STATE.md exists (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'workstreams', 'bot', 'STATE.md'),
      '---\nstatus: executing\nmilestone: v1.0\n---\n'
    );

    const saved = saveSessionEnv();
    clearSessionEnv();
    t.after(() => restoreSessionEnv(saved));
    process.env.GSD_WORKSTREAM = 'bot';

    const s = readGsdState(proj);
    assert.notEqual(s, null, 'must not silently return null when a workstream resolves');
    assert.equal(s.status, 'executing');
    assert.equal(s.milestone, 'v1.0');
  });

  test('resolves via GSD_WORKSTREAM env with CRLF frontmatter (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'workstreams', 'bot', 'STATE.md'),
      '---\r\nstatus: planning\r\nmilestone: v2.0\r\n---\r\n'
    );

    const saved = saveSessionEnv();
    clearSessionEnv();
    t.after(() => restoreSessionEnv(saved));
    process.env.GSD_WORKSTREAM = 'bot';

    const s = readGsdState(proj);
    assert.equal(s.status, 'planning');
    assert.equal(s.milestone, 'v2.0');
  });

  test('flat root STATE.md takes precedence over workstream mode when both exist (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'STATE.md'),
      '---\nstatus: executing\nmilestone: v-flat\n---\n'
    );
    fs.writeFileSync(
      path.join(proj, '.planning', 'workstreams', 'bot', 'STATE.md'),
      '---\nstatus: planning\nmilestone: v-ws\n---\n'
    );

    const saved = saveSessionEnv();
    clearSessionEnv();
    t.after(() => restoreSessionEnv(saved));
    process.env.GSD_WORKSTREAM = 'bot';

    const s = readGsdState(proj);
    assert.equal(s.milestone, 'v-flat', 'flat STATE.md must win — flat-mode behavior stays byte-for-byte unchanged');
  });

  test('returns an observable "no active workstream" signal when nothing resolves (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'other'), { recursive: true });

    const saved = saveSessionEnv();
    clearSessionEnv();
    t.after(() => restoreSessionEnv(saved));

    const s = readGsdState(proj);
    assert.deepEqual(s, { noActiveWorkstream: true });
  });

  test('resolved workstream with no STATE.md yet degrades to null without crashing (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    // No STATE.md written under workstreams/bot/ — workstream exists, state doesn't yet.

    const saved = saveSessionEnv();
    clearSessionEnv();
    t.after(() => restoreSessionEnv(saved));
    process.env.GSD_WORKSTREAM = 'bot';

    assert.equal(readGsdState(proj), null);
  });

  test('resolves active workstream via the stored shared pointer file (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.planning', 'workstreams', 'bot', 'STATE.md'),
      '---\nstatus: verifying\nmilestone: v3.0\n---\n'
    );
    fs.writeFileSync(path.join(proj, '.planning', 'active-workstream'), 'bot\n');

    const { _resetControllingTtyCacheForTests } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
    const saved = saveSessionEnv();
    clearSessionEnv();
    _resetControllingTtyCacheForTests();
    t.after(() => {
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    });

    const s = readGsdState(proj);
    assert.equal(s.status, 'verifying');
    assert.equal(s.milestone, 'v3.0');
  });

  test('whitespace-only stored pointer file is treated as no active workstream (#2850)', (t) => {
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'bot'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'active-workstream'), '   \n');

    const { _resetControllingTtyCacheForTests } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
    const saved = saveSessionEnv();
    clearSessionEnv();
    _resetControllingTtyCacheForTests();
    t.after(() => {
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    });

    assert.deepEqual(readGsdState(proj), { noActiveWorkstream: true });
  });

  test('stored pointer naming an absent workstream dir degrades to the sentinel WITHOUT deleting the pointer file (#2850)', (t) => {
    // Regression for a review finding: readGsdState previously resolved via
    // resolveActiveWorkstream's DEFAULT store lookup (getActiveWorkstream),
    // which self-heals a stale pointer by deleting it (adapter.clear() in
    // active-workstream-store.cts). The statusline renders once per prompt,
    // so a merely-stale pointer (mid-rename, mid-cleanup, or any transient
    // absence of the workstream dir) would be silently unlinked by a hook
    // whose only job is to display text — violating issue #2850's AC4 ("the
    // fix is purely additive to what's displayed"). The fix routes through
    // peekActiveWorkstream, a read-only sibling that never calls clear().
    // This test asserts BOTH halves: the render still degrades usefully,
    // AND the pointer file survives the render untouched.
    const proj = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
    // workstream mode is detected via .planning/workstreams/ existing — but
    // note it does NOT contain a 'ghost' directory, so the pointer below
    // names a workstream that does not exist.
    fs.mkdirSync(path.join(proj, '.planning', 'workstreams', 'other'), { recursive: true });
    const pointerPath = path.join(proj, '.planning', 'active-workstream');
    fs.writeFileSync(pointerPath, 'ghost\n');

    const { _resetControllingTtyCacheForTests } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
    const saved = saveSessionEnv();
    clearSessionEnv();
    _resetControllingTtyCacheForTests();
    t.after(() => {
      restoreSessionEnv(saved);
      _resetControllingTtyCacheForTests();
    });

    assert.equal(fs.existsSync(pointerPath), true, 'precondition: pointer file must exist before the render');

    const s = readGsdState(proj);

    assert.deepEqual(s, { noActiveWorkstream: true }, 'a stale pointer must still degrade to the observable sentinel');
    assert.equal(
      fs.existsSync(pointerPath),
      true,
      'a read-only render must never delete the pointer file — that is a write, and the statusline must be purely additive to what is displayed (#2850 AC4)'
    );
    assert.equal(
      fs.readFileSync(pointerPath, 'utf8'),
      'ghost\n',
      'the pointer file content must be byte-for-byte unchanged by the render, not just present'
    );
  });
});

// ─── CLAUDE_CODE_AUTO_COMPACT_WINDOW context meter (#2219) ──────────────────

describe('context meter respects CLAUDE_CODE_AUTO_COMPACT_WINDOW (#2219)', () => {
  const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  /**
   * Run the statusline hook with a synthetic context_window payload.
   * Returns { normalizedUsed, rawUsedPct } where:
   *   - normalizedUsed: the buffer-adjusted % shown in the statusline bar
   *     (parsed from the hook's stdout ANSI output, e.g. "60%")
   *   - rawUsedPct: the raw value written to the bridge file (100 - remaining,
   *     CC-consistent per #2451 fix)
   */
  function runHook(remainingPct, totalTokens, acwEnv) {
    const sessionId = `test-2219-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: sessionId,
      context_window: {
        remaining_percentage: remainingPct,
        total_tokens: totalTokens,
      },
    });

    const env = { ...process.env };
    if (acwEnv != null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(acwEnv);
    } else {
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    const r = runHookSeam(hookPath, [], { input: payload, env, timeoutMs: 4000 });
    const stdout = r.stdout;

    // Parse normalized used% from the statusline bar output (e.g. "60%")
    // Strip ANSI escape codes then extract the percentage digit(s) before "%"
    // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const match = clean.match(/(\d+)%/);
    const normalizedUsed = match ? parseInt(match[1], 10) : null;

    // Read raw used_pct from the bridge file (#2451: bridge stores raw CC value)
    const bridgePath = path.join(os.tmpdir(), `claude-ctx-${sessionId}.json`);
    let rawUsedPct = null;
    try {
      const bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
      rawUsedPct = bridge.used_pct;
      fs.unlinkSync(bridgePath);
    } catch { /* bridge may not exist if hook exited early */ }

    return { normalizedUsed, rawUsedPct };
  }

  test('default buffer (no env var): 50% remaining → ~60% normalized bar display', () => {
    // Default 16.5% buffer: usableRemaining = (50 - 16.5) / (100 - 16.5) * 100 ≈ 40.12%
    // normalized used ≈ 100 - 40.12 = 59.88 → rounded 60 (shown in statusline bar)
    const { normalizedUsed } = runHook(50, 1_000_000, null);
    assert.strictEqual(normalizedUsed, 60);
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000: 50% remaining → 100% normalized bar display', () => {
    // ACW = 400k usable tokens out of 1M total → usable fraction = 40%, buffer = 60%.
    // (1 - 400000/1000000) * 100 = 60% buffer. With 50% remaining already below the
    // 60% buffer threshold, usableRemaining = max(0, (50-60)/(100-60)*100) = 0%,
    // normalized used = 100 (bar shows full — context is within the compact-trigger buffer).
    const { normalizedUsed } = runHook(50, 1_000_000, 400_000);
    assert.strictEqual(normalizedUsed, 100);
  });

  test('CLAUDE_CODE_AUTO_COMPACT_WINDOW=0 falls back to default buffer', () => {
    // Explicit "0" means unset — should behave like no env var (16.5% buffer)
    const { normalizedUsed } = runHook(50, 1_000_000, 0);
    assert.strictEqual(normalizedUsed, 60);
  });

  test('ACW exceeds total context: buffer clamped to 0% — used reflects real remaining', () => {
    // Pathological: ACW > totalCtx → (1 - 2M/1M) * 100 = -100% → clamped to 0%.
    // With 0% buffer, usableRemaining = 50%, normalized used = 50.
    // The Math.max(0, ...) clamp prevents negative buffer from inverting the display.
    const { normalizedUsed } = runHook(50, 1_000_000, 2_000_000);
    assert.strictEqual(normalizedUsed, 50);
  });

  test('bridge used_pct is raw (CC-consistent) regardless of ACW setting (#2451)', () => {
    // Fix for #2451: bridge used_pct must be raw (100 - remaining), not normalized.
    // This ensures gsd-context-monitor warning messages match CC native /context.
    // The ACW normalization only affects the statusline bar display, not the bridge.
    const { rawUsedPct } = runHook(50, 1_000_000, 400_000);
    assert.strictEqual(rawUsedPct, 50,
      'bridge used_pct must be raw (100-50=50) regardless of CLAUDE_CODE_AUTO_COMPACT_WINDOW');
  });
});

// ─── auto-compact buffer boundary tests (#1194) ─────────────────────────────

describe('context meter boundary: acw at/near totalCtx does not pin used at 100% (#1194)', () => {
  const { execFileSync } = require('node:child_process');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  /**
   * Run the hook with a given acw and totalTokens; remaining fixed at 50%.
   * Returns the normalizedUsed percentage shown in the statusline bar.
   */
  function runBoundaryHook(remainingPct, totalTokens, acwEnv) {
    const sessionId = `test-1194-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: sessionId,
      context_window: {
        remaining_percentage: remainingPct,
        total_tokens: totalTokens,
      },
    });

    const env = { ...process.env };
    if (acwEnv != null) {
      env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(acwEnv);
    } else {
      delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;
    }

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookPath], {
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });
    } catch (e) {
      stdout = e.stdout || '';
    }

    // Strip ANSI escape codes then extract the percentage digit(s) before "%"
    // eslint-disable-next-line no-control-regex -- \x1b is the required leading byte of ANSI SGR sequences
    const clean = stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const match = clean.match(/(\d+)%/);
    return match ? parseInt(match[1], 10) : null;
  }

  // acw == totalCtx - 1 (one token below total): buffer is near-zero (≈0%),
  // so the full window is usable. With 50% remaining the bar should show ~50%.
  test('acw = totalCtx - 1: used reflects actual remaining context (≈50%)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx - 1; // 999999
    const used = runBoundaryHook(50, totalCtx, acw);
    // buffer ≈ 0% → usableRemaining ≈ 50% → used ≈ 50. Accept 49-51 for rounding.
    assert.ok(
      used !== null && used >= 49 && used <= 51,
      `expected used ≈ 50 when acw=totalCtx-1, got: ${used}`
    );
  });

  // acw == totalCtx (the triggering edge case): buffer should be 0%,
  // NOT 100%.  The "used" value must reflect real remaining context, not 100.
  test('acw = totalCtx: used MUST NOT stick at 100 (division-by-zero boundary)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx; // 1000000
    const used = runBoundaryHook(50, totalCtx, acw);
    // Buffer = 0% → usableRemaining = 50% → used ≈ 50. Must not be 100.
    assert.ok(
      used !== null && used !== 100,
      `expected used != 100 when acw==totalCtx (div-by-zero boundary), got: ${used}`
    );
    // Also assert the bar is in a sane range (should be around 50%)
    assert.ok(
      used >= 0 && used <= 99,
      `expected used in 0-99 when acw==totalCtx, got: ${used}`
    );
  });

  // acw == totalCtx + 1 (exceeds total): buffer would be negative without a clamp;
  // the Math.max(0,...) clamp should keep buffer=0%, not a negative value.
  test('acw = totalCtx + 1: does not produce negative buffer (clamp prevents it)', () => {
    const totalCtx = 1_000_000;
    const acw = totalCtx + 1; // 1000001
    const used = runBoundaryHook(50, totalCtx, acw);
    // Buffer clamped to 0 → used ≈ 50 (reflects real remaining, not 100)
    assert.ok(
      used !== null && used !== 100,
      `expected used != 100 when acw=totalCtx+1, got: ${used}`
    );
    assert.ok(
      used >= 0 && used <= 99,
      `expected used in 0-99 when acw=totalCtx+1, got: ${used}`
    );
  });

  // Default path (no env var / acw==0): must be unchanged. 50% remaining → ~60%.
  test('acw = 0 (default path): unchanged, ~60% normalized for 50% remaining', () => {
    const used = runBoundaryHook(50, 1_000_000, 0);
    assert.strictEqual(used, 60, `default path must still produce 60, got: ${used}`);
  });

  // Normal partial value: 93% remaining → ~usesd ≈ 7% with default buffer.
  test('normal partial value: 93% remaining → ~7% normalized used', () => {
    // Default 16.5% buffer: usableRemaining = (93 - 16.5) / (100 - 16.5) * 100 = 91.6%
    // used ≈ 100 - 91.6 = 8.4 → rounded 8
    const used = runBoundaryHook(93, 1_000_000, null);
    assert.ok(
      used !== null && used >= 7 && used <= 10,
      `expected used ≈ 7-10 for 93% remaining with default buffer, got: ${used}`
    );
  });
});

// ─── todo-resolution path (#305) ────────────────────────────────────────────

describe('todo-resolution: resolves in_progress task from the newest matching todos file (#305)', () => {
  const { execFileSync } = require('node:child_process');
  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  test('resolves in_progress task from the newest matching todos file (#305)', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-305-'));
    t.after(() => {
      cleanup(tempDir);
    });

    const todosDir = path.join(tempDir, 'todos');
    fs.mkdirSync(todosDir, { recursive: true });

    const session = `sess-305-${Math.random().toString(36).slice(2)}`;
    const now = Date.now() / 1000; // seconds for utimesSync

    // Older matching file — should NOT be selected
    const olderPath = path.join(todosDir, `${session}-agent-A.json`);
    fs.writeFileSync(olderPath, JSON.stringify([
      { content: 'old task', status: 'in_progress', activeForm: 'OLDER TASK 305' },
    ]));
    const olderTime = now - 10000;
    fs.utimesSync(olderPath, olderTime, olderTime);

    // Newer matching file — should be selected
    const newerPath = path.join(todosDir, `${session}-agent-B.json`);
    fs.writeFileSync(newerPath, JSON.stringify([
      { content: 'new task', status: 'in_progress', activeForm: 'NEWER TASK 305' },
    ]));
    const newerTime = now - 1000;
    fs.utimesSync(newerPath, newerTime, newerTime);

    // Distractor: different session prefix — must be ignored even with very-new mtime
    const wrongSessPath = path.join(todosDir, 'other-sess-agent-Z.json');
    fs.writeFileSync(wrongSessPath, JSON.stringify([
      { content: 'wrong session', status: 'in_progress', activeForm: 'WRONG SESSION 305' },
    ]));
    fs.utimesSync(wrongSessPath, now, now);

    // Distractor: matches session + .json but lacks -agent- — must be ignored
    const notAgentPath = path.join(todosDir, `${session}-notagent.json`);
    fs.writeFileSync(notAgentPath, JSON.stringify([
      { content: 'not agent', status: 'in_progress', activeForm: 'NOT AGENT 305' },
    ]));
    fs.utimesSync(notAgentPath, now, now);

    const payload = JSON.stringify({
      model: { display_name: 'Claude' },
      workspace: { current_dir: os.tmpdir() },
      session_id: session,
      context_window: { remaining_percentage: 80, total_tokens: 1_000_000 },
    });

    const env = { ...process.env, CLAUDE_CONFIG_DIR: tempDir };

    let stdout = '';
    try {
      stdout = execFileSync(process.execPath, [hookPath], {
        input: payload,
        env,
        encoding: 'utf8',
        timeout: 4000,
      });
    } catch (e) {
      stdout = e.stdout || '';
    }

    assert.ok(stdout.includes('NEWER TASK 305'),
      `expected stdout to contain "NEWER TASK 305", got: ${stdout}`);
    assert.ok(!stdout.includes('OLDER TASK 305'),
      `stdout must NOT contain "OLDER TASK 305", got: ${stdout}`);
    assert.ok(!stdout.includes('WRONG SESSION 305'),
      `stdout must NOT contain "WRONG SESSION 305", got: ${stdout}`);
    assert.ok(!stdout.includes('NOT AGENT 305'),
      `stdout must NOT contain "NOT AGENT 305", got: ${stdout}`);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2538-statusline-last-command.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2538-statusline-last-command (consolidation epic #1969 B5 #1974)", () => {
'use strict';

/**
 * Enhancement #2538 — statusline `last: /cmd` suffix.
 *
 * Asserts that:
 *   - default (flag absent) output does NOT include "last:" text
 *   - with statusline.show_last_command=true AND a transcript containing
 *     <command-name>/gsd-plan-phase</command-name>, output includes "last: /gsd-plan-phase"
 *   - a missing transcript_path does not throw and produces no "last:" suffix
 *   - an existing transcript with no slash commands produces no "last:" suffix
 *   - the config key is registered in the schema so /gsd-settings can surface it
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { cleanup } = require('./helpers.cjs');

const statusline = require('../hooks/gsd-statusline.js');
const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

function makeProject({ flag, transcript }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enh-2538-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (flag !== undefined) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'config.json'),
      JSON.stringify({ statusline: { show_last_command: flag } }),
    );
  }
  let transcriptPath = null;
  if (transcript !== undefined) {
    transcriptPath = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, transcript);
  }
  return { dir, transcriptPath, cleanup: () => cleanup(dir) };
}

function buildInput(dir, transcriptPath) {
  return {
    model: { display_name: 'Claude' },
    workspace: { current_dir: dir },
    session_id: 'test-session',
    transcript_path: transcriptPath,
  };
}

test('config schema registers statusline.show_last_command', () => {
  assert.ok(
    VALID_CONFIG_KEYS.has('statusline.show_last_command'),
    'statusline.show_last_command must be in VALID_CONFIG_KEYS',
  );
});

test('default (flag absent) output has no "last:" suffix', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gsd-plan-phase</command-name>' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(!out.includes('last:'), `expected no "last:" in output; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with recorded command yields "last: /<cmd>"', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gsd-plan-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { content: 'ok' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(out.includes('last: /gsd-plan-phase'), `expected "last: /gsd-plan-phase" in output; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true picks the MOST RECENT command when multiple are present', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gsd-discuss-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gsd-plan-phase</command-name>' } }) + '\n' +
    JSON.stringify({ type: 'user', message: { content: '<command-name>/gsd-execute-phase</command-name>' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(out.includes('last: /gsd-execute-phase'), `expected most-recent "gsd-execute-phase"; got: ${out}`);
    assert.ok(!out.includes('last: /gsd-discuss-phase'), `should not show stale command; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with missing transcript_path does not throw and omits suffix', () => {
  const { dir, cleanup } = makeProject({ flag: true });
  try {
    let out;
    assert.doesNotThrow(() => {
      out = statusline.renderStatusline(buildInput(dir, undefined));
    });
    assert.ok(!out.includes('last:'), `expected no "last:" suffix when transcript missing; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('flag=true with transcript lacking command tags omits suffix', () => {
  const transcript =
    JSON.stringify({ type: 'user', message: { content: 'just a plain prompt' } }) + '\n';
  const { dir, transcriptPath, cleanup } = makeProject({ flag: true, transcript });
  try {
    const out = statusline.renderStatusline(buildInput(dir, transcriptPath));
    assert.ok(!out.includes('last:'), `expected no "last:" suffix with no commands; got: ${out}`);
  } finally {
    cleanup();
  }
});

test('readLastSlashCommand returns null for nonexistent paths', () => {
  assert.strictEqual(statusline.readLastSlashCommand('/nonexistent/path.jsonl'), null);
  assert.strictEqual(statusline.readLastSlashCommand(null), null);
  assert.strictEqual(statusline.readLastSlashCommand(undefined), null);
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2833-phase-lifecycle-statusline.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2833-phase-lifecycle-statusline (consolidation epic #1969 B5 #1974)", () => {
/**
 * Tests for issue #2833 — phase-lifecycle status-line.
 *
 * Covers the additions made by the two preceding feat commits:
 *
 *   1. parseStateMd reads four new STATE.md frontmatter fields
 *      - active_phase
 *      - next_action
 *      - next_phases (YAML flow array)
 *      - progress (nested block: completed_phases / total_phases / percent)
 *
 *   2. formatGsdState renders three new scenes when those fields are populated
 *      - Scene 1: active_phase set         → "Phase X.Y <stage>"
 *      - Scene 2: idle + next_action set   → "next <action> <phases>"
 *      - Scene 3: percent 100 / all done   → "milestone complete"
 *      - Scene 4: default fallback         → unchanged "<status> · <phase>"
 *
 *   3. renderProgressBar() helper for the opt-in milestone bar.
 *
 *   4. Backward compatibility — existing STATE.md files (without any of the
 *      new fields) render byte-for-byte identically to v1.38.x.
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseStateMd,
  formatGsdState,
} = require('../hooks/gsd-statusline.js');

// ─── parseStateMd: new lifecycle fields ─────────────────────────────────────

describe('parseStateMd #2833 lifecycle fields', () => {
  test('reads active_phase from frontmatter', () => {
    const content = [
      '---',
      'milestone: v2.0',
      'status: executing',
      'active_phase: "4.5"',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.equal(s.activePhase, '4.5');
  });

  test('reads next_action from frontmatter', () => {
    const content = [
      '---',
      'milestone: v2.0',
      'next_action: execute-phase',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.equal(s.nextAction, 'execute-phase');
  });

  test('treats "null" literal as null for active_phase and next_action', () => {
    const content = [
      '---',
      'active_phase: null',
      'next_action: null',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.equal(s.activePhase, null);
    assert.equal(s.nextAction, null);
  });

  test('parses next_phases YAML flow array (single item)', () => {
    const content = [
      '---',
      'next_phases: ["4.5"]',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.deepEqual(s.nextPhases, ['4.5']);
  });

  test('parses next_phases YAML flow array (multiple items)', () => {
    const content = [
      '---',
      'next_phases: ["4.5", "4.6", "5"]',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.deepEqual(s.nextPhases, ['4.5', '4.6', '5']);
  });

  test('parses progress nested block — all three fields', () => {
    const content = [
      '---',
      'progress:',
      '  total_phases: 17',
      '  completed_phases: 10',
      '  percent: 59',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.equal(s.totalPhases, '17');
    assert.equal(s.completedPhases, '10');
    assert.equal(s.percent, '59');
  });

  test('returns undefined for absent lifecycle fields', () => {
    const content = [
      '---',
      'milestone: v1.9',
      'status: executing',
      '---',
    ].join('\n');
    const s = parseStateMd(content);
    assert.equal(s.activePhase, undefined);
    assert.equal(s.nextAction, undefined);
    assert.equal(s.nextPhases, undefined);
    assert.equal(s.percent, undefined);
  });
});

// ─── formatGsdState: new scenes ─────────────────────────────────────────────

describe('formatGsdState #2833 lifecycle scenes', () => {
  test('Scene 1 — active_phase set renders "Phase X.Y <stage>"', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      status: 'executing',
      activePhase: '4.5',
      percent: '59',
    });
    assert.equal(out, 'v2.0 [█████░░░░░] 59% · Phase 4.5 executing');
  });

  test('Scene 1 — active_phase without status renders "Phase X.Y"', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      activePhase: '4.5',
    });
    assert.equal(out, 'v2.0 · Phase 4.5');
  });

  test('Scene 2 — idle + next_action renders "next <action> <phases>"', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      activePhase: null,
      nextAction: 'execute-phase',
      nextPhases: ['4.5'],
      percent: '59',
    });
    assert.equal(out, 'v2.0 [█████░░░░░] 59% · next execute-phase 4.5');
  });

  test('Scene 2 — multiple next_phases joined with /', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      nextAction: 'discuss-phase',
      nextPhases: ['4.7', '6.5'],
    });
    assert.equal(out, 'v2.0 · next discuss-phase 4.7/6.5');
  });

  test('Scene 3 — percent=100 renders "milestone complete"', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      percent: '100',
    });
    assert.equal(out, 'v2.0 [██████████] 100% · milestone complete');
  });

  test('Scene 3 — completed_phases equals total_phases also triggers complete', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      completedPhases: '17',
      totalPhases: '17',
    });
    assert.equal(out, 'v2.0 · milestone complete');
  });

  // #3945: the counters arrive as regex-captured STRINGS, so '0' is truthy and
  // '0' === '0' made the "every phase done" guard fire on the empty set —
  // rendering "0% · milestone complete" for a freshly-roadmapped milestone.
  test('Scene 3 — 0 of 0 counters does not render milestone complete (#3945)', () => {
    const out = formatGsdState({
      milestone: 'v1.15',
      milestoneName: 'Design Refresh',
      status: 'planning',
      completedPhases: '0',
      totalPhases: '0',
      percent: '0',
    });
    assert.ok(!out.includes('milestone complete'),
      `0 of 0 phases must not read as complete; got: ${out}`);
    assert.ok(out.includes('planning'), `default path should render the status; got: ${out}`);
  });

  test('Scene 3 — boundary denominators: 1/1 completes, 0/1 and 1/0 do not (#3945)', () => {
    assert.ok(formatGsdState({ milestone: 'v2.0', completedPhases: '1', totalPhases: '1' })
      .includes('milestone complete'), '1 of 1 done is complete');
    assert.ok(!formatGsdState({ milestone: 'v2.0', completedPhases: '0', totalPhases: '1' })
      .includes('milestone complete'), '0 of 1 is not complete');
    assert.ok(!formatGsdState({ milestone: 'v2.0', completedPhases: '1', totalPhases: '0' })
      .includes('milestone complete'), '1 of 0 is not a complete milestone');
  });
});

// ─── Backward compatibility — CRITICAL: existing STATE.md unchanged ─────────

describe('formatGsdState #2833 backward compatibility', () => {
  test('legacy STATE.md (only status + milestone + phase) renders unchanged', () => {
    // Identical to the format documented in #1989 (the foundation issue).
    // No new lifecycle fields populated → must render exactly as v1.38.x did.
    const out = formatGsdState({
      status: 'executing',
      milestone: 'v1.9',
      milestoneName: 'Code Quality',
      phaseNum: '1',
      phaseTotal: '5',
      phaseName: 'fix-graphiti-deployment',
    });
    assert.equal(out, 'v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)');
  });

  test('only status set (no phase, no lifecycle fields) renders just "<milestone> · <status>"', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      status: 'executing',
    });
    assert.equal(out, 'v1.9 · executing');
  });

  test('empty state renders empty string', () => {
    const out = formatGsdState({});
    assert.equal(out, '');
  });

  test('progress.percent is opt-in — absent percent leaves milestone segment unchanged', () => {
    const out = formatGsdState({
      milestone: 'v1.9',
      milestoneName: 'Code Quality',
      status: 'executing',
    });
    // No bar rendered when percent is absent.
    assert.equal(out, 'v1.9 Code Quality · executing');
  });
});

// ─── renderProgressBar (exported indirectly via formatGsdState behavior) ────

describe('progress bar rendering', () => {
  test('0% renders 10 empty segments', () => {
    // percent=0 doesn't trigger Scene 3 (only percent='100' does), so
    // Scene 4 fallback fires with no extra parts — just milestone + bar.
    const out = formatGsdState({ milestone: 'v2.0', percent: '0' });
    assert.ok(out.includes('[░░░░░░░░░░] 0%'));
  });

  test('50% renders 5 filled + 5 empty', () => {
    const out = formatGsdState({ milestone: 'v2.0', percent: '50' });
    assert.ok(out.includes('[█████░░░░░] 50%'));
  });

  test('100% renders 10 filled (and triggers Scene 3)', () => {
    const out = formatGsdState({ milestone: 'v2.0', percent: '100' });
    assert.equal(out, 'v2.0 [██████████] 100% · milestone complete');
  });

  test('percent absent → no bar rendered (opt-in)', () => {
    const out = formatGsdState({ milestone: 'v2.0', status: 'executing' });
    assert.ok(!out.includes('['));
    assert.ok(!out.includes('░'));
    assert.ok(!out.includes('█'));
  });

  test('percent over 100 clamps to 100', () => {
    const out = formatGsdState({ milestone: 'v2.0', percent: '150' });
    assert.ok(out.includes('[██████████] 100%'));
  });

  test('percent below 0 clamps to 0', () => {
    const out = formatGsdState({ milestone: 'v2.0', percent: '-10' });
    assert.ok(out.includes('[░░░░░░░░░░] 0%'));
  });
});

// ─── Scene priority — first-match-wins guarantee ────────────────────────────

describe('formatGsdState #2833 scene priority', () => {
  test('active_phase wins over next_action when both populated', () => {
    // active_phase populated should win — orchestrator is in flight,
    // any "next" recommendation would be misleading.
    const out = formatGsdState({
      milestone: 'v2.0',
      status: 'executing',
      activePhase: '4.5',
      nextAction: 'execute-phase',
      nextPhases: ['4.5'],
    });
    assert.ok(out.includes('Phase 4.5 executing'));
    assert.ok(!out.includes('next execute-phase'));
  });

  test('next_action wins over Scene 4 fallback when active_phase null', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      status: 'in_progress',  // would be Scene 4 fallback alone
      activePhase: null,
      nextAction: 'execute-phase',
      nextPhases: ['4.5'],
      phaseNum: '1',
      phaseTotal: '5',
    });
    assert.ok(out.includes('next execute-phase 4.5'));
    assert.ok(!out.includes('in_progress'));
    assert.ok(!out.includes('1/5'));
  });

  test('percent=100 wins over Scene 4 even with phase set', () => {
    const out = formatGsdState({
      milestone: 'v2.0',
      percent: '100',
      phaseNum: '1',
      phaseTotal: '5',
    });
    assert.ok(out.includes('milestone complete'));
    assert.ok(!out.includes('1/5'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2937-statusline-context-position.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2937-statusline-context-position (consolidation epic #1969 B5 #1974)", () => {
'use strict';

/**
 * Enhancement #2937 — statusline opt-in `context_position` config.
 *
 * Asserts that:
 *   - VALID_CONFIG_KEYS registers statusline.context_position (parity guard)
 *   - Default (no config) renders ctx at tail — "end" layout
 *   - Explicit "end" is byte-identical to default (regression guard)
 *   - Explicit "front" puts ctx after model, before first " │ "
 *   - Empty ctx with "front" leaves no stray separator
 *   - Invalid value (e.g. "middle") silently falls back to "end" at runtime
 *   - gsdUpdate warning stays leftmost in both "front" and "end" modes
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { composeStatusline } = require('../hooks/gsd-statusline.js');
const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ── Parity guard ─────────────────────────────────────────────────────────────

test('config schema registers statusline.context_position', () => {
  assert.ok(
    VALID_CONFIG_KEYS.has('statusline.context_position'),
    'statusline.context_position must be in VALID_CONFIG_KEYS',
  );
});

// ── Default / "end" layout ───────────────────────────────────────────────────

test('default (no position arg) renders ctx at tail — end layout', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const out = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx });
  // ctx should appear after dirname, not before first │
  const dirIdx = out.indexOf('myproject');
  const ctxIdx = out.indexOf(ctx);
  assert.ok(ctxIdx > dirIdx, `ctx should be after dirname; got: ${out}`);
});

test('explicit "end" is byte-identical to default', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const args = { model: 'Claude', dirname: 'myproject', ctx };
  const defaultOut = composeStatusline(args);
  const endOut = composeStatusline({ ...args, position: 'end' });
  assert.strictEqual(endOut, defaultOut, 'explicit "end" must equal default output');
});

test('"end" with middle segment places ctx after dirname', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const out = composeStatusline({ model: 'Claude', ctx, middle: 'doing work', dirname: 'proj', position: 'end' });
  const dirIdx = out.indexOf('proj');
  const ctxIdx = out.indexOf(ctx);
  assert.ok(ctxIdx > dirIdx, `ctx should be after dirname in end mode; got: ${out}`);
});

// ── "front" layout ───────────────────────────────────────────────────────────

test('"front" puts ctx after model name, before first │', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const out = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx, position: 'front' });
  const firstPipe = out.indexOf(' │ ');
  const ctxIdx = out.indexOf(ctx);
  assert.ok(ctxIdx !== -1, `ctx should appear in output; got: ${out}`);
  assert.ok(ctxIdx < firstPipe, `ctx should come before first │ in front mode; got: ${out}`);
});

test('"front" with middle segment: ctx after model, before first │', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const out = composeStatusline({ model: 'Claude', ctx, middle: 'doing work', dirname: 'proj', position: 'front' });
  const firstPipe = out.indexOf(' │ ');
  const ctxIdx = out.indexOf(ctx);
  assert.ok(ctxIdx < firstPipe, `ctx must precede first │; got: ${out}`);
});

// ── Empty ctx ────────────────────────────────────────────────────────────────

test('empty ctx + "front" renders no stray separator', () => {
  const out = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx: '', position: 'front' });
  // Should not have double-separator or leading │
  assert.ok(!out.includes(' │  │ '), `stray separator found; got: ${out}`);
  // Should still contain the single separator between model area and dirname
  assert.ok(out.includes(' │ '), `expected at least one separator; got: ${out}`);
});

test('empty ctx + "end" renders no stray separator', () => {
  const out = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx: '', position: 'end' });
  assert.ok(!out.includes(' │  │ '), `stray separator found; got: ${out}`);
});

// ── Invalid value fallback ───────────────────────────────────────────────────

test('invalid position value silently falls back to "end" layout', () => {
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const invalid = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx, position: 'middle' });
  const end = composeStatusline({ model: 'Claude', dirname: 'myproject', ctx, position: 'end' });
  assert.strictEqual(invalid, end, `invalid position should produce same output as "end"; got: ${invalid}`);
});

test('invalid position "banana" silently falls back to "end"', () => {
  const ctx = ' \x1b[33m██████░░░░ 60%\x1b[0m';
  const invalid = composeStatusline({ model: 'Claude', dirname: 'proj', ctx, position: 'banana' });
  const end = composeStatusline({ model: 'Claude', dirname: 'proj', ctx, position: 'end' });
  assert.strictEqual(invalid, end, `invalid "banana" should fall back to "end"; got: ${invalid}`);
});

// ── gsdUpdate leftmost invariant ─────────────────────────────────────────────

test('gsdUpdate warning is leftmost in "end" mode', () => {
  const gsdUpdate = '\x1b[33m⬆ /gsd:update\x1b[0m │ ';
  const out = composeStatusline({ gsdUpdate, model: 'Claude', dirname: 'proj', position: 'end' });
  assert.ok(out.startsWith(gsdUpdate), `gsdUpdate should be leftmost in end mode; got: ${out}`);
});

test('gsdUpdate warning is leftmost in "front" mode', () => {
  const gsdUpdate = '\x1b[33m⬆ /gsd:update\x1b[0m │ ';
  const ctx = ' \x1b[32m████░░░░░░ 40%\x1b[0m';
  const out = composeStatusline({ gsdUpdate, model: 'Claude', dirname: 'proj', ctx, position: 'front' });
  assert.ok(out.startsWith(gsdUpdate), `gsdUpdate should be leftmost in front mode; got: ${out}`);
});

// ── CLI write-path enforcement (config-set rejects invalid enum) ─────────────
// Locked design: hard reject at config-set time AND silent fallback at runtime.
// The runtime fallback is covered by the "Invalid position value silently falls
// back" tests above. This test covers the other half — that the CLI write path
// actually refuses to persist an invalid value in the first place.

test('config-set rejects invalid statusline.context_position', () => {
  const tmpDir = createTempProject();
  try {
    const r = runGsdTools(
      ['config-set', 'statusline.context_position', 'middle'],
      tmpDir,
    );
    assert.equal(
      r.success,
      false,
      `config-set should exit non-zero on invalid enum; got success=${r.success}, output=${r.output}`,
    );
    assert.ok(
      /statusline\.context_position|Invalid/i.test(r.error),
      `stderr must reference key or "Invalid"; got: ${r.error}`,
    );
  } finally {
    cleanup(tmpDir);
  }
});

// Same write-path enforcement for the boolean statusline.show_context_tokens
// key (#2161) — mirrors the workflow.post_planning_gaps precedent the issue's
// scope names (tests/post-planning-gaps-2493.test.cjs).
test('config-set statusline.show_context_tokens true → persisted as boolean', () => {
  const tmpDir = createTempProject();
  try {
    const r = runGsdTools(['config-set', 'statusline.show_context_tokens', 'true'], tmpDir);
    assert.ok(r.success, r.error);
    const config = JSON.parse(
      fs.readFileSync(path.join(tmpDir, '.planning', 'config.json'), 'utf-8'));
    assert.strictEqual(config.statusline.show_context_tokens, true);
  } finally {
    cleanup(tmpDir);
  }
});

test('config-set statusline.show_context_tokens yes → rejected', () => {
  const tmpDir = createTempProject();
  try {
    const r = runGsdTools(['config-set', 'statusline.show_context_tokens', 'yes'], tmpDir);
    assert.equal(r.success, false, 'non-boolean value must be rejected');
    assert.match(r.error || r.output, /boolean|true|false/i);
  } finally {
    cleanup(tmpDir);
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Context meter token count (statusline.show_context_tokens)
// ────────────────────────────────────────────────────────────────────────
{
  const { test, describe } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
  const { cleanup } = require('./helpers.cjs');
  const { formatTokens, contextTokenSuffix } = require('../hooks/gsd-statusline.js');
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

  describe('config schema: statusline.show_context_tokens', () => {
    test('registers statusline.show_context_tokens', () => {
      assert.ok(
        VALID_CONFIG_KEYS.has('statusline.show_context_tokens'),
        'statusline.show_context_tokens must be in VALID_CONFIG_KEYS',
      );
    });
  });

  describe('formatTokens', () => {
    test('passes small counts through', () => {
      assert.equal(formatTokens(0), '0');
      assert.equal(formatTokens(999), '999');
    });
    test('rounds thousands to k', () => {
      assert.equal(formatTokens(1000), '1k');
      assert.equal(formatTokens(156342), '156k');
      assert.equal(formatTokens(156700), '157k');
    });
    test('formats millions with one decimal', () => {
      assert.equal(formatTokens(1000000), '1.0M');
      assert.equal(formatTokens(1234567), '1.2M');
    });
    test('k-to-M threshold boundary: limit-1 / limit / limit+1', () => {
      // 999,999 k-rounds to 1000 — must promote to the M branch, never "1000k"
      assert.equal(formatTokens(999999), '1.0M');
      assert.equal(formatTokens(1000000), '1.0M');
      assert.equal(formatTokens(1000001), '1.0M');
      // 999,499 is the last value that still k-rounds below 1000
      assert.equal(formatTokens(999499), '999k');
      assert.equal(formatTokens(999500), '1.0M');
    });
  });

  describe('contextTokenSuffix', () => {
    test('returns empty string for absent/malformed usage', () => {
      assert.equal(contextTokenSuffix(null), '');
      assert.equal(contextTokenSuffix(undefined), '');
      assert.equal(contextTokenSuffix('nope'), '');
      assert.equal(contextTokenSuffix({}), '');
    });
    test('sums all four token dimensions', () => {
      const suffix = contextTokenSuffix({
        input_tokens: 1000,
        cache_creation_input_tokens: 2000,
        cache_read_input_tokens: 150000,
        output_tokens: 3000,
      });
      assert.equal(suffix, ' (156k)');
    });
    test('tolerates missing dimensions', () => {
      assert.equal(contextTokenSuffix({ input_tokens: 500 }), ' (500)');
    });
  });

  describe('statusline output token suffix (e2e)', () => {
    function makeProject(flag) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-tokens-'));
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      if (flag !== undefined) {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ statusline: { show_context_tokens: flag } }),
        );
      }
      return dir;
    }

    function runHook(dir) {
      const payload = JSON.stringify({
        model: { display_name: 'Claude' },
        workspace: { current_dir: dir },
        session_id: `test-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        context_window: {
          remaining_percentage: 70,
          total_tokens: 200000,
          current_usage: {
            input_tokens: 1000,
            cache_read_input_tokens: 150000,
            output_tokens: 5000,
          },
        },
      });
      const r = runHookSeam(hookPath, [], { input: payload, timeoutMs: 4000 });
      // eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences from captured CLI output
      return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    }

    test('flag=true appends the token count after the percentage', () => {
      const dir = makeProject(true);
      try {
        const out = runHook(dir);
        assert.match(out, /% \(156k\)/, `expected "(156k)" after the meter %; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });

    test('default (flag absent) meter is unchanged — no token count', () => {
      const dir = makeProject(undefined);
      try {
        const out = runHook(dir);
        assert.doesNotMatch(out, /\(\d+(?:\.\d+)?[kM]?\)/, `expected no token suffix; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });

    test('flag=false meter is unchanged — no token count', () => {
      const dir = makeProject(false);
      try {
        const out = runHook(dir);
        assert.doesNotMatch(out, /\(\d+(?:\.\d+)?[kM]?\)/, `expected no token suffix; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });
  });
}


// ────────────────────────────────────────────────────────────────────────
// Compact GSD-state format (statusline.state_format)
// ────────────────────────────────────────────────────────────────────────
{
  const { test, describe } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
  const statusline = require('../hooks/gsd-statusline.js');
  const { shortGsdStatus, formatGsdStateCompact, formatGsdState } = statusline;
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  describe('config schema: statusline.state_format', () => {
    test('registers statusline.state_format', () => {
      assert.ok(
        VALID_CONFIG_KEYS.has('statusline.state_format'),
        'statusline.state_format must be in VALID_CONFIG_KEYS',
      );
    });
    // Direct config-set write-path coverage, mirroring the sibling
    // context_position tests (the ENUM_KEYS matrix covers only the JSON
    // coercion-bypass shapes, not the plain-string paths).
    test('config-set accepts "compact" and rejects an invalid plain string', () => {
      const tmpDir = createTempProject();
      try {
        const ok = runGsdTools(['config-set', 'statusline.state_format', 'compact'], tmpDir);
        assert.ok(ok.success, ok.error);
        const bad = runGsdTools(['config-set', 'statusline.state_format', 'tiny'], tmpDir);
        assert.equal(bad.success, false, 'invalid enum value must be rejected');
        assert.ok(
          /statusline\.state_format|Invalid/i.test(bad.error),
          `stderr must reference key or "Invalid"; got: ${bad.error}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    });
  });

  describe('shortGsdStatus', () => {
    test('returns null for empty input', () => {
      assert.equal(shortGsdStatus(null), null);
      assert.equal(shortGsdStatus(''), null);
      assert.equal(shortGsdStatus(undefined), null);
    });
    test('paused — the canonical stuck state — renders uppercase (#2162 condition)', () => {
      // The #2162 shout applies to the canonical token, which is what the
      // state writer persists (#4186 anchored vocabulary).
      assert.equal(shortGsdStatus('paused'), 'PAUSED');
      assert.equal(shortGsdStatus('Paused'), 'PAUSED');
      // #4186: narrative prose is no longer keyword-guessed — a paused-led
      // narrative renders its first word (visible, never a silent wrong
      // token), so the shout is reserved for the recognized token itself.
      assert.equal(shortGsdStatus('paused — waiting on credentials'), 'paused');
      assert.equal(shortGsdStatus('stopped by user'), 'stopped');
    });
    test('collapses vocabulary values to canonical keywords via normalizeStateStatus (#4186 anchored)', () => {
      // #4186: normalizeStateStatus recognizes the DECLARED vocabulary
      // (whole-field match), so exactly those values collapse to keywords.
      assert.equal(shortGsdStatus('Executing Phase 7'), 'executing');
      assert.equal(shortGsdStatus('ready to plan'), 'planning');
      assert.equal(shortGsdStatus('Discussing'), 'discussing');
      assert.equal(shortGsdStatus('Verifying Phase 2'), 'verifying');
      assert.equal(shortGsdStatus('Work complete'), 'Work');
      // Narrative prose — vocabulary words embedded in longer sentences — is
      // no longer guessed at (a `.planning/` mention in non-English prose
      // used to render `planning`); it falls back to the first word.
      assert.equal(shortGsdStatus('Executing phase 7 of the parser milestone'), 'Executing');
      assert.equal(shortGsdStatus('Ready to plan next phase'), 'Ready');
    });
    test('matches the canonical vocabulary exactly — no drift from normalizeStateStatus', () => {
      const { normalizeStateStatus } = require('../gsd-core/bin/lib/state-document.cjs');
      for (const canonical of ['discussing', 'planning', 'executing', 'verifying', 'completed', 'paused']) {
        const rendered = shortGsdStatus(canonical);
        const expected = canonical === 'paused' ? 'PAUSED' : canonical;
        assert.equal(rendered, expected);
        assert.equal(normalizeStateStatus(canonical, null), canonical,
          `canonical vocabulary changed upstream: ${canonical}`);
      }
    });
    test('unknown shapes fall back to the first word, capped at 16 chars', () => {
      assert.equal(shortGsdStatus('reticulating splines'), 'reticulating');
      assert.equal(shortGsdStatus('supercalifragilisticexpialidocious state'), 'supercalifragili');
    });
    test('16-char cap boundary: limit-1 / limit / limit+1', () => {
      assert.equal(shortGsdStatus('x'.repeat(15)), 'x'.repeat(15));
      assert.equal(shortGsdStatus('x'.repeat(16)), 'x'.repeat(16));
      assert.equal(shortGsdStatus('x'.repeat(17)), 'x'.repeat(16));
    });
  });

  describe('formatGsdStateCompact', () => {
    test('renders version · phase/total · status', () => {
      const out = formatGsdStateCompact({
        milestone: 'v1.12', phaseNum: '7', phaseTotal: '12',
        status: 'Executing Phase 7',
      });
      assert.equal(out, 'v1.12 · P7/12 · executing');
      // #4186: narrative status is not keyword-guessed — first word renders.
      const narrative = formatGsdStateCompact({
        milestone: 'v1.12', phaseNum: '7', phaseTotal: '12',
        status: 'Executing phase 7 — building the parser',
      });
      assert.equal(narrative, 'v1.12 · P7/12 · Executing');
    });
    test('prefers lifecycle active_phase over body phase number', () => {
      const out = formatGsdStateCompact({
        milestone: 'v2.0', activePhase: '4.5', phaseNum: '4', status: 'executing',
      });
      assert.equal(out, 'v2.0 · P4.5 · executing');
    });
    test('paused state renders uppercase in the compact line', () => {
      const out = formatGsdStateCompact({
        milestone: 'v2.0', activePhase: '4.5', status: 'paused',
      });
      assert.equal(out, 'v2.0 · P4.5 · PAUSED');
    });
    test('milestone completion renders "complete"', () => {
      assert.equal(formatGsdStateCompact({ milestone: 'v2.0', percent: '100' }), 'v2.0 · complete');
      assert.equal(
        formatGsdStateCompact({ milestone: 'v2.0', completedPhases: '5', totalPhases: '5' }),
        'v2.0 · complete');
    });
    test('scene exclusivity: an in-flight phase wins over milestone-complete', () => {
      // Non-atomic STATE.md edits can leave active_phase populated alongside
      // percent=100 — the compact format must mirror formatGsdState's
      // if/else-chain precedence (Scene 1 beats Scene 3), never render both.
      const state = {
        milestone: 'v2.0', activePhase: '4.5', percent: '100', status: 'executing',
      };
      assert.equal(formatGsdStateCompact(state), 'v2.0 · P4.5 · executing');
      const full = formatGsdState(state);
      assert.ok(!/(complete)/.test(full) || !/4\.5/.test(full),
        `full format must not co-render phase and complete either; got: ${full}`);
      // The legacy body-phase shape (phaseNum, no activePhase) does NOT hold
      // completion back — formatGsdState reaches Scene 3 on percent=100
      // regardless of phaseNum, and compact must agree (#2175 re-review Major).
      const legacyDone = { milestone: 'v2.0', phaseNum: '5', phaseTotal: '5', percent: '100', status: 'verifying' };
      assert.equal(formatGsdStateCompact(legacyDone), 'v2.0 · P5/5 · complete');
      assert.ok(formatGsdState(legacyDone).includes('milestone complete'),
        'parity: full format must render Scene 3 for the same input');
    });
    test('parity: both renderers agree on completion for the same input', () => {
      // Feed identical state objects to both renderers and require they agree
      // on whether the milestone reads as complete — the drift guard for the
      // parallel rendering surfaces.
      const cases = [
        { milestone: 'v2.0', percent: '100' },
        { milestone: 'v2.0', phaseNum: '5', phaseTotal: '5', percent: '100', status: 'verifying' },
        { milestone: 'v2.0', completedPhases: '5', totalPhases: '5' },
        { milestone: 'v2.0', activePhase: '4.5', percent: '100', status: 'executing' },
        { milestone: 'v1.9', percent: '40', status: 'executing', phaseNum: '2', phaseTotal: '5' },
        // #3945: the vacuous 0-of-0 shape must agree on NOT-complete too.
        { milestone: 'v1.15', status: 'planning', completedPhases: '0', totalPhases: '0', percent: '0' },
      ];
      for (const s of cases) {
        const fullDone = formatGsdState(s).includes('milestone complete');
        const compactDone = / complete$|^complete$/.test(formatGsdStateCompact(s));
        assert.equal(compactDone, fullDone,
          `completion parity diverged for ${JSON.stringify(s)}`);
      }
    });
    test('compact — 0 of 0 counters does not render complete (#3945)', () => {
      // Same vacuous-equality defect as the full renderer's Scene 3; the
      // compact completion branch must also require a non-empty denominator.
      const out = formatGsdStateCompact({
        milestone: 'v1.15', status: 'planning',
        completedPhases: '0', totalPhases: '0', percent: '0',
      });
      assert.ok(!/(^|\s)complete(\s|$)/.test(out),
        `0 of 0 phases must not read as complete in compact; got: ${out}`);
      assert.ok(out.includes('planning'), `compact should render the status; got: ${out}`);
    });

    test('idle with queued next action renders "next <action> <phases>"', () => {
      const out = formatGsdStateCompact({
        milestone: 'v2.0', nextAction: 'execute-phase', nextPhases: ['4.5', '4.6'],
      });
      assert.equal(out, 'v2.0 · next execute-phase 4.5/4.6');
    });
    test('empty state renders empty string', () => {
      assert.equal(formatGsdStateCompact({}), '');
    });
    test('drops the milestone name and progress bar the full format shows', () => {
      const state = {
        milestone: 'v1.9', milestoneName: 'Code Quality', percent: '40',
        status: 'executing', phaseNum: '2', phaseTotal: '5',
      };
      const full = formatGsdState(state);
      const compact = formatGsdStateCompact(state);
      assert.ok(full.includes('Code Quality'), `full keeps name; got: ${full}`);
      assert.ok(!compact.includes('Code Quality'), `compact drops name; got: ${compact}`);
      assert.ok(!compact.includes('█'), `compact drops bar; got: ${compact}`);
    });
  });

  describe('state_format via renderStatusline', () => {
    function makeProject(stateFormat) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-fmt-'));
      fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
      if (stateFormat !== undefined) {
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ statusline: { state_format: stateFormat } }),
        );
      }
      fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), [
        '---',
        'milestone: v1.9',
        'milestone_name: Code Quality',
        'status: executing',
        '---',
        '',
        'Phase: 2 of 5 (parser-rewrite)',
        '',
      ].join('\n'));
      return dir;
    }

    test('compact format drops the milestone name', () => {
      const dir = makeProject('compact');
      try {
        const out = statusline.renderStatusline({
          model: { display_name: 'Claude' },
          workspace: { current_dir: dir },
        });
        assert.ok(out.includes('v1.9 · P2/5 · executing'), `expected compact state; got: ${out}`);
        assert.ok(!out.includes('Code Quality'), `expected no milestone name; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });

    test('default (key absent) keeps the full format unchanged', () => {
      const dir = makeProject(undefined);
      try {
        const out = statusline.renderStatusline({
          model: { display_name: 'Claude' },
          workspace: { current_dir: dir },
        });
        assert.ok(out.includes('Code Quality'), `expected full format; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });

    test('explicit "full" matches the default rendering', () => {
      const dirDefault = makeProject(undefined);
      const dirFull = makeProject('full');
      try {
        const input = (dir) => ({
          model: { display_name: 'Claude' },
          workspace: { current_dir: dir },
        });
        const a = statusline.renderStatusline(input(dirDefault));
        const b = statusline.renderStatusline(input(dirFull));
        // Same STATE.md content → same rendered middle segment (the trailing
        // directory basename differs per temp dir, so compare with it removed)
        assert.equal(
          a.replace(path.basename(dirDefault), ''),
          b.replace(path.basename(dirFull), ''));
      } finally {
        cleanup(dirDefault);
        cleanup(dirFull);
      }
    });
  });
}


// ────────────────────────────────────────────────────────────────────────
// Compact 1M model badge
// ────────────────────────────────────────────────────────────────────────
{
  const { test, describe } = require('node:test');
  const assert = require('node:assert/strict');
  const statusline = require('../hooks/gsd-statusline.js');
  const { compactModelName } = statusline;

  describe('compactModelName', () => {
    test('collapses "(1M context)" to "(1M)"', () => {
      assert.equal(compactModelName('Sonnet 4.5 (1M context)'), 'Sonnet 4.5 (1M)');
    });
    test('is case-insensitive on "context" and preserves the token case', () => {
      assert.equal(compactModelName('Opus 4.6  (1m CONTEXT)'), 'Opus 4.6 (1m)');
    });
    test('tolerates future window sizes (#2160 approval condition)', () => {
      assert.equal(compactModelName('Sonnet 5 (500K context)'), 'Sonnet 5 (500K)');
      assert.equal(compactModelName('Opus 5 (2M context)'), 'Opus 5 (2M)');
    });
    test('handles the abbreviated "ctx" variant (#2160 approval condition)', () => {
      assert.equal(compactModelName('Sonnet 4.5 (1M ctx)'), 'Sonnet 4.5 (1M)');
      assert.equal(compactModelName('Opus 5 (2M CTX)'), 'Opus 5 (2M)');
    });
    test('leaves non-context parentheticals untouched', () => {
      assert.equal(compactModelName('Sonnet 5 (beta)'), 'Sonnet 5 (beta)');
      assert.equal(compactModelName('Opus 4 (deprecated)'), 'Opus 4 (deprecated)');
    });
    test('leaves ordinary names unchanged', () => {
      assert.equal(compactModelName('Claude'), 'Claude');
      assert.equal(compactModelName('Sonnet 4.5'), 'Sonnet 4.5');
    });
    test('only matches the suffix position', () => {
      assert.equal(
        compactModelName('(1M context) Special'), '(1M context) Special');
    });
    test('passes non-strings through', () => {
      assert.equal(compactModelName(undefined), undefined);
      assert.equal(compactModelName(null), null);
    });
  });

  describe('renderStatusline uses the compact badge', () => {
    test('rendered output carries (1M), not (1M context)', () => {
      const out = statusline.renderStatusline({
        model: { display_name: 'Sonnet 4.5 (1M context)' },
        workspace: { current_dir: require('node:os').tmpdir() },
      });
      assert.ok(out.includes('Sonnet 4.5 (1M)'), `expected compact badge; got: ${out}`);
      assert.ok(!out.includes('(1M context)'), `expected no verbose suffix; got: ${out}`);
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Git segment (statusline.show_git)
// ────────────────────────────────────────────────────────────────────────
{
  const { test, describe } = require('node:test');
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
  const { gitOrThrow } = require('./helpers/git-fixture.cjs');
  const { cleanup } = require('./helpers.cjs');
  const statusline = require('../hooks/gsd-statusline.js');
  const { parseGitStatus, buildGitSegment, readGitStatus, composeStatusline } = statusline;
  const { VALID_CONFIG_KEYS } = require('../gsd-core/bin/lib/config-schema.cjs');

  describe('config schema: statusline.show_git', () => {
    test('registers statusline.show_git', () => {
      assert.ok(
        VALID_CONFIG_KEYS.has('statusline.show_git'),
        'statusline.show_git must be in VALID_CONFIG_KEYS',
      );
    });
  });

  describe('parseGitStatus', () => {
    test('returns null for non-string / missing branch header', () => {
      assert.equal(parseGitStatus(null), null);
      assert.equal(parseGitStatus(undefined), null);
      assert.equal(parseGitStatus(''), null);
      assert.equal(parseGitStatus('? some-file\n'), null);
    });

    test('parses a clean, in-sync branch', () => {
      const text = [
        '# branch.oid abc123',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +0 -0',
        '',
      ].join('\n');
      assert.deepEqual(parseGitStatus(text), {
        branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0,
      });
    });

    test('counts staged, unstaged, untracked, ahead, behind', () => {
      const text = [
        '# branch.oid abc123',
        '# branch.head feat/x',
        '# branch.upstream origin/feat/x',
        '# branch.ab +2 -1',
        '1 M. N... 100644 100644 100644 aaa bbb staged-only.txt',
        '1 .M N... 100644 100644 100644 aaa bbb unstaged-only.txt',
        '1 MM N... 100644 100644 100644 aaa bbb both.txt',
        '2 R. N... 100644 100644 100644 aaa bbb R100 new.txt\told.txt',
        '? untracked-1.txt',
        '? untracked-2.txt',
        '',
      ].join('\n');
      assert.deepEqual(parseGitStatus(text), {
        branch: 'feat/x', ahead: 2, behind: 1, staged: 3, unstaged: 2, untracked: 2,
      });
    });

    test('counts unmerged (conflict) entries as unstaged', () => {
      const text = [
        '# branch.head main',
        'u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt',
        '',
      ].join('\n');
      const info = parseGitStatus(text);
      assert.equal(info.unstaged, 1);
      assert.equal(info.staged, 0);
    });

    test('detached HEAD passes through as "(detached)"', () => {
      const text = '# branch.head (detached)\n';
      assert.equal(parseGitStatus(text).branch, '(detached)');
    });

    test('no upstream (no branch.ab line) leaves ahead/behind at 0', () => {
      const text = '# branch.head local-only\n? new.txt\n';
      const info = parseGitStatus(text);
      assert.deepEqual([info.ahead, info.behind, info.untracked], [0, 0, 1]);
    });
  });

  describe('buildGitSegment', () => {
    const strip = (s) =>
      // eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences to assert on visible text
      s.replace(/\x1b\[[0-9;]*m/g, '');

    test('returns empty string for null info', () => {
      assert.equal(buildGitSegment(null), '');
      assert.equal(buildGitSegment({}), '');
    });

    test('clean repo renders branch with a check mark', () => {
      const seg = buildGitSegment({ branch: 'main', ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
      assert.equal(strip(seg), ' │ main✓');
    });

    test('dirty repo renders each nonzero marker in order', () => {
      const seg = buildGitSegment({ branch: 'feat/x', ahead: 2, behind: 1, staged: 3, unstaged: 2, untracked: 4 });
      assert.equal(strip(seg), ' │ feat/x+3~2?4↑2↓1');
    });

    test('omits zero markers', () => {
      const seg = buildGitSegment({ branch: 'main', ahead: 1, behind: 0, staged: 0, unstaged: 0, untracked: 0 });
      assert.equal(strip(seg), ' │ main↑1');
    });
  });

  describe('readGitStatus + parseGitStatus against a real repo', () => {
    function makeGitRepo() {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seg-'));
      const run = (args) => gitOrThrow(['-C', dir, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      run(['init', '-q', '-b', 'main']);
      run(['config', 'user.email', 'test@test.invalid']);
      run(['config', 'user.name', 'Test']);
      return { dir, run };
    }

    test('non-repo directory yields null', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seg-plain-'));
      try {
        assert.equal(parseGitStatus(readGitStatus(dir)), null);
      } finally {
        cleanup(dir);
      }
    });

    // Deterministic IO-failure injection (repo convention, cf. the fs
    // monkeypatch in ensure-runtime-build.test.cjs): readGitStatus shares the
    // one cached child_process module object, so replacing execFileSync here
    // injects the failure without a real hang or oversized repo.
    test('maxBuffer overflow degrades to null (segment absent)', () => {
      const childProcess = require('node:child_process');
      const original = childProcess.execFileSync;
      childProcess.execFileSync = () => {
        const err = new RangeError('stdout maxBuffer length exceeded');
        err.code = 'ERR_CHILD_PROCESS_STDOUT_MAXBUFFER';
        throw err;
      };
      try {
        assert.equal(readGitStatus('/tmp'), null);
      } finally {
        childProcess.execFileSync = original;
      }
    });

    test('spawn timeout degrades to null (segment absent)', () => {
      const childProcess = require('node:child_process');
      const original = childProcess.execFileSync;
      childProcess.execFileSync = () => {
        const err = new Error('spawnSync git ETIMEDOUT');
        err.code = 'ETIMEDOUT';
        err.errno = -110;
        throw err;
      };
      try {
        assert.equal(readGitStatus('/tmp'), null);
      } finally {
        childProcess.execFileSync = original;
      }
    });

    test('fresh repo with an untracked file is counted', () => {
      const { dir } = makeGitRepo();
      try {
        fs.writeFileSync(path.join(dir, 'new.txt'), 'hello');
        const info = parseGitStatus(readGitStatus(dir));
        assert.equal(info.branch, 'main');
        assert.equal(info.untracked, 1);
        assert.equal(info.staged, 0);
      } finally {
        cleanup(dir);
      }
    });

    test('staged and committed states are reflected', () => {
      const { dir, run } = makeGitRepo();
      try {
        fs.writeFileSync(path.join(dir, 'a.txt'), '1');
        run(['add', 'a.txt']);
        let info = parseGitStatus(readGitStatus(dir));
        assert.equal(info.staged, 1);
        run(['commit', '-q', '-m', 'init']);
        info = parseGitStatus(readGitStatus(dir));
        assert.deepEqual(
          [info.staged, info.unstaged, info.untracked], [0, 0, 0]);
      } finally {
        cleanup(dir);
      }
    });
  });

  describe('composeStatusline gitSuffix placement', () => {
    test('git segment renders after the directory in end layout', () => {
      const out = composeStatusline({
        model: 'Claude', dirname: 'proj',
        gitSuffix: ' │ main✓', ctx: ' CTX', lastCmdSuffix: ' │ last: /foo',
      });
      assert.ok(
        out.includes('proj\x1b[0m │ main✓ CTX │ last: /foo'),
        `expected dir → git → ctx → last-cmd order; got: ${out}`,
      );
    });
    test('git segment renders after the directory in front layout', () => {
      const out = composeStatusline({
        model: 'Claude', dirname: 'proj',
        gitSuffix: ' │ main✓', position: 'front',
      });
      assert.ok(out.endsWith('proj\x1b[0m │ main✓'), `got: ${out}`);
    });
    test('default (no gitSuffix) output is unchanged', () => {
      const a = composeStatusline({ model: 'Claude', dirname: 'proj' });
      const b = composeStatusline({ model: 'Claude', dirname: 'proj', gitSuffix: '' });
      assert.equal(a, b);
    });
  });

  describe('show_git e2e through the hook', () => {
    const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');

    function runHook(dir) {
      const payload = JSON.stringify({
        model: { display_name: 'Claude' },
        workspace: { current_dir: dir },
        session_id: `test-git-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      });
      const r = runHookSeam(hookPath, [], { input: payload, timeoutMs: 4000 });
      // eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences from captured CLI output
      return r.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    }

    test('flag=true renders the branch segment', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seg-e2e-'));
      try {
        gitOrThrow(['-C', dir, 'init', '-q', '-b', 'main']);
        fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
        fs.writeFileSync(
          path.join(dir, '.planning', 'config.json'),
          JSON.stringify({ statusline: { show_git: true } }),
        );
        const out = runHook(dir);
        assert.ok(out.includes('│ main'), `expected branch segment; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });

    test('default (flag absent) has no git segment', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seg-e2e-'));
      try {
        gitOrThrow(['-C', dir, 'init', '-q', '-b', 'main']);
        fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
        const out = runHook(dir);
        assert.ok(!out.includes('│ main'), `expected no git segment; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-607-cache-lineage.test.cjs — H3 Wave 5 (#3337)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-607-cache-lineage (H3 Wave 5 #3337)', () => {
'use strict';

/**
 * Tests for cache lineage validation (issue #607).
 *
 * Verifies that per-package cache filenames and package_name lineage guards
 * are correctly enforced across gsd-update-banner.js, gsd-statusline.js,
 * and the worker result shape.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { PACKAGE_NAME, updateCacheFileName } = require('../gsd-core/bin/lib/package-identity.cjs');
const { buildBannerOutput } = require('../hooks/gsd-update-banner.js');
const { evaluateUpdateCache } = require('../hooks/gsd-statusline.js');

// ─── Package identity constants ──────────────────────────────────────────────

describe('package-identity exports', () => {
  test('PACKAGE_NAME is @opengsd/gsd-core', () => {
    assert.equal(PACKAGE_NAME, '@opengsd/gsd-core');
  });

  test('updateCacheFileName is per-package filename', () => {
    assert.equal(updateCacheFileName, 'gsd-update-check-opengsd-gsd-core.json');
  });
});

// ─── Worker result shape: package_name field ─────────────────────────────────
// The worker writes { ..., package_name: PACKAGE_NAME } to the cache.
// We assert the documented contract by confirming PACKAGE_NAME is correct
// and that it equals the value that the worker will embed.

describe('worker result shape contract', () => {
  test('PACKAGE_NAME value matches the expected installed package', () => {
    // The worker adds package_name: PACKAGE_NAME to its result object.
    // This test asserts the value that will appear in the cache.
    assert.equal(PACKAGE_NAME, '@opengsd/gsd-core');
  });
});

// ─── buildBannerOutput: lineage guard ────────────────────────────────────────

describe('buildBannerOutput lineage guard', () => {
  test('returns null when package_name is present but foreign', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.42.3',
        package_name: 'get-shit-done-cc',
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null, 'foreign lineage must be rejected');
  });

  test('returns banner when package_name matches PACKAGE_NAME', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.3.0',
        package_name: '@opengsd/gsd-core',
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.ok(out, 'expected banner envelope for matching lineage');
    assert.equal(typeof out.systemMessage, 'string');
    assert.ok(out.systemMessage.includes('1.2.0'));
    assert.ok(out.systemMessage.includes('1.3.0'));
    assert.ok(out.systemMessage.includes('/gsd:update'));
  });

  test('returns null when package_name is absent (untrusted cache)', () => {
    const out = buildBannerOutput({
      cache: {
        update_available: true,
        installed: '1.2.0',
        latest: '1.3.0',
        // no package_name field
      },
      parseError: false,
      suppressFailureWarning: false,
    });
    assert.equal(out, null, 'absent package_name must be treated as untrusted → null');
  });
});

// ─── evaluateUpdateCache: lineage guard in statusline ────────────────────────

describe('evaluateUpdateCache lineage guard', () => {
  test('returns showUpdate=false when cache is null', () => {
    const r = evaluateUpdateCache(null);
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when package_name is absent (untrusted)', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when package_name is foreign', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
      package_name: 'some-other-package',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=true when update_available and package_name matches', () => {
    const r = evaluateUpdateCache({
      update_available: true,
      installed: '1.2.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
    });
    assert.equal(r.showUpdate, true);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns showUpdate=false when update_available=false', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
    });
    assert.equal(r.showUpdate, false);
    assert.equal(r.staleWarning, 'none');
  });

  test('returns staleWarning=stale when stale_hooks present and matching package_name', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '1.3.0' }],
    });
    assert.equal(r.staleWarning, 'stale');
  });

  test('returns staleWarning=dev when installed > latest (dev install) and matching package_name', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '2.0.0',
      latest: '1.3.0',
      package_name: '@opengsd/gsd-core',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '2.0.0' }],
    });
    assert.equal(r.staleWarning, 'dev');
  });

  test('returns staleWarning=none when stale_hooks present but package_name is foreign', () => {
    const r = evaluateUpdateCache({
      update_available: false,
      installed: '1.3.0',
      latest: '1.2.0',
      package_name: 'foreign-pkg',
      stale_hooks: [{ file: 'gsd-statusline.js', hookVersion: '1.2.0', installedVersion: '1.3.0' }],
    });
    assert.equal(r.staleWarning, 'none');
  });
});
  });
}

// ─── #3582: cold tree (no gsd-core/bin/lib/*.cjs) — degrade, not crash ─────
//
// gsd-core/bin/lib/semver-compare.cjs, package-identity.cjs,
// state-document.cjs, active-workstream-store.cjs, and planning-workspace.cjs
// are tsc build artifacts (ADR-457), gitignored and absent on a raw
// plugin-marketplace / git-clone install that never ran `npm run build:lib`.
// The statusline renders on EVERY prompt — before #3582 a missing library
// crashed the whole hook process at module load (bare "Cannot find module"),
// so Claude Code's statusline would show nothing AND emit a visible error on
// every single render. The fix: the spawned-as-a-script path
// (`require.main === module`) calls ensureRuntimeBuild() first and, on
// failure, writes empty stdout and exits 0 — the SAME quiet no-signal
// behavior every other internal failure in this hook already degrades to
// (see e.g. the `try { ... } catch (e) { /* Silent fail */ }` wrapping
// runStatusline's own body). Simulated hermetically via a fixture install
// tree that copies hooks/ + the seam module but never gsd-core/bin/lib/ or
// tsconfig.build.json (tests/helpers/cold-runtime-lib-fixture.cjs) — the REAL
// gsd-core/bin/lib/ is never touched.
{
  const { describe, test } = require('node:test');
  const assert = require('node:assert/strict');
  const os = require('node:os');
  const path = require('node:path');
  const { runHook: runHookSeam } = require('./helpers/process-seam.cjs');
  const { buildColdInstallTree } = require('./helpers/cold-runtime-lib-fixture.cjs');

  describe('gsd-statusline.js: #3582 cold tree — degrade to empty output, exit 0', () => {
    test('missing compiled runtime library -> empty stdout, exit 0, no crash', (t) => {
      const cold = buildColdInstallTree();
      t.after(cold.cleanup);

      const payload = JSON.stringify({
        model: { display_name: 'Claude' },
        workspace: { current_dir: os.tmpdir() },
        session_id: `test-3582-${Date.now()}`,
      });
      const r = runHookSeam(path.join(cold.hooksDir, 'gsd-statusline.js'), [], {
        input: payload,
        timeoutMs: 4000,
      });
      assert.equal(r.exitCode, 0, `must exit 0 on a build failure; stdout: ${r.stdout} stderr: ${r.stderr}`);
      assert.equal(r.stdout, '', 'must degrade to empty output, not throw a stack trace to stdout');
    });
  });
}

// ─── #2734: STATE.md freshness marker (failing-first — API does not exist yet) ─
//
// Test matrix: .gsd/phase/feat-2734-statusline-state-freshness/50-test-matrix.md
// Design:      .gsd/phase/feat-2734-statusline-state-freshness/40-design.md
//
// This block binds the new hook contract (STATE_HEAD_ADVISORY_COMMITS,
// isValidStateHeadStamp, parseRevListCounts, deriveStateFreshness,
// formatStateFreshness, resolveStatuslineOptions, readGsdState's opts arg,
// parseStateMd's stateHead field, and the renderers' freshness suffix) —
// none of it is implemented yet, so every test below is expected to fail
// (or error at call time) until the hook change lands.
{
  const {
    STATE_HEAD_ADVISORY_COMMITS, isValidStateHeadStamp, parseRevListCounts,
    deriveStateFreshness, formatStateFreshness, resolveStatuslineOptions,
  } = require('../hooks/gsd-statusline.js');
  const { createTempGitProject, createTempProject } = require('./helpers.cjs');
  const { gitOrThrow, GIT_FIXTURE_TIMEOUT_MS } = require('./helpers/git-fixture.cjs');
  const { runHook: runHookSeam, OUTCOME } = require('./helpers/process-seam.cjs');
  const childProcess = require('node:child_process');

  // Deterministic IO-failure / fake-response injection (repo convention —
  // never chmod 0o000, which root bypasses). Lives in a module-level helper,
  // never inline in a test body, per the repo's no-try/finally-in-tests rule.
  function withSpawnSpy(impl, body) {
    const original = childProcess.execFileSync;
    const calls = [];
    childProcess.execFileSync = (...args) => {
      calls.push(args);
      return impl(...args);
    };
    try {
      body(calls);
    } finally {
      childProcess.execFileSync = original;
    }
  }

  // Returns HEAD's sha BEFORE writing n filler commits, so the returned sha
  // is exactly n commits behind the new HEAD. Unique filenames per call so
  // multiple commitN() invocations against the same repo (e.g. two branches,
  // or a re-stamp mid-test) never collide.
  function commitN(dir, n) {
    const sha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
    for (let i = 0; i < n; i++) {
      const marker = `freshness-filler-${Date.now()}-${Math.random().toString(36).slice(2)}-${i}.txt`;
      fs.writeFileSync(path.join(dir, marker), String(i));
      gitOrThrow(['add', '-A'], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
      gitOrThrow(['commit', '-m', `filler ${i}`], { cwd: dir, timeoutMs: GIT_FIXTURE_TIMEOUT_MS });
    }
    return sha;
  }

  function writeConfig(dir, cfg) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(cfg));
  }

  // Writes a STATE.md carrying `state_head: <stateHeadValue>` and returns the
  // exact content string written, so callers can feed the same content to
  // parseStateMd() directly without a redundant readFileSync of a fixture file.
  function writeStateHead(dir, stateHeadValue, extraLines = []) {
    const content = [
      '---',
      'status: executing',
      ...extraLines,
      `state_head: ${stateHeadValue}`,
      '---',
      '',
      '# State',
    ].join('\n');
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), content);
    return content;
  }

  describe('gsd-statusline.js: #2734 STATE.md freshness marker', () => {
    // ─── rows 1-7: deriveStateFreshness threshold boundary ─────────────────

    describe('deriveStateFreshness: advisory threshold boundary', () => {
      test('rendersMarkerAtAdvisoryThreshold', (t) => {
        const dir = createTempGitProject('gsd-freshness-at-threshold-');
        t.after(() => cleanup(dir));
        const stamp = commitN(dir, STATE_HEAD_ADVISORY_COMMITS);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, STATE_HEAD_ADVISORY_COMMITS);
        assert.equal(ir.commit_stale, true);
        assert.equal(formatStateFreshness(ir), `state ~${STATE_HEAD_ADVISORY_COMMITS} commits back`);
      });

      test('omitsMarkerJustBelowThreshold', (t) => {
        const dir = createTempGitProject('gsd-freshness-below-threshold-');
        t.after(() => cleanup(dir));
        const n = STATE_HEAD_ADVISORY_COMMITS - 1;
        const stamp = commitN(dir, n);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, n);
        assert.equal(formatStateFreshness(ir), '');
      });

      test('rendersMarkerExactlyAtThreshold', (t) => {
        const dir = createTempGitProject('gsd-freshness-exact-threshold-');
        t.after(() => cleanup(dir));
        const stamp = commitN(dir, STATE_HEAD_ADVISORY_COMMITS);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.state_head, stamp.slice(0, 7));
        assert.equal(ir.commits_behind, STATE_HEAD_ADVISORY_COMMITS);
        assert.notEqual(formatStateFreshness(ir), '');
      });

      test('rendersMarkerJustAboveThreshold', (t) => {
        const dir = createTempGitProject('gsd-freshness-above-threshold-');
        t.after(() => cleanup(dir));
        const n = STATE_HEAD_ADVISORY_COMMITS + 1;
        const stamp = commitN(dir, n);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, n);
        assert.equal(formatStateFreshness(ir), `state ~${n} commits back`);
      });

      test('omitsMarkerWhenStampIsHead', (t) => {
        const dir = createTempGitProject('gsd-freshness-stamp-is-head-');
        t.after(() => cleanup(dir));
        const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, 0);
        assert.equal(ir.commit_stale, false);
        assert.equal(formatStateFreshness(ir), '');
      });

      test('omitsMarkerForCommitDocsOffByOne', (t) => {
        const dir = createTempGitProject('gsd-freshness-off-by-one-');
        t.after(() => cleanup(dir));
        const stamp = commitN(dir, 1);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, 1);
        assert.equal(ir.commit_stale, true);
        assert.equal(formatStateFreshness(ir), '', 'a single commit_docs restamp commit must not alarm');
      });

      test('rendersLargeCountUncapped', (t) => {
        const dir = createTempGitProject('gsd-freshness-large-count-');
        t.after(() => cleanup(dir));
        const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        withSpawnSpy(() => '0\t99999\n', () => {
          const ir = deriveStateFreshness(dir, stamp);
          assert.equal(ir.commits_behind, 99999);
          assert.equal(formatStateFreshness(ir), 'state ~99999 commits back');
        });
      });
    });

    // ─── rows 8-10: resolveStatuslineOptions flag gating ───────────────────

    describe('resolveStatuslineOptions: show_state_freshness gating', () => {
      test('omitsMarkerAndSpawnsNothingWhenFlagOff', (t) => {
        const dir = createTempGitProject('gsd-freshness-flag-off-');
        t.after(() => cleanup(dir));
        const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        writeStateHead(dir, stamp);
        assert.equal(resolveStatuslineOptions({}).showStateFreshness, false);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir);
          assert.equal('freshness' in state, false);
          assert.equal(calls.length, 0);
        });
      });

      test('defaultsToDisabledWhenKeyAbsent', () => {
        assert.equal(resolveStatuslineOptions({}).showStateFreshness, false);
        assert.equal(resolveStatuslineOptions({ statusline: {} }).showStateFreshness, false);
        assert.equal(resolveStatuslineOptions(undefined).showStateFreshness, false);
      });

      test('requiresStrictTrueToEnable', () => {
        assert.equal(resolveStatuslineOptions({ statusline: { show_state_freshness: 'yes' } }).showStateFreshness, false);
        assert.equal(resolveStatuslineOptions({ statusline: { show_state_freshness: 1 } }).showStateFreshness, false);
        assert.equal(resolveStatuslineOptions({ statusline: { show_state_freshness: true } }).showStateFreshness, true);
      });
    });

    // ─── rows 11-14: stamp-presence guards ──────────────────────────────────

    describe('deriveStateFreshness wiring: stamp-absence guards', () => {
      test('omitsMarkerWhenStampAbsent', (t) => {
        const dir = createTempGitProject('gsd-freshness-no-stamp-');
        t.after(() => cleanup(dir));
        const content = ['---', 'status: executing', '---', '', '# State'].join('\n');
        fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.planning', 'STATE.md'), content);
        assert.equal(parseStateMd(content).stateHead, undefined);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir, { stateFreshness: true });
          assert.equal(state.freshness, undefined);
          assert.equal(calls.length, 0);
        });
      });

      test('treatsLiteralNullStampAsAbsent', (t) => {
        const dir = createTempGitProject('gsd-freshness-null-stamp-');
        t.after(() => cleanup(dir));
        const content = writeStateHead(dir, 'null');
        assert.equal(parseStateMd(content).stateHead, null);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir, { stateFreshness: true });
          assert.equal(state.freshness, undefined);
          assert.equal(calls.length, 0);
        });
      });

      test('treatsEmptyStampAsAbsent', (t) => {
        const dir = createTempGitProject('gsd-freshness-empty-stamp-');
        t.after(() => cleanup(dir));
        const content = writeStateHead(dir, '""');
        assert.equal(parseStateMd(content).stateHead, null);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir, { stateFreshness: true });
          assert.equal(state.freshness, undefined);
          assert.equal(calls.length, 0);
        });
      });

      test('treatsWhitespaceStampAsAbsent', () => {
        assert.equal(isValidStateHeadStamp('   '), false);
        assert.equal(isValidStateHeadStamp('\t\t'), false);
      });
    });

    // ─── rows 15-19: hash-fence boundaries ──────────────────────────────────

    describe('isValidStateHeadStamp: hash-fence boundaries', () => {
      test('rejectsStampBelowFenceMinimum', () => {
        assert.equal(isValidStateHeadStamp('abc'), false);
      });

      test('acceptsStampAtFenceMinimum', () => {
        assert.equal(isValidStateHeadStamp('abcd'), true);
      });

      test('acceptsStampAtFenceMaximum', () => {
        assert.equal(isValidStateHeadStamp('a'.repeat(40)), true);
      });

      test('rejectsStampAboveFenceMaximum', () => {
        assert.equal(isValidStateHeadStamp('a'.repeat(41)), false);
      });

      test('rejectsNonHexStamp', () => {
        assert.equal(isValidStateHeadStamp('zzzz'), false);
        assert.equal(isValidStateHeadStamp('g1b2'), false);
      });
    });

    // ─── rows 20-22: hostile stamps — negative proof (git never invoked) ───

    describe('deriveStateFreshness: hostile stamps never reach git', () => {
      test('rejectsFlagLookalikeStampBeforeSpawn', (t) => {
        const dir = createTempGitProject('gsd-freshness-hostile-flag-');
        t.after(() => cleanup(dir));
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const ir = deriveStateFreshness(dir, '--upload-pack=/bin/sh');
          assert.equal(ir.state_head, null);
          assert.equal(ir.commits_behind, null);
          assert.equal(calls.length, 0, 'git must never be invoked for a flag-lookalike stamp');
        });
      });

      test('rejectsRevisionSyntaxStamp', (t) => {
        const dir = createTempGitProject('gsd-freshness-hostile-revsyntax-');
        t.after(() => cleanup(dir));
        const hostileStamps = ['HEAD', '..', '@{u}', '-'];
        withSpawnSpy(() => '0\t20\n', (calls) => {
          for (const stamp of hostileStamps) {
            const ir = deriveStateFreshness(dir, stamp);
            assert.equal(ir.state_head, null, `expected state_head null for ${JSON.stringify(stamp)}`);
            assert.equal(ir.commits_behind, null, `expected commits_behind null for ${JSON.stringify(stamp)}`);
          }
          assert.equal(calls.length, 0, 'git must never be invoked for revision-syntax stamps');
        });
      });

      test('rejectsShellMetacharacterStamp', (t) => {
        const dir = createTempGitProject('gsd-freshness-hostile-shellmeta-');
        t.after(() => cleanup(dir));
        const hostileStamps = ['abcd1234\nrm -rf /', 'abcd1234;rm -rf /', '`touch /tmp/pwned`', '$(touch /tmp/pwned)'];
        withSpawnSpy(() => '0\t20\n', (calls) => {
          for (const stamp of hostileStamps) {
            const ir = deriveStateFreshness(dir, stamp);
            assert.equal(ir.state_head, null, `expected state_head null for ${JSON.stringify(stamp)}`);
            assert.equal(ir.commits_behind, null, `expected commits_behind null for ${JSON.stringify(stamp)}`);
          }
          assert.equal(calls.length, 0, 'git must never be invoked for shell-metacharacter stamps');
        });
      });
    });

    // ─── rows 23-30: ancestry + provenance degradation guards ──────────────

    describe('deriveStateFreshness: ancestry and provenance guards', () => {
      test('omitsMarkerForUnknownStamp', (t) => {
        const dir = createTempGitProject('gsd-freshness-unknown-stamp-');
        t.after(() => cleanup(dir));
        const ir = deriveStateFreshness(dir, 'deadbeef');
        assert.equal(ir.state_head, 'deadbee');
        assert.equal(ir.commits_behind, null);
        assert.equal(ir.commit_stale, null);
      });

      test('omitsMarkerWhenStampIsNotAncestor', (t) => {
        const dir = createTempGitProject('gsd-freshness-rewind-');
        t.after(() => cleanup(dir));
        const preSha = commitN(dir, 3);
        const advancedSha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        gitOrThrow(['reset', '--hard', preSha], { cwd: dir });
        const ir = deriveStateFreshness(dir, advancedSha);
        assert.equal(ir.state_head, advancedSha.slice(0, 7));
        assert.equal(ir.commits_behind, null);
        assert.equal(ir.commit_stale, null);
      });

      test('omitsMarkerForDivergedHistory', (t) => {
        const dir = createTempGitProject('gsd-freshness-diverge-');
        t.after(() => cleanup(dir));
        const originalBranch = gitOrThrow(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }).trim();
        gitOrThrow(['checkout', '-b', 'gsd-freshness-side'], { cwd: dir });
        commitN(dir, 2);
        const divergedStamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        gitOrThrow(['checkout', originalBranch], { cwd: dir });
        commitN(dir, 2);
        const ir = deriveStateFreshness(dir, divergedStamp);
        assert.equal(ir.commits_behind, null);
        assert.equal(ir.commit_stale, null);
      });

      test('omitsMarkerWhenProjectDoesNotOwnRepo', (t) => {
        const outerDir = createTempGitProject('gsd-freshness-outer-');
        t.after(() => cleanup(outerDir));
        const nestedDir = path.join(outerDir, 'nested-project');
        fs.mkdirSync(path.join(nestedDir, '.planning'), { recursive: true });
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const ir = deriveStateFreshness(nestedDir, 'abcd1234');
          assert.equal(ir.commits_behind, null);
          assert.equal(ir.commit_stale, null);
          assert.equal(calls.length, 0);
        });
      });

      test('omitsMarkerInSubReposWorkspace', (t) => {
        const dir = createTempGitProject('gsd-freshness-subrepos-');
        t.after(() => cleanup(dir));
        writeConfig(dir, { planning: { sub_repos: ['child-a', 'child-b'] } });
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const ir = deriveStateFreshness(dir, 'abcd1234');
          assert.equal(ir.commits_behind, null);
          assert.equal(ir.commit_stale, null);
          assert.equal(calls.length, 0);
        });
      });

      test('omitsMarkerForFlatSubReposKey', (t) => {
        const dir = createTempGitProject('gsd-freshness-subrepos-flat-');
        t.after(() => cleanup(dir));
        writeConfig(dir, { 'planning.sub_repos': ['child-a'] });
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const ir = deriveStateFreshness(dir, 'abcd1234');
          assert.equal(ir.commits_behind, null);
          assert.equal(calls.length, 0);
        });
      });

      test('allowsMarkerWhenSubReposEmpty', (t) => {
        const dir = createTempGitProject('gsd-freshness-subrepos-empty-');
        t.after(() => cleanup(dir));
        writeConfig(dir, { planning: { sub_repos: [] } });
        const stamp = commitN(dir, STATE_HEAD_ADVISORY_COMMITS);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, STATE_HEAD_ADVISORY_COMMITS);
        assert.equal(formatStateFreshness(ir), `state ~${STATE_HEAD_ADVISORY_COMMITS} commits back`);
      });

      test('ignoresNonArraySubRepos', (t) => {
        const dir = createTempGitProject('gsd-freshness-subrepos-scalar-');
        t.after(() => cleanup(dir));
        writeConfig(dir, { planning: { sub_repos: 'child-a' } });
        const stamp = commitN(dir, STATE_HEAD_ADVISORY_COMMITS);
        const ir = deriveStateFreshness(dir, stamp);
        assert.equal(ir.commits_behind, STATE_HEAD_ADVISORY_COMMITS);
      });
    });

    // ─── rows 31-34: IO fault injection ─────────────────────────────────────

    describe('deriveStateFreshness: never throws on git faults', () => {
      test('degradesWhenGitMissing', (t) => {
        const dir = createTempGitProject('gsd-freshness-enoent-');
        t.after(() => cleanup(dir));
        withSpawnSpy(() => {
          const err = new Error('spawnSync git ENOENT');
          err.code = 'ENOENT';
          throw err;
        }, () => {
          let ir;
          assert.doesNotThrow(() => { ir = deriveStateFreshness(dir, 'abcd1234'); });
          assert.equal(ir.commits_behind, null);
          assert.equal(ir.commit_stale, null);
        });
      });

      test('degradesOnGitTimeout', (t) => {
        const dir = createTempGitProject('gsd-freshness-timeout-');
        t.after(() => cleanup(dir));
        withSpawnSpy(() => {
          const err = new Error('spawnSync git ETIMEDOUT');
          err.code = 'ETIMEDOUT';
          err.errno = -110;
          throw err;
        }, () => {
          let ir;
          assert.doesNotThrow(() => { ir = deriveStateFreshness(dir, 'abcd1234'); });
          assert.equal(ir.commits_behind, null);
          assert.equal(ir.commit_stale, null);
        });
      });

      test('degradesOnUnparseableRevListOutput', (t) => {
        const dir = createTempGitProject('gsd-freshness-bad-stdout-');
        t.after(() => cleanup(dir));
        assert.equal(parseRevListCounts(null), null);
        assert.equal(parseRevListCounts(''), null);
        assert.equal(parseRevListCounts('garbage'), null);
        assert.equal(parseRevListCounts('1'), null);
        assert.equal(parseRevListCounts('a\tb'), null);
        assert.equal(parseRevListCounts('\t'), null);
        assert.equal(parseRevListCounts('not-a-count\n'), null);
        withSpawnSpy(() => 'not-a-count\n', () => {
          const ir = deriveStateFreshness(dir, 'abcd1234');
          assert.equal(ir.commits_behind, null);
          assert.equal(ir.commit_stale, null);
        });
      });

      test('neverThrowsFromDerivation', (t) => {
        const dir = createTempGitProject('gsd-freshness-arbitrary-throw-');
        t.after(() => cleanup(dir));
        withSpawnSpy(() => { throw new TypeError('arbitrary failure'); }, () => {
          assert.doesNotThrow(() => deriveStateFreshness(dir, 'abcd1234'));
        });
      });
    });

    // ─── rows 35-39: renderer composition ───────────────────────────────────

    describe('formatGsdState / formatGsdStateCompact: freshness suffix', () => {
      test('fullRendererShowsMarker', () => {
        const freshness = { state_head: 'abcd123', commits_behind: 20, commit_stale: true };
        const s = { status: 'executing', phaseNum: '1', phaseTotal: '5', freshness };
        const expected = ['executing', 'ph 1/5', formatStateFreshness(freshness)].join(' · ');
        assert.equal(formatGsdState(s), expected);
      });

      test('compactRendererShowsMarker', () => {
        const freshness = { state_head: 'abcd123', commits_behind: 20, commit_stale: true };
        const s = { milestone: 'v1.9', status: 'executing', freshness };
        const expected = ['v1.9', 'executing', formatStateFreshness(freshness)].join(' · ');
        assert.equal(formatGsdStateCompact(s), expected);
      });

      test('compactRendererOmitsBelowThreshold', () => {
        const freshness = { state_head: 'abcd123', commits_behind: 5, commit_stale: true };
        const s = { milestone: 'v1.9', status: 'executing', freshness };
        const expected = ['v1.9', 'executing'].join(' · ');
        assert.equal(formatGsdStateCompact(s), expected);
      });

      test('workstreamSentinelSuppressesMarker', () => {
        const freshness = { state_head: 'abcd123', commits_behind: 20, commit_stale: true };
        const s = { noActiveWorkstream: true, freshness };
        assert.equal(formatGsdState(s), 'no active workstream');
        assert.equal(formatGsdStateCompact(s), 'no active workstream');
      });

      test('markerCoexistsWithMilestoneComplete', () => {
        const freshness = { state_head: 'abcd123', commits_behind: 25, commit_stale: true };
        const sFull = { milestone: 'v1.9', percent: '100', freshness };
        const expectedFull = ['v1.9 [██████████] 100%', 'milestone complete', formatStateFreshness(freshness)].join(' · ');
        assert.equal(formatGsdState(sFull), expectedFull);

        const sCompact = { milestone: 'v1.9', percent: '100', freshness };
        const expectedCompact = ['v1.9', 'complete', formatStateFreshness(freshness)].join(' · ');
        assert.equal(formatGsdStateCompact(sCompact), expectedCompact);
      });
    });

    // ─── row 40: todo-task gate (no wasted spawn while a task is active) ───

    describe('runStatusline wiring: todo-task gate', () => {
      test('skipsFreshnessWorkWhenTodoTaskActive', { skip: process.platform === 'win32' ? 'POSIX-only git shim' : false }, (t) => {
        const dir = createTempGitProject('gsd-freshness-todo-gate-');
        t.after(() => cleanup(dir));
        writeConfig(dir, { statusline: { show_state_freshness: true } });
        const stamp = commitN(dir, STATE_HEAD_ADVISORY_COMMITS);
        writeStateHead(dir, stamp);

        // A `git` shim on PATH that appends a line to a marker file on
        // EVERY invocation and always fails — proves the ONLY way to
        // detect a spawn across a real subprocess boundary (an in-process
        // execFileSync monkeypatch can't reach a child node process's own
        // module cache). Asserting the marker file never exists is a
        // filesystem fact, not a text match against rendered output.
        const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-freshness-shim-'));
        t.after(() => cleanup(shimDir));
        const marker = path.join(shimDir, 'git-was-invoked');
        fs.writeFileSync(path.join(shimDir, 'git'), ['#!/bin/sh', `echo invoked >> "${marker}"`, 'exit 1', ''].join('\n'));
        fs.chmodSync(path.join(shimDir, 'git'), 0o755);

        const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-freshness-todo-claude-'));
        t.after(() => cleanup(claudeDir));
        const todosDir = path.join(claudeDir, 'todos');
        fs.mkdirSync(todosDir, { recursive: true });
        const session = `sess-2734-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        fs.writeFileSync(path.join(todosDir, `${session}-agent-A.json`), JSON.stringify([
          { content: 'task', status: 'in_progress', activeForm: 'ACTIVE TASK 2734' },
        ]));

        const hookPath = path.join(__dirname, '..', 'hooks', 'gsd-statusline.js');
        const payload = JSON.stringify({
          model: { display_name: 'Claude' },
          workspace: { current_dir: dir },
          session_id: session,
          context_window: { remaining_percentage: 80, total_tokens: 1_000_000 },
        });
        const r = runHookSeam(hookPath, [], {
          input: payload,
          env: { ...process.env, PATH: `${shimDir}${path.delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: claudeDir },
          timeoutMs: 5000,
        });
        assert.equal(r.outcome, OUTCOME.EXITED, `expected clean exit, got outcome=${r.outcome}`);
        assert.equal(r.exitCode, 0);
        assert.equal(fs.existsSync(marker), false, 'git must never be invoked while a todo task is active');
      });
    });

    // ─── rows 41-45: parseStateMd state_head extraction edge cases ─────────

    describe('parseStateMd: state_head extraction', () => {
      test('parsesStampFromCrlfStateMd', () => {
        const lf = ['---', 'status: executing', 'state_head: abcd1234', '---', '', '# State'].join('\n');
        const crlf = lf.replace(/\n/g, '\r\n');
        assert.equal(parseStateMd(crlf).stateHead, parseStateMd(lf).stateHead);
        assert.equal(parseStateMd(crlf).stateHead, 'abcd1234');
      });

      test('omitsMarkerWithoutFrontmatter', () => {
        const content = ['# State', 'Status: executing'].join('\n');
        assert.equal(parseStateMd(content).stateHead, undefined);
      });

      test('handlesEmptyStateFile', () => {
        assert.doesNotThrow(() => parseStateMd(''));
        assert.equal(parseStateMd('').stateHead, undefined);
      });

      test('handlesDuplicateStampKey', () => {
        const content = ['---', 'state_head: aaaa1111', 'state_head: bbbb2222', '---'].join('\n');
        assert.equal(parseStateMd(content).stateHead, 'bbbb2222');
      });

      test('stripsQuotesFromStamp', () => {
        const content = ['---', 'state_head: "abc1234"', '---'].join('\n');
        assert.equal(parseStateMd(content).stateHead, 'abc1234');
      });
    });

    // ─── rows 46-52: independence + parity ──────────────────────────────────

    describe('independence + parity', () => {
      test('defaultCallShapeIsUnchanged', (t) => {
        const dir = createTempGitProject('gsd-freshness-default-shape-');
        t.after(() => cleanup(dir));
        const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        writeStateHead(dir, stamp);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir);
          assert.equal('freshness' in state, false);
          assert.equal(calls.length, 0);
        });
      });

      test('spendsExactlyOneSpawnPerRender', (t) => {
        const dir = createTempGitProject('gsd-freshness-spawn-count-');
        t.after(() => cleanup(dir));
        const stamp = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        writeStateHead(dir, stamp);
        withSpawnSpy(() => '0\t20\n', (calls) => {
          const state = readGsdState(dir, { stateFreshness: true });
          assert.equal(calls.length, 1, `expected exactly one git spawn, got ${calls.length}`);
          assert.equal(state.freshness.commits_behind, 20);
        });
      });

      test('thresholdMatchesHealthConstant', () => {
        const { STATE_HEAD_ADVISORY_COMMITS: healthConstant } = require('../gsd-core/bin/lib/verify.cjs');
        assert.equal(STATE_HEAD_ADVISORY_COMMITS, healthConstant);
      });

      test('fenceAgreesWithStateModule', (t) => {
        const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');
        const dir = createTempProject('gsd-freshness-fence-parity-');
        t.after(() => cleanup(dir));
        const candidates = [
          'abcd', 'abcd1234', 'a'.repeat(40), 'a'.repeat(41), 'abc', 'zzzz', 'g1b2',
          '', '   ', 'null', '--upload-pack=x', 'HEAD', '..', '@{u}', '-',
          'abcd1234\nrm -rf /', 'abcd1234;rm -rf /', '`abcd1234`', '$(abcd1234)', '"abcd1234"',
        ];
        for (const candidate of candidates) {
          const hookAccepts = isValidStateHeadStamp(candidate);
          const moduleAccepts = readStateHeadFreshness(dir, candidate).state_head !== null;
          assert.equal(hookAccepts, moduleAccepts, `fence mismatch for candidate ${JSON.stringify(candidate)}`);
        }
      });

      test('derivationAgreesWithStateModule', (t) => {
        const { readStateHeadFreshness } = require('../gsd-core/bin/lib/state.cjs');

        // Registers cleanup for THIS fixture's directory at scheduling time
        // (captured as a function parameter, not a reused outer `dir`
        // binding) so a throw partway through the fixture list still tears
        // down every directory created up to that point.
        function registerCleanup(fixtureDir) {
          t.after(() => cleanup(fixtureDir));
        }

        function assertAgree(dir, stamp) {
          const hookIr = deriveStateFreshness(dir, stamp);
          const moduleIr = readStateHeadFreshness(dir, stamp);
          assert.equal(hookIr.state_head, moduleIr.state_head, 'state_head mismatch');
          assert.equal(hookIr.commits_behind, moduleIr.commits_behind, 'commits_behind mismatch');
          assert.equal(hookIr.commit_stale, moduleIr.commit_stale, 'commit_stale mismatch');
        }

        // Ancestor stamp, 5 commits behind.
        let dir = createTempGitProject('gsd-freshness-parity-ancestor-');
        registerCleanup(dir);
        let stamp = commitN(dir, 5);
        assertAgree(dir, stamp);

        // Rewound (non-ancestor) stamp.
        dir = createTempGitProject('gsd-freshness-parity-rewound-');
        registerCleanup(dir);
        const preSha = commitN(dir, 3);
        const advancedSha = gitOrThrow(['rev-parse', 'HEAD'], { cwd: dir }).trim();
        gitOrThrow(['reset', '--hard', preSha], { cwd: dir });
        assertAgree(dir, advancedSha);

        // Invalid (non-hex) stamp.
        dir = createTempGitProject('gsd-freshness-parity-invalid-');
        registerCleanup(dir);
        assertAgree(dir, 'zzzznothex');

        // .git-less root.
        dir = createTempProject('gsd-freshness-parity-nogit-');
        registerCleanup(dir);
        assertAgree(dir, 'abcd1234');

        // sub_repos workspace.
        dir = createTempGitProject('gsd-freshness-parity-subrepos-');
        registerCleanup(dir);
        writeConfig(dir, { planning: { sub_repos: ['child-a'] } });
        assertAgree(dir, 'abcd1234');
      });

      test('bothEntryPointsResolveOptionsIdentically', () => {
        const cfgs = [
          {},
          { statusline: { show_state_freshness: true } },
          { statusline: { state_format: 'compact', show_git: true, show_state_freshness: true } },
          { 'statusline.show_state_freshness': true, 'statusline.context_position': 'front' },
        ];
        for (const cfg of cfgs) {
          const o = resolveStatuslineOptions(cfg);
          assert.equal(typeof o.showStateFreshness, 'boolean', `showStateFreshness type for ${JSON.stringify(cfg)}`);
          assert.equal(typeof o.showGit, 'boolean', `showGit type for ${JSON.stringify(cfg)}`);
          assert.ok(o.stateFormat === 'full' || o.stateFormat === 'compact', `unexpected stateFormat for ${JSON.stringify(cfg)}: ${o.stateFormat}`);
          assert.ok(o.position === 'end' || o.position === 'front', `unexpected position for ${JSON.stringify(cfg)}: ${o.position}`);
        }

        const flat = resolveStatuslineOptions({ 'statusline.show_state_freshness': true, 'statusline.state_format': 'compact' });
        const nested = resolveStatuslineOptions({ statusline: { show_state_freshness: true, state_format: 'compact' } });
        assert.deepEqual(flat, nested, 'flat dotted-key and nested config forms must resolve identically');
      });

      test('derivationIsNotMemoizedAcrossRenders', (t) => {
        const dir = createTempGitProject('gsd-freshness-no-memo-');
        t.after(() => cleanup(dir));
        const stampA = commitN(dir, 5);
        writeStateHead(dir, stampA);

        const first = readGsdState(dir, { stateFreshness: true });
        assert.equal(first.freshness.commits_behind, 5);

        const stampB = commitN(dir, 10);
        writeStateHead(dir, stampB);

        const second = readGsdState(dir, { stateFreshness: true });
        assert.equal(second.freshness.commits_behind, 10);
        assert.notEqual(first.freshness.commits_behind, second.freshness.commits_behind);
      });
    });
  });
}
