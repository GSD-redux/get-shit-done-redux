'use strict';

/**
 * Regression tests for issue #766: additive Claude Code plugin manifest.
 *
 * Asserts structural and semantic correctness of:
 *   .claude-plugin/plugin.json  — plugin manifest
 *   hooks/hooks.json            — plugin hook wiring
 *
 * Section C1 validates plugin.json against the snapshotted schema fixture
 * (tests/fixtures/plugin-manifest-schema.json) using explicit structural
 * assertions instead of an Ajv dependency, so this gate runs unconditionally
 * without requiring ajv in devDependencies.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const identity = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'package-identity.cjs'));
const pkg = require(path.join(ROOT, 'package.json'));
const { MANAGED_HOOKS } = require(path.join(ROOT, 'hooks', 'managed-hooks-registry.cjs'));
const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');

const PLUGIN_JSON_PATH = path.join(ROOT, '.claude-plugin', 'plugin.json');
const HOOKS_JSON_PATH  = path.join(ROOT, 'hooks', 'hooks.json');

// ─── Section A: plugin.json ───────────────────────────────────────────────────
describe('A: .claude-plugin/plugin.json', () => {

  let manifest;

  test('exists and is valid JSON', () => {
    assert.ok(fs.existsSync(PLUGIN_JSON_PATH), '.claude-plugin/plugin.json must exist');
    const raw = fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8');
    manifest = JSON.parse(raw); // throws on invalid JSON
    assert.ok(typeof manifest === 'object' && manifest !== null, 'manifest must be a JSON object');
  });

  test('name equals identity.binName ("gsd-core")', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.name, identity.binName, `name should be "${identity.binName}"`);
  });

  test('name is kebab-case, no colons, spaces, or uppercase', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.match(
      manifest.name,
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'name must be kebab-case (no colon, space, or uppercase) to be namespace-safe'
    );
  });

  test('version matches package.json version', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.version, pkg.version, `.claude-plugin/plugin.json version (${manifest.version}) must match package.json version (${pkg.version}). When bumping the package version, update .claude-plugin/plugin.json \`version\` to match — Claude Code plugin --strict validation requires a version field and the plugin manifest must track the package version. (#766)`);
  });

  test('repository equals identity.repoUrl', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.repository, identity.repoUrl, 'repository must equal identity.repoUrl');
  });

  test('homepage equals identity.repoUrl', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.homepage, identity.repoUrl, 'homepage must equal identity.repoUrl');
  });

  test('license matches package.json license', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.license, pkg.license, 'license must match package.json');
  });

  test('author.name is a non-empty string', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(
      manifest.author && typeof manifest.author.name === 'string' && manifest.author.name.trim().length > 0,
      'author.name must be a non-empty string'
    );
  });

  test('commands field is "./commands/gsd/" and that dir exists with at least one .md file', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.commands, './commands/gsd/', 'commands must be "./commands/gsd/"');
    const resolvedDir = path.resolve(path.dirname(PLUGIN_JSON_PATH), '..', manifest.commands);
    assert.ok(fs.existsSync(resolvedDir), `resolved commands dir must exist: ${resolvedDir}`);
    const mdFiles = fs.readdirSync(resolvedDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length > 0, `commands dir must contain at least one .md file`);
  });

  test('#3029: hooks field is ABSENT — Claude Code auto-loads hooks/hooks.json (explicit declaration caused duplicate-rejection)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(!manifest.hooks, 'plugin.json must NOT declare hooks — Claude Code auto-loads hooks/hooks.json; an explicit declaration causes a duplicate-rejection that silently disables all hooks (#3029)');
    // The auto-loaded hooks file must still exist on disk.
    const resolvedHooks = path.resolve(path.dirname(PLUGIN_JSON_PATH), '..', 'hooks', 'hooks.json');
    assert.ok(fs.existsSync(resolvedHooks), `hooks/hooks.json must exist for auto-loading: ${resolvedHooks}`);
  });

  test('no "$schema" key (intentionally omitted)', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.ok(!Object.prototype.hasOwnProperty.call(manifest, '$schema'), 'plugin.json must NOT contain a $schema key');
  });
});

// ─── Section B: hooks/hooks.json ─────────────────────────────────────────────
describe('B: hooks/hooks.json', () => {

  let hooksConfig;

  test('exists and is valid JSON with top-level "hooks" object', () => {
    assert.ok(fs.existsSync(HOOKS_JSON_PATH), 'hooks/hooks.json must exist');
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    hooksConfig = JSON.parse(raw);
    assert.ok(
      typeof hooksConfig === 'object' && hooksConfig !== null &&
      typeof hooksConfig.hooks === 'object' && hooksConfig.hooks !== null,
      'hooks.json must have a top-level "hooks" object'
    );
  });

  test('every event name is a known Claude Code lifecycle event', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    // Complete set of Claude Code hook events as of #770 (SubagentStop, Stop,
    // PreCompact, FileChanged added in #770; prior set was SessionStart,
    // PreToolUse, PostToolUse from #766).
    const validEvents = new Set([
      'SessionStart', 'PreToolUse', 'PostToolUse',
      'SubagentStop', 'Stop', 'PreCompact', 'FileChanged',
    ]);
    for (const eventName of Object.keys(hooksConfig.hooks)) {
      assert.ok(validEvents.has(eventName), `Unknown hook event: "${eventName}"`);
    }
  });

  test('every hook entry has type "command" and command contains ${CLAUDE_PLUGIN_ROOT}', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    for (const [eventName, eventEntries] of Object.entries(hooksConfig.hooks)) {
      assert.ok(Array.isArray(eventEntries), `Event "${eventName}" must be an array`);
      for (const entry of eventEntries) {
        assert.ok(Array.isArray(entry.hooks), `Entry in "${eventName}" must have a hooks array`);
        for (const hook of entry.hooks) {
          assert.equal(hook.type, 'command', `All hook entries must have type "command" (got "${hook.type}")`);
          assert.ok(
            typeof hook.command === 'string' && hook.command.includes('${CLAUDE_PLUGIN_ROOT}'),
            `Hook command must contain "\${CLAUDE_PLUGIN_ROOT}": ${hook.command}`
          );
        }
      }
    }
  });

  test('every referenced script file exists on disk and its basename is in MANAGED_HOOKS', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    // Extract script path: substring after ${CLAUDE_PLUGIN_ROOT}/ up to next "
    const scriptPathRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/g;
    const allScripts = [];
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          const matches = [...hook.command.matchAll(scriptPathRe)];
          for (const m of matches) {
            allScripts.push(m[1]);
          }
        }
      }
    }
    assert.ok(allScripts.length > 0, 'Should have found at least one script path in hooks.json');
    for (const scriptPath of allScripts) {
      const fullPath = path.join(ROOT, scriptPath);
      assert.ok(fs.existsSync(fullPath), `Script referenced in hooks.json does not exist on disk: ${fullPath}`);
      const basename = path.basename(scriptPath);
      assert.ok(
        MANAGED_HOOKS.includes(basename),
        `Script basename "${basename}" is not listed in hooks/managed-hooks-registry.cjs MANAGED_HOOKS`
      );
    }
  });

  test('all seven always-on hooks are wired', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    const REQUIRED_HOOKS = [
      'gsd-check-update.js',
      'gsd-prompt-guard.js',
      'gsd-read-guard.js',
      'gsd-worktree-path-guard.js',
      'gsd-write-guard.js',
      'gsd-context-monitor.js',
      'gsd-read-injection-scanner.js',
    ];
    // Collect all basenames wired in hooks.json
    const wiredBasenames = new Set();
    const scriptPathRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^"]+)/g;
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          const matches = [...hook.command.matchAll(scriptPathRe)];
          for (const m of matches) {
            wiredBasenames.add(m[1]);
          }
        }
      }
    }
    for (const required of REQUIRED_HOOKS) {
      assert.ok(wiredBasenames.has(required), `Required hook "${required}" is not wired in hooks/hooks.json`);
    }
  });

  test('gsd-context-monitor.js entry has timeout === 10', (t) => {
    if (!hooksConfig) { t.skip('hooks.json could not be parsed'); return; }
    let found = false;
    for (const eventEntries of Object.values(hooksConfig.hooks)) {
      for (const entry of eventEntries) {
        for (const hook of entry.hooks) {
          if (hook.command && hook.command.includes('gsd-context-monitor.js')) {
            found = true;
            assert.equal(hook.timeout, 10, 'gsd-context-monitor.js must have timeout === 10');
          }
        }
      }
    }
    assert.ok(found, 'gsd-context-monitor.js entry was not found in hooks.json');
  });
});

// ─── Section C: Unconditional JSON schema gate + opportunistic CLI integration ──
//
// The `claude plugin validate --strict` binary is absent on CI, so Section C was
// previously SKIPPED there — the only full-schema gate never ran.  This section
// replaces the skip-on-absent pattern with three tiers:
//
//   C1 (UNCONDITIONAL) — Validate plugin.json against a snapshotted JSON schema
//        fixture that captures the fields `--strict` requires.  Runs on every
//        platform, every CI job, every local run.  A bug that removes `version`
//        or changes `name` to an invalid form goes red immediately.
//
//   C2 (OPPORTUNISTIC — LOCAL-ONLY IN PRACTICE) — When the `claude` binary IS on
//        PATH, also run `claude plugin validate <temp-plugin-root> --strict` as an
//        end-to-end smoke test, catching schema changes Claude Code may introduce
//        that the C1 fixture hasn't yet captured.
//
//        #3613: no job under .github/workflows/ installs the `claude` CLI, so
//        `claudeAvailable` is false on today's CI images and this tier runs ONLY on a
//        developer machine that happens to have the binary. Read its coverage
//        that way — a best-effort local check, not a gate any PR must clear.
//        Provisioning the CLI in a CI job would turn it into a real gate; that
//        is a maintainer call and is deliberately left open here.
//
//   C3 (UNCONDITIONAL) — Enforces a symlink-free fixture throughout, deliberately
//        stricter than what C2 itself requires. It is a
//        tripwire against a symlink regression, not a substitute for C2's end-to-end
//        check — but it is the only part of that pair CI can run.
//
describe('C: plugin.json schema validation', () => {

  const SCHEMA_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'plugin-manifest-schema.json');

  // ── C1: Unconditional structural gate ────────────────────────────────────────
  //
  // Validates plugin.json against the required fields from the snapshotted
  // schema fixture (tests/fixtures/plugin-manifest-schema.json) using explicit
  // structural assertions.  This avoids a runtime dependency on `ajv` (which is
  // only a transitive dep) while providing identical coverage for the fields that
  // `claude plugin validate --strict` requires.
  //
  // Required fields and constraints are derived directly from SCHEMA_FIXTURE_PATH.
  // If the fixture changes (new required field, new pattern), update this test too.

  test('C1: plugin.json satisfies the snapshotted Claude Code plugin schema (unconditional)', () => {
    assert.ok(
      fs.existsSync(SCHEMA_FIXTURE_PATH),
      `Schema fixture must exist: ${SCHEMA_FIXTURE_PATH}`
    );
    assert.ok(
      fs.existsSync(PLUGIN_JSON_PATH),
      `.claude-plugin/plugin.json must exist: ${PLUGIN_JSON_PATH}`
    );

    const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8'));
    const schema = JSON.parse(fs.readFileSync(SCHEMA_FIXTURE_PATH, 'utf-8'));
    const errors = [];

    const schemaRequired = Array.isArray(schema.required) ? schema.required : [];
    const schemaProps = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};

    // Helper: assert a required field exists with the expected type.
    function requireField(key, type) {
      if (!(key in manifest)) {
        errors.push(`"${key}" is required but missing`);
      } else if (typeof manifest[key] !== type) {
        errors.push(`"${key}" must be a ${type}, got ${typeof manifest[key]}`);
      }
    }

    // Derive required fields and their types directly from the schema fixture.
    // Each required field whose "properties" entry has a primitive "type" is
    // checked via requireField; "object"-typed fields are handled below.
    for (const key of schemaRequired) {
      const propDef = schemaProps[key];
      const fieldType = propDef && propDef.type;
      if (fieldType === 'object') {
        // Object fields are validated with deeper checks below.
        continue;
      }
      requireField(key, fieldType || 'string');
    }

    // Validate "object"-typed required fields from the schema.
    // For each such field, check existence, type, and any nested "required" sub-fields.
    for (const key of schemaRequired) {
      const propDef = schemaProps[key];
      if (!propDef || propDef.type !== 'object') continue;

      if (!(key in manifest)) {
        errors.push(`"${key}" is required but missing`);
      } else if (typeof manifest[key] !== 'object' || manifest[key] === null) {
        errors.push(`"${key}" must be an object`);
      } else {
        // Validate nested required sub-fields declared in the schema.
        const nestedRequired = Array.isArray(propDef.required) ? propDef.required : [];
        const nestedProps = (propDef.properties && typeof propDef.properties === 'object') ? propDef.properties : {};
        for (const subKey of nestedRequired) {
          const subDef = nestedProps[subKey];
          const subType = subDef && subDef.type;
          if (!(subKey in manifest[key])) {
            errors.push(`"${key}.${subKey}" is required but missing`);
          } else if (subType && typeof manifest[key][subKey] !== subType) {
            errors.push(`"${key}.${subKey}" must be a ${subType}, got ${typeof manifest[key][subKey]}`);
          }
          // minLength check for nested string sub-fields
          if (subType === 'string' && subDef.minLength !== undefined) {
            if (typeof manifest[key][subKey] === 'string' && manifest[key][subKey].length < subDef.minLength) {
              errors.push(`"${key}.${subKey}" must have minLength ${subDef.minLength}`);
            }
          }
        }
      }
    }

    // Derive pattern and minLength constraints from the schema fixture properties.
    for (const key of schemaRequired) {
      const propDef = schemaProps[key];
      if (!propDef || propDef.type === 'object') continue;
      const value = manifest[key];

      if (propDef.pattern && typeof value === 'string') {
        // Pattern extracted verbatim from the schema fixture — the shipped
        // JSON-schema pattern IS the product under test (#3951).
        const re = new RegExp(propDef.pattern); // allow-adhoc-regex-escape: runtime-contract-is-the-product
        if (!re.test(value)) {
          errors.push(`"${key}" must match ${propDef.pattern}, got "${value}"`);
        }
      }

      if (propDef.minLength !== undefined && typeof value === 'string') {
        if (value.length < propDef.minLength) {
          errors.push(`"${key}" must have minLength ${propDef.minLength}, got length ${value.length}`);
        }
      }
    }

    if (errors.length > 0) {
      assert.fail(
        `plugin.json fails structural validation against ${path.relative(ROOT, SCHEMA_FIXTURE_PATH)}:\n` +
        errors.map(e => `  - ${e}`).join('\n') +
        `\n\nFull manifest:\n${JSON.stringify(manifest, null, 2)}`
      );
    }
  });

  // ── C2: Opportunistic CLI integration (skipped when claude not on PATH) ──────

  // #2665: the `claude` CLI is a THIRD-PARTY binary that bootstraps its own
  // config (.claude.json plus a backups/ dir) into whatever CLAUDE_CONFIG_DIR
  // names. Two things follow, and only the first is obvious:
  //
  //   1. Inheriting the developer's ambient CLAUDE_CONFIG_DIR makes even a bare
  //      `--version` probe write into their live config dir. That alone kept
  //      `CLAUDE_CONFIG_DIR=<dir> npm run test:unit; find <dir> -type f` from
  //      returning empty after every GSD-side leak was closed.
  //   2. BLANKING it (TEST_ENV_BASE's '' convention) is not enough here. GSD's
  //      own resolvers treat '' as falsy and fall back to the home dir, but this
  //      binary is not ours and gives no such guarantee -- blanking it produced a
  //      stray backups/ directory in the REPO ROOT.
  //
  // So point it at a real throwaway dir rather than at nothing.
  const claudeCliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2665-claude-cli-'));
  const claudeCliEnv = () => ({
    ...process.env,
    ...TEST_ENV_BASE,
    HOME: claudeCliHome,
    USERPROFILE: claudeCliHome,
    CLAUDE_CONFIG_DIR: path.join(claudeCliHome, '.claude'),
  });

  const claudeAvailable = (() => {
    try {
      const result = spawnSync('claude', ['--version'], {
        encoding: 'utf-8',
        timeout: 5000,
        env: claudeCliEnv(),
      });
      return result.status === 0;
    } catch (_) {
      return false;
    }
  })();

  // #3613: the component directories are COPIED, never symlinked. `claude plugin
  // validate` reads them WITHOUT following symlinks and warns when it finds one,
  // and `--strict` promotes that warning to a non-zero exit — so a symlinked
  // fixture failed the gate on its own construction rather than on the manifest
  // under test. Copying still gives the CLI a tree containing only plugin.json
  // and the three component directories — which is the isolation the temp root
  // exists for, since nothing else from the repo root is placed where the
  // validator can read it — while letting it actually read those components.
  // Exactly the three directories #3613 names — the ones the pre-fix code
  // symlinked. An earlier revision also copied agents/, on the (correct)
  // observation that the CLI auto-validates it and a frontmatter-less
  // agents/*.md exits 1. Dropped in review: it is a NEW gate the issue does not
  // ask for, on the largest of the trees. RESOLVED by #3751 (2026-09-02,
  // options 1+3): CI provisions the claude CLI, agents/ is in the fixture, and
  // the asymmetry #3613 existed to remove is gone — C2 runs in CI.
  // #3751 (decision 1+3, 2026-09-02): agents/ is included — the CLI validates
  // it by convention (measured on 2.1.239), and CI now provisions the claude
  // CLI in a dedicated test.yml job, so C2 is a real gate over this tree.
  const COMPONENT_DIRS = ['commands', 'hooks', 'skills', 'agents'];

  /**
   * One entry that must survive the copy into each component tree, so C3 catches
   * a partial copy rather than only a wholly empty one. `commands/gsd` and
   * `skills/` are what `.claude-plugin/plugin.json` declares; `hooks/hooks.json`
   * is the manifest the runtime loads and the one entry hooks/ cannot be useful
   * without.
   */
  const EXPECTED_ENTRY = {
    commands: 'gsd',
    hooks: 'hooks.json',
    skills: 'gsd-add-tests',
    // #3751: agents/ is undeclared in plugin.json (CLI-convention pickup), so
    // the expected entry is a shipped agent file, not a manifest-declared path.
    agents: 'gsd-executor.md',
  };

  /**
   * Should this top-level `hooks/` entry be copied into the validation fixture?
   *
   * By NAME, before anything stats it. `scripts/build-hooks.js` writes
   * atomically through a per-PID `hooks/.dist-staging-<pid>` and removes it when
   * done, and nine test files invoke that script from their before() hooks — so
   * a walk can enumerate a staging directory and then lstat it after the owning
   * process deleted it (ENOENT). A filter applied AFTER the stat does not close
   * that. `dist` is excluded for an independent reason: a real marketplace
   * install contains neither dist nor a transient staging dir.
   *
   * Deliberately local rather than reusing cold-runtime-lib-fixture.cjs's
   * identical predicate. That one is documented as scoped to the cold-tree
   * fixture and had exactly one caller; making it two, across fixtures with
   * different requirements and nothing asserting they stay compatible, is how a
   * later cold-tree change silently alters what this fixture validates.
   * Raised in review of #3627.
   */
  function shouldCopyHookEntry(name) {
    return name !== 'dist' && !name.startsWith('.dist-staging');
  }

  function buildValidationPluginRoot() {
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plugin-validate-'));
    // Construction is self-cleaning: the callers' try/finally only begins once
    // this returns, so a throw partway through would otherwise strand a
    // half-built root on disk. Before this helper existed the same steps ran
    // inside C2's own try, and that teardown guarantee is preserved here.
    try {
      fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
      fs.copyFileSync(PLUGIN_JSON_PATH, path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
      for (const dir of COMPONENT_DIRS) {
        // Copy entry-by-entry and skip by NAME BEFORE anything stats it. A bare
        // recursive copy of hooks/ races the builders: scripts/build-hooks.js
        // writes atomically through a per-PID `hooks/.dist-staging-<pid>` and
        // removes it when done, and nine test files invoke that script from
        // their before() hooks — so a recursive walk can enumerate a staging
        // directory and then lstat it after the owning process deleted it
        // (ENOENT). #3656 fixed this same shape in the cold-tree fixture; the
        // rule is the same one, stated locally above rather than imported.
        const src = path.join(ROOT, dir);
        fs.mkdirSync(path.join(pluginRoot, dir), { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          // The predicate is documented as a hooks/ filter, so apply it only
          // there. Applying it to the other trees happens to be harmless today
          // but silently encodes a hooks-shaped exclusion into them — a future
          // commands/dist would vanish from the validated tree with no signal.
          if (dir === 'hooks' && !shouldCopyHookEntry(entry.name)) continue;
          fs.cpSync(path.join(src, entry.name), path.join(pluginRoot, dir, entry.name), { recursive: true });
        }
      }
    } catch (err) {
      // Best-effort: cleanup() can itself throw (it tolerates Windows EBUSY by
      // giving up after retries), and a throw here would replace the real
      // construction error with a teardown one.
      try {
        cleanup(pluginRoot);
      } catch {
        /* keep the original error */
      }
      throw err;
    }
    return pluginRoot;
  }

  test(
    'C2: claude plugin validate --strict exits 0 (opportunistic — skip when claude not on PATH)',
    {
      skip: !claudeAvailable
        ? 'claude binary not on PATH (local-only tier — no CI job provisions it, see #3613)'
        : false,
    },
    () => {
      const pluginRoot = buildValidationPluginRoot();
      try {
        const result = spawnSync('claude', ['plugin', 'validate', pluginRoot, '--strict'], {
          cwd: ROOT,
          encoding: 'utf-8',
          timeout: 15000,
          env: claudeCliEnv(),
        });
        assert.equal(
          result.status,
          0,
          `claude plugin validate ${pluginRoot} --strict exited with ${result.status}.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
        );
      } finally {
        cleanup(pluginRoot);
      }
    }
  );

  // ── #3751: agents/ coverage (maintainer decision 2026-09-02: options 1+3) ────
  //
  // `claude plugin validate` auto-validates agents/ by CLI CONVENTION (the
  // manifest does not declare it), measured live on CLI 2.1.239 in the issue.
  // Decision: CI provisions the claude CLI (a dedicated test.yml job), so C2 is
  // a real gate, and the fixture + C3 cover the tree everywhere else.

  test('C3+#3751: the validation fixture covers agents/, the tree the CLI validates by convention', () => {
    const pluginRoot = buildValidationPluginRoot();
    try {
      const agentsDir = path.join(pluginRoot, 'agents');
      const stat = fs.lstatSync(agentsDir);
      assert.ok(stat.isDirectory(), 'agents/ must be a real directory in the C2 validation fixture');
      assert.equal(stat.isSymbolicLink(), false, 'agents/ must be copied, not symlinked');
      const entries = fs.readdirSync(agentsDir);
      assert.ok(entries.length > 0, 'agents/ is EMPTY in the C2 validation fixture');
      assert.ok(
        entries.some((e) => /^gsd-.*\.md$/.test(e)),
        'agents/ must carry the shipped gsd-*.md files, not a stub'
      );
    } finally {
      cleanup(pluginRoot);
    }
  });

  test('#3751: CI provisions the claude CLI so C2 is a real gate, not a local-only tier', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
    assert.ok(
      /@anthropic-ai\/claude-code/.test(workflow),
      'test.yml must install the claude CLI (npm i -g @anthropic-ai/claude-code) in a job'
    );
    assert.ok(
      /plugin-manifest\.test\.cjs/.test(workflow),
      'the provisioning job must run tests/plugin-manifest.test.cjs (the C2 gate)'
    );
  });

  // ── C3: Unconditional fixture-construction guard ─────────────────────────────
  //
  // #3613 regression. C2 above is the test that actually shells out to the CLI,
  // but no CI job provisions that binary today, so it does not execute there. A
  // revert to symlinked component directories would therefore sail through every
  // CI lane and surface only as a red suite on contributor machines — which is
  // exactly how #3613 went unnoticed. This enforces a symlink-free fixture with no
  // dependency on the CLI, so it runs on every platform and every job — a stricter
  // invariant than C2 requires, chosen so it does not encode the CLI's exact and
  // undocumented boundary.
  //
  // Scope, stated honestly: this is a tripwire, not product coverage. It cannot be
  // demonstrated red against the base commit, because the helper it calls arrives in
  // the same change; the genuine failing-first artifact for #3613 is C2. What it buys
  // is that a future edit reverting the helper to symlinkSync goes red somewhere CI
  // can see, which C2 cannot do.
  //
  // It deliberately builds the fixture for real rather than stubbing it — that is the
  // only way it exercises the code path it guards, and it is why the ~1.06 MB copy (commands 340K, hooks 380K excluding dist, skills 336K — 176 files) now
  // runs on every job (and twice when `claude` is present). Do not "optimize" that
  // into a stub; it would void the guard — and the emptiness assertions in C3 are
  // what make that statement enforceable rather than advisory.
  test('C3: validation fixture exposes real component directories, not symlinks (#3613)', () => {
    const pluginRoot = buildValidationPluginRoot();
    try {
      for (const dir of COMPONENT_DIRS) {
        const target = path.join(pluginRoot, dir);
        const stat = fs.lstatSync(target);
        assert.equal(
          stat.isSymbolicLink(),
          false,
          `${dir}/ is a symlink in the C2 validation fixture. \`claude plugin validate\` reads component directories without following symlinks and warns on each one, and --strict turns that warning into a failing exit (#3613). Copy the directory with fs.cpSync instead of symlinking it.`
        );
        assert.ok(stat.isDirectory(), `${dir}/ must be a real directory in the C2 validation fixture`);
        // Raised in review: without this, C3 goes green on a fixture that
        // validates nothing. buildValidationPluginRoot() mkdir's every component
        // dir BEFORE the entry loop, so if the copy ever stops happening — a
        // broadened filter, a mis-scoped `if (dir === ...)`, a wrong src, an
        // early continue — the result is real, empty directories, and all three
        // structural assertions above still pass (an empty tree contains no
        // symlinks). C2 would catch it, but C2 does not run in CI; C3 is the only
        // CI-visible guard on this fixture, so it has to see it.
        const contents = fs.readdirSync(target);
        assert.ok(
          contents.length > 0,
          `${dir}/ is EMPTY in the C2 validation fixture. The directory was created but nothing was copied into it — C3's symlink assertions pass vacuously on an empty tree, and \`claude plugin validate\` reports "Path not found" for the manifest's declared components.`
        );
        // A known entry per tree, so a PARTIAL copy is caught too, not just a
        // wholly empty one. These are the paths plugin.json declares (commands,
        // skills) and the hooks manifest the runtime loads.
        assert.ok(
          fs.existsSync(path.join(target, EXPECTED_ENTRY[dir])),
          `${dir}/${EXPECTED_ENTRY[dir]} is missing from the C2 validation fixture — the copy is partial, so the validated tree is not the shipped one.`
        );
      }

      // Depth-N, not just depth-1. fs.cpSync defaults to dereference:false, so any
      // symlink inside a component directory is copied AS a symlink.
      //
      // An earlier revision of this comment carried a table indexed by DEPTH and
      // claimed a symlink two levels inside skills/ exits 0. That row was wrong,
      // and the mistake was measuring an inert file. Re-measured on CLI 2.1.239
      // (exit code of `plugin validate --strict`), reproducing the review's
      // 2.1.237 result:
      //
      //     component dir is itself a symlink ................... 1
      //     symlink one level inside skills/ (file or dir) ...... 1
      //     symlink two levels in, an inert file (a stray *.md) . 0
      //     symlink two levels in that IS the component file
      //       (skills/<name>/SKILL.md) .......................... 1
      //     symlink inside commands/ (a dir, or a component *.md) . 0
      //     stray symlinked dir or *.js inside hooks/ ........... 0
      //     symlinked hooks/hooks.json .......................... 1
      //
      // So the boundary is not depth at all — it is whether the symlink is a file
      // the CLI actually reads as a component ("1 component here was not read —
      // the path is not a regular file"). That is an external, undocumented
      // boundary that has already moved once between CLI versions, so C3 does not
      // encode it: it enforces the stricter invariant "no symlinks anywhere in the
      // fixture", a superset that stays correct as the CLI tightens, for one walk
      // over ~176 files. The trees are symlink-free today, so this is latent, not
      // a live break.
      //
      // Walk with an explicit stack, NOT readdirSync's `recursive: true` — that
      // option follows directory symlinks (verified on Node 24: a symlinked dir
      // inside the tree is descended into), so a link pointing outward would walk
      // an unrelated tree, or a cycle, before this assertion ever ran. Record links
      // and descend only into real directories.
      const nested = [];
      const stack = COMPONENT_DIRS.map((dir) => path.join(pluginRoot, dir));
      while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const full = path.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            nested.push(path.relative(pluginRoot, full));
          } else if (entry.isDirectory()) {
            stack.push(full);
          }
        }
      }
      nested.sort();
      assert.deepStrictEqual(
        nested,
        [],
        `The C2 validation fixture contains symlink(s): ${nested.join(', ')}. The fixture must be symlink-free throughout: \`claude plugin validate\` reads component directories without following symlinks and warns on ones it finds, and --strict turns that warning into a failing exit (#3613). Measured on CLI 2.1.239, a component dir itself, an entry directly under skills/, a symlinked SKILL.md at any depth, or a symlinked hooks/hooks.json is enough to fail; this assertion is deliberately stricter than that boundary so it stays correct if the CLI tightens. Copy with fs.cpSync instead of symlinking.`
      );
    } finally {
      cleanup(pluginRoot);
    }
  });
});

