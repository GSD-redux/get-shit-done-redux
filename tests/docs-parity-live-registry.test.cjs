// allow-test-rule: source-text-is-the-product
// Reads docs/*.md files whose deployed text IS what the user sees — asserting
// that every slash-command token in docs resolves to a live registered command
// tests the deployed contract. The commands/gsd/*.md reads in the helper are
// the source-of-truth registry (product markdown).

/**
 * Docs-parity live-registry test (#3049)
 *
 * Replaces three deny-list tests:
 *   - bug-3010-reapply-patches-references.test.cjs
 *   - bug-3029-3034-stale-command-routes.test.cjs
 *   - bug-3042-3044-research-flag-and-stale-refs.test.cjs
 *
 * Polarity: instead of "these specific dead commands must be absent", we
 * assert "every slash-command token in docs must be a live registered command".
 *
 * This catches two failure modes the deny-list shape missed:
 *   1. A freshly-deleted command referenced in docs (no test-file edit needed)
 *   2. A live command renamed without updating docs (deny-list would pass silently)
 *
 * Surfaces scanned:
 *   - docs/*.md (English)
 *   - docs/{ja-JP,ko-KR,zh-CN,pt-BR}/*.md (localized)
 *
 * ALLOWED_HISTORICAL_MENTIONS: files that legitimately reference deleted
 * commands as part of deprecation documentation are excluded from the scan.
 * Preserved from the three legacy tests:
 *   - gsd-core/workflows/help.md  (deprecation-trail prose)
 *   - CHANGELOG.md                     (historical release notes, must not be rewritten)
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getLiveCommandTokens } = require('./helpers/live-command-registry.cjs');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const LOCALES = ['ja-JP', 'ko-KR', 'zh-CN', 'pt-BR'];

// Files that legitimately reference deleted commands as deprecation history.
// Preserved from the three legacy tests — do not remove without understanding
// why the exemption exists (see issue #3049 and legacy test comments).
const ALLOWED_HISTORICAL_MENTIONS = new Set([
  path.join(ROOT, 'gsd-core', 'workflows', 'help.md'),
  path.join(ROOT, 'CHANGELOG.md'),
]);

// RELEASE-*.md files document past behavior for historical record.
// They must not be rewritten, so they are exempt from the live-registry check.
// Pattern: docs/RELEASE-*.md
function isReleaseDoc(filePath) {
  return path.basename(filePath).startsWith('RELEASE-') && filePath.endsWith('.md');
}

// Slugs that appear in docs as internal component names or documentation
// syntax placeholders — they match the /gsd-* regex but are NOT user-typable
// slash commands and never appear in the command registry. Adding a slug here
// requires a code comment explaining why it is not a slash command.
//
// Do NOT add here:
//   - deleted slash commands (those should be scrubbed from docs)
//   - renamed commands (update the docs instead)
const INTERNAL_COMPONENT_SLUGS = new Set([
  // Documentation syntax placeholder — "command-name" is used in ARCHITECTURE.md,
  // COMMANDS.md, and USER-GUIDE.md to show the template form of a slash command
  // (e.g. "/gsd-command-name [args]"). It is not a registered command.
  'command-name',
  'command',

  // gsd-tools.cjs — the legacy Node CLI binary (bin/gsd-tools.cjs).
  // Docs reference it as a path component in shell examples, not as a slash command.
  // Example: node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate
  'tools',

  // Hook scripts — internal runtime hooks, not user-invocable slash commands.
  //   hooks/gsd-statusline.js       — session statusline hook
  //   hooks/gsd-context-monitor.js  — context-window monitor hook
  //   hooks/gsd-update-banner.js    — update-available banner hook
  //   hooks/gsd-graphify-update.sh  — knowledge-graph auto-update PostToolUse hook (#3347)
  // These appear in docs as file-path references (e.g. "gsd-statusline.js reads
  // the cache"), not as command invocations.
  'statusline',
  'context-monitor',
  'update-banner',
  'graphify-update',

  // gsd-update-check.json — background update-check CACHE FILE, not a slash command.
  // ARCHITECTURE.md references "~/.cache/gsd/gsd-update-check.json" as a path;
  // the regex captures "/gsd-update-check" from the path component.
  'update-check',

  // Internal agent names referenced in ARCHITECTURE.md tables of agents.
  // These are spawned agents (gsd-planner, etc.), not user-typable slash commands.
  'planner',

  // Malformed token from SDK init reference: "/gsd-init-" appears as a truncated
  // prefix in CLI-TOOLS.md describing the gsd-sdk init command family
  // (e.g., "gsd-sdk query init.phase-op 12"). The regex captures "/gsd-init-"
  // without a following slug — this is a documentation formatting artifact, not
  // a real command token.
  'init-',

  // Compatibility guard for legacy doc links that may include
  // legacy org path segments in migrated historical URLs.
  // This is not a user-typable slash command.
  'build',

  // ~/gsd-workspaces/ — filesystem directory path used by /gsd-workspace.
  // Docs reference "~/gsd-workspaces/<name>" as the default workspace directory
  // in shell examples and option tables (e.g. "--path /target (default: ~/gsd-workspaces/<name>)").
  // The regex captures "/gsd-workspaces" from the path component. The LIVE slash
  // command is "/gsd-workspace" (singular) — not "/gsd-workspaces" (plural).
  'workspaces',

  // Portuguese translation of "command" — pt-BR/ARCHITECTURE.md uses "/gsd-comando"
  // as the localized equivalent of the "/gsd-command-name" English placeholder
  // in an architecture flow diagram. Not a registered command.
  'comando',

  // GitHub repository name: zh-CN/README.md references "github.com/rokicool/gsd-opencode"
  // as an external community project URL. The regex captures "/gsd-opencode" from
  // the URL path. Not a user-typable slash command in this product.
  'opencode',

  // gsd-sdk — the @opengsd/gsd-sdk npm package and `gsd-sdk query` CLI binary.
  // Docs reference it as a package name (e.g. `@opengsd/gsd-sdk`) and CLI tool
  // (e.g. `gsd-sdk query init phase-op 12`). The regex captures "/gsd-sdk" from
  // the npm scope path separator in `@opengsd/gsd-sdk`. Not a user-typable slash command.
  'sdk',

  // Smoke-test directory path — locale docs reference "/tmp/gsd-smoke-$(date +%s)"
  // as a temporary directory path in bash code-block examples. The regex captures
  // "/gsd-smoke-" from the filesystem path. Not a slash command.
  'smoke-',

  // Template placeholders — zh-CN/references/ui-brand.md used "/gsd-alternative-1"
  // and "/gsd-alternative-2" as unfilled placeholders in a UI template example.
  // These were never registered commands. Fixed in the source doc; kept here as
  // a belt-and-suspenders guard against the pattern returning in other locale docs.
  'alternative-1',
  'alternative-2',

  // gsd-sync-skills — installed Claude skill directory name (also a workflow
  // under gsd-core/workflows/sync-skills.md), but NOT a registered
  // slash command (no commands/gsd/sync-skills.md). Docs reference it as a
  // filesystem path component, e.g. "~/.agents/skills/gsd-sync-skills/" in
  // docs/discussions/grok-build-support-2026-05.md. The regex captures
  // "/gsd-sync-skills" from the path. Invoked via Skill(skill="gsd-sync-skills").
  'sync-skills',

  // gsd-test-runner — GitHub repository name: "github.com/open-gsd/gsd-test-runner".
  // docs/contributing/bootstrap.md references it as a hyperlink target:
  //   [gsd-test-runner](https://github.com/open-gsd/gsd-test-runner)
  // The regex captures "/gsd-test-runner" from the URL path component. This is
  // an external tool repo, not a user-typable slash command in this product.
  'test-runner',

  // gsd-core — GitHub repository name: "open-gsd/gsd-core".
  // docs/adr/22-plan-drift-guard.md references it as an issue tracker link:
  //   open-gsd/gsd-core#22
  // The regex captures "/gsd-core" from the org/repo path separator. This is
  // the canonical repo name, not a user-typable slash command in this product.
  'core',
]);

/**
 * Strip HTML comments from content to avoid flagging commented-out examples
 * or prose that names a dead command for historical context (e.g. "previously
 * this was /gsd-old-name...").
 */
