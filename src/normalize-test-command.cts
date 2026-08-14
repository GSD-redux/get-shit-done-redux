/**
 * Test-command normalizer (#1857).
 *
 * A GSD verification gate resolves a project's test command and runs it. When
 * that command is a watch/dev-mode runner (vitest defaults to WATCH in an
 * interactive TTY — which is exactly a user running `gsd-execute-phase` in their
 * terminal — and jest with `--watch`/`--watchAll`), the process never exits and
 * the orchestrator waits forever.
 *
 * `normalizeTestCommand` rewrites a resolved command to a best-effort one-shot
 * form so a gate cannot hang on watch mode. It is intentionally conservative:
 *   - it NEVER double-adds flags (already-one-shot commands are returned verbatim),
 *   - it only touches commands it positively recognises as a watch runner,
 *   - anything it cannot classify is returned unchanged.
 * The gate's wall-clock `timeout` is the ultimate guarantee for anything this
 * best-effort pass cannot defeat (e.g. an explicit `--watch` baked into a
 * project's `test` script, which even `CI=1` cannot override per vitest docs).
 *
 * Bounded by design (#1857 security review): the input is length-capped, all
 * scanning is linear-time (no super-linear regex backtracking), and package.json
 * is only read when it is a regular file — so normalization itself can never
 * hang or take super-linear time on an adversarial `workflow.test_command`.
 *
 * Single source of truth: all four test-command gates (regression, post-merge,
 * audit-fix) route their resolved command through this helper so
 * the paths cannot drift.
 *
 * Leaf module — depends only on node:fs / node:path.
 */

import fs from 'node:fs';
import path from 'node:path';

// A resolved test command is never realistically this long; anything larger is
// not a real runner invocation. We skip normalization above this bound (the
// gate's own timeout still bounds the actual run) so no regex ever scans an
// adversarial multi-KB string.
const MAX_COMMAND_LENGTH = 4096;

// Markers proving a command is already one-shot / non-watch. If any is present
// we return the command unchanged so we never double-add flags or fight an
// explicit user choice.
const ONE_SHOT_MARKERS: RegExp[] = [
  /(?:^|\s)vitest\s+run\b/, // vitest run …
  /(?:^|\s)--run\b/, // vitest --run
  /(?:^|\s)--no-watch\b/, // vitest --no-watch
  /(?:^|\s)--watchAll=false\b/, // jest --watchAll=false
  /(?:^|\s)--watch=false\b/,
  /(?:^|\s)--ci\b/, // jest --ci
  /^\s*CI=/, // already forced into CI/run mode via env
];

/** True if the command already runs one-shot (so normalization is a no-op). */
function isAlreadyOneShot(cmd: string): boolean {
  return ONE_SHOT_MARKERS.some((re) => re.test(cmd));
}

// Match a runner as a standalone command TOKEN (whitespace-delimited), NOT as a
// substring — so "vitest.config.js" / "jest-environment" / "node vitest-x.js"
// are not treated as the runner and are never mangled.
const VITEST_TOKEN = /(?:^|\s)vitest(?=\s|$)/;
const JEST_TOKEN = /(?:^|\s)jest(?=\s|$)/;

/**
 * Linear-time detection of a package-manager `test` script invocation
 * (`npm test`, `pnpm run test`, `pnpm --dir app test`, `yarn test`, …). We split
 * on shell separators FIRST (linear), then test each bounded segment with simple
 * anchored regexes — no tempered-greedy scan, so no super-linear backtracking on
 * adversarial input.
 */
function isScriptInvocation(cmd: string): boolean {
  return cmd.split(/&&|\|\||;/).some((seg) => {
    const s = seg.trim();
    return /^(?:npm|pnpm|yarn|bun)\b/.test(s) && /\btest\b/.test(s);
  });
}

/**
 * Resolve the package.json directory for a command that may target a different
 * working dir via `--dir <p>` (pnpm), `-C <p>` (pnpm), or `--prefix <p>` (npm).
 */
