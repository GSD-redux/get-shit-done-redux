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
  readGsdState,
  isInstalledAheadOfLatest,
} = require('../hooks/gsd-statusline.js');
const { cleanup } = require('./helpers.cjs');

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
});

// ─── CLAUDE_CODE_AUTO_COMPACT_WINDOW context meter (#2219) ──────────────────

describe('context meter respects CLAUDE_CODE_AUTO_COMPACT_WINDOW (#2219)', () => {
  const { execFileSync } = require('node:child_process');
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
  const { execFileSync } = require('node:child_process');
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
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [hookPath], {
          input: payload, encoding: 'utf8', timeout: 4000,
        });
      } catch (e) {
        stdout = e.stdout || '';
      }
      // eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences from captured CLI output
      return stdout.replace(/\x1b\[[0-9;]*m/g, '');
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
    test('paused — the canonical stuck state — wins and renders uppercase (#2162 condition)', () => {
      assert.equal(shortGsdStatus('paused — waiting on credentials'), 'PAUSED');
      assert.equal(shortGsdStatus('stopped by user'), 'PAUSED');
    });
    test('collapses lifecycle narratives to canonical keywords via normalizeStateStatus', () => {
      assert.equal(shortGsdStatus('Executing phase 7 of the parser milestone'), 'executing');
      assert.equal(shortGsdStatus('Ready to plan next phase'), 'planning');
      assert.equal(shortGsdStatus('Discussing scope with user'), 'discussing');
      assert.equal(shortGsdStatus('Verifying UAT criteria'), 'verifying');
      assert.equal(shortGsdStatus('Work complete'), 'completed');
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
        status: 'Executing phase 7 — building the parser',
      });
      assert.equal(out, 'v1.12 · P7/12 · executing');
    });
    test('prefers lifecycle active_phase over body phase number', () => {
      const out = formatGsdStateCompact({
        milestone: 'v2.0', activePhase: '4.5', phaseNum: '4', status: 'executing',
      });
      assert.equal(out, 'v2.0 · P4.5 · executing');
    });
    test('paused state renders uppercase in the compact line', () => {
      const out = formatGsdStateCompact({
        milestone: 'v2.0', activePhase: '4.5', status: 'paused — waiting on review',
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
      ];
      for (const s of cases) {
        const fullDone = formatGsdState(s).includes('milestone complete');
        const compactDone = / complete$|^complete$/.test(formatGsdStateCompact(s));
        assert.equal(compactDone, fullDone,
          `completion parity diverged for ${JSON.stringify(s)}`);
      }
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
  const { execFileSync } = require('node:child_process');
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
      const run = (args) => execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
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
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [hookPath], {
          input: payload, encoding: 'utf8', timeout: 4000,
        });
      } catch (e) {
        stdout = e.stdout || '';
      }
      // eslint-disable-next-line no-control-regex -- stripping ANSI SGR sequences from captured CLI output
      return stdout.replace(/\x1b\[[0-9;]*m/g, '');
    }

    test('flag=true renders the branch segment', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-seg-e2e-'));
      try {
        execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
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
        execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
        fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
        const out = runHook(dir);
        assert.ok(!out.includes('│ main'), `expected no git segment; got: ${out}`);
      } finally {
        cleanup(dir);
      }
    });
  });
}