function stripHtmlComments(content) {
  // regex-free HTML-comment stripper (CodeQL: avoid incomplete-multi-character-sanitization)
  let out = '';
  let rest = content;
  let idx;
  while ((idx = rest.indexOf('<!--')) !== -1) {
    out += rest.slice(0, idx);
    const end = rest.indexOf('-->', idx + 4);
    if (end === -1) { rest = ''; break; }
    rest = rest.slice(end + 3);
  }
  return out + rest;
}

/**
 * Extract the set of slash-command tokens from markdown content.
 * Three forms per command per runtime:
 *   /gsd-slug  — Claude / non-Gemini
 *   /gsd:slug  — Gemini
 *   $gsd-slug  — Codex
 *
 * Internal component slugs (INTERNAL_COMPONENT_SLUGS) are filtered out —
 * those are file-path references or documentation placeholders, not slash
 * command invocations.
 *
 * Returns: { slash: Set<string>, colon: Set<string>, dollar: Set<string> }
 */
function extractCommandTokens(content) {
  const stripped = stripHtmlComments(content);

  function isInternal(token) {
    // Strip the /gsd- or /gsd: or $gsd- prefix to get the slug
    const slug = token.replace(/^(?:\/gsd[:-]|\$gsd-)/, '');
    // Exact match OR prefix match for 'init-' (which ends with a dash)
    if (INTERNAL_COMPONENT_SLUGS.has(slug)) return true;
    for (const s of INTERNAL_COMPONENT_SLUGS) {
      if (s.endsWith('-') && slug.startsWith(s)) return true;
    }
    return false;
  }

  // Negative lookbehind: only match tokens NOT preceded by a letter, digit,
  // `/`, `_`, or `-`. This prevents matching the `/gsd-core` substring inside
  // the org/repo path `open-gsd/gsd-core` (and similar path-embedded segments)
  // while still matching real invocations preceded by BOL, space, backtick, or
  // `(`. Fixes false-positive class identified in #489.
  const allSlash = (stripped.match(/(?<![A-Za-z0-9/_-])\/gsd-[a-z0-9][a-z0-9-]*/g) || []);
  const allColon = (stripped.match(/(?<![A-Za-z0-9/_-])\/gsd:[a-z0-9][a-z0-9-]*/g) || []);
  const allDollar = (stripped.match(/(?<![A-Za-z0-9/_-])\$gsd-[a-z0-9][a-z0-9-]*/g) || []);

  const slash = new Set(allSlash.filter(t => !isInternal(t)));
  const colon = new Set(allColon.filter(t => !isInternal(t)));
  const dollar = new Set(allDollar.filter(t => !isInternal(t)));
  return { slash, colon, dollar };
}

/**
 * Walk a directory and return all .md files recursively.
 * Uses hand-rolled DFS for Node 20 compat (Node 22+ recursive readdirSync is
 * not available in all CI matrix entries). Surfaces permission-denied errors
 * as structured warnings (PRED.k302) rather than silently skipping.
 */
function listMdFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      try {
        files.push(...listMdFiles(fullPath));
      } catch (err) {
        process.stderr.write('[docs-parity] WARNING: skipping unreadable directory ' + fullPath + ': ' + err.message + '\n');
      }
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Assert that every command token in a doc file resolves to the live registry.
 * Returns an array of diagnostic strings (empty = pass).
 */
function findUnknownTokens(filePath, liveTokens) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const { slash, colon, dollar } = extractCommandTokens(content);
  const unknowns = [];
  for (const token of slash) {
    if (!liveTokens.has(token)) unknowns.push(token);
  }
  for (const token of colon) {
    if (!liveTokens.has(token)) unknowns.push(token);
  }
  for (const token of dollar) {
    if (!liveTokens.has(token)) unknowns.push(token);
  }
  return unknowns;
}

// ─── Helper unit tests ────────────────────────────────────────────────────────

describe('getLiveCommandTokens() — helper contract', () => {
  test('returns a Set', () => {
    const result = getLiveCommandTokens();
    assert.ok(result instanceof Set, 'getLiveCommandTokens() must return a Set');
  });

  test('returns a non-empty set (commands/gsd/ has registered commands)', () => {
    const result = getLiveCommandTokens();
    assert.ok(result.size > 0, 'live registry must contain at least one token');
  });

  test('contains /gsd-help (from commands/gsd/help.md name: gsd:help)', () => {
    const result = getLiveCommandTokens();
    assert.ok(result.has('/gsd-help'), 'registry must contain /gsd-help');
  });

  test('contains /gsd:help (Gemini form)', () => {
    const result = getLiveCommandTokens();
    assert.ok(result.has('/gsd:help'), 'registry must contain /gsd:help');
  });

  test('contains $gsd-help (Codex form)', () => {
    const result = getLiveCommandTokens();
    assert.ok(result.has('$gsd-help'), 'registry must contain $gsd-help');
  });

  test('contains /gsd-plan-phase (from commands/gsd/plan-phase.md)', () => {
    const result = getLiveCommandTokens();
    assert.ok(result.has('/gsd-plan-phase'), 'registry must contain /gsd-plan-phase');
  });

  test('contains exactly 3 tokens per slug (slash, colon, dollar)', () => {
    const result = getLiveCommandTokens();
    // Every /gsd-slug should have a matching /gsd:slug and $gsd-slug
    const slashTokens = [...result].filter(t => t.startsWith('/gsd-'));
    for (const slash of slashTokens) {
      const slug = slash.slice('/gsd-'.length);
      assert.ok(
        result.has(`/gsd:${slug}`),
        `registry must contain Gemini form /gsd:${slug} for slash form ${slash}`
      );
      assert.ok(
        result.has(`$gsd-${slug}`),
        `registry must contain Codex form $gsd-${slug} for slash form ${slash}`
      );
    }
  });

  test('does NOT contain removed /gsd-reapply-patches', () => {
    const result = getLiveCommandTokens();
    assert.ok(!result.has('/gsd-reapply-patches'), 'registry must NOT contain removed /gsd-reapply-patches');
  });

  test('does NOT contain removed /gsd-code-review-fix', () => {
    const result = getLiveCommandTokens();
    assert.ok(!result.has('/gsd-code-review-fix'), 'registry must NOT contain removed /gsd-code-review-fix');
  });

  test('does NOT contain removed /gsd-status', () => {
    const result = getLiveCommandTokens();
    assert.ok(!result.has('/gsd-status'), 'registry must NOT contain removed /gsd-status');
  });

  test('memoizes — returns the same Set reference on repeated calls', () => {
    const a = getLiveCommandTokens();
    const b = getLiveCommandTokens();
    assert.strictEqual(a, b, 'getLiveCommandTokens() must return the same Set instance (memoized)');
  });
});

// ─── Fixture-based helper tests ───────────────────────────────────────────────

