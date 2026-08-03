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
const { cleanup } = require('./helpers.cjs');

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

  test('hooks field is "./hooks/hooks.json" and that file exists', (t) => {
    if (!manifest) { t.skip('manifest could not be parsed'); return; }
    assert.equal(manifest.hooks, './hooks/hooks.json', 'hooks must be "./hooks/hooks.json"');
    const resolvedHooks = path.resolve(path.dirname(PLUGIN_JSON_PATH), '..', manifest.hooks);
    assert.ok(fs.existsSync(resolvedHooks), `resolved hooks file must exist: ${resolvedHooks}`);
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
// replaces the skip-on-absent pattern with two tiers:
//
//   C1 (UNCONDITIONAL) — Validate plugin.json against a snapshotted JSON schema
//        fixture that captures the fields `--strict` requires.  Runs on every
//        platform, every CI job, every local run.  A bug that removes `version`
//        or changes `name` to an invalid form goes red immediately.
//
//   C2 (OPPORTUNISTIC) — When the `claude` binary IS on PATH, also run
//        `claude plugin validate <temp-plugin-root> --strict` as an end-to-end
//        smoke test. This tier provides defence-in-depth for schema changes
//        Claude Code may introduce that the fixture hasn't yet captured.
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
        const re = new RegExp(propDef.pattern);
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

  const claudeAvailable = (() => {
    try {
      const result = spawnSync('claude', ['--version'], { encoding: 'utf-8', timeout: 5000 });
      return result.status === 0;
    } catch (_) {
      return false;
    }
  })();

  test(
    'C2: claude plugin validate --strict exits 0 (opportunistic — skip when claude not on PATH)',
    { skip: !claudeAvailable ? 'claude binary not on PATH' : false },
    () => {
      const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-plugin-validate-'));
      try {
        fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
        fs.copyFileSync(PLUGIN_JSON_PATH, path.join(pluginRoot, '.claude-plugin', 'plugin.json'));
        fs.symlinkSync(path.join(ROOT, 'commands'), path.join(pluginRoot, 'commands'), 'dir');
        fs.symlinkSync(path.join(ROOT, 'hooks'), path.join(pluginRoot, 'hooks'), 'dir');
        fs.symlinkSync(path.join(ROOT, 'skills'), path.join(pluginRoot, 'skills'), 'dir');

        const result = spawnSync('claude', ['plugin', 'validate', pluginRoot, '--strict'], {
          cwd: ROOT,
          encoding: 'utf-8',
          timeout: 15000,
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
