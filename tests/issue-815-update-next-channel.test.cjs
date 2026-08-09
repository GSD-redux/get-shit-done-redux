'use strict';
// allow-test-rule: source-text-is-the-product
// Reads product workflow/command markdown to verify the --next RC channel
// contract.

// Issue #815: `/gsd-update --next` (alias `--rc`) must thread the @next dist-tag
// through the whole update flow (version check + install) while leaving the
// default @latest path unchanged.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WF = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'update.md'), 'utf8');
const CMD = fs.readFileSync(path.join(ROOT, 'commands', 'gsd', 'update.md'), 'utf8');

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
  assert.ok(robust.length >= 3, `expected >=3 tag-parameterized npx invocations, found ${robust.length}`);
  assert.doesNotMatch(WF, /--package=@opengsd\/gsd-core@latest -- gsd-core/,
    'install lines must not hardcode @latest once --next exists');
  assert.doesNotMatch(WF, /--package=@opengsd\/gsd-core@(?:latest|next|beta|canary|rc) -- gsd-core/,
    'install lines must use the $TAG variable, never a hardcoded dist-tag literal');
});

test('issue #815: command documents --next/--rc and routes it to the update workflow', () => {
  assert.match(CMD, /--next/);
  assert.match(CMD, /--rc/);
  assert.match(CMD, /argument-hint:.*--next/);
});


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
'use strict';


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

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const UPDATE_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md');

describe('update.md — no bare ~.claude path references (#2470)', () => {
  const content = fs.readFileSync(UPDATE_MD, 'utf-8');

  test('update.md does not contain bare ~/\\.claude (without trailing slash)', () => {
    // This is the exact pattern from the installer's scanForLeakedPaths():
    // /(?:~|\$HOME)\/\.claude\b/g
    // The replacer handles ~/\.claude\/ (with trailing slash) but misses bare ~/\.claude
    // so we must not have bare references in the source file.
    const matches = content.match(/(?:~|\$HOME)\/\.claude(?!\/)/g);
    assert.strictEqual(
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
'use strict';
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

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const UPDATE_WF = path.join(ROOT, 'gsd-core', 'workflows', 'update.md');

const src = fs.readFileSync(UPDATE_WF, 'utf8');

test('bug #3130: update.md contains no bare npx invocations (cache-stale form)', () => {
  // Any occurrence of `npx -y @opengsd/gsd-core@<something>` without `--package=`
  // is the stale form that triggers the two failure modes.
  const stale = (src.match(/npx -y @opengsd\/gsd-core@\S+[^\r\n]*/g) || []);
  assert.deepEqual(
    stale,
    [],
    `Stale npx forms found in update.md (must use --package= form): ${stale.join('; ')}`,
  );
});

test('bug #3130: update.md has >=3 robust npx invocations (--package= + -- separator)', () => {
  // Three sibling invocations: local, global, and unknown/fallback.
  // The tag is now a $TAG variable (latest by default, next under --next/--rc).
  const robust = (src.match(/npx -y --package=@opengsd\/gsd-core@\S+ -- gsd-core/g) || []);
  assert.ok(
    robust.length >= 3,
    `Expected >=3 robust npx invocations in update.md, found ${robust.length}`,
  );
});
  });
}