// ─── Section D: Always-on hook contract (drift guard) ────────────────────────
describe('D: always-on hook contract drift guard', () => {

  /**
   * Parses hooks.json and builds a map:
   *   event -> matcher (or '' for no-matcher) -> [{script, timeout}]
   *
   * script: basename of the .js/.sh file referenced in the command string
   * timeout: numeric value from hook.timeout, or undefined if absent
   */
  function buildHookMap() {
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    const hooksConfig = JSON.parse(raw);
    const scriptRe = /\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+)/;
    const map = {};
    for (const [eventName, eventEntries] of Object.entries(hooksConfig.hooks)) {
      map[eventName] = map[eventName] || {};
      for (const entry of eventEntries) {
        const matcher = entry.matcher || '';
        map[eventName][matcher] = map[eventName][matcher] || [];
        for (const hook of entry.hooks) {
          const m = hook.command.match(scriptRe);
          if (m) {
            map[eventName][matcher].push({
              script: m[1],
              timeout: hook.timeout,
            });
          }
        }
      }
    }
    return map;
  }

  test('SessionStart: one no-matcher group with gsd-ensure-canonical-path.js then gsd-check-update.js', () => {
    // #997: gsd-ensure-canonical-path.js is wired alongside gsd-check-update.js
    // in the single SessionStart no-matcher group. It must run FIRST so the
    // canonical ~/.claude/gsd-core path (and its @-include targets) exist before
    // any other SessionStart logic that may read the bundled tree.
    const map = buildHookMap();
    const groups = map['SessionStart'];
    assert.ok(groups, 'SessionStart must be present in hooks.json');
    // There must be exactly one entry group (key '' = no matcher)
    const noMatcherHooks = groups[''];
    assert.ok(
      Array.isArray(noMatcherHooks) && noMatcherHooks.length === 2,
      `SessionStart no-matcher group must contain exactly two hooks; got: ${JSON.stringify(noMatcherHooks)}`
    );
    assert.equal(
      noMatcherHooks[0].script, 'gsd-ensure-canonical-path.js',
      'gsd-ensure-canonical-path.js must be the FIRST SessionStart hook (#997)'
    );
    assert.equal(
      noMatcherHooks[0].timeout, 5,
      'gsd-ensure-canonical-path.js must have a small timeout (5s) — symlink setup is fast'
    );
    assert.equal(
      noMatcherHooks[1].script, 'gsd-check-update.js',
      'gsd-check-update.js must remain a SessionStart hook'
    );
    assert.equal(noMatcherHooks[1].timeout, undefined, 'gsd-check-update.js must NOT have a timeout field');
  });

  test('PreToolUse Write|Edit group: gsd-prompt-guard.js (timeout 5) + gsd-read-guard.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PreToolUse'];
    assert.ok(groups, 'PreToolUse must be present in hooks.json');
    const hooks = groups['Write|Edit'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 2,
      `PreToolUse Write|Edit must have exactly 2 hooks; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-prompt-guard.js', 'first hook must be gsd-prompt-guard.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-prompt-guard.js must have timeout 5');
    assert.equal(hooks[1].script, 'gsd-read-guard.js', 'second hook must be gsd-read-guard.js');
    assert.equal(hooks[1].timeout, 5, 'gsd-read-guard.js must have timeout 5');
  });

  test('PreToolUse Write|Edit|MultiEdit group: gsd-worktree-path-guard.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PreToolUse'];
    assert.ok(groups, 'PreToolUse must be present in hooks.json');
    const hooks = groups['Write|Edit|MultiEdit'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PreToolUse Write|Edit|MultiEdit must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-worktree-path-guard.js', 'hook must be gsd-worktree-path-guard.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-worktree-path-guard.js must have timeout 5');
  });

  test('PreToolUse Write group: gsd-write-guard.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PreToolUse'];
    assert.ok(groups, 'PreToolUse must be present in hooks.json');
    // #2255: catastrophic-shrink guard for curated .planning/ writes — its own
    // matcher group because it guards Write payloads only (Edit/MultiEdit are
    // scoped by construction and out of scope by design).
    const hooks = groups['Write'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PreToolUse Write must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-write-guard.js', 'hook must be gsd-write-guard.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-write-guard.js must have timeout 5');
  });

  test('PostToolUse Bash|Edit|Write|MultiEdit|Agent|Task group: gsd-context-monitor.js (timeout 10)', () => {
    const map = buildHookMap();
    const groups = map['PostToolUse'];
    assert.ok(groups, 'PostToolUse must be present in hooks.json');
    const hooks = groups['Bash|Edit|Write|MultiEdit|Agent|Task'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PostToolUse Bash|Edit|Write|MultiEdit|Agent|Task must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-context-monitor.js', 'hook must be gsd-context-monitor.js');
    assert.equal(hooks[0].timeout, 10, 'gsd-context-monitor.js must have timeout 10');
  });

  test('PostToolUse Read|WebFetch|WebSearch group: gsd-read-injection-scanner.js (timeout 5)', () => {
    const map = buildHookMap();
    const groups = map['PostToolUse'];
    assert.ok(groups, 'PostToolUse must be present in hooks.json');
    // #1577: the injection scanner now also covers WebFetch/WebSearch ingress,
    // so the matcher is the combined "Read|WebFetch|WebSearch" group.
    const hooks = groups['Read|WebFetch|WebSearch'];
    assert.ok(
      Array.isArray(hooks) && hooks.length === 1,
      `PostToolUse Read|WebFetch|WebSearch must have exactly 1 hook; got: ${JSON.stringify(hooks)}`
    );
    assert.equal(hooks[0].script, 'gsd-read-injection-scanner.js', 'hook must be gsd-read-injection-scanner.js');
    assert.equal(hooks[0].timeout, 5, 'gsd-read-injection-scanner.js must have timeout 5');
  });
});

// ─── Section E: Config-gated hooks must be absent from hooks.json ─────────────
describe('E: config-gated (opt-in) hooks must not appear in hooks.json', () => {

  const CONFIG_GATED_HOOKS = [
    'gsd-workflow-guard.js',
    'gsd-validate-commit.sh',
    'gsd-graphify-update.sh',
    'gsd-session-state.sh',
    'gsd-phase-boundary.sh',
    'gsd-update-banner.js',
    'gsd-statusline.js',
    'gsd-check-update-worker.js',
  ];

  test('none of the config-gated hook basenames appear in hooks.json command strings', () => {
    const raw = fs.readFileSync(HOOKS_JSON_PATH, 'utf-8');
    // Check raw text — simple and resistant to structure changes
    for (const hookBasename of CONFIG_GATED_HOOKS) {
      assert.ok(
        !raw.includes(hookBasename),
        `Config-gated hook "${hookBasename}" must NOT appear in hooks/hooks.json ` +
        `(it is opt-in and must not run unconditionally on the plugin path)`
      );
    }
  });
});

// ─── Section F: #997 canonical-path hook registration ────────────────────────
//
// gsd-ensure-canonical-path.js must be shipped + wired so plugin installs get a
// real ~/.claude/gsd-core directory (with the immutable bundled subdirs
// symlinked) — otherwise every `@~/.claude/gsd-core/...` include in agents /
// commands / templates resolves to nothing and agents fail (#997).
describe('F: #997 gsd-ensure-canonical-path.js is shipped and wired', () => {
  const HOOK_BASENAME = 'gsd-ensure-canonical-path.js';

  test('hook source file exists in hooks/', () => {
    assert.ok(
      fs.existsSync(path.join(ROOT, 'hooks', HOOK_BASENAME)),
      `hooks/${HOOK_BASENAME} must exist on disk`
    );
  });

  test('hook is listed in HOOKS_TO_COPY (build-hooks.js) so it ships to dist', () => {
    const { HOOKS_TO_COPY } = require(path.join(ROOT, 'scripts', 'build-hooks.js'));
    assert.ok(
      HOOKS_TO_COPY.includes(HOOK_BASENAME),
      `${HOOK_BASENAME} must be in HOOKS_TO_COPY or it never ships to hooks/dist`
    );
  });

  test('hook is listed in MANAGED_HOOKS (staleness detection)', () => {
    assert.ok(
      MANAGED_HOOKS.includes(HOOK_BASENAME),
      `${HOOK_BASENAME} must be in MANAGED_HOOKS so it is checked for staleness after update`
    );
  });

  test('hook is wired in hooks.json SessionStart with ${CLAUDE_PLUGIN_ROOT}', () => {
    const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf-8'));
    const sessionStart = hooksConfig.hooks.SessionStart || [];
    let wired = false;
    for (const entry of sessionStart) {
      for (const hook of entry.hooks || []) {
        if (hook.command && hook.command.includes(HOOK_BASENAME)) {
          wired = true;
          assert.ok(
            hook.command.includes('${CLAUDE_PLUGIN_ROOT}'),
            'canonical-path hook command must use ${CLAUDE_PLUGIN_ROOT}'
          );
        }
      }
    }
    assert.ok(wired, `${HOOK_BASENAME} must be wired under SessionStart in hooks.json`);
  });
});

// ─── Section G: #997 ensureCanonicalPath() behavioral regression ─────────────
//
// Drives the hook's exported pure core with fake home / fake plugin-root layouts
// to prove the actual canonical-path bootstrap behaviour: creates symlinks for a
// plugin layout, no-ops for classic installs, preserves user files, prunes stale
// links (self-heal after `claude plugin update`), and handles boundary cases
// (missing bundled dir, pre-existing real dir, pre-existing user file at a link
// target). Behavioral — calls the exported function and asserts the resulting
// filesystem state, not source text.
describe('G: #997 ensureCanonicalPath() behavioural regression', () => {
  const { ensureCanonicalPath, dirLinkType, MANAGED_SUBDIRS } =
    require(path.join(ROOT, 'hooks', 'gsd-ensure-canonical-path.js'));

  test('win32 uses a junction; other platforms use a dir symlink', () => {
    // Junction correctness is an explicit requirement but real junctions can
    // only be created on Windows. Assert the platform→fs.symlinkSync type
    // mapping directly so the win32 branch is covered on any host.
    assert.equal(dirLinkType('win32'), 'junction', 'win32 must use a junction');
    assert.equal(dirLinkType('linux'), 'dir', 'POSIX must use a dir symlink');
    assert.equal(dirLinkType('darwin'), 'dir', 'POSIX must use a dir symlink');
  });

  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-997-'));
  });
  afterEach(() => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- per-test temp cleanup, swallows ENOENT
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Build a fake plugin layout: <tmp>/plugin/gsd-core/<subdir>/marker.md and a
  // separate fake home <tmp>/home with an (initially absent) .claude dir.
  function makePluginLayout(subdirs = MANAGED_SUBDIRS) {
    const pluginRoot = path.join(tmp, 'plugin');
    const bundled = path.join(pluginRoot, 'gsd-core');
    for (const sub of subdirs) {
      fs.mkdirSync(path.join(bundled, sub), { recursive: true });
      fs.writeFileSync(path.join(bundled, sub, 'marker.md'), `bundled ${sub}`);
    }
    const homeDir = path.join(tmp, 'home');
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    return { pluginRoot, homeDir, bundled };
  }

  test('plugin layout: creates ~/.claude/gsd-core with all subdirs symlinked to the bundle', () => {
    const { pluginRoot, homeDir, bundled } = makePluginLayout();
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });

    assert.equal(result.status, 'ensured', `expected ensured; got ${JSON.stringify(result)}`);
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    assert.ok(fs.existsSync(canonical), 'canonical dir must exist');

    for (const sub of MANAGED_SUBDIRS) {
      const linkPath = path.join(canonical, sub);
      const st = fs.lstatSync(linkPath);
      assert.ok(st.isSymbolicLink(), `${sub} must be a symlink`);
      assert.equal(
        fs.realpathSync(linkPath),
        fs.realpathSync(path.join(bundled, sub)),
        `${sub} link must resolve to the bundled subdir`
      );
      // The @-include target now resolves to real bundled content.
      assert.equal(
        fs.readFileSync(path.join(linkPath, 'marker.md'), 'utf-8'),
        `bundled ${sub}`,
        `@-include into ${sub} must resolve to bundled content (this is the #997 fix)`
      );
    }
    assert.deepEqual(result.linked.sort(), [...MANAGED_SUBDIRS].sort());
  });

  test('idempotent: a second run with the same layout re-affirms links and changes nothing', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    const second = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(second.status, 'ensured');
    assert.deepEqual(second.linked.sort(), [...MANAGED_SUBDIRS].sort());
    assert.deepEqual(second.prunedStale, []);
    assert.deepEqual(second.preserved, []);
  });

  test('classic install: real bundled subdirs at canonical path → no-op (never touched)', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    // Simulate a classic bin/install.js layout: canonical dir is a REAL dir with
    // REAL subdirs (not symlinks).
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    for (const sub of MANAGED_SUBDIRS) {
      fs.mkdirSync(path.join(canonical, sub), { recursive: true });
      fs.writeFileSync(path.join(canonical, sub, 'real.md'), `classic ${sub}`);
    }
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'noop');
    assert.equal(result.reason, 'classic-install');
    for (const sub of MANAGED_SUBDIRS) {
      const st = fs.lstatSync(path.join(canonical, sub));
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${sub} must stay a real dir`);
    }
  });

  test('no plugin context: CLAUDE_PLUGIN_ROOT unset → no-op (classic/npm install path)', () => {
    const { homeDir } = makePluginLayout();
    const result = ensureCanonicalPath({ pluginRoot: undefined, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'noop');
    assert.equal(result.reason, 'no-plugin-bundle');
    assert.ok(!fs.existsSync(path.join(homeDir, '.claude', 'gsd-core')), 'must not create canonical dir');
  });

  test('boundary: bundled gsd-core dir missing under plugin root → no-op', () => {
    const pluginRoot = path.join(tmp, 'plugin-empty');
    fs.mkdirSync(pluginRoot, { recursive: true }); // no gsd-core/ inside
    const homeDir = path.join(tmp, 'home');
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'noop');
    assert.equal(result.reason, 'no-plugin-bundle');
  });

  test('preserve: a real user file at a managed link target is never clobbered', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    fs.mkdirSync(canonical, { recursive: true });
    // User (or partial state) put a REAL directory at 'references' with content.
    fs.mkdirSync(path.join(canonical, 'references'), { recursive: true });
    fs.writeFileSync(path.join(canonical, 'references', 'USER-NOTES.md'), 'precious');
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    // 'references' is a real dir → classic detection kicks in and the whole op
    // is a no-op, preserving everything. Either way, the user file survives.
    assert.ok(
      fs.existsSync(path.join(canonical, 'references', 'USER-NOTES.md')),
      'user file under a managed target must survive'
    );
    assert.equal(
      fs.readFileSync(path.join(canonical, 'references', 'USER-NOTES.md'), 'utf-8'),
      'precious'
    );
    void result;
  });

  test('preserve user-generated top-level file (USER-PROFILE.md) while linking subdirs', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    fs.mkdirSync(canonical, { recursive: true });
    // A user-generated file at the TOP of the canonical dir (not a managed
    // subdir) — must never be removed. No managed subdir is real yet, so the
    // hook proceeds to link them.
    fs.writeFileSync(path.join(canonical, 'USER-PROFILE.md'), 'my profile');
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'ensured');
    assert.ok(
      fs.existsSync(path.join(canonical, 'USER-PROFILE.md')),
      'USER-PROFILE.md must survive canonical-path setup'
    );
    assert.equal(fs.readFileSync(path.join(canonical, 'USER-PROFILE.md'), 'utf-8'), 'my profile');
    // And subdirs are still linked.
    for (const sub of MANAGED_SUBDIRS) {
      assert.ok(fs.lstatSync(path.join(canonical, sub)).isSymbolicLink(), `${sub} linked`);
    }
  });

  test('self-heal: a stale symlink (pointing at a removed prior plugin version) is pruned and recreated', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    fs.mkdirSync(canonical, { recursive: true });
    // Simulate a stale link left by a previous plugin version that has since
    // been removed (claude plugin update rotated the version dir).
    const stalePrior = path.join(tmp, 'plugin-OLD', 'gsd-core', 'references');
    fs.mkdirSync(stalePrior, { recursive: true });
    const linkPath = path.join(canonical, 'references');
    fs.symlinkSync(stalePrior, linkPath, 'dir');
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- simulate removed prior version
    fs.rmSync(path.join(tmp, 'plugin-OLD'), { recursive: true, force: true });
    assert.ok(!fs.existsSync(linkPath), 'precondition: link now dangles (target removed)');

    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'ensured');
    assert.ok(result.prunedStale.includes('references'), 'stale references link must be pruned');
    // Now resolves to the CURRENT bundle.
    assert.equal(
      fs.realpathSync(linkPath),
      fs.realpathSync(path.join(pluginRoot, 'gsd-core', 'references')),
      'references must now point at the current bundled tree'
    );
  });

  test('self-heal: a managed symlink pointing at the wrong (but existing) target is repointed', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    fs.mkdirSync(canonical, { recursive: true });
    // A link to some OTHER real directory (e.g. a different plugin version still
    // on disk). It is a valid link but points at the wrong place.
    const otherDir = path.join(tmp, 'plugin-OTHER', 'gsd-core', 'workflows');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.symlinkSync(otherDir, path.join(canonical, 'workflows'), 'dir');
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'ensured');
    assert.equal(
      fs.realpathSync(path.join(canonical, 'workflows')),
      fs.realpathSync(path.join(pluginRoot, 'gsd-core', 'workflows')),
      'workflows must be repointed to the current bundle'
    );
  });

  test('security: bundled gsd-core that symlinks OUTSIDE the plugin root is rejected', () => {
    const pluginRoot = path.join(tmp, 'plugin-evil');
    fs.mkdirSync(pluginRoot, { recursive: true });
    // Attacker places a symlink at <pluginRoot>/gsd-core pointing outside root.
    const outside = path.join(tmp, 'OUTSIDE');
    fs.mkdirSync(path.join(outside, 'references'), { recursive: true });
    fs.symlinkSync(outside, path.join(pluginRoot, 'gsd-core'), 'dir');
    const homeDir = path.join(tmp, 'home');
    fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'noop', 'a bundled tree resolving outside the plugin root must be rejected');
    assert.equal(result.reason, 'no-plugin-bundle');
    assert.ok(
      !fs.existsSync(path.join(homeDir, '.claude', 'gsd-core', 'references')),
      'must NOT link the canonical path at content outside the plugin root'
    );
  });

  test('CLAUDE_CONFIG_DIR honoured: canonical path is created under the custom config dir', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const customCfg = path.join(tmp, 'custom-cfg');
    fs.mkdirSync(customCfg, { recursive: true });
    const result = ensureCanonicalPath({
      pluginRoot, homeDir, platform: 'linux',
      env: { CLAUDE_CONFIG_DIR: customCfg },
    });
    assert.equal(result.status, 'ensured');
    assert.equal(result.canonicalDir, path.join(customCfg, 'gsd-core'));
    assert.ok(fs.lstatSync(path.join(customCfg, 'gsd-core', 'references')).isSymbolicLink());
  });

  test('canonical path is itself a symlink → no-op (never writes links through a user-pointed symlink)', () => {
    // A user pointed ~/.claude/gsd-core at some other directory via a symlink.
    // The hook must NOT create managed links through it into a dir it does not
    // own — it bails as a no-op.
    const { pluginRoot, homeDir } = makePluginLayout();
    const userTarget = path.join(tmp, 'user-gsd');
    fs.mkdirSync(userTarget, { recursive: true });
    const canonical = path.join(homeDir, '.claude', 'gsd-core');
    fs.symlinkSync(userTarget, canonical, 'dir');

    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'noop');
    assert.equal(result.reason, 'canonical-is-symlink');
    // No managed links were written into the user's target directory.
    for (const sub of MANAGED_SUBDIRS) {
      assert.ok(
        !fs.existsSync(path.join(userTarget, sub)),
        `must not write ${sub} link through the user symlink`
      );
    }
  });

  test('uniform result contract: every status carries the four action arrays', () => {
    const { pluginRoot, homeDir } = makePluginLayout();
    const noop = ensureCanonicalPath({ pluginRoot: undefined, homeDir, platform: 'linux', env: {} });
    for (const k of ['linked', 'prunedStale', 'preserved', 'skipped']) {
      assert.ok(Array.isArray(noop[k]), `noop result.${k} must be an array, not undefined`);
    }
    const ensured = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    for (const k of ['linked', 'prunedStale', 'preserved', 'skipped']) {
      assert.ok(Array.isArray(ensured[k]), `ensured result.${k} must be an array`);
    }
  });

  test('security: a bundled subdir that symlinks OUTSIDE the bundle is skipped, not linked', () => {
    // Defence-in-depth: even within a (validated) plugin root, a tampered
    // bundle that ships <bundle>/references as a symlink escaping the bundle
    // must NOT be exposed at the canonical path.
    const { pluginRoot, homeDir, bundled } = makePluginLayout(['workflows']);
    // Plant an escaping symlink at <bundle>/references → outside the bundle.
    const outside = path.join(tmp, 'OUTSIDE-references');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'evil.md'), 'evil');
    fs.symlinkSync(outside, path.join(bundled, 'references'), 'dir');

    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'ensured');
    assert.ok(result.linked.includes('workflows'), 'legit subdir still linked');
    assert.ok(result.skipped.includes('references'), 'escaping subdir must be skipped');
    assert.ok(
      !fs.existsSync(path.join(homeDir, '.claude', 'gsd-core', 'references')),
      'canonical path must NOT expose the escaping subdir'
    );
  });

  test('partial bundle: only ships some subdirs → links those, skips absent ones', () => {
    const { pluginRoot, homeDir } = makePluginLayout(['references', 'workflows']);
    const result = ensureCanonicalPath({ pluginRoot, homeDir, platform: 'linux', env: {} });
    assert.equal(result.status, 'ensured');
    assert.deepEqual(result.linked.sort(), ['references', 'workflows']);
    assert.deepEqual(
      result.skipped.sort(),
      ['bin', 'contexts', 'templates'].sort(),
      'subdirs not present in the bundle must be skipped, not errored'
    );
  });
});

// ─── Section H: skills surface projection (#1596 — Phase B-provide) ──────────
//
// ADR-766 originally projected commands + hooks but NOT skills. Phase B-provide
// (#1596) adds a build-generated `skills/` dir + a `skills` manifest field so
// plugin-installed GSD exposes `gsd-core:<skill>` the native Claude Code way.
// The skills are generated from `commands/gsd/*.md` by
// `scripts/gen-plugin-skills.cjs` using `convertClaudeCommandToClaudeSkill`.
describe('H: skills surface projection (#1596)', () => {
  const SKILLS_DIR = path.resolve(ROOT, 'skills');

  test('plugin.json declares skills: "./skills/"', () => {
    const manifest = JSON.parse(fs.readFileSync(PLUGIN_JSON_PATH, 'utf-8'));
    assert.equal(
      manifest.skills, './skills/',
      'plugin.json must declare "skills": "./skills/" so Claude Code discovers plugin skills (#1596)'
    );
  });

  test('skills/ dir exists with at least one gsd-*/SKILL.md', () => {
    assert.ok(fs.existsSync(SKILLS_DIR), `skills/ dir must exist (run: npm run gen:plugin-skills -- --write): ${SKILLS_DIR}`);
    const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
    const skillDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillDirs.length > 0, 'skills/ must contain at least one gsd-*/ directory');
    // Each must have a SKILL.md
    for (const dir of skillDirs) {
      const skillMd = path.join(SKILLS_DIR, dir.name, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `${dir.name}/SKILL.md must exist`);
    }
  });

  test('every generated SKILL.md has name: and description: frontmatter', () => {
    assert.ok(fs.existsSync(SKILLS_DIR), 'skills/ must exist');
    const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillDirs.length > 0, 'must have at least one skill dir');
    for (const dir of skillDirs) {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, dir.name, 'SKILL.md'), 'utf-8');
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own generated SKILL.md frontmatter, fixed-size author-controlled content
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, `${dir.name}/SKILL.md must have frontmatter`);
      const fm = fmMatch[1];
      assert.ok(/^\s*name:\s*\S/m.test(fm), `${dir.name}/SKILL.md frontmatter must have a name: field`);
      assert.ok(/^\s*description:\s*\S/m.test(fm), `${dir.name}/SKILL.md frontmatter must have a description: field`);
    }
  });

  test('parity: one skill dir per command file (DEFECT.GENERATIVE-FIX)', () => {
    const commandsDir = path.resolve(ROOT, 'commands', 'gsd');
    const commandFiles = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md'));
    const skillDirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.equal(
      skillDirs.length, commandFiles.length,
      `skills/gsd-*/ count (${skillDirs.length}) must equal commands/gsd/*.md count (${commandFiles.length}). ` +
      `Run: npm run gen:plugin-skills -- --write`
    );
  });
});
