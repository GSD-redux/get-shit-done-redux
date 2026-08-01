'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'gen-registry.cjs');
const { renderMarkdown } = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

// gen-registry.cjs resolves docs/registries/ from process.cwd() (mirrors
// validate-registry.cjs), so tests drive it as a subprocess with `cwd`
// pointed at an isolated temp fixture directory.

function validCapabilityEntry() {
  return {
    id: 'my-capability',
    name: 'My Capability',
    type: 'capability',
    repo: 'octocat/my-capability',
    description: 'Does a useful thing for GSD users.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-capability.git#v1.0.0',
    uninstall: 'gsd capability remove my-capability',
    interactions: {
      loopExtensionPoints: ['execute:pre'],
      hookKinds: ['step'],
      configKeys: [],
      requires: [],
      runtimeCompat: ['all'],
      produces: [],
      consumes: [],
    },
    discussion: 'https://github.com/octocat/my-capability/discussions/1',
  };
}

function validEosEntry() {
  return {
    id: 'my-host-plugin',
    name: 'My Host Plugin',
    type: 'eos',
    repo: 'octocat/my-host-plugin',
    description: 'Embeds GSD as an orchestration engine in My Host.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'See the My Host plugin marketplace listing.',
    uninstall: 'Uninstall via the My Host plugin manager.',
    protocolVersion: 1,
    interactions: {
      interfacePoints: ['command', 'state'],
      profile: 'programmatic-cli',
      axes: {
        embeddingMode: 'imperative',
        commandSurface: 'slash-file',
        dispatch: 'Supports nested background dispatch up to depth 3.',
        modelMode: 'active',
        hookBus: 'host',
        stateIO: 'filesystem',
        transport: 'mcp',
        runtime: 'node',
      },
    },
    discussion: 'https://github.com/octocat/my-host-plugin/discussions/2',
  };
}

function validReviewerEntry() {
  return {
    id: 'my-reviewer',
    name: 'My Reviewer',
    type: 'reviewer',
    repo: 'octocat/my-reviewer',
    description: 'Reviews GSD PRs for a specific concern.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-reviewer.git#v1.0.0',
    uninstall: 'gsd capability remove my-reviewer',
    interactions: {
      slug: 'my-reviewer',
      flags: ['--my-reviewer'],
      transport: 'spawn',
      evidenceClass: 'source-grounded',
      reviewsSection: 'My Reviewer',
      requiresBinaries: [],
      configKeys: [],
      runtimeCompat: ['all'],
    },
    discussion: 'https://github.com/octocat/my-reviewer/discussions/1',
  };
}

function withFixture(entries, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(entries, null, 2) + '\n');
    fn(tmp, registriesDir);
  } finally {
    cleanup(tmp);
  }
}

// Same as withFixture, but also writes docs/registries/reviewers.json — used
// by the reviewer-catalog cases below (#2904), which need capabilities.json
// AND reviewers.json present simultaneously.
function withReviewerFixture(capabilityEntries, reviewerEntries, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-reviewer-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(capabilityEntries, null, 2) + '\n');
    fs.writeFileSync(path.join(registriesDir, 'reviewers.json'), JSON.stringify(reviewerEntries, null, 2) + '\n');
    fn(tmp, registriesDir);
  } finally {
    cleanup(tmp);
  }
}

function runGen(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8' });
}

describe('gen-registry CLI (subprocess)', () => {
  test('--write then --check is clean (no drift) for a populated registry', () => {
    withFixture([validCapabilityEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);
      assert.ok(fs.existsSync(path.join(registriesDir, 'capability-registry.md')));

      const check = runGen(tmp, ['--check']);
      assert.equal(check.status, 0, `stderr: ${check.stderr}`);
    });
  });

  test('hand-mutating the generated md then --check fails (drift detected)', () => {
    withFixture([validCapabilityEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'capability-registry.md');
      fs.appendFileSync(mdPath, '\nhand-edited drift line\n');

      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0);
    });
  });

  test('--write on an empty registry ([]) produces md containing the empty-state text', () => {
    withFixture([], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'capability-registry.md');
      const content = fs.readFileSync(mdPath, 'utf8');
      assert.match(content, /No entries yet/);
    });
  });

  test('default (no flag) prints rendered markdown to stdout', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runGen(tmp, []);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      assert.ok(result.stdout.length > 0);
    });
  });
});