function resolvePackageDir(cmd: string, cwd: string): string {
  const m = cmd.match(/(?:--dir|--prefix|-C)[=\s]+(\S+)/);
  if (m && m[1]) {
    const p = m[1].replace(/^['"]|['"]$/g, '');
    return path.isAbsolute(p) ? p : path.join(cwd, p);
  }
  return cwd;
}

type WatchRunner = 'vitest' | 'jest' | null;

/**
 * Inspect package.json `scripts.test` for the given command's target dir and
 * report whether it resolves to a watch-by-default / explicitly-watching runner.
 * Only ever reads `scripts.test` as a STRING for classification — it is never
 * executed or spliced into the output.
 */
function scriptTestRunner(cmd: string, cwd: string): WatchRunner {
  try {
    const pkgPath = path.join(resolvePackageDir(cmd, cwd), 'package.json');
    // Only read a REGULAR file — never block on a FIFO/socket/dir named
    // "package.json" reachable via --dir (#1857 security review).
    let stat: fs.Stats;
    try {
      stat = fs.statSync(pkgPath);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as {
      scripts?: Record<string, string>;
    };
    const testScript = pkg.scripts?.test ?? '';
    if (!testScript) return null;
    // vitest watches by default unless the script itself is already one-shot.
    if (VITEST_TOKEN.test(testScript) && !isAlreadyOneShot(testScript)) return 'vitest';
    // jest only watches when explicitly asked to.
    if (
      JEST_TOKEN.test(testScript) &&
      /(?:^|\s)--watch(?:All)?\b/.test(testScript) &&
      !/--watch(?:All)?=false\b/.test(testScript)
    ) {
      return 'jest';
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip a bare/explicit-true `--watch` / `--watchAll` (never `=false`). */
function stripWatchFlags(cmd: string): string {
  return cmd
    .replace(/(?:^|\s)--watch(?:All)?(?:=true)?(?=\s|$)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Normalize a resolved test command to a best-effort one-shot form.
 *
 * @param rawCmd The resolved test command (e.g. from `config-get
 *   workflow.test_command` or the gate's runner sniff).
 * @param cwd    Directory used to locate package.json for script invocations.
 * @returns A one-shot command, or `rawCmd` unchanged when it is already
 *   one-shot / not a recognised watch runner / too long to be a real runner.
 */
function normalizeTestCommand(rawCmd: string, cwd: string): string {
  const cmd = (rawCmd ?? '').trim();
  if (!cmd || cmd === 'true') return rawCmd;
  if (cmd.length > MAX_COMMAND_LENGTH) return rawCmd; // bound all downstream scanning
  if (isAlreadyOneShot(cmd)) return rawCmd;

  const isScript = isScriptInvocation(cmd);

  // 1. Direct vitest invocation (`vitest`, `npx vitest`, `pnpm exec vitest`, …):
  //    force the explicit one-shot `run` command and drop any bare --watch.
  if (VITEST_TOKEN.test(cmd) && !isScript) {
    return stripWatchFlags(cmd).replace(/(^|\s)vitest(?=\s|$)/, '$1vitest run');
  }

  // 2. Direct jest invocation with an explicit watch flag: make it one-shot.
  if (JEST_TOKEN.test(cmd) && !isScript) {
    if (/(?:^|\s)--watch(?:All)?\b/.test(cmd)) {
      return `${stripWatchFlags(cmd)} --watchAll=false`;
    }
    return rawCmd; // jest without --watch already runs once
  }

  // 3. Package-manager `test` script invocation: the runner is inside
  //    package.json. If it resolves to a watch runner, force CI/run mode via
  //    the CI env — robust across --dir and pnpm/yarn `--` propagation quirks
  //    (vitest & jest both switch to run/non-interactive mode when CI is set).
  if (isScript) {
    const runner = scriptTestRunner(cmd, cwd);
    if (runner === 'vitest' || runner === 'jest') {
      return `CI=true ${cmd}`;
    }
    return rawCmd;
  }

  return rawCmd;
}

/**
 * CLI handler for `gsd-tools query normalize-test-command <raw-cmd>`: prints the
 * normalized one-shot command to stdout (the gates capture it via `$(…)`).
 */
function cmdNormalizeTestCommand(cwd: string, rawCmd: string | undefined): void {
  process.stdout.write(normalizeTestCommand(rawCmd ?? '', cwd));
}

export = {
  normalizeTestCommand,
  cmdNormalizeTestCommand,
  isAlreadyOneShot,
};
