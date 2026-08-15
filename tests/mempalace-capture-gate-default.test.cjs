// allow-test-rule: source-text-is-the-product (see #2641)
// The mempalace-capture skill gates on config.mempalace.capture_artifacts.
// The capability registry declares this key with default: true, so an absent
// key must be treated as enabled. The skill previously used `!== true` which
// treated absent (undefined) as disabled — inverted from the schema default.
// The fix changes it to `=== false` (disabled only on explicit false).

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = path.join(__dirname, '..', 'skills', 'gsd-mempalace-capture', 'SKILL.md');
const COMMAND = path.join(__dirname, '..', 'commands', 'gsd', 'mempalace-capture.md');

describe('#2641 — mempalace-capture gate treats absent capture_artifacts as enabled', () => {
  test('SKILL.md uses === false (disabled only on explicit false), not !== true', () => {
    const text = fs.readFileSync(SKILL, 'utf8');
    assert.ok(
      text.includes('capture_artifacts === false'),
      'SKILL.md must use capture_artifacts === false (defaults to enabled when absent, matching the schema) — not !== true (#2641)',
    );
    assert.ok(
      !text.includes('capture_artifacts !== true'),
      'SKILL.md must NOT use the inverted capture_artifacts !== true check (#2641)',
    );
  });

  test('commands/gsd/mempalace-capture.md uses === false, not !== true', () => {
    const text = fs.readFileSync(COMMAND, 'utf8');
    assert.ok(
      text.includes('capture_artifacts === false'),
      'commands/gsd/mempalace-capture.md must use capture_artifacts === false (#2641)',
    );
    assert.ok(
      !text.includes('capture_artifacts !== true'),
      'commands/gsd/mempalace-capture.md must NOT use the inverted check (#2641)',
    );
  });
});

// #3479 — the #2982/#2641 fix was applied to the capture_artifacts gate but not
// to the sibling gates on other mempalace sub-toggles whose registry-declared
// default is `true`. A positive-presence gate ("when `X` is true") treats an
// absent key as disabled — inverted from the registry default. Every gate on a
// default-true key must treat absent as enabled (disabled only on an explicit
// false); every gate on a default-false key must keep requiring positive
// presence. The hand-maintained commands/gsd/*.md mirrors must stay in lockstep
// with their skills/*/SKILL.md originals.

const RECALL_SKILL = path.join(__dirname, '..', 'skills', 'gsd-mempalace-recall', 'SKILL.md');
const RECALL_COMMAND = path.join(__dirname, '..', 'commands', 'gsd', 'mempalace-recall.md');
const CURATOR = path.join(__dirname, '..', 'agents', 'gsd-mempalace-curator.md');
const REGISTRY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');

/** Deep-search the mempalace capability for the flat settings schema keyed `mempalace.<key>`. */
function mempalaceSettings() {
  const { capabilities } = require(REGISTRY_PATH);
  const stack = [capabilities.mempalace];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(node, 'mempalace.mirror_kg')) return node;
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return null;
}

/** Boolean mempalace.<key> settings partitioned by their registry-declared default. */
function mempalaceBooleansByDefault() {
  const settings = mempalaceSettings();
  assert.ok(settings, 'capability registry must expose a mempalace settings schema');
  const defaultTrue = [];
  const defaultFalse = [];
  for (const [key, spec] of Object.entries(settings)) {
    if (!key.startsWith('mempalace.') || spec.type !== 'boolean') continue;
    (spec.default === true ? defaultTrue : defaultFalse).push(key);
  }
  return { defaultTrue, defaultFalse };
}

