#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// Claude Code Statusline - GSD Edition
// Shows: model | current task (or GSD state) | directory | context usage

const fs = require('fs');
const path = require('path');
const os = require('os');
// Namespace (not destructured) so tests can inject spawn failures by
// monkeypatching childProcess.execFileSync.
const childProcess = require('child_process');
const { HOOK_ON_CRASH, allow, crash } = require('./lib/hook-exit.js');

// This hook's build-seam outer catch (require.main guard just below) has
// always exited 0 (fail open — the statusline renders on EVERY prompt, so a
// build failure must degrade to a blank line rather than break Claude Code's
// per-render hook). Declared ONCE so that catch's crash() call states its
// policy explicitly rather than inheriting a default (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;
// #3582: gsd-core/bin/lib/*.cjs (semver-compare.cjs, state-document.cjs,
// active-workstream-store.cjs, planning-workspace.cjs — required below) and
// package-identity.cjs are tsc build artifacts (ADR-457), gitignored and
// absent on a raw plugin-marketplace / git-clone install that never ran
// `npm run build:lib`. The statusline renders on EVERY prompt, so a build
// failure here must DEGRADE (print nothing, exit 0) rather than crash
// Claude Code's per-render statusline hook. Scoped to the spawned-as-a-script
// path (`require.main === module`) — a test `require()` of this module for
// its pure helpers assumes a built tree, same as every other hook test.
if (require.main === module) {
  try {
    const { ensureRuntimeBuild } = require('../gsd-core/bin/ensure-runtime-build.cjs');
    ensureRuntimeBuild();
  } catch (e) {
    // #3911: crash(ON_CRASH, ...) with an undefined payload preserves the
    // pre-migration `process.stdout.write(''); process.exit(0);` byte-for-
    // byte — undefined makes terminateNow's stdout JSON.stringify throw
    // internally (swallowed there), so fd 1 stays untouched, same as writing
    // an explicit empty string did.
    crash(ON_CRASH, undefined);
  }
}
const { isSemverNewer } = require('../gsd-core/bin/lib/semver-compare.cjs');
const { PACKAGE_NAME, updateCacheFileName } = require('../gsd-core/bin/lib/package-identity.cjs');
const { normalizeStateStatus } = require('../gsd-core/bin/lib/state-document.cjs');
// #2850: reuse the existing workstream resolution seams rather than
// re-implementing CLI>env>store precedence or path construction inline.
// peekActiveWorkstream is the read-only sibling of the store-tier lookup
// resolveActiveWorkstream defaults to (getActiveWorkstream) — that default
// self-heals a stale/invalid pointer by deleting it, which is correct for a
// command but not for a renderer invoked on every prompt. Injecting it via
// resolveActiveWorkstream's own `getStored` override keeps the CLI>env>store
// precedence itself fully reused (untouched); only the store tier's *write*
// side effect is removed.
const { resolveActiveWorkstream, peekActiveWorkstream } = require('../gsd-core/bin/lib/active-workstream-store.cjs');
const { listAvailableWorkstreams, planningPaths } = require('../gsd-core/bin/lib/planning-workspace.cjs');

// --- Config + last-command readers ------------------------------------------

/**
 * Walk up from dir looking for .planning/config.json and return its parsed contents.
 * Returns {} if not found or unreadable.
 */
function readGsdConfig(dir) {
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(current, '.planning', 'config.json');
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8')) || {};
      } catch (e) {
        return {};
      }
    }
    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return {};
}

/**
 * Lookup a dotted key path (e.g. 'statusline.show_last_command') in a config
 * object that may use either nested or flat keys.
 */