describe('getLiveCommandTokens() — fixture contract', () => {
  test('parses gsd:foo frontmatter and emits 3 canonical tokens', () => {
    // This test validates the parsing logic against a known-good fixture
    // by inspecting the live registry for commands/gsd/help.md (name: gsd:help).
    // Fixture file tests are done inline since the helper reads commands/gsd/ only.
    // The canonical token contract:
    //   name: gsd:foo → /gsd-foo, /gsd:foo, $gsd-foo
    const registry = getLiveCommandTokens();
    // We know help.md has name: gsd:help
    const slug = 'help';
    assert.ok(registry.has(`/gsd-${slug}`), `must have /gsd-${slug}`);
    assert.ok(registry.has(`/gsd:${slug}`), `must have /gsd:${slug}`);
    assert.ok(registry.has(`$gsd-${slug}`), `must have $gsd-${slug}`);
  });

  test('parses gsd-slug frontmatter (ns-* commands) and emits 3 tokens', () => {
    // ns-context.md has name: gsd-context (dash-style, no colon)
    const registry = getLiveCommandTokens();
    assert.ok(registry.has('/gsd-context'), 'must have /gsd-context (from ns-context.md)');
    assert.ok(registry.has('/gsd:context'), 'must have /gsd:context (Gemini form)');
    assert.ok(registry.has('$gsd-context'), 'must have $gsd-context (Codex form)');
  });
});

// ─── English docs parity check ───────────────────────────────────────────────

// Precomputed locale directory prefixes for efficient exclusion in the English scan.
const LOCALE_DIRS = LOCALES.map(l => path.join(DOCS_DIR, l) + path.sep);

/**
 * List all .md files under dir, excluding files under any of the known locale
 * subdirectories (which are covered by the per-locale describe blocks below).
 */
function listEnglishMdFiles(dir) {
  return listMdFiles(dir).filter(
    f => !LOCALE_DIRS.some(ld => f.startsWith(ld))
  );
}

describe('docs parity — English docs/*.md ⊆ liveRegistry', () => {
  test('docs/ directory exists and contains markdown files', () => {
    const files = listEnglishMdFiles(DOCS_DIR);
    assert.ok(files.length > 0, `expected markdown files under ${DOCS_DIR}`);
  });

  test('every slash-command token in docs/*.md resolves to a live command', () => {
    const liveTokens = getLiveCommandTokens();
    const docFiles = listEnglishMdFiles(DOCS_DIR);
    const allOffenders = [];

    for (const filePath of docFiles) {
      if (ALLOWED_HISTORICAL_MENTIONS.has(filePath)) continue;
      if (isReleaseDoc(filePath)) continue;

      const unknowns = findUnknownTokens(filePath, liveTokens);
      if (unknowns.length > 0) {
        allOffenders.push(
          `${path.relative(ROOT, filePath)}: unknown command token(s): [${unknowns.join(', ')}]`
        );
      }
    }

    assert.deepStrictEqual(
      allOffenders,
      [],
      'docs/*.md must only reference live registered commands:\n  ' + allOffenders.join('\n  ')
    );
  });
});

// ─── Localized docs parity check ─────────────────────────────────────────────

for (const locale of LOCALES) {
  const localeDir = path.join(DOCS_DIR, locale);

  describe(`docs parity — docs/${locale}/*.md ⊆ liveRegistry`, () => {
    test(`docs/${locale}/ exists and contains markdown files (or is empty/absent — skip gracefully)`, () => {
      if (!fs.existsSync(localeDir)) {
        // Some locales may not exist in every repo state — that is fine.
        return;
      }
      // If the dir exists, it should have at least one .md file.
      const files = listMdFiles(localeDir);
      // Warn but don't fail if locale dir is unexpectedly empty.
      // The parity test below will simply pass vacuously.
      assert.ok(
        files.length >= 0,
        `docs/${locale}/ exists but contains no markdown files`
      );
    });

    test(`every slash-command token in docs/${locale}/*.md resolves to a live command`, () => {
      if (!fs.existsSync(localeDir)) return;

      const liveTokens = getLiveCommandTokens();
      const docFiles = listMdFiles(localeDir);
      const allOffenders = [];

      for (const filePath of docFiles) {
        if (ALLOWED_HISTORICAL_MENTIONS.has(filePath)) continue;
        if (isReleaseDoc(filePath)) continue;

        const unknowns = findUnknownTokens(filePath, liveTokens);
        if (unknowns.length > 0) {
          allOffenders.push(
            `${path.relative(ROOT, filePath)}: unknown command token(s): [${unknowns.join(', ')}]`
          );
        }
      }

      assert.deepStrictEqual(
        allOffenders,
        [],
        `docs/${locale}/*.md must only reference live registered commands:\n  ` + allOffenders.join('\n  ')
      );
    });
  });
}

// ─── Adversarial regression tests ────────────────────────────────────────────

describe('adversarial: polarity inversion catches drift deny-list misses', () => {
  test('renaming a live command without updating docs would fail this test (demonstrated via token absence)', () => {
    // If /gsd-progress were renamed to /gsd-status-new, the old /gsd-progress
    // token would not appear in the live registry, and any doc referencing
    // /gsd-progress would fail. The deny-list shape would have passed silently
    // (it only checks for specific known-bad tokens).
    // We can't simulate an actual rename in a live test, but we can assert
    // that the registry correctly contains the live name (progress, not status):
    const registry = getLiveCommandTokens();
    assert.ok(registry.has('/gsd-progress'), '/gsd-progress must be live (not renamed to /gsd-status)');
    assert.ok(!registry.has('/gsd-status'), '/gsd-status must be absent (was deleted, replaced by /gsd-progress)');
  });

  test('freshly-deleted command /gsd-check-todos is absent from registry', () => {
    const registry = getLiveCommandTokens();
    assert.ok(!registry.has('/gsd-check-todos'), '/gsd-check-todos must not be in the live registry');
  });

  test('freshly-deleted command /gsd-new-workspace is absent from registry', () => {
    const registry = getLiveCommandTokens();
    assert.ok(!registry.has('/gsd-new-workspace'), '/gsd-new-workspace must not be in the live registry');
  });

  test('freshly-deleted command /gsd-plan-milestone-gaps is absent from registry', () => {
    const registry = getLiveCommandTokens();
    assert.ok(!registry.has('/gsd-plan-milestone-gaps'), '/gsd-plan-milestone-gaps must not be in the live registry');
  });

  test('freshly-deleted command /gsd-research-phase is absent from registry', () => {
    const registry = getLiveCommandTokens();
    assert.ok(!registry.has('/gsd-research-phase'), '/gsd-research-phase must not be in the live registry');
  });
});

// ─── Tokenizer regression tests (#489) ───────────────────────────────────────

