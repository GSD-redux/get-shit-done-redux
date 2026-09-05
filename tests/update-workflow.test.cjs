/**
 * Regression (#498, adversarial-review finding): the custom-file backup step in
 * update.md must derive RUNTIME_DIR from GSD_DIR.
 *
 * The get_installed_version step was rewritten to call `gsd-tools update-context`
 * and now emits GSD_DIR (the resolved config dir) instead of the old probe-loop
 * variables LOCAL_DIR / GLOBAL_DIR. The backup_custom_files step still read
 * LOCAL_DIR / GLOBAL_DIR, which are no longer assigned anywhere — so RUNTIME_DIR
 * went empty for every LOCAL/GLOBAL install and detect-custom-files was skipped.
 * Because the update then runs a clean install that wipes managed dirs
 * (commands/gsd, gsd-core), user-added files inside those dirs could be
 * deleted without the intended backup.
 *
 * This locks the fix: RUNTIME_DIR comes from GSD_DIR, and the dead LOCAL_DIR /
 * GLOBAL_DIR references are gone.
 *
 * Source-text-is-the-product: update.md's bash blocks ARE the deployed /gsd:update
 * program; asserting their shape is asserting on the deployed contract.
 */

// allow-test-rule: source-text-is-the-product (#3338)
// update.md's bash blocks ARE the deployed /gsd:update program; asserting
// their shape is asserting on the deployed contract. The data-loss behavior
// only manifests against a real install during a clean reinstall, which CI
// does not perform.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractFencedBlock } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const UPDATE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md');

function codeOnly(file) {
  // Strip fenced-block prose is unnecessary here; we assert on the whole doc
  // but ignore markdown comment prose by only matching shell-assignment forms.
  return fs.readFileSync(file, 'utf8');
}