describe('gen-registry CLI (subprocess): F3 — missing capabilities.json is an error, not a silent pass', () => {
  test('--check exits non-zero when docs/registries/ exists but capabilities.json is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-nocaps-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      // Deliberately do NOT write capabilities.json — only eos.json is optional.
      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0, `expected non-zero exit, got 0. stdout: ${check.stdout}`);
      assert.match(check.stderr, /capabilities\.json/);
    } finally {
      cleanup(tmp);
    }
  });

  test('default mode (no flag) also hard-errors when capabilities.json is absent', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-nocaps-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      const result = runGen(tmp, []);
      assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout: ${result.stdout}`);
      assert.match(result.stderr, /capabilities\.json/);
    } finally {
      cleanup(tmp);
    }
  });
});

describe('gen-registry: renderMarkdown (direct, via registry-schema)', () => {
  test('renders empty-state text for an empty capability registry', () => {
    const rendered = renderMarkdown([], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /No entries yet/);
  });

  test('renders the shields.io badge + discussion link for a populated capability registry', () => {
    const entry = validCapabilityEntry();
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /img\.shields\.io\/github\/v\/release/);
    assert.ok(rendered.includes(entry.discussion));
  });
});

// ─── gen-registry CLI (subprocess): reviewer catalog (#2904) ───────────────
//
// scripts/gen-registry.cjs's SOURCES array does not yet include the reviewer
// { type:'reviewer', jsonFile:'reviewers.json', mdFile:'reviewer-registry.md',
// optional:true } entry — every case below is FAILING-FIRST against the
// unmodified script. See
// .gsd/phase/feat-2904-enh-registries-add-a-reviewer-entry-type/50-test-matrix.md.

describe('gen-registry CLI (subprocess): reviewer catalog', () => {
  test('--write emits all three catalogs when all sources exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-all3-'));
    try {
      const registriesDir = path.join(tmp, 'docs', 'registries');
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify([validCapabilityEntry()], null, 2) + '\n');
      fs.writeFileSync(path.join(registriesDir, 'eos.json'), JSON.stringify([validEosEntry()], null, 2) + '\n');
      fs.writeFileSync(path.join(registriesDir, 'reviewers.json'), JSON.stringify([validReviewerEntry()], null, 2) + '\n');

      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);
      assert.ok(fs.existsSync(path.join(registriesDir, 'capability-registry.md')));
      assert.ok(fs.existsSync(path.join(registriesDir, 'eos-registry.md')));
      assert.ok(
        fs.existsSync(path.join(registriesDir, 'reviewer-registry.md')),
        'expected reviewer-registry.md to be written',
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('an absent reviewers.json is skipped, not an error', () => {
    withFixture([validCapabilityEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);
      assert.ok(fs.existsSync(path.join(registriesDir, 'capability-registry.md')));
      assert.ok(
        !fs.existsSync(path.join(registriesDir, 'reviewer-registry.md')),
        'expected no reviewer-registry.md when reviewers.json is absent',
      );
    });
  });

  test('--check fails when the reviewer catalog is missing', () => {
    withReviewerFixture([validCapabilityEntry()], [validReviewerEntry()], (tmp, registriesDir) => {
      // Write only the capability md by hand (simulating a repo that has
      // reviewers.json committed but never ran --write for it).
      fs.writeFileSync(
        path.join(registriesDir, 'capability-registry.md'),
        renderMarkdown([validCapabilityEntry()], { type: 'capability', sourceFile: 'capabilities.json' }),
      );
      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0, `expected non-zero exit, got 0. stdout: ${check.stdout}`);
      assert.match(check.stderr, /reviewer-registry\.md does not exist/);
    });
  });

  test('--check fails on reviewer catalog drift', () => {
    withReviewerFixture([validCapabilityEntry()], [validReviewerEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'reviewer-registry.md');
      fs.appendFileSync(mdPath, '\nhand-edited drift line\n');

      const check = runGen(tmp, ['--check']);
      assert.notEqual(check.status, 0);
      assert.match(check.stderr, /reviewer-registry\.md is stale/);
    });
  });

  test('--check passes on a fresh reviewer catalog', () => {
    withReviewerFixture([validCapabilityEntry()], [validReviewerEntry()], (tmp) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const check = runGen(tmp, ['--check']);
      assert.equal(check.status, 0, `stderr: ${check.stderr}`);
    });
  });

  test('CRLF in the committed reviewer catalog is not drift', () => {
    withReviewerFixture([validCapabilityEntry()], [validReviewerEntry()], (tmp, registriesDir) => {
      const write = runGen(tmp, ['--write']);
      assert.equal(write.status, 0, `stderr: ${write.stderr}`);

      const mdPath = path.join(registriesDir, 'reviewer-registry.md');
      const original = fs.readFileSync(mdPath, 'utf8');
      // Normalize via \r?\n so the conversion is idempotent, ensuring the fixture is exactly
      // the CRLF variant even on a checkout that already delivered CRLF line endings.
      fs.writeFileSync(mdPath, original.replace(/\r?\n/g, '\r\n'));

      const check = runGen(tmp, ['--check']);
      assert.equal(check.status, 0, `expected CRLF-only diff to not be drift. stderr: ${check.stderr}`);
    });
  });

  test('malformed reviewers.json fails cleanly', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-gen-registry-badjson-'));
    try {
      const registriesDir = path.join(tmp, 'docs', 'registries');
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify([validCapabilityEntry()], null, 2) + '\n');
      fs.writeFileSync(path.join(registriesDir, 'reviewers.json'), '{ this is not valid JSON');

      const result = runGen(tmp, ['--write']);
      assert.notEqual(result.status, 0, `expected non-zero exit, got 0. stdout: ${result.stdout}`);
      assert.ok(
        !/at Object\.<anonymous>/.test(result.stderr) && !/\.js:\d+:\d+/.test(result.stderr),
        `expected no raw Node stack trace leaked to stderr, got: ${result.stderr}`,
      );
    } finally {
      cleanup(tmp);
    }
  });
});