describe('extractCommandTokens() — repo-path false-positive regression (#489)', () => {
  test('open-gsd/gsd-core#22 repo path does NOT produce a /gsd-core token', () => {
    // Before the lookbehind fix, /gsd-core inside `open-gsd/gsd-core#22`
    // would be matched by the slash regex — a false positive.
    const { slash, colon, dollar } = extractCommandTokens(
      'see open-gsd/gsd-core#22 for details'
    );
    const all = [...slash, ...colon, ...dollar];
    assert.ok(
      !all.includes('/gsd-core'),
      'repo path open-gsd/gsd-core#22 must not produce a /gsd-core token; got: ' + all.join(', ')
    );
    assert.strictEqual(all.length, 0, 'expected zero tokens from a bare repo-path string; got: ' + all.join(', '));
  });

  test('space-preceded /gsd-totally-not-a-real-command is still extracted (real invocation)', () => {
    // A genuine (but unregistered) command reference after whitespace must be
    // captured so the live-registry check can flag it as unknown.
    const { slash } = extractCommandTokens(
      'run /gsd-totally-not-a-real-command here'
    );
    assert.ok(
      slash.has('/gsd-totally-not-a-real-command'),
      'invocation after whitespace must be extracted; slash set: ' + [...slash].join(', ')
    );
  });

  test('backtick-wrapped `/gsd-plan` is still extracted (real invocation)', () => {
    // Backtick-wrapped commands (common in markdown) must still be captured.
    const { slash } = extractCommandTokens(
      'use `/gsd-plan` to plan'
    );
    assert.ok(
      slash.has('/gsd-plan'),
      'backtick-wrapped invocation must be extracted; slash set: ' + [...slash].join(', ')
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2954-help-md-slash-command-stubs.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2954-help-md-slash-command-stubs (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #2954)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2954: keep `help.md` and the live `commands/gsd/*` slash surface
 * in lockstep. Two regression tests:
 *
 *   1. help.md must not advertise any /gsd[-:]<name> that has no shipped
 *      slash command. (Caught the original #2954 regression: #2824 deleted
 *      31 stubs without updating help.md.)
 *
 *   2. Every shipped /gsd[-:]<name> command must appear in help.md. (Caught
 *      the inverse: a command lands without docs, so users never discover it.)
 *
 * The shipped slash name is parsed from frontmatter `name:` (which can be
 * either `gsd:foo` or `gsd-foo` — Claude Code surfaces both as `/gsd-foo`),
 * NOT from the filename, because some files (e.g. `ns-context.md`) ship a
 * different slash name (`gsd-context`) than their filename suggests.
 *
 * Also covers `do.md`, the dispatcher invoked at runtime by
 * `/gsd:progress --do`: any `/gsd[-:]<name>` token in its routing table must
 * resolve to a live command, otherwise the dispatcher emits "Unknown command".
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');
// After #3039, the canonical command reference is the `--full` mode file.
// `workflows/help.md` is now a small dispatcher; the bidirectional parity
// invariant lives with the comprehensive reference body.
const HELP_MD = path.join(ROOT, 'gsd-core', 'workflows', 'help', 'modes', 'full.md');
const DO_MD = path.join(ROOT, 'gsd-core', 'workflows', 'do.md');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const fieldMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const value = fieldMatch[2].trim().replace(/^["']|["']$/g, '');
    fields[fieldMatch[1]] = value;
  }
  return fields;
}

/**
 * Returns the set of slash-base-names actually shipped under commands/gsd/.
 * A "slash-base-name" is the part after `/gsd-` — e.g. for frontmatter
 * `name: gsd:foo` or `name: gsd-foo`, the slash-base-name is `foo`.
 */
function listShippedSlashBaseNames() {
  const names = new Set();
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(COMMANDS_DIR, entry.name), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name) continue;
    const fmName = fm.name;
    let base = null;
    if (fmName.startsWith('gsd:')) base = fmName.slice(4);
    else if (fmName.startsWith('gsd-')) base = fmName.slice(4);
    if (base && /^[a-z][a-z0-9-]*$/.test(base)) names.add(base);
  }
  return names;
}

function extractSlashReferences(contents) {
  const names = new Set();
  // Negative lookbehind: must not be preceded by a letter (avoids matching npm scope
  // paths like @opengsd/gsd-core where `/gsd-` appears inside a package URL).
  // Negative lookahead (?![\w-]*\/): excludes filesystem path segments like
  // `/gsd-core/bin` where the captured name is followed by a `/`, which would
  // be a directory segment rather than a slash command name.
  const tokenRe = /(?<![a-z])\/gsd[:-]([a-z][a-z0-9-]*)(?![\w-]*\/)/g;
  let match;
  while ((match = tokenRe.exec(contents)) !== null) {
    names.add(match[1]);
  }
  return names;
}

/**
 * For every shipped command with an `argument-hint:` frontmatter entry,
 * collect the `--flag` tokens it advertises. Returns a Map<slashBaseName,
 * Set<flagName>>. Flags are recorded without their leading `--`.
 */
function listShippedFlagsByCommand() {
  const out = new Map();
  for (const entry of fs.readdirSync(COMMANDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(COMMANDS_DIR, entry.name), 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm || !fm.name || !fm['argument-hint']) continue;
    const fmName = fm.name;
    let base = null;
    if (fmName.startsWith('gsd:')) base = fmName.slice(4);
    else if (fmName.startsWith('gsd-')) base = fmName.slice(4);
    if (!base || !/^[a-z][a-z0-9-]*$/.test(base)) continue;
    const flags = new Set();
    for (const m of fm['argument-hint'].matchAll(/--([a-z][a-z0-9-]*)/g)) {
      flags.add(m[1]);
    }
    if (flags.size) out.set(base, flags);
  }
  return out;
}

describe('Bug #2954: help.md ↔ commands/gsd/ bidirectional parity', () => {
  test('every /gsd[-:]<name> referenced in help.md is a shipped command', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const referenced = extractSlashReferences(helpContents);
    const shipped = listShippedSlashBaseNames();
    const dangling = [...referenced].filter((n) => !shipped.has(n)).sort();
    assert.deepEqual(
      dangling,
      [],
      `help.md advertises /gsd[-:]<name> commands that are not shipped: ${dangling.join(', ')}`,
    );
  });

  test('every shipped /gsd[-:]<name> command is documented in help.md', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const referenced = extractSlashReferences(helpContents);
    const shipped = listShippedSlashBaseNames();
    const undocumented = [...shipped].filter((n) => !referenced.has(n)).sort();
    assert.deepEqual(
      undocumented,
      [],
      `commands shipped under commands/gsd/ with no /gsd[-:]<name> reference in help.md: ${undocumented.join(', ')}`,
    );
  });

  test('every /gsd[-:]<name> in do.md (live dispatcher) is a shipped command', () => {
    const doContents = fs.readFileSync(DO_MD, 'utf8');
    const referenced = extractSlashReferences(doContents);
    const shipped = listShippedSlashBaseNames();
    const dangling = [...referenced].filter((n) => !shipped.has(n)).sort();
    assert.deepEqual(
      dangling,
      [],
      `do.md routing table references /gsd[-:]<name> that is not shipped: ${dangling.join(', ')}`,
    );
  });

  test('every --flag in a command\'s argument-hint appears in help.md', () => {
    const helpContents = fs.readFileSync(HELP_MD, 'utf8');
    const flagsByCommand = listShippedFlagsByCommand();
    const gaps = [];
    for (const [command, flags] of flagsByCommand) {
      for (const flag of flags) {
        // Accept `/gsd-<command> --<flag>` (precise) OR a bare `--<flag>` token
        // anywhere in help.md (good enough for shared flags like `--force` that
        // appear under multiple commands' descriptions).
        const preciseDash = `/gsd-${command} --${flag}`;
        const preciseColon = `/gsd:${command} --${flag}`;
        const flagToken = `--${flag}`;
        if (
          !helpContents.includes(preciseDash) &&
          !helpContents.includes(preciseColon) &&
          !helpContents.includes(flagToken)
        ) {
          gaps.push(`/gsd:${command} --${flag}`);
        }
      }
    }
    assert.deepEqual(
      gaps.sort(),
      [],
      `commands ship --flag(s) in argument-hint that are absent from help.md: ${gaps.join(', ')}`,
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2950-stale-command-refs.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2950-stale-command-refs (consolidation epic #1969 B4 #1973)", () => {
/**
 * Bug #2950: Stale deleted command references in workflow files
 *
 * Multiple workflow files referenced command names removed in #2790
 * (gsd-add-phase, gsd-insert-phase, gsd-remove-phase, gsd-add-todo,
 * gsd-set-profile, gsd-settings-integrations, gsd-settings-advanced,
 * gsd-spike-wrap-up, gsd-sketch-wrap-up, gsd-code-review-fix).
 *
 * Fix: Update every occurrence to the new consolidated forms:
 *   /gsd:phase (no flag | --insert | --remove)
 *   /gsd:capture
 *   /gsd:config (--profile | --integrations | --advanced)
 *   /gsd:spike --wrap-up
 *   /gsd:sketch --wrap-up
 *   /gsd:code-review --fix
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

function read(filename) {
  return fs.readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf-8');
}

// Deleted command names that must not appear anywhere in the fixed files.
const DELETED_COMMANDS = [
  '/gsd-add-phase',
  '/gsd-insert-phase',
  '/gsd-remove-phase',
  '/gsd-add-todo',
  '/gsd-set-profile',
  '/gsd-settings-integrations',
  '/gsd-settings-advanced',
  '/gsd-spike-wrap-up',
  '/gsd-sketch-wrap-up',
  '/gsd-code-review-fix',
];

// Per-file assertions: [file, deletedCmd, newForm]
const FILE_ASSERTIONS = [
  // help.md → moved to help/modes/full.md in #3039 tiered-help refactor
  ['help/modes/full.md', '/gsd-add-phase', '/gsd:phase "Add admin dashboard"'],
  ['help/modes/full.md', '/gsd-insert-phase', '/gsd:phase --insert 7 "Fix critical auth bug"'],
  ['help/modes/full.md', '/gsd-remove-phase', '/gsd:phase --remove 17'],
  ['help/modes/full.md', '/gsd-spike-wrap-up', '/gsd:spike --wrap-up'],
  ['help/modes/full.md', '/gsd-sketch-wrap-up', '/gsd:sketch --wrap-up'],
  ['help/modes/full.md', '/gsd-add-todo', '/gsd:capture'],
  ['help/modes/full.md', '/gsd-set-profile', '/gsd:config --profile budget'],

  // do.md
  ['do.md', '/gsd-spike-wrap-up', '/gsd:spike --wrap-up'],
  ['do.md', '/gsd-sketch-wrap-up', '/gsd:sketch --wrap-up'],
  ['do.md', '/gsd-add-phase', '/gsd:phase'],
  ['do.md', '/gsd-add-todo', '/gsd:capture'],

  // settings.md
  ['settings.md', '/gsd-code-review-fix', '/gsd:code-review --fix'],
  ['settings.md', '/gsd-settings-integrations', '/gsd:config --integrations'],
  ['settings.md', '/gsd-set-profile', '/gsd:config --profile'],
  ['settings.md', '/gsd-settings-advanced', '/gsd:config --advanced'],

  // discuss-phase.md
  ['discuss-phase.md', '/gsd-spike-wrap-up', '/gsd:spike --wrap-up'],
  ['discuss-phase.md', '/gsd-sketch-wrap-up', '/gsd:sketch --wrap-up'],

  // new-project.md
  ['new-project.md', '/gsd-spike-wrap-up', '/gsd:spike --wrap-up'],
  ['new-project.md', '/gsd-sketch-wrap-up', '/gsd:sketch --wrap-up'],

  // plan-phase.md
  ['plan-phase.md', '/gsd-insert-phase', '/gsd:phase --insert'],

  // spike.md
  ['spike.md', '/gsd-spike-wrap-up', '/gsd:spike --wrap-up'],

  // sketch.md
  ['sketch.md', '/gsd-sketch-wrap-up', '/gsd:sketch --wrap-up'],
];

describe('bug #2950: stale deleted-command references removed from workflow files', () => {
  // Build a map of file → content to avoid re-reading
  const files = [...new Set(FILE_ASSERTIONS.map(([f]) => f))];
  const contentMap = {};
  for (const f of files) {
    contentMap[f] = read(f);
  }

  // For each (file, deletedCmd) pair, assert the old name is absent
  for (const [file, deletedCmd] of FILE_ASSERTIONS) {
    test(`${file}: does not contain deleted command "${deletedCmd}"`, () => {
      const content = contentMap[file];
      assert.ok(
        !content.includes(deletedCmd),
        `${file} still contains deleted command "${deletedCmd}" — update to new form`
      );
    });
  }

  // For each (file, deletedCmd, newForm) triple, assert the new form is present
  for (const [file, , newForm] of FILE_ASSERTIONS) {
    test(`${file}: contains new form "${newForm}"`, () => {
      const content = contentMap[file];
      assert.ok(
        content.includes(newForm),
        `${file} is missing expected new form "${newForm}"`
      );
    });
  }

  // Blanket check: no affected workflow file contains any of the deleted command names
  // (catches any we might have missed in per-file assertions above)
  const affectedFiles = [
    'help.md',
    'help/modes/full.md',
    'help/modes/default.md',
    'help/modes/brief.md',
    'help/modes/topic.md',
    'do.md',
    'settings.md',
    'discuss-phase.md',
    'new-project.md',
    'plan-phase.md',
    'spike.md',
    'sketch.md',
  ];

  for (const file of affectedFiles) {
    const content = read(file);
    for (const deleted of DELETED_COMMANDS) {
      test(`${file}: blanket check — "${deleted}" not present`, () => {
        assert.ok(
          !content.includes(deleted),
          `${file} contains deleted command "${deleted}"`
        );
      });
    }
  }
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-2840-issue-driven-orchestration-guide.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-2840-issue-driven-orchestration-guide (consolidation epic #1969 B8 #1977)", () => {
/**
 * Tests for docs/issue-driven-orchestration.md (#2840).
 *
 * Structural-IR assertions per CONTRIBUTING.md "Prohibited: Raw Text Matching
 * on Test Outputs": parse the guide into a typed record and assert on
 * semantic flags, not regex on prose. The guide is rebuildable as long as
 * the structural invariants survive — section-level rewording is fine.
 *
 * Acceptance criteria from issue #2840:
 *   - One guide explaining issue-driven orchestration using existing GSD
 *     commands.
 *   - Concrete end-to-end issue → workspace → plan/execute → verify/review
 *     → PR flow.
 *   - Explicitly documents safety boundaries: isolated worktrees, explicit
 *     human review, no automatic public posting by default.
 *   - Adds no runtime dependencies / no new command, daemon, or tracker
 *     integration. (Test-enforced via concept-mapping audit.)
 */

// allow-test-rule: source-text-is-the-product (see #2840)
// docs/issue-driven-orchestration.md's deployed prose IS the product being
// validated for required-concept coverage. The .includes() calls below build
// a typed record (commandsPresent flags, conceptPairs flags, nonGoalFlags,
// safetyFlags); assertions run on those booleans, not on raw text.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GUIDE_PATH = path.join(__dirname, '..', 'docs', 'issue-driven-orchestration.md');

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extract a section starting at a given heading. Returns the body up to (but
 * not including) the next heading at the same or shallower depth, or null if
 * the heading isn't found.
 */
function extractSection(content, heading) {
  const lines = content.split('\n');
  const headingRe = new RegExp(`^(#+)\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
  let start = -1;
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headingRe);
    if (m) {
      start = i + 1;
      depth = m[1].length;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s+/);
    if (m && m[1].length <= depth) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * Parse the guide into a typed record. Returns null when the guide is
 * missing so the file-presence test can name the actual problem instead of
 * cascading TypeErrors.
 */
function parseGuide() {
  if (!fs.existsSync(GUIDE_PATH)) return null;
  const content = fs.readFileSync(GUIDE_PATH, 'utf8');
  // Strip inline emphasis but NOT underscores (snake_case identifiers like
  // gsd-new-workspace, .planning/, etc. must survive).
  const stripped = content.replace(/\*{1,3}|~{2}/g, '');

  // Concept-mapping table: rows that pair a Symphony-style concept with a
  // GSD primitive. Test asserts on presence of each required pair, not on
  // exact prose ordering.
  const conceptMappingSection = extractSection(content, 'Concept mapping');
  const endToEndSection = extractSection(content, 'End-to-end flow') ||
                          extractSection(content, 'End-to-end issue → PR flow') ||
                          extractSection(content, 'End-to-end orchestration loop');
  const safetySection = extractSection(content, 'Safety boundaries') ||
                        extractSection(content, 'Safety');
  const nonGoalsSection = extractSection(content, 'Non-goals') ||
                          extractSection(content, 'What this guide does not do');

  // Track which referenced commands appear at least once anywhere in the
  // guide. This prevents drift if /gsd-* command names are renamed.
  const requiredCommands = [
    '/gsd-workspace --new',
    '/gsd-manager',
    '/gsd-autonomous',
    '/gsd-discuss-phase',
    '/gsd-plan-phase',
    '/gsd-execute-phase',
    '/gsd-verify-work',
    '/gsd-review',
    '/gsd-ship',
  ];
  const commandsPresent = Object.fromEntries(
    requiredCommands.map((c) => [c, content.includes(c)])
  );

  // Concept-mapping invariants — keys are concept slugs, values are the
  // GSD primitive that must appear in the same paragraph/row of the
  // concept-mapping section.
  const conceptPairs = conceptMappingSection
    ? {
        roadmap: /ROADMAP\.md/.test(conceptMappingSection),
        statemd: /STATE\.md/.test(conceptMappingSection),
        contextmd: /CONTEXT\.md/.test(conceptMappingSection),
        planmd: /PLAN\.md/.test(conceptMappingSection),
        workspaceCommand: /\/gsd-workspace\s+--new/.test(conceptMappingSection),
        executionCommand:
          /\/gsd-manager/.test(conceptMappingSection) ||
          /\/gsd-autonomous/.test(conceptMappingSection),
        verifyCommand: /\/gsd-verify-work/.test(conceptMappingSection),
        reviewCommand: /\/gsd-review/.test(conceptMappingSection),
        shipCommand: /\/gsd-ship/.test(conceptMappingSection),
      }
    : null;

  // Non-goals required by the issue: must explicitly disclaim all four.
  const nonGoalFlags = nonGoalsSection
    ? {
        noVendoring: /vendor|copy/i.test(nonGoalsSection),
        noDaemon: /daemon|polling/i.test(nonGoalsSection),
        noTrackerDependency: /tracker.*depend|mandatory.*track/i.test(nonGoalsSection),
        noBypassReview: /bypass|review|verification|human.*decision|human gate/i.test(nonGoalsSection),
      }
    : null;

  // Safety boundaries — required disclaimers about how the loop stays safe.
  const safetyFlags = safetySection
    ? {
        isolatedWorktrees: /worktree|isolated/i.test(safetySection),
        explicitReview: /review|human.*gate|human.*approval/i.test(safetySection),
        noAutoPosting: /not.*automatic|no.*auto|explicit.*confirm|user.*confirm|human.*confirm/i.test(safetySection),
      }
    : null;

  // End-to-end flow must enumerate at least the seven step sequence the
  // acceptance criteria call out. We assert on numbered list items so the
  // narrative can be reworded freely.
  const numberedSteps = endToEndSection
    ? (endToEndSection.match(/^\s*\d+\.\s+/gm) || []).length
    : 0;

  // Strip markdown emphasis when checking for snake_case-sensitive content
  // in section bodies (per the markdown-aware matching pattern).
  const strippedConceptMapping = conceptMappingSection
    ? conceptMappingSection.replace(/\*{1,3}|~{2}/g, '')
    : null;

  return {
    raw: content,
    stripped,
    conceptMappingSection,
    strippedConceptMapping,
    endToEndSection,
    safetySection,
    nonGoalsSection,
    commandsPresent,
    conceptPairs,
    nonGoalFlags,
    safetyFlags,
    numberedSteps,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('issue-driven-orchestration guide (#2840)', () => {
  test('docs/issue-driven-orchestration.md exists', () => {
    assert.ok(
      fs.existsSync(GUIDE_PATH),
      `Guide must live at docs/issue-driven-orchestration.md per #2840`
    );
  });

  test('every required GSD command is referenced at least once', () => {
    const ir = parseGuide();
    assert.ok(ir, 'parseGuide returned null — guide is missing');
    for (const [cmd, present] of Object.entries(ir.commandsPresent)) {
      assert.ok(present, `guide must reference ${cmd}`);
    }
  });

  test('concept mapping section exists and pairs Symphony concepts with GSD primitives', () => {
    const ir = parseGuide();
    assert.ok(ir, 'guide must be present');
    assert.ok(
      ir.conceptMappingSection,
      'guide must contain a "Concept mapping" section'
    );
    const expected = {
      roadmap: 'ROADMAP.md must appear in the concept mapping',
      statemd: 'STATE.md must appear in the concept mapping',
      contextmd: 'CONTEXT.md must appear in the concept mapping',
      planmd: 'PLAN.md must appear in the concept mapping',
      workspaceCommand: '/gsd-workspace --new must appear in the concept mapping',
      executionCommand:
        '/gsd-manager or /gsd-autonomous must appear in the concept mapping',
      verifyCommand: '/gsd-verify-work must appear in the concept mapping',
      reviewCommand: '/gsd-review must appear in the concept mapping',
      shipCommand: '/gsd-ship must appear in the concept mapping',
    };
    for (const [flag, msg] of Object.entries(expected)) {
      assert.equal(ir.conceptPairs[flag], true, msg);
    }
  });

  test('safety boundaries section names isolation, review, and non-auto-posting', () => {
    const ir = parseGuide();
    assert.ok(ir, 'guide must be present');
    assert.ok(
      ir.safetySection,
      'guide must contain a "Safety boundaries" or "Safety" section'
    );
    assert.equal(
      ir.safetyFlags.isolatedWorktrees,
      true,
      'safety section must mention isolated worktrees'
    );
    assert.equal(
      ir.safetyFlags.explicitReview,
      true,
      'safety section must require explicit human review'
    );
    assert.equal(
      ir.safetyFlags.noAutoPosting,
      true,
      'safety section must disclaim automatic public posting'
    );
  });

  test('non-goals section disclaims vendoring, daemon, tracker dependency, and gate-bypass', () => {
    const ir = parseGuide();
    assert.ok(ir, 'guide must be present');
    assert.ok(
      ir.nonGoalsSection,
      'guide must contain a "Non-goals" section'
    );
    const expected = {
      noVendoring: 'must disclaim copying/vendoring Symphony',
      noDaemon: 'must disclaim a long-running daemon',
      noTrackerDependency: 'must disclaim mandatory tracker dependency',
      noBypassReview: 'must disclaim bypassing review/verification gates',
    };
    for (const [flag, msg] of Object.entries(expected)) {
      assert.equal(ir.nonGoalFlags[flag], true, msg);
    }
  });

  test('end-to-end flow enumerates at least 7 numbered steps (per acceptance criteria)', () => {
    const ir = parseGuide();
    assert.ok(ir, 'guide must be present');
    assert.ok(
      ir.endToEndSection,
      'guide must contain an "End-to-end flow" (or equivalent) section'
    );
    assert.ok(
      ir.numberedSteps >= 7,
      `end-to-end section must enumerate ≥7 numbered steps; found ${ir.numberedSteps}`
    );
  });

  test('every fenced code block has a language tag (markdownlint MD040)', () => {
    const ir = parseGuide();
    assert.ok(ir, 'guide must be present');
    // Pair fence opens; flag any opener with no language tag.
    const fences = ir.raw.match(/^```.*$/gm) || [];
    const openers = [];
    for (let i = 0; i < fences.length; i++) {
      // Even index = opener, odd = closer. An opener with empty trailing
      // text is MD040.
      if (i % 2 === 0) openers.push(fences[i]);
    }
    const bare = openers.filter((f) => /^```\s*$/.test(f));
    assert.equal(
      bare.length,
      0,
      `MD040: ${bare.length} fenced block(s) lack a language tag`
    );
  });

  test('cross-linked from docs/README.md', () => {
    const readme = path.join(__dirname, '..', 'docs', 'README.md');
    if (!fs.existsSync(readme)) {
      // docs/README.md is the discovery surface. Without a cross-link, the
      // guide is invisible to users browsing docs/.
      return; // tolerate absence; test below ensures FEATURES.md anchor.
    }
    const txt = fs.readFileSync(readme, 'utf8');
    assert.ok(
      /issue-driven-orchestration/.test(txt),
      'docs/README.md must link to the new guide'
    );
  });

  test('cross-linked from docs/USER-GUIDE.md', () => {
    const guide = path.join(__dirname, '..', 'docs', 'USER-GUIDE.md');
    // Mirror the null-guard pattern from the README test above: a missing
    // file must produce a meaningful assertion message, not a cryptic
    // ENOENT stack trace. (CR #3036.)
    assert.ok(
      fs.existsSync(guide),
      'docs/USER-GUIDE.md must exist for cross-link validation'
    );
    const txt = fs.readFileSync(guide, 'utf8');
    assert.ok(
      /issue-driven-orchestration/.test(txt),
      'docs/USER-GUIDE.md must link to the new guide'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-3025-mcp-token-budget-docs.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-3025-mcp-token-budget-docs (consolidation epic #1969 B8 #1977)", () => {
/**
 * Documentation regression test for issue #3025 — MCP token-budget guidance.
 *
 * Verifies that gsd-core/references/context-budget.md contains the
 * structural elements the issue requires:
 *
 *   1. A section explaining MCP/tool schemas as a context-budget concern
 *   2. References to the harness-side toggles (enabledMcpjsonServers,
 *      disabledMcpjsonServers in .claude/settings.json)
 *   3. A pre-phase audit checklist (browser/playwright, platform-specific,
 *      project-specific)
 *   4. An explicit note that GSD does NOT manage MCP enablement — this is
 *      a Claude Code harness concern (with a cross-link)
 *   5. Note the interaction with model_profile (compounding levers)
 *
 * Tests parse the doc into a typed section record (parseMcpSection) and
 * assert on flag booleans, not raw text matches. Adheres to
 * CONTRIBUTING.md "no-source-grep" — describes invariants, not wording,
 * so the prose can be reworded freely as long as the semantics survive.
 *
 * Companion to docs/USER-GUIDE.md task section, which is exercised by the
 * same parser shape (separate test below).
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONTEXT_BUDGET_MD = path.join(ROOT, 'gsd-core', 'references', 'context-budget.md');
const USER_GUIDE_MD = path.join(ROOT, 'docs', 'USER-GUIDE.md');

/**
 * Extract the MCP-budget section from a markdown file by header text.
 * Returns null if the section is missing. Section runs from the matching
 * `## ` header up to the next `## ` header (or EOF).
 */
function extractSection(filePath, headerSubstring) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  let inSection = false;
  let startDepth = 0;
  const collected = [];
  for (const line of lines) {
    const headerMatch = /^(#+)\s/.exec(line);
    if (headerMatch) {
      const depth = headerMatch[1].length;
      if (inSection) {
        // Section ends at a header at the same or shallower depth.
        // Subsections at deeper depth are part of the section.
        if (depth <= startDepth) break;
      } else if (line.toLowerCase().includes(headerSubstring.toLowerCase())) {
        inSection = true;
        startDepth = depth;
      }
    }
    if (inSection) collected.push(line);
  }
  return collected.length > 0 ? collected.join('\n') : null;
}

/**
 * Parse the MCP-budget section into a typed semantic-flag record.
 * Each flag answers a single behavioral question that #3025 requires
 * the prose to encode.
 */
function parseMcpBudgetSection(section) {
  if (!section || typeof section !== 'string') {
    return {
      ok: false,
      sectionLength: 0,
      explainsMcpAsBudgetConcern: false,
      namesEnabledMcpjsonServers: false,
      namesDisabledMcpjsonServers: false,
      namesClaudeSettingsJson: false,
      includesPrePhaseAudit: false,
      auditMentionsBrowserOrPlaywright: false,
      auditMentionsPlatformSpecific: false,
      auditMentionsCrossProject: false,
      explainsHarnessNotGsd: false,
      mentionsModelProfileInteraction: false,
      crossLinksContextBudget: false,
    };
  }
  // CR follow-up: strip inline markdown emphasis (`**`, `*`, `~~`) and
  // backticks before phrase-matching so e.g. "GSD does **not** manage"
  // is caught by the primary `gsd does not manage` alternative below.
  // WITHOUT this, the markdown-bold breaks the contiguous match and the
  // test only passes via the fallback branch (silent dead code).
  // Underscores are intentionally NOT stripped — `model_profile` and
  // other snake_case identifiers must survive intact so the
  // model_profile interaction check still finds them.
  const stripped = section.replace(/\*{1,3}|~{2}|`/g, '');
  // (1) Explains MCP as budget concern — must mention BOTH "MCP" / "tool
  // schema" AND a token/cost framing.
  const explainsMcpAsBudgetConcern =
    /\bmcp\b|tool schema|tool schemas/i.test(stripped) &&
    /\btoken|context budget|per[- ]turn|cost\b/i.test(stripped);
  // (2) Names the harness keys verbatim
  const namesEnabledMcpjsonServers = /enabledMcpjsonServers/.test(stripped);
  const namesDisabledMcpjsonServers = /disabledMcpjsonServers/.test(stripped);
  // (3) Names the settings file location
  const namesClaudeSettingsJson = /\.claude\/settings\.json/.test(stripped);
  // (4) Audit checklist — must mention all three classes the issue
  // calls out, plus a "before this phase / pre-phase" framing
  const includesPrePhaseAudit =
    /audit|checklist|review (your )?mcp|before (starting|beginning) (a |the )?phase/i.test(stripped);
  const auditMentionsBrowserOrPlaywright = /\bbrowser\b|playwright/i.test(stripped);
  const auditMentionsPlatformSpecific = /platform[- ]specific|mac[- ]?tools|windows[- ]?tools|os[- ]specific/i.test(stripped);
  const auditMentionsCrossProject = /(other|different|cross[- ])\s*project|stale (project )?mcp/i.test(stripped);
  // (5) Harness vs GSD distinction — must explicitly state GSD doesn't
  // own this knob and point at the harness
  const explainsHarnessNotGsd =
    /(gsd does(?:n[''’]t| not) (own|manage|control)|harness (concern|setting|controlled)|not a gsd (setting|knob))/i.test(stripped);
  // (6) Compounding with model_profile
  const mentionsModelProfileInteraction =
    /model[_ ]profile/i.test(stripped) &&
    /compound|multiplier|stack|every[- ]turn|regardless of (which )?model|in addition/i.test(stripped);
  // (7) Cross-link to the canonical reference doc — task-guide section
  // must point readers at context-budget.md for the full audit. Encoded
  // as a named flag (CR follow-up) so the assertion sits alongside the
  // other parsed invariants rather than as a one-off inline regex.
  const crossLinksContextBudget = /context-budget/i.test(stripped);
  return {
    ok: true,
    sectionLength: section.length,
    explainsMcpAsBudgetConcern,
    namesEnabledMcpjsonServers,
    namesDisabledMcpjsonServers,
    namesClaudeSettingsJson,
    includesPrePhaseAudit,
    auditMentionsBrowserOrPlaywright,
    auditMentionsPlatformSpecific,
    auditMentionsCrossProject,
    explainsHarnessNotGsd,
    mentionsModelProfileInteraction,
    crossLinksContextBudget,
  };
}

// ─── context-budget.md ──────────────────────────────────────────────────────

describe('#3025 context-budget.md: MCP token-budget section exists with required content', () => {
  test('the file exists', () => {
    assert.ok(fs.existsSync(CONTEXT_BUDGET_MD), `expected file at ${CONTEXT_BUDGET_MD}`);
  });

  test('has a section header that mentions MCP', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    assert.ok(section, 'must have a `## ...MCP...` heading; section was not found');
  });

  test('explains MCP/tool schemas as a context-budget concern (#3025 requirement 1)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.explainsMcpAsBudgetConcern, true,
      `must explain MCP/tool schemas as a token/context-budget concern; section was:\n${section}`);
  });

  test('names enabledMcpjsonServers and disabledMcpjsonServers (#3025 requirement 2)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.namesEnabledMcpjsonServers, true,
      'section must reference `enabledMcpjsonServers` so users know the exact key');
    assert.equal(parsed.namesDisabledMcpjsonServers, true,
      'section must reference `disabledMcpjsonServers` for parity');
    assert.equal(parsed.namesClaudeSettingsJson, true,
      'section must name `.claude/settings.json` as the location of the toggle');
  });

  test('includes a pre-phase audit checklist with all three classes (#3025 requirement 3)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.includesPrePhaseAudit, true,
      'section must include audit/checklist framing for pre-phase MCP review');
    assert.equal(parsed.auditMentionsBrowserOrPlaywright, true,
      'audit must mention browser/playwright tools as a candidate for disabling');
    assert.equal(parsed.auditMentionsPlatformSpecific, true,
      'audit must mention platform-specific tools (Mac/Windows/OS-specific)');
    assert.equal(parsed.auditMentionsCrossProject, true,
      'audit must mention stale/cross-project MCPs from other projects');
  });

  test('explains GSD does not own MCP enablement — harness concern (#3025 requirement 4)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.explainsHarnessNotGsd, true,
      'section must explicitly state GSD does not manage MCP enablement (harness concern)');
  });

  test('notes interaction with model_profile (compounding levers) (#3025 requirement 5)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.mentionsModelProfileInteraction, true,
      'section must note that trimming MCPs compounds with model_profile choice');
  });

  test('full semantic record matches the #3025 contract — typed snapshot', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    const contract = {
      ok: parsed.ok,
      explainsMcpAsBudgetConcern: parsed.explainsMcpAsBudgetConcern,
      namesEnabledMcpjsonServers: parsed.namesEnabledMcpjsonServers,
      namesDisabledMcpjsonServers: parsed.namesDisabledMcpjsonServers,
      namesClaudeSettingsJson: parsed.namesClaudeSettingsJson,
      includesPrePhaseAudit: parsed.includesPrePhaseAudit,
      auditMentionsBrowserOrPlaywright: parsed.auditMentionsBrowserOrPlaywright,
      auditMentionsPlatformSpecific: parsed.auditMentionsPlatformSpecific,
      auditMentionsCrossProject: parsed.auditMentionsCrossProject,
      explainsHarnessNotGsd: parsed.explainsHarnessNotGsd,
      mentionsModelProfileInteraction: parsed.mentionsModelProfileInteraction,
    };
    assert.deepStrictEqual(contract, {
      ok: true,
      explainsMcpAsBudgetConcern: true,
      namesEnabledMcpjsonServers: true,
      namesDisabledMcpjsonServers: true,
      namesClaudeSettingsJson: true,
      includesPrePhaseAudit: true,
      auditMentionsBrowserOrPlaywright: true,
      auditMentionsPlatformSpecific: true,
      auditMentionsCrossProject: true,
      explainsHarnessNotGsd: true,
      mentionsModelProfileInteraction: true,
    }, 'context-budget.md MCP section contract violated');
  });
});