describe('#3479 — gates on default-true mempalace keys treat an absent key as enabled', () => {
  test('capture SKILL.md mirror_kg gate is disabled-only-on-explicit-false', () => {
    const text = fs.readFileSync(SKILL, 'utf8');
    assert.ok(
      text.includes('config.mempalace.mirror_kg === false'),
      'skills/gsd-mempalace-capture/SKILL.md step 3 must mirror KG facts unless config.mempalace.mirror_kg === false (#3479)',
    );
    assert.ok(
      !text.includes('config.mempalace.mirror_kg` is true'),
      'skills/gsd-mempalace-capture/SKILL.md must NOT gate mirror_kg on positive presence — absent means enabled per the registry default (#3479)',
    );
  });

  test('commands/gsd/mempalace-capture.md mirror_kg gate matches the skill', () => {
    const text = fs.readFileSync(COMMAND, 'utf8');
    assert.ok(
      text.includes('config.mempalace.mirror_kg === false'),
      'commands/gsd/mempalace-capture.md is a hand-maintained mirror of the skill — its mirror_kg gate needs the same fix (#3479)',
    );
    assert.ok(
      !text.includes('config.mempalace.mirror_kg` is true'),
      'commands/gsd/mempalace-capture.md must NOT gate mirror_kg on positive presence (#3479)',
    );
  });

  test('recall SKILL.md mirror_kg gate is disabled-only-on-explicit-false', () => {
    const text = fs.readFileSync(RECALL_SKILL, 'utf8');
    assert.ok(
      text.includes('config.mempalace.mirror_kg !== false'),
      'skills/gsd-mempalace-recall/SKILL.md KG-facts step must include mirror_kg unless !== false, matching its recall_on_plan gate style (#3479)',
    );
    assert.ok(
      !text.includes('config.mempalace.mirror_kg` is true'),
      'skills/gsd-mempalace-recall/SKILL.md must NOT gate mirror_kg on positive presence (#3479)',
    );
  });

  test('commands/gsd/mempalace-recall.md mirror_kg gate matches the skill', () => {
    const text = fs.readFileSync(RECALL_COMMAND, 'utf8');
    assert.ok(
      text.includes('config.mempalace.mirror_kg !== false'),
      'commands/gsd/mempalace-recall.md is a hand-maintained mirror of the skill — its mirror_kg gate needs the same fix (#3479)',
    );
    assert.ok(
      !text.includes('config.mempalace.mirror_kg` is true'),
      'commands/gsd/mempalace-recall.md must NOT gate mirror_kg on positive presence (#3479)',
    );
  });

  test('curator agent diary_journal and mirror_kg gates are disabled-only-on-explicit-false', () => {
    const text = fs.readFileSync(CURATOR, 'utf8');
    assert.ok(
      text.includes('mempalace.diary_journal !== false'),
      'agents/gsd-mempalace-curator.md diary gate must run unless mempalace.diary_journal !== false (#3479)',
    );
    assert.ok(
      text.includes('mempalace.mirror_kg !== false'),
      'agents/gsd-mempalace-curator.md KG-mirror gate must run unless mempalace.mirror_kg !== false (#3479)',
    );
    assert.ok(
      !text.includes('mempalace.diary_journal` is true'),
      'agents/gsd-mempalace-curator.md must NOT gate diary_journal on positive presence (#3479)',
    );
    assert.ok(
      !text.includes('mempalace.mirror_kg` is true'),
      'agents/gsd-mempalace-curator.md must NOT gate mirror_kg on positive presence (#3479)',
    );
  });
});

describe('#3479 — registry parity guard: no default-true mempalace key is positively gated', () => {
  test('every default-true mempalace boolean defaults to enabled in the registry', () => {
    // Lock the declared defaults the corrected gates depend on: if one of these
    // flips in the registry, the absence semantics of its prose gates must be
    // re-audited — fail here so that happens consciously.
    const { defaultTrue } = mempalaceBooleansByDefault();
    for (const key of ['mempalace.capture_artifacts', 'mempalace.mirror_kg', 'mempalace.diary_journal']) {
      assert.ok(defaultTrue.includes(key), `${key} must declare default: true in the capability registry`);
    }
  });

  test('no gate file uses positive presence for a default-true key', () => {
    const { defaultTrue } = mempalaceBooleansByDefault();
    const files = [SKILL, COMMAND, RECALL_SKILL, RECALL_COMMAND, CURATOR];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const key of defaultTrue) {
        for (const refix of ['config.' + key, key]) {
          assert.ok(
            !text.includes('`' + refix + '` is true'),
            `${path.relative(process.cwd(), file)} gates \`${key}\` on positive presence, but the registry declares default: true — absent must mean enabled (#3479)`,
          );
        }
      }
    }
  });

  test('default-false keys keep requiring positive presence (no over-correction)', () => {
    const { defaultFalse } = mempalaceBooleansByDefault();
    assert.ok(
      defaultFalse.includes('mempalace.enabled'),
      'mempalace.enabled must stay default: false — the master switch is opt-in',
    );
    const capture = fs.readFileSync(SKILL, 'utf8');
    const curator = fs.readFileSync(CURATOR, 'utf8');
    assert.ok(
      capture.includes('config.mempalace.enabled !== true'),
      'capture master gate must keep treating an absent mempalace.enabled as disabled (#3479)',
    );
    assert.ok(
      curator.includes('mempalace.enabled !== true'),
      'curator master gate must keep treating an absent mempalace.enabled as disabled (#3479)',
    );
    assert.ok(
      curator.includes('mempalace.cross_project_tunnels` is true'),
      'cross_project_tunnels (default: false) must keep its positive-presence gate — do not over-correct (#3479)',
    );
  });
});