describe('#4153 regression: unresolved update targets stop before later workflow steps', () => {
  const src = codeOnly(UPDATE_MD);
  const start = src.indexOf('<step name="get_installed_version">');
  const end = src.indexOf('</step>', start);

  test('the unresolved path is explicit, ordered, and contains no mutation', () => {
    assert.ok(start >= 0, 'get_installed_version step must exist');
    assert.ok(end > start, 'get_installed_version step must close');
    const step = src.slice(start, end);
    const unresolved = step.indexOf('UPDATE_TARGET_UNRESOLVED');
    const exit = step.indexOf('Exit.', unresolved);

    assert.ok(unresolved >= 0, 'unresolved target must have a typed result');
    assert.match(step, /TARGET_RUNTIME=""/);
    assert.match(step, /GSD_DIR=""/);
    assert.match(
      step,
      /otherwise leave (?:it )?empty/,
      'an unrecognized execution_context path must not infer Claude',
    );
    assert.match(step, /`\/\.claude\/` -> `claude`/);
    assert.match(step, /`\/\.windsurf\/`, `\/\.devin\/` -> `windsurf`/);
    assert.doesNotMatch(step, /otherwise `?claude`?\./);
    assert.match(step, /INSTALL_SCOPE` is `UNKNOWN`, `TARGET_RUNTIME` is empty, or `GSD_DIR` is empty/);
    assert.match(step, /rerun from a valid installed runtime/i);
    assert.match(step, /Rerun from a valid installed runtime: `\/gsd:update`\./);
    assert.match(step, /npx -y --package=@opengsd\/gsd-core@latest -- gsd-core --global/);
    assert.match(step, /target runtime \(`claude`, `opencode`, `kilo`, `codex`, `antigravity`, `windsurf`\)/);
    assert.ok(exit > unresolved, 'unresolved target must exit before the next step');

    const versionMissing = step.indexOf('VERSION file missing');
    assert.ok(versionMissing >= 0, 'VERSION-missing bullet must exist');
    assert.ok(
      unresolved < versionMissing,
      'unresolved-target gate must precede the VERSION-missing bullet, or the ' +
        'fully-unresolved case (version 0.0.0 AND unresolved target) can fall ' +
        'through to "proceed to install" instead of exiting',
    );
    assert.match(
      step,
      /Otherwise, if VERSION file missing.*but the target above resolved/,
      'VERSION-missing bullet must be explicitly scoped to exclude the unresolved-target case',
    );

    const mutationSpies = [
      { name: 'version check', text: src, needle: 'check-latest-version.cjs', after: end },
      { name: 'custom-file detection', text: src, needle: 'detect-custom-files --config-dir', after: end },
      { name: 'resolved installer', text: src, needle: 'npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core "$RUNTIME_FLAG"', after: end },
      { name: 'update-cache removal', text: src, needle: 'rm -f "$HOME/.cache/gsd/gsd-update-check"', after: end },
      { name: 'restore apply', text: src, needle: 'restore-custom-files --config-dir "$GSD_DIR" --apply', after: end },
      { name: 'patch check', text: src, needle: 'check_local_patches', after: end },
    ];
    for (const { name, text, needle, after } of mutationSpies) {
      assert.equal(step.indexOf(needle), -1, `unresolved path reaches ${name}`);
      assert.ok(text.indexOf(needle, after) >= after, `${name} must remain after the exit`);
    }
  });

  test('latest-result parsing stays Node-only and preserves the false default', () => {
    const latestStart = src.indexOf('<step name="check_latest_version">');
    const latestEnd = src.indexOf('</step>', latestStart);

    assert.ok(latestStart >= 0, 'check_latest_version step must exist');
    assert.ok(latestEnd > latestStart, 'check_latest_version step must close');
    const latest = src.slice(latestStart, latestEnd);
    const latestBash = extractFencedBlock(latest, 'bash');

    assert.ok(latestBash, 'check_latest_version must contain a bash block');
    assert.doesNotMatch(latestBash, /\bjq\b/, 'latest-result parsing must not invoke jq');
    assert.match(
      latestBash,
      /uc_field\(\)\s*\{/,
      'check_latest_version must define its JSON parser in the same shell block that invokes it',
    );
    assert.match(
      latest,
      /if LATEST_RESULT="\$\(node [^\n]+\)"; then\s+LATEST_STATUS=0\s+else\s+LATEST_STATUS=\$\?\s+fi/,
      'latest-version failure must be captured when errexit is active',
    );
    assert.match(latest, /LATEST_OK="\$\(uc_field ok "\$LATEST_RESULT"\)"/);
    assert.match(latest, /LATEST_OK="\$\{LATEST_OK:-false\}"/);
    assert.match(latest, /LATEST_VERSION="\$\(uc_field version "\$LATEST_RESULT"\)"/);
    assert.match(latest, /LATEST_REASON="\$\(uc_field reason "\$LATEST_RESULT"\)"/);
  });
});

describe('#498 regression: update.md backup uses GSD_DIR, not the removed LOCAL_DIR/GLOBAL_DIR', () => {
  const src = codeOnly(UPDATE_MD);

  test('RUNTIME_DIR is assigned from GSD_DIR', () => {
    assert.match(
      src,
      /RUNTIME_DIR="\$GSD_DIR"/,
      'backup_custom_files must set RUNTIME_DIR="$GSD_DIR" (the resolved config dir from update-context)',
    );
  });

  test('no shell assignment reads the removed LOCAL_DIR/GLOBAL_DIR probe variables', () => {
    // The get_installed_version rewrite no longer assigns LOCAL_DIR/GLOBAL_DIR.
    // Any RUNTIME_DIR="$LOCAL_DIR" / "$GLOBAL_DIR" would silently resolve to empty.
    assert.doesNotMatch(
      src,
      /="\$(LOCAL_DIR|GLOBAL_DIR)"/,
      'update.md still reads LOCAL_DIR/GLOBAL_DIR, which get_installed_version no longer sets — backup will be skipped',
    );
  });

  test('detect-custom-files stays gated on a non-empty RUNTIME_DIR', () => {
    assert.match(
      src,
      /\[ -n "\$RUNTIME_DIR" \][\s\S]*?detect-custom-files --config-dir "\$RUNTIME_DIR"/,
      'backup must still skip when RUNTIME_DIR is empty (UNKNOWN scope)',
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-815-update-next-channel.test.cjs (#3338 H3 Wave 6)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-815-update-next-channel', () => {
// allow-test-rule: source-text-is-the-product (#3338)
// Reads product workflow/command markdown to verify the --next RC channel
// contract.

// Issue #815: `/gsd-update --next` (alias `--rc`) must thread the @next dist-tag
// through the whole update flow (version check + install) while leaving the
// default @latest path unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT815 = path.join(__dirname, '..');
const WF = fs.readFileSync(path.join(ROOT815, 'gsd-core', 'workflows', 'update.md'), 'utf8');
const CMD = fs.readFileSync(path.join(ROOT815, 'commands', 'gsd', 'update.md'), 'utf8');

test('issue #815: workflow parses --next/--rc into a TAG channel', () => {
  assert.match(WF, /--next/);
  assert.match(WF, /--rc/);
  assert.match(WF, /TAG="next"/);
  assert.match(WF, /TAG="latest"/);
});

test('issue #815: version check threads the tag through check-latest-version.cjs', () => {
  // The script path is double-quoted in the shell command, so the line is:
  //   node "$GSD_DIR/gsd-core/bin/check-latest-version.cjs" --json --tag "$TAG"
  // The closing " on the script path sits between .cjs and --json.
  assert.match(WF, /check-latest-version\.cjs"? --json --tag "\$TAG"/);
});

test('issue #815: install uses the selected tag, not a hardcoded @latest', () => {
  const robust = WF.match(/npx -y --package=@opengsd\/gsd-core@"\$TAG" -- gsd-core/g) || [];
  const runUpdateStart = WF.indexOf('<step name="run_update">');
  const runUpdateEnd = WF.indexOf('</step>', runUpdateStart);
  assert.ok(runUpdateStart >= 0 && runUpdateEnd > runUpdateStart, 'run_update step must exist');
  const runUpdate = WF.slice(runUpdateStart, runUpdateEnd);
  assert.ok(robust.length >= 2, `expected >=2 tag-parameterized npx invocations, found ${robust.length}`);
  assert.doesNotMatch(runUpdate, /--package=@opengsd\/gsd-core@latest -- gsd-core/,
    'install lines must not hardcode @latest once --next exists');
  assert.doesNotMatch(runUpdate, /--package=@opengsd\/gsd-core@(?:latest|next|beta|canary|rc) -- gsd-core/,
    'install lines must use the $TAG variable, never a hardcoded dist-tag literal');
});

test('issue #815: command documents --next/--rc and routes it to the update workflow', () => {
  assert.match(CMD, /--next/);
  assert.match(CMD, /--rc/);
  assert.match(CMD, /argument-hint:.*--next/);
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2470-update-md-claude-path.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2470-update-md-claude-path (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2470)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.


/**
 * Regression test for #2470.
 *
 * update.md is installed into every runtime directory including .gemini, .codex,
 * .opencode, etc. The installer's scanForLeakedPaths() uses the regex
 * /(?:~|\$HOME)\/\.claude\b/g to detect unresolved .claude path references after
 * copyWithPathReplacement() runs. The replacer handles "~/.claude/" (trailing slash)
 * but not "~/.claude" (bare, no trailing slash) — so any bare reference in
 * update.md would slip through and trigger the installer warning for non-Claude runtimes.
 */

const { test: __t2470, describe: __d2470 } = require('node:test');
const assert2470 = require('node:assert/strict');
const fs2470 = require('fs');
const path2470 = require('path');

const UPDATE_MD_2470 = path2470.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md');

__d2470('update.md — no bare ~.claude path references (#2470)', () => {
  const content = fs2470.readFileSync(UPDATE_MD_2470, 'utf-8');

  __t2470('update.md does not contain bare ~/\\.claude (without trailing slash)', () => {
    // This is the exact pattern from the installer's scanForLeakedPaths():
    // /(?:~|\$HOME)\/\.claude\b/g
    // The replacer handles ~/\.claude\/ (with trailing slash) but misses bare ~/\.claude
    // so we must not have bare references in the source file.
    const matches = content.match(/(?:~|\$HOME)\/\.claude(?!\/)/g);
    assert2470.strictEqual(
      matches,
      null,
      `update.md must not contain bare ~/.claude (without trailing slash) — installer scanner flags these as unresolved path refs: ${JSON.stringify(matches)}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3130-update-npx-robust-invocation.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3130-update-npx-robust-invocation (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #3130)
// Reads product workflow markdown (update.md) to verify structural
// invocation contract.

// Regression guard for bug #3130.
//
// Two failure modes were observed with the pre-fix npx invocation form:
//   1. Cache-stale: bare `npx -y @opengsd/gsd-core@<tag>` hits npx's local
//      cache and may pull an older version instead of the target tag.
//   2. Token-routing: Bash-tool wrappers misroute the `@` token in
//      `@opengsd/gsd-core@<tag>`, causing npm to error with
//      "Unknown command: @opengsd/gsd-core@<tag>".
//
// The robust form is:
//   npx -y --package=@opengsd/gsd-core@"$TAG" -- gsd-core $ARGS
//
// `--package=` forces a fresh registry fetch, bypassing the npx cache.
// `--` clearly delineates npx flags from the run-command, preventing
// Bash-tool @-token misrouting.
// `$TAG` is a shell variable (latest by default, next under --next/--rc),
// set by the parse_update_channel step (#815).

const { test: __t3130 } = require('node:test');
const assert3130 = require('node:assert/strict');
const fs3130 = require('node:fs');
const path3130 = require('node:path');

const ROOT_3130 = path3130.join(__dirname, '..');
const UPDATE_WF_3130 = path3130.join(ROOT_3130, 'gsd-core', 'workflows', 'update.md');

const src3130 = fs3130.readFileSync(UPDATE_WF_3130, 'utf8');

__t3130('bug #3130: update.md contains no bare npx invocations (cache-stale form)', () => {
  // Any occurrence of `npx -y @opengsd/gsd-core@<something>` without `--package=`
  // is the stale form that triggers the two failure modes.
  // eslint-disable-next-line local/no-unbounded-quantifier -- parses maintainer-authored update.md workflow, bounded prose, not adversarial input
  const stale = (src3130.match(/npx -y @opengsd\/gsd-core@\S+[^\r\n]*/g) || []);
  assert3130.deepEqual(
    stale,
    [],
    `Stale npx forms found in update.md (must use --package= form): ${stale.join('; ')}`,
  );
});

__t3130('bug #3130: update.md has exactly two robust resolved-install invocations', () => {
  const start = src3130.indexOf('<step name="run_update">');
  const end = src3130.indexOf('</step>', start);
  assert3130.ok(start >= 0 && end > start, 'run_update step must exist');
  const robust = (src3130.slice(start, end).match(/npx -y --package=@opengsd\/gsd-core@\S+ -- gsd-core/g) || []);
  assert3130.strictEqual(
    robust.length,
    2,
    `Expected two resolved-install npx invocations in update.md, found ${robust.length}`,
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #4153 review nit: update.md's PREFERRED_RUNTIME prose table and
// src/update-context.cts's RUNTIME_DIRS constant are two independently
// maintained representations of the same runtime -> dir mapping. Nothing
// enforced they stay in sync; this parity check does.
// ────────────────────────────────────────────────────────────────────────
{
  const { test: __t4153parity } = require('node:test');
  const assert4153parity = require('node:assert/strict');
  const path4153parity = require('node:path');
  const fs4153parity = require('node:fs');
  const { RUNTIME_DIRS: RUNTIME_DIRS_4153 } = require(
    path4153parity.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'update-context.cjs'),
  );
  const { splitLines: splitLines4153parity } = require('../gsd-core/bin/lib/text-lines.cjs');

  __t4153parity('update.md PREFERRED_RUNTIME table matches RUNTIME_DIRS', () => {
    const src = fs4153parity.readFileSync(
      path4153parity.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md'),
      'utf8',
    );
    const line = splitLines4153parity(src).find((l) => l.includes('Infer `PREFERRED_RUNTIME` from the path'));
    assert4153parity.ok(line, 'PREFERRED_RUNTIME inference line must exist');

    // Each clause: one or more backtick-quoted `/dir/` tokens, `->`, a
    // backtick-quoted runtime name. The trailing "otherwise leave it empty"
    // clause has no `->` and is intentionally skipped.
    const docPairs = new Set();
    for (const clause of line.split(';')) {
      const arrow = clause.indexOf('->');
      if (arrow === -1) continue;
      const dirs = [...clause.slice(0, arrow).matchAll(/`\/([^`]+)\/`/g)].map((m) => m[1]);
      const runtime = clause.slice(arrow + 2).match(/`([a-z]+)`/)?.[1];
      assert4153parity.ok(runtime, `clause must name a runtime: ${clause}`);
      for (const dir of dirs) docPairs.add(`${runtime}:${dir}`);
    }

    const tablePairs = new Set(RUNTIME_DIRS_4153.map(([runtime, dir]) => `${runtime}:${dir}`));
    assert4153parity.deepEqual(
      [...docPairs].sort(),
      [...tablePairs].sort(),
      'update.md PREFERRED_RUNTIME prose and RUNTIME_DIRS must list the same runtime -> dir pairs',
    );
  });
}