function getConfigValue(cfg, keyPath) {
  if (!cfg || typeof cfg !== 'object') return undefined;
  if (keyPath in cfg) return cfg[keyPath];
  const parts = keyPath.split('.');
  let cur = cfg;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * Extract the most recently invoked slash command from a Claude Code JSONL
 * transcript file. Returns the command name (no leading slash) or null.
 *
 * Claude Code embeds slash invocations in user messages as
 *   <command-name>/foo</command-name>
 * We scan lines from the end of the file, stopping at the first match.
 */
function readLastSlashCommand(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  let content;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    // Read only the tail — typical transcripts grow large. 256 KiB comfortably
    // covers dozens of recent turns while staying cheap per render.
    const stat = fs.statSync(transcriptPath);
    const MAX = 256 * 1024;
    const start = Math.max(0, stat.size - MAX);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      content = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    return null;
  }
  // Find the LAST occurrence — scan right-to-left via lastIndexOf on the tag.
  const tagClose = '</command-name>';
  const idx = content.lastIndexOf(tagClose);
  if (idx < 0) return null;
  const openTag = '<command-name>';
  const openIdx = content.lastIndexOf(openTag, idx);
  if (openIdx < 0) return null;
  let name = content.slice(openIdx + openTag.length, idx).trim();
  // Strip a leading slash if present, and any trailing arguments-on-same-line noise.
  if (name.startsWith('/')) name = name.slice(1);
  // Command names in Claude Code transcripts are plain identifiers like "gsd-plan-phase"
  // or namespaced like "plugin:skill". Reject anything with whitespace/newlines/control chars.
  if (!name || /[\s\\"<>]/.test(name) || name.length > 80) return null;
  return name;
}

// --- GSD state reader -------------------------------------------------------

/**
 * Read and parse a STATE.md if it exists. Returns the parsed state object,
 * `null` when the file is absent, or `null` on any read/parse failure (never
 * throws) — the single shared shape for both the flat and workstream reads
 * in readGsdState() below.
 */
function readStateFileOrNull(statePath) {
  if (!fs.existsSync(statePath)) return null;
  try {
    return parseStateMd(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

/**
 * Walk up from dir looking for .planning/STATE.md (flat mode). If an ancestor
 * has no flat STATE.md but IS in workstream mode (.planning/workstreams/
 * present — the single-source-of-truth check `listAvailableWorkstreams`
 * shares with the init.progress/phase.complete #1912/#2028 guards, so this
 * can't drift from how every other GSD command detects the mode), resolve
 * the active workstream and read that workstream's STATE.md instead (#2850).
 *
 * Resolution reuses `resolveActiveWorkstream` (active-workstream-store.cjs)
 * called with an empty args array, so only its env>store precedence applies
 * here — the CLI leg is inert for this renderer, which never receives argv.
 * The store tier is `peekActiveWorkstream`, a READ-ONLY sibling of the
 * default `getActiveWorkstream`: the default self-heals a stale/invalid
 * pointer by deleting it, which is correct for a command but not for a
 * renderer invoked on every prompt — a render must never write or delete.
 *
 * Returns:
 *   - the parsed state object when a flat or workstream STATE.md is found
 *   - { noActiveWorkstream: true } when workstream mode is active at an
 *     ancestor but no workstream can be resolved — an observable signal so
 *     this is distinguishable from "GSD isn't installed here" (#2850)
 *   - null when no .planning marker is found at all (GSD not present), or
 *     when a workstream DOES resolve but its STATE.md doesn't exist yet
 *     (negative space: mirrors flat-mode's own silent pre-STATE.md window)
 *
 * @param {string} dir
 * @param {{ stateFreshness?: boolean }} [opts] — #2734, additive/default-off.
 *   When true and the resolved state carries a truthy `.stateHead`, attaches
 *   `state.freshness` (deriveStateFreshness) before returning — `current` at
 *   that point is the project root the walk resolved, which is what AC-4's
 *   repo-pinning check needs. Never derived when false or the stamp is
 *   absent, so existing callers (default opts) spend zero extra spawns.
 */
function readGsdState(dir, opts = {}) {
  const { stateFreshness = false } = opts;
  const home = os.homedir();
  let current = dir;
  for (let i = 0; i < 10; i++) {
    const flatState = readStateFileOrNull(path.join(current, '.planning', 'STATE.md'));
    if (flatState !== null) {
      if (stateFreshness && flatState.stateHead) {
        flatState.freshness = deriveStateFreshness(current, flatState.stateHead);
      }
      return flatState;
    }

    if (listAvailableWorkstreams(current).length > 0) {
      let resolvedWs = null;
      try {
        resolvedWs = resolveActiveWorkstream(current, [], process.env, { getStored: peekActiveWorkstream }).ws;
      } catch (e) {
        resolvedWs = null;
      }

      if (!resolvedWs) return { noActiveWorkstream: true };

      const wsState = readStateFileOrNull(planningPaths(current, resolvedWs).state);
      if (wsState !== null && stateFreshness && wsState.stateHead) {
        wsState.freshness = deriveStateFreshness(current, wsState.stateHead);
      }
      return wsState;
    }

    const parent = path.dirname(current);
    if (parent === current || current === home) break;
    current = parent;
  }
  return null;
}

/**
 * Parse STATE.md frontmatter + Phase line from body.
 *
 * Returns:
 *   { status, milestone, milestoneName, phaseNum, phaseTotal, phaseName,
 *     activePhase, nextAction, nextPhases, completedPhases, totalPhases, percent }
 *
 * Phase-lifecycle fields (issue #2833):
 *   - activePhase  : phase number ("4.5") when an orchestrator is mid-flight, null otherwise
 *   - nextAction   : recommended next command ("execute-phase") when idle, null otherwise
 *   - nextPhases   : array of phase numbers (["4.5"]) for nextAction, null otherwise
 *   - completedPhases / totalPhases / percent : milestone progress dimension
 *
 * All new fields default to undefined when absent — formatGsdState() degrades
 * gracefully so existing STATE.md files (without these fields) keep working.
 */
function parseStateMd(content) {
  const state = {};

  // YAML frontmatter between --- markers (anchored at file start).
  // #2754: \r?\n (not literal \n) so a CRLF STATE.md (Windows-authored) parses
  // identically to LF — pre-fix the literal-\n fence dropped the ENTIRE block.
  // Mirrors the CRLF-safe extractFrontmatter in src/frontmatter.cts.
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    // Top-level scalar key: value
    for (const line of fm.split(/\r?\n/)) {
      const m = line.match(/^(\w+):\s*(.+)/);
      if (!m) continue;
      const [, key, val] = m;
      const v = val.trim().replace(/^["']|["']$/g, '');
      // status / milestone-level fields (existing — preserved exactly)
      if (key === 'status') state.status = v === 'null' ? null : v;
      if (key === 'milestone') state.milestone = v === 'null' ? null : v;
      if (key === 'milestone_name') state.milestoneName = v === 'null' ? null : v;
      // Phase-lifecycle fields (new in issue #2833)
      // active_phase: phase number when an orchestrator is in-flight, null when idle
      if (key === 'active_phase') state.activePhase = (v === 'null' || v === '') ? null : v;
      // next_action: recommended command when idle (discuss-phase / plan-phase / execute-phase / verify-phase)
      if (key === 'next_action') state.nextAction = (v === 'null' || v === '') ? null : v;
      // #2734: state_head — the commit STATE.md was written against, consumed
      // by deriveStateFreshness() below. Mirrors active_phase/next_action's
      // null/empty handling exactly.
      if (key === 'state_head') state.stateHead = (v === 'null' || v === '') ? null : v;
    }
    // next_phases supports both flow array and block-list YAML forms.
    const npFlowMatch = fm.match(/^next_phases:\s*\[([^\]]*)\]/m);
    if (npFlowMatch) {
      const items = npFlowMatch[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      state.nextPhases = items.length > 0 ? items : null;
    } else {
      const npBlockMatch = fm.match(/^next_phases:\s*\r?\n((?:[ \t]*-[ \t]*[^\r\n]+\r?\n?)*)/m);
      if (npBlockMatch) {
        const items = npBlockMatch[1]
          .split(/\r?\n/)
          .map(line => line.match(/^[ \t]*-[ \t]*(.+)$/))
          .filter(Boolean)
          .map(m => m[1].trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
        state.nextPhases = items.length > 0 ? items : null;
      }
    }
    // progress nested block: completed_phases / total_phases / percent (2-space indent)
    const progMatch = fm.match(/^progress:\s*\r?\n((?:[ \t]+\w+:.+\r?\n?)+)/m);
    if (progMatch) {
      const cp = progMatch[1].match(/^[ \t]+completed_phases:\s*(\d+)/m);
      const tp = progMatch[1].match(/^[ \t]+total_phases:\s*(\d+)/m);
      const pc = progMatch[1].match(/^[ \t]+percent:\s*(\d+)/m);
      if (cp) state.completedPhases = cp[1];
      if (tp) state.totalPhases = tp[1];
      if (pc) state.percent = pc[1];
    }
  }

  // Phase: N of M (name)  or  Phase: none active (...)
  const phaseMatch = content.match(/^Phase:\s*(\d+)\s+of\s+(\d+)(?:\s+\(([^)]+)\))?/m);
  if (phaseMatch) {
    state.phaseNum = phaseMatch[1];
    state.phaseTotal = phaseMatch[2];
    state.phaseName = phaseMatch[3] || null;
  }

  // Fallback: parse Status: from body when frontmatter is absent
  if (!state.status) {
    const bodyStatus = content.match(/^Status:\s*(.+)/m);
    if (bodyStatus) {
      const raw = bodyStatus[1].trim().toLowerCase();
      if (raw.includes('ready to plan') || raw.includes('planning')) state.status = 'planning';
      else if (raw.includes('execut')) state.status = 'executing';
      else if (raw.includes('complet') || raw.includes('archived')) state.status = 'complete';
    }
  }

  return state;
}

// #2850: shared literal for formatGsdState/formatGsdStateCompact's "nothing
// resolvable" signal — one source of truth so the two renderers can't drift.
const NO_ACTIVE_WORKSTREAM_LABEL = 'no active workstream';

/**
 * Render a 10-segment milestone progress bar (matches the context meter style).
 *
 * @param {number|string|null|undefined} percent — 0-100; missing/NaN returns ''
 * @returns {string} '[█████░░░░░] 50%' or '' (so callers can `[bar].filter(Boolean)`)
 */
function renderProgressBar(percent) {
  if (percent == null || isNaN(percent)) return '';
  const pct = Math.max(0, Math.min(100, parseInt(percent, 10)));
  const filled = Math.floor(pct / 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  return `[${bar}] ${pct}%`;
}

/**
 * Format GSD state into display string.
 *
 * Backward-compatible default (no new fields populated):
 *   "v1.9 Code Quality · executing · fix-graphiti-deployment (1/5)"
 *
 * Phase-lifecycle scenes (issue #2833 — activate when STATE.md frontmatter
 * carries the new fields; otherwise rendering falls through to the default):
 *
 *   active_phase set                       → "v2.0 [██░] X% · Phase 4.5 executing"
 *   active_phase null + next_action set    → "v2.0 [██░] X% · next execute-phase 4.5"
 *   percent=100 (milestone done)           → "v2.0 [██████████] 100% · milestone complete"
 *   none of the above                      → existing "<status> · <phase>" path
 *
 * Progress bar is opt-in: appended to the milestone segment only when
 * progress.percent is present in frontmatter; absent → empty string.
 */
function formatGsdState(s) {
  // #2850: workstream mode with nothing resolvable — an observable signal,
  // never silent emptiness (distinguishes from "GSD isn't installed here").
  if (s.noActiveWorkstream) return NO_ACTIVE_WORKSTREAM_LABEL;

  const parts = [];

  // Milestone segment: version + name + (opt-in) progress bar
  if (s.milestone || s.milestoneName) {
    const ver = s.milestone || '';
    const name = (s.milestoneName && s.milestoneName !== 'milestone') ? s.milestoneName : '';
    const bar = renderProgressBar(s.percent);
    const pieces = [ver, name, bar].filter(Boolean);
    if (pieces.length > 0) parts.push(pieces.join(' '));
  }

  // Phase-lifecycle scenes (issue #2833) — first match wins; falls through to
  // the original "<status> · <phase>" path when none of the new fields apply.
  const phasesStr = (s.nextPhases && s.nextPhases.length > 0) ? s.nextPhases.join('/') : null;

  if (s.activePhase) {
    // Scene 1: an orchestrator is mid-flight on this phase.
    // stage = whichever lifecycle status was written by the orchestrator
    //   (discussing / planning / executing / verifying)
    const stage = s.status || '';
    parts.push(stage ? `Phase ${s.activePhase} ${stage}` : `Phase ${s.activePhase}`);
  } else if (s.nextAction && phasesStr) {
    // Scene 2: idle + a recommended next command is visible to the user.
    // Surfaces "what to run next" without the user opening STATE.md.
    parts.push(`next ${s.nextAction} ${phasesStr}`);
  } else if (Number(s.percent) === 100 || (Number(s.totalPhases) > 0 && Number(s.completedPhases) === Number(s.totalPhases))) {
    // Scene 3: milestone complete (every phase done). #3945: the counters are
    // regex-captured STRINGS, so the old `cp && tp && cp === tp` guard fired on
    // the empty set ('0' is truthy, '0' === '0') — "0% · milestone complete".
    // Numeric coercion + a non-empty denominator makes "nothing to measure"
    // stop meaning "everything is done".
    parts.push('milestone complete');
  } else {
    // Backward-compatible default — preserved EXACTLY for STATE.md files that
    // don't carry the new lifecycle fields. Identical output to v1.38.x and
    // earlier so no existing project's status-line changes shape.
    if (s.status) parts.push(s.status);
    if (s.phaseNum && s.phaseTotal) {
      const phase = s.phaseName
        ? `${s.phaseName} (${s.phaseNum}/${s.phaseTotal})`
        : `ph ${s.phaseNum}/${s.phaseTotal}`;
      parts.push(phase);
    }
  }

  // #2734: STATE.md freshness marker — opt-in, appended last.
  const fresh = formatStateFreshness(s.freshness);
  if (fresh) parts.push(fresh);

  return parts.join(' · ');
}

// --- Context token count (opt-in) ---------------------------------------------

/**
 * Format a token count compactly: 156342 → '156k', 1234567 → '1.2M'.
 */
function formatTokens(tokens) {
  // Promote to the M branch when k-rounding would reach 1000 (999,500-999,999
  // must render "1.0M", never "1000k").
  if (tokens >= 1000000 || Math.round(tokens / 1000) >= 1000) {
    return (tokens / 1000000).toFixed(1) + 'M';
  }
  if (tokens >= 1000) return Math.round(tokens / 1000) + 'k';
  return String(tokens);
}

/**
 * Pure function: build the token-count suffix for the context meter from the
 * hook input's context_window.current_usage block. Sums input, cache-creation,
 * cache-read, and output tokens (the same total Claude Code's /context shows).
 * Returns ' (156k)' or '' when usage is absent/empty.
 */
function contextTokenSuffix(currentUsage) {
  if (!currentUsage || typeof currentUsage !== 'object') return '';
  const total = (Number(currentUsage.input_tokens) || 0) +
    (Number(currentUsage.cache_creation_input_tokens) || 0) +
    (Number(currentUsage.cache_read_input_tokens) || 0) +
    (Number(currentUsage.output_tokens) || 0);
  return total > 0 ? ` (${formatTokens(total)})` : '';
}

// --- Compact state format (opt-in) ---------------------------------------------

/**
 * Collapse GSD's free-text status (often a multi-sentence narrative) to a
 * single keyword, built on the canonical normalizer (#2162 approval
 * condition): normalizeStateStatus() in state-document.cjs owns the status
 * vocabulary (discussing / planning / executing / verifying / completed /
 * paused) so the two can't drift. "paused" — the canonical stuck state — is
 * uppercased to PAUSED, the one state worth shouting about. Statuses the
 * normalizer passes through unrecognized fall back to their first word,
 * capped at 16 chars so a rogue STATE.md can't blow up the line.
 * Returns null for empty input.
 */
const CANONICAL_STATUSES = ['discussing', 'planning', 'executing', 'verifying', 'completed', 'paused'];

function shortGsdStatus(status) {
  if (!status) return null;
  const norm = normalizeStateStatus(status, null);
  if (CANONICAL_STATUSES.includes(norm)) {
    return norm === 'paused' ? 'PAUSED' : norm;
  }
  // Unrecognized free text passes through normalizeStateStatus verbatim —
  // fall back to the first word, capped.
  const first = String(norm).trim().split(/[\s\u2014\u2013-]+/)[0] || '';
  return first ? first.slice(0, 16) : null;
}

/**
 * Compact alternative to formatGsdState, selected via
 * `statusline.state_format: "compact"`:
 *
 *   "v1.12 · P7/12 · executing"     (phase active)
 *   "v2.0 · P4.5 · BLOCKED"         (no total known)
 *   "v2.0 · complete"               (milestone done)
 *   "v2.0 · next execute-phase 4.5" (idle with a queued action)
 *
 * Drops the milestone name and progress bar — the biggest width costs in the
 * default format — and collapses narrative statuses via shortGsdStatus().
 * The default "full" format is untouched.
 */
function formatGsdStateCompact(s) {
  // #2850: mirrors formatGsdState's observable "nothing resolvable" signal.
  if (s.noActiveWorkstream) return NO_ACTIVE_WORKSTREAM_LABEL;

  const parts = [];

  if (s.milestone) parts.push(s.milestone);

  const phaseId = s.activePhase || s.phaseNum;
  if (phaseId) {
    parts.push(s.phaseTotal ? `P${phaseId}/${s.phaseTotal}` : `P${phaseId}`);
  }

  // Scene exclusivity mirrors formatGsdState's if/else chain: an in-flight
  // phase (Scene 1, gated on activePhase ONLY — the legacy phaseNum shape
  // still completes) wins over milestone-complete (Scene 3), even if a
  // non-atomic STATE.md edit leaves percent=100 alongside a lifecycle phase.
  const done = !s.activePhase && (Number(s.percent) === 100 ||
    (Number(s.totalPhases) > 0 && Number(s.completedPhases) === Number(s.totalPhases)));

  if (done) {
    parts.push('complete');
  } else {
    const st = shortGsdStatus(s.status);
    if (st) {
      parts.push(st);
    } else if (!phaseId && s.nextAction) {
      const phasesStr = (s.nextPhases && s.nextPhases.length > 0) ? s.nextPhases.join('/') : '';
      parts.push(`next ${s.nextAction}${phasesStr ? ' ' + phasesStr : ''}`);
    }
  }

  // #2734: STATE.md freshness marker \u2014 opt-in, appended last.
  const fresh = formatStateFreshness(s.freshness);
  if (fresh) parts.push(fresh);

  return parts.join(' \u00b7 ');
}

// --- Model name --------------------------------------------------------------

/**
 * Collapse the verbose " (… context)" model-name suffix Claude Code sends for
 * long-context sessions (e.g. "Sonnet 4.5 (1M context)") to a compact badge
 * (" (1M)"). The signal is preserved; the width isn't. Tolerant by design
 * (issue #2160 approval condition): any trailing parenthesized token ending
 * in "context" is collapsed — a future "(500K context)" becomes "(500K)"
 * rather than silently no-opping. The token's own casing is preserved.
 * Any other display name passes through unchanged.
 */
function compactModelName(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/\s*\(([^)]+?)\s+(?:context|ctx)\)$/i, ' ($1)');
}

// --- Git segment (opt-in) ------------------------------------------------------
//
// Opt-in via `statusline.show_git: true` in .planning/config.json. Renders the
// current branch plus compact work-state markers after the directory segment:
//   " │ main+2~1?3↑1"  (staged / unstaged / untracked / ahead / behind)
//   " │ main✓"         (clean, in sync)
// One `git status --porcelain=v2 --branch` spawn per render — no shell, args
// are a fixed array, and the workspace dir is passed via -C. Fails silently
// (segment absent) outside a repo, without git, or on timeout.

const GIT_STATUS_TIMEOUT_MS = 1500;

/**
 * Run `git status --porcelain=v2 --branch` in dir.
 * Returns raw stdout, or null when git is missing, dir isn't a repo, or the
 * call times out. Never throws.
 */
function readGitStatus(dir) {
  try {
    // 8 MiB maxBuffer (default 1 MiB) headroom for repos with very many changed
    // or untracked files; overflow still degrades safely to segment-absent via
    // the catch below.
    return childProcess.execFileSync('git', ['-C', dir, 'status', '--porcelain=v2', '--branch'],
      { encoding: 'utf8', timeout: GIT_STATUS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (e) {
    return null;
  }
}

/**
 * Pure function: parse `git status --porcelain=v2 --branch` output.
 *
 * Returns { branch, ahead, behind, staged, unstaged, untracked } or null when
 * the text carries no branch header (not a repo / unparseable). Detached HEAD
 * reports branch "(detached)" — porcelain v2's literal spelling, shown as-is.
 * Unmerged (conflict) entries count as unstaged: they're pending work either way.
 */
function parseGitStatus(text) {
  if (typeof text !== 'string') return null;
  const info = { branch: null, ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0 };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      info.branch = line.slice('# branch.head '.length).trim() || null;
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { info.ahead = parseInt(m[1], 10); info.behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // Changed / renamed entries: XY pair at cols 2-3, '.' = unmodified side
      const xy = line.slice(2, 4);
      if (xy[0] !== '.') info.staged++;
      if (xy[1] !== '.') info.unstaged++;
    } else if (line.startsWith('u ')) {
      info.unstaged++;
    } else if (line.startsWith('? ')) {
      info.untracked++;
    }
  }
  return info.branch ? info : null;
}

/**
 * Pure function: format parsed git info into the statusline segment, divider
 * included (mirrors lastCmdSuffix). Branch is dimmed to match the directory
 * segment; markers keep their own colors. Returns '' when info is absent.
 */
function buildGitSegment(info) {
  if (!info || !info.branch) return '';
  const markers = [];
  if (info.staged) markers.push(`\x1b[32m+${info.staged}\x1b[0m`);
  if (info.unstaged) markers.push(`\x1b[33m~${info.unstaged}\x1b[0m`);
  if (info.untracked) markers.push(`\x1b[31m?${info.untracked}\x1b[0m`);
  if (info.ahead) markers.push(`\x1b[32m↑${info.ahead}\x1b[0m`);
  if (info.behind) markers.push(`\x1b[31m↓${info.behind}\x1b[0m`);
  const state = markers.length ? markers.join('') : '\x1b[32m✓\x1b[0m';
  return ` │ \x1b[2m${info.branch}\x1b[0m${state}`;
}

// --- STATE.md freshness marker (opt-in, #2734) --------------------------------
//
// Opt-in via `statusline.show_state_freshness: true`. Renders `state ~N
// commits back` inside the GSD-state segment when STATE.md's `state_head`
// stamp (#2573) is at least STATE_HEAD_ADVISORY_COMMITS commits behind HEAD.
// Same impure-reader -> pure-IR -> pure-formatter shape as the git segment
// above. See .gsd/phase/feat-2734-statusline-state-freshness/40-design.md.

// Deliberate mirror of the fence in src/state.cts (STATE_HEAD_HASH_RE) — kept
// hook-side rather than requiring state.cjs on the per-render path (measured
// ~20ms; see design doc "Laws that apply"). tests/gsd-statusline.test.cjs
// asserts behavioral parity against readStateHeadFreshness rather than
// comparing source (local/no-source-grep forbids the latter anyway).
const STATE_HEAD_HASH_RE = /^[0-9a-f]{4,40}$/i;

// Mirror of the constant verify.cts's W024 health check thresholds on
// (STATE_HEAD_ADVISORY_COMMITS). A test asserts equality with verify.cjs's
// export so the two copies can't drift.
const STATE_HEAD_ADVISORY_COMMITS = 20;

// Same bound class as GIT_STATUS_TIMEOUT_MS above.
const STATE_FRESHNESS_GIT_TIMEOUT_MS = 1500;

/**
 * Pure function: does raw pass the state_head hash fence? Must run BEFORE any
 * value from STATE.md reaches a git argv slot.
 */
function isValidStateHeadStamp(raw) {
  return typeof raw === 'string' && STATE_HEAD_HASH_RE.test(raw.trim());
}

/**
 * Run `git rev-list --left-right --count <stamp>...HEAD` in root. Returns raw
 * stdout, or null when git is missing, root isn't a repo, the stamp is
 * unknown, or the call times out. Never throws. Only call with a stamp that
 * already passed isValidStateHeadStamp/the hash fence above.
 */
function readStateHeadCommits(root, stamp) {
  try {
    return childProcess.execFileSync('git',
      ['-C', root, 'rev-list', '--left-right', '--count', `${stamp}...HEAD`],
      { encoding: 'utf8', timeout: STATE_FRESHNESS_GIT_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (e) {
    return null;
  }
}

/**
 * Pure function: parse `git rev-list --left-right --count A...B` output
 * ("<left>\t<right>"). Returns { left, right } as non-negative integers, or
 * null when text isn't a matching string (covers null, '', 'garbage', '1',
 * 'a\tb', '\t', and any other unparseable shape).
 */
function parseRevListCounts(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(/^(\d+)\s+(\d+)\s*$/);
  if (!m) return null;
  return { left: parseInt(m[1], 10), right: parseInt(m[2], 10) };
}

/**
 * Impure -> pure IR: derive the freshness signal for a recorded state_head
 * stamp. Returns { state_head, commits_behind, commit_stale } — never throws,
 * every unresolvable input degrades to the all-null-but-state_head shape.
 *
 * Order (each failure returns immediately, no further work):
 *   a. hash fence — malformed/absent stamp never reaches a spawn
 *   b. repo pinning — root must own its own .git (mirrors projectOwnsItsRepo
 *      in src/state.cts: a filesystem-identity check, not a --show-toplevel
 *      string compare, which is unreliable on macOS /private/var and Windows
 *      8.3 paths). Costs no subprocess.
 *   c. sub_repos guard — a planning.sub_repos workspace's outer HEAD never
 *      advances when code lands in nested children, so a "fresh" answer here
 *      would be a confident lie. Costs no subprocess.
 *   d. one bounded git spawn: rev-list --left-right --count answers ancestry
 *      and distance together. left > 0 means the stamp is not an ancestor of
 *      HEAD (reset/rebase/force-push) -> unknown, never "fresh".
 */
function deriveStateFreshness(root, stamp, deps = {}) {
  const { existsSync = fs.existsSync, readConfig = readGsdConfig, readCounts = readStateHeadCommits } = deps;

  const raw = typeof stamp === 'string' ? stamp.trim() : '';
  const valid = STATE_HEAD_HASH_RE.test(raw);
  const state_head = valid ? raw.slice(0, 7) : null;
  const nullResult = { state_head, commits_behind: null, commit_stale: null };
  if (!valid || !root) return nullResult;

  try {
    if (!existsSync(path.join(root, '.git'))) return nullResult;
  } catch (e) {
    return nullResult;
  }

  try {
    const cfg = readConfig(root);
    const sub = getConfigValue(cfg, 'planning.sub_repos') ?? getConfigValue(cfg, 'sub_repos');
    if (Array.isArray(sub) && sub.length > 0) return nullResult;
  } catch (e) {
    return nullResult;
  }

  const counts = parseRevListCounts(readCounts(root, raw));
  if (!counts || counts.left > 0) return nullResult;

  return { state_head, commits_behind: counts.right, commit_stale: counts.right > 0 };
}

/**
 * Pure function: format the freshness IR into the marker text, or '' below
 * STATE_HEAD_ADVISORY_COMMITS (including when commits_behind is absent/null —
 * the unknown case must never render, never mind alarm on it).
 */
function formatStateFreshness(fresh) {
  if (!fresh || typeof fresh.commits_behind !== 'number' || fresh.commits_behind < STATE_HEAD_ADVISORY_COMMITS) return '';
  return `state ~${fresh.commits_behind} commits back`;
}

/**
 * Pure function: single source of truth for statusline config resolution.
 * `runStatusline()` and `renderStatusline()` previously read this config
 * independently, which had drifted into a live divergence between the two
 * entry points — this collapses both onto one resolver.
 *
 * @param {object} cfg — parsed .planning/config.json (readGsdConfig())
 * @returns {{ showLastCommand: boolean, position: 'end'|'front', stateFormat: 'full'|'compact', showGit: boolean, showStateFreshness: boolean }}
 */
function resolveStatuslineOptions(cfg) {
  const showLastCommand = getConfigValue(cfg, 'statusline.show_last_command') === true;
  const cfgPos = getConfigValue(cfg, 'statusline.context_position');
  // Clamp any non-'front' value (including absent/null) to 'end' — the single
  // source of truth for this default; composeStatusline's own coercion stays
  // as belt-and-suspenders defense for direct callers.
  const position = cfgPos === 'front' ? 'front' : 'end';
  const stateFormat = getConfigValue(cfg, 'statusline.state_format') === 'compact' ? 'compact' : 'full';
  const showGit = getConfigValue(cfg, 'statusline.show_git') === true;
  const showStateFreshness = getConfigValue(cfg, 'statusline.show_state_freshness') === true;
  return { showLastCommand, position, stateFormat, showGit, showStateFreshness };
}

// --- stdin ------------------------------------------------------------------

function runStatusline() {
  let input = '';
  // Timeout guard: if stdin doesn't close within 3s (e.g. pipe issues on
  // Windows/Git Bash), exit silently instead of hanging. See #775.
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    const model = compactModelName(data.model?.display_name || 'Claude');
    const dir = data.workspace?.current_dir || process.cwd();
    const session = data.session_id || '';
    const remaining = data.context_window?.remaining_percentage;

    // Read .planning config once — used by the context meter (token suffix)
    // and the last-command/position block below. Fail-soft to {}.
    let cfg = {};
    try { cfg = readGsdConfig(dir); } catch (e) {}

    // Context window display (shows USED percentage scaled to usable context)
    // Claude Code reserves a buffer for autocompact. By default this is ~16.5%
    // of the total window, but users can override it via CLAUDE_CODE_AUTO_COMPACT_WINDOW
    // (a token count). When the env var is set, compute the buffer % dynamically so
    // the meter correctly reflects early-compaction configurations (#2219).
    const totalCtx = data.context_window?.total_tokens || 1_000_000;
    const acw = parseInt(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '0', 10);
    const AUTO_COMPACT_BUFFER_PCT = acw > 0
      ? Math.min(100, Math.max(0, (1 - acw / totalCtx) * 100))
      : 16.5;
    let ctx = '';
    if (remaining != null) {
      // Normalize: subtract buffer from remaining, scale to usable range
      const usableRemaining = Math.max(0, ((remaining - AUTO_COMPACT_BUFFER_PCT) / (100 - AUTO_COMPACT_BUFFER_PCT)) * 100);
      const used = Math.max(0, Math.min(100, Math.round(100 - usableRemaining)));

      // Write context metrics to bridge file for the context-monitor PostToolUse hook.
      // The monitor reads this file to inject agent-facing warnings when context is low.
      // Reject session IDs with path separators or traversal sequences to prevent
      // a malicious session_id from writing files outside the temp directory.
      const sessionSafe = session && !/[/\\]|\.\./.test(session);
      if (sessionSafe) {
        try {
          const bridgePath = path.join(os.tmpdir(), `claude-ctx-${session}.json`);
          // used_pct written to the bridge must match CC's native /context reporting:
          // raw used = 100 - remaining_percentage (no buffer normalization applied).
          // The normalized `used` value is correct for the statusline progress bar but
          // inflates the context monitor warning messages by ~13 points (#2451).
          const rawUsedPct = Math.round(100 - remaining);
          const bridgeData = JSON.stringify({
            session_id: session,
            remaining_percentage: remaining,
            used_pct: rawUsedPct,
            timestamp: Math.floor(Date.now() / 1000)
          });
          fs.writeFileSync(bridgePath, bridgeData);
        } catch (e) {
          // Silent fail -- bridge is best-effort, don't break statusline
        }
      }

      // Build progress bar (10 segments)
      const filled = Math.floor(used / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);

      // Opt-in absolute token count after the percentage (statusline.show_context_tokens)
      let tokenSuffix = '';
      if (getConfigValue(cfg, 'statusline.show_context_tokens') === true) {
        tokenSuffix = contextTokenSuffix(data.context_window?.current_usage);
      }

      // Color based on usable context thresholds
      if (used < 50) {
        ctx = ` \x1b[32m${bar} ${used}%${tokenSuffix}\x1b[0m`;
      } else if (used < 65) {
        ctx = ` \x1b[33m${bar} ${used}%${tokenSuffix}\x1b[0m`;
      } else if (used < 80) {
        ctx = ` \x1b[38;5;208m${bar} ${used}%${tokenSuffix}\x1b[0m`;
      } else {
        ctx = ` \x1b[5;31m💀 ${bar} ${used}%${tokenSuffix}\x1b[0m`;
      }
    }

    // Current task from todos
    let task = '';
    const homeDir = os.homedir();
    // Respect CLAUDE_CONFIG_DIR for custom config directory setups (#870)
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
    const todosDir = path.join(claudeDir, 'todos');
    if (session && fs.existsSync(todosDir)) {
      try {
        // Single-pass max-by-mtime scan: only the newest matching todos file
        // is needed, so the O(n log n) sort and the intermediate array from the
        // prior `.filter().map(statSync).sort()` chain are unnecessary. Identical
        // I/O (one statSync per match) and identical result. (#305)
        let latest = null;
        for (const entry of fs.readdirSync(todosDir)) {
          if (!entry.startsWith(session) || !entry.includes('-agent-') || !entry.endsWith('.json')) continue;
          const mtime = fs.statSync(path.join(todosDir, entry)).mtime;
          if (!latest || mtime > latest.mtime) latest = { name: entry, mtime };
        }

        if (latest) {
          try {
            const todos = JSON.parse(fs.readFileSync(path.join(todosDir, latest.name), 'utf8'));
            const inProgress = todos.find(t => t.status === 'in_progress');
            if (inProgress) task = inProgress.activeForm || '';
          } catch (e) {}
        }
      } catch (e) {
        // Silently fail on file system errors - don't break statusline
      }
    }

    // GSD state (milestone · status · phase) — shown when no todo task.
    // Format resolved below once config is read (statusline.state_format).
    let gsdStateStr = '';

    // GSD update available?
    // Read only the per-package shared cache file (#607). The legacy
    // runtime-specific fallback has been removed — the per-package filename
    // carries lineage and avoids multi-runtime resolution mismatches (#1421).
    let gsdUpdate = '';
    const cacheFile = path.join(homeDir, '.cache', 'gsd', updateCacheFileName);
    if (fs.existsSync(cacheFile)) {
      try {
        const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        const { showUpdate, staleWarning } = evaluateUpdateCache(cache);
        if (showUpdate) {
          gsdUpdate = '\x1b[33m⬆ /gsd:update\x1b[0m │ ';
        }
        if (staleWarning === 'dev') {
          gsdUpdate += '\x1b[33m⚠ dev install — re-run installer to sync hooks\x1b[0m │ ';
        } else if (staleWarning === 'stale') {
          gsdUpdate += '\x1b[31m⚠ stale hooks — run /gsd:update\x1b[0m │ ';
        }
      } catch (e) {}
    }

    // Last-slash-command suffix and context_position config (#2538, #2937).
    // Reads the active session transcript for the most recent <command-name> tag.
    // Failure here must never break the statusline — wrap the entire lookup.
    // #2734: config resolution moved to resolveStatuslineOptions() — the single
    // source of truth shared with renderStatusline() below. The two entry
    // points duplicated this resolution byte-for-byte; one copy is what keeps
    // a new key from reaching only one of them.
    let lastCmdSuffix = '';
    let gitSuffix = '';
    const options = resolveStatuslineOptions(cfg);
    try {
      if (options.showLastCommand) {
        const transcriptPath = data.transcript_path;
        const lastCmd = readLastSlashCommand(transcriptPath);
        if (lastCmd) {
          lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
        }
      }
      if (options.showGit) {
        gitSuffix = buildGitSegment(parseGitStatus(readGitStatus(dir)));
      }
    } catch (e) {
      // Never break the statusline on config/transcript/git errors
    }

    // #2734: readGsdState is inside `if (!task)` deliberately — when a todo
    // task is in flight the GSD-state segment is not rendered, so spending a
    // freshness git spawn here would spend a subprocess on discarded output.
    if (!task) {
      const state = readGsdState(dir, { stateFreshness: options.showStateFreshness }) || {};
      gsdStateStr = options.stateFormat === 'compact' ? formatGsdStateCompact(state) : formatGsdState(state);
    }

    // Output
    const dirname = path.basename(dir);
    const middle = task
      ? `\x1b[1m${task}\x1b[0m`
      : gsdStateStr
        ? `\x1b[2m${gsdStateStr}\x1b[0m`
        : null;

    process.stdout.write(composeStatusline({ gsdUpdate, model, ctx, middle, dirname, lastCmdSuffix, gitSuffix, position: options.position }));
  } catch (e) {
    // Silent fail - don't break statusline on parse errors
  }
});
}

// --- Layout composer --------------------------------------------------------

/**
 * Compose the statusline string from pre-built segments.
 *
 * @param {object} opts
 * @param {string} [opts.gsdUpdate='']      - leading update/stale-hooks warning (already formatted)
 * @param {string} opts.model               - model display name (plain text; dim styling applied here)
 * @param {string} [opts.ctx='']            - context-window meter segment (empty string = absent)
 * @param {string|null} [opts.middle=null]  - middle segment (todo task or GSD state), null = absent
 * @param {string} opts.dirname             - project directory basename (dim styling applied here)
 * @param {string} [opts.lastCmdSuffix='']  - last-command suffix, e.g. ' │ last: /foo'
 * @param {string} [opts.gitSuffix='']      - git branch/status segment, e.g. ' │ main✓' (after dirname)
 * @param {'end'|'front'} [opts.position='end']
 *   - 'end'   (default): ctx appended after dirname — preserved byte-for-byte
 *   - 'front': ctx immediately after model name so the meter stays visible in narrow terminals
 *
 * Invalid position values are silently coerced to 'end' — config-set schema rejects
 * invalid values upfront; runtime fallback defends against stale/corrupt configs
 * without breaking the statusline.
 */
function composeStatusline({
  gsdUpdate = '',
  model,
  ctx = '',
  middle = null,
  dirname,
  lastCmdSuffix = '',
  gitSuffix = '',
  position = 'end',
} = {}) {
  const modelSeg = `\x1b[2m${model}\x1b[0m`;
  const dirSeg = `\x1b[2m${dirname}\x1b[0m`;
  // Coerce invalid values to 'end' (belt-and-suspenders; see JSDoc above)
  const pos = position === 'front' ? 'front' : 'end';

  if (pos === 'front') {
    if (middle) return `${gsdUpdate}${modelSeg}${ctx} │ ${middle} │ ${dirSeg}${gitSuffix}${lastCmdSuffix}`;
    return `${gsdUpdate}${modelSeg}${ctx} │ ${dirSeg}${gitSuffix}${lastCmdSuffix}`;
  }
  // 'end' — preserved byte-for-byte relative to original inline templates
  if (middle) return `${gsdUpdate}${modelSeg} │ ${middle} │ ${dirSeg}${gitSuffix}${ctx}${lastCmdSuffix}`;
  return `${gsdUpdate}${modelSeg} │ ${dirSeg}${gitSuffix}${ctx}${lastCmdSuffix}`;
}

function isInstalledAheadOfLatest(installed, latest) {
  return isSemverNewer(installed, latest);
}

/**
 * Pure function: evaluate an update-check cache object and return display flags.
 * Applies lineage guard — if package_name is absent or foreign, treats cache as absent.
 *
 * @param {object|null} cache  Parsed cache object, or null.
 * @returns {{ showUpdate: boolean, staleWarning: 'none'|'dev'|'stale' }}
 */
function evaluateUpdateCache(cache) {
  const none = { showUpdate: false, staleWarning: 'none' };
  if (!cache) return none;
  // Lineage guard: package_name must be present and match this package.
  if (!cache.package_name || cache.package_name !== PACKAGE_NAME) return none;
  const showUpdate = Boolean(cache.update_available);
  let staleWarning = 'none';
  if (cache.stale_hooks && cache.stale_hooks.length > 0) {
    const isDevInstall = (
      cache.installed &&
      cache.latest &&
      cache.latest !== 'unknown' &&
      isInstalledAheadOfLatest(cache.installed, cache.latest)
    );
    staleWarning = isDevInstall ? 'dev' : 'stale';
  }
  return { showUpdate, staleWarning };
}

// Export helpers for unit tests. Harmless when run as a script.
module.exports = {
  readGsdState, parseStateMd, formatGsdState,
  readGsdConfig, getConfigValue, readLastSlashCommand,
  composeStatusline,
  isInstalledAheadOfLatest,
  evaluateUpdateCache,
  formatTokens,
  contextTokenSuffix,
  shortGsdStatus, formatGsdStateCompact,
  compactModelName,
  readGitStatus, parseGitStatus, buildGitSegment,
  STATE_HEAD_ADVISORY_COMMITS, isValidStateHeadStamp,
  readStateHeadCommits, parseRevListCounts, deriveStateFreshness,
  formatStateFreshness, resolveStatuslineOptions,
};

/**
 * Render the statusline from an already-parsed hook input object. Exported for
 * testing without feeding stdin. Returns the rendered string.
 */
function renderStatusline(data) {
  const model = compactModelName(data.model?.display_name || 'Claude');
  const dir = data.workspace?.current_dir || process.cwd();
  const dirname = path.basename(dir);

  // #2734: config resolution moved to resolveStatuslineOptions() — the single
  // source of truth shared with runStatusline() above. The two entry points
  // duplicated this resolution byte-for-byte; one copy is what keeps a new
  // key from reaching only one of them.
  let lastCmdSuffix = '';
  let gitSuffix = '';
  let options = { showLastCommand: false, position: 'end', stateFormat: 'full', showGit: false, showStateFreshness: false };
  try {
    const cfg = readGsdConfig(dir);
    options = resolveStatuslineOptions(cfg);
    if (options.showLastCommand) {
      const lastCmd = readLastSlashCommand(data.transcript_path);
      if (lastCmd) {
        lastCmdSuffix = ` │ \x1b[2mlast: /${lastCmd}\x1b[0m`;
      }
    }
    if (options.showGit) {
      gitSuffix = buildGitSegment(parseGitStatus(readGitStatus(dir)));
    }
  } catch (e) { /* swallow */ }

  const state = readGsdState(dir, { stateFreshness: options.showStateFreshness }) || {};
  const gsdStateStr = options.stateFormat === 'compact' ? formatGsdStateCompact(state) : formatGsdState(state);
  const middle = gsdStateStr ? `\x1b[2m${gsdStateStr}\x1b[0m` : null;
  return composeStatusline({ model, ctx: '', middle, dirname, lastCmdSuffix, gitSuffix, position: options.position });
}

module.exports.renderStatusline = renderStatusline;

if (require.main === module) runStatusline();