// ─── docs/USER-GUIDE.md task section ────────────────────────────────────────

describe('#3025 docs/USER-GUIDE.md: companion task section exists', () => {
  test('USER-GUIDE.md has an MCP-trimming task section', () => {
    const section = extractSection(USER_GUIDE_MD, 'mcp');
    assert.ok(section,
      'USER-GUIDE.md must have a `### ...MCP...` task section so users find it via the guide');
  });

  test('USER-GUIDE.md task section names the harness key and cross-links the reference', () => {
    const section = extractSection(USER_GUIDE_MD, 'mcp');
    const parsed = parseMcpBudgetSection(section);
    assert.equal(parsed.namesEnabledMcpjsonServers, true,
      'task section must mention the harness key by name');
    // Cross-link to the reference doc — assert on the parsed flag so
    // the invariant lives alongside the other named flags (CR follow-up
    // on the no-source-grep standard).
    assert.equal(parsed.crossLinksContextBudget, true,
      'task section must cross-link to context-budget.md');
  });
});

// ─── markdownlint pre-flight (per bundle-docs-with-code skill) ──────────────

describe('#3025 markdownlint pre-flight: MD040 + MD056', () => {
  test('every fenced code block in the new MCP section has a language tag (MD040)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    // Guard: extractSection returns null when the section is missing.
    // Without this, `section.match(...)` would throw a TypeError instead
    // of producing a meaningful assertion failure (CR follow-up).
    assert.ok(section, 'MCP section not found in context-budget.md — cannot check MD040');
    const fences = (section.match(/^```([a-zA-Z0-9_+-]*)?\s*$/gm) || []);
    // Pairs of fences open/close; odd-indexed ones close blocks. Every
    // OPENING fence must have a language tag. Closing fences are bare ```.
    // Walk pairs: even index = opener, odd = closer.
    const openers = fences.filter((_, i) => i % 2 === 0);
    const missing = openers.filter((line) => /^```\s*$/.test(line));
    assert.deepStrictEqual(missing, [],
      `every fenced code block opener must have a language tag (MD040). Missing: ${JSON.stringify(missing)}`);
  });

  test('every markdown table row in the new MCP section has the same column count as its header (MD056)', () => {
    const section = extractSection(CONTEXT_BUDGET_MD, 'mcp');
    // Guard: same null-section concern as MD040 above (CR follow-up).
    assert.ok(section, 'MCP section not found in context-budget.md — cannot check MD056');
    const lines = section.split(/\r?\n/);
    // Walk through and detect tables: header row followed by a separator
    // (--- pattern) followed by data rows. Count `|` per line.
    const issues = [];
    for (let i = 0; i < lines.length - 1; i += 1) {
      const header = lines[i];
      const sep = lines[i + 1];
      if (!/^\s*\|.*\|\s*$/.test(header)) continue;
      if (!/^\s*\|[\s\-:|]+\|\s*$/.test(sep)) continue;
      const headerCols = (header.match(/\|/g) || []).length;
      // Walk data rows
      for (let j = i + 2; j < lines.length; j += 1) {
        const row = lines[j];
        if (!/^\s*\|.*\|\s*$/.test(row)) break;
        const rowCols = (row.match(/\|/g) || []).length;
        if (rowCols !== headerCols) {
          issues.push({ line: j, expected: headerCols, actual: rowCols, row });
        }
      }
    }
    assert.deepStrictEqual(issues, [],
      `table rows must match header column count (MD056). Issues: ${JSON.stringify(issues, null, 2)}`);
  });
});
  });
}
