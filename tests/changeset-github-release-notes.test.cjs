'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const helpers = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'changeset', 'cli.cjs');
const {
  loadFragmentsFromRange,
  buildGithubReleaseNotesIr,
  serializeGithubReleaseNotes,
  renderGithubReleaseNotes,
} = require(path.join(ROOT, 'scripts', 'changeset', 'github-release-notes.cjs'));

// Every call site in this file runs `git` — this helper is git-only
// (gitOrThrow), which preserves its original throw-on-failure semantics (it
// used to assert.equal(status, 0)). The generic `command` parameter this
// used to carry was dropped (#3147 pre-PR review finding): every call site
// passed the literal 'git' and immediately asserted it, so the parameter
// carried no information.
function run(args, cwd, env) {
  return gitOrThrow(args, { cwd, env: env || process.env });
}

function writeFragment(repo, name, type, pr, body) {
  const dir = path.join(repo, '.changeset');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\ntype: ${type}\npr: ${pr}\n---\n${body}\n`);
}

function createTaggedRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-release-notes-'));
  // Isolate from the developer's global/system git config (e.g. gpgSign settings)
  // by pointing GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at an empty file inside
  // the temp dir. This prevents tag.gpgSign / commit.gpgSign / tag.forceSignAnnotated
  // from leaking in and breaking lightweight tags or unsigned commits.
  const emptyGitConfig = path.join(repo, '.git-config-empty');
  fs.writeFileSync(emptyGitConfig, '');
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
  };
  run(['init', '-q'], repo, gitEnv);
  // Belt-and-suspenders: also set local repo config to disable signing
  run(['config', 'user.email', 'test@example.com'], repo, gitEnv);
  run(['config', 'user.name', 'Test User'], repo, gitEnv);
  run(['config', 'commit.gpgSign', 'false'], repo, gitEnv);
  run(['config', 'tag.gpgSign', 'false'], repo, gitEnv);
  run(['config', 'tag.forceSignAnnotated', 'false'], repo, gitEnv);
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n');
  run(['add', 'README.md'], repo, gitEnv);
  run(['commit', '-q', '-m', 'initial'], repo, gitEnv);
  run(['tag', 'v1.0.0'], repo, gitEnv);

  writeFragment(repo, 'fix-install-sdk', 'Fixed', 101, '**`gsd-sdk` now installs reliably** — persistent PATH is checked.');
  writeFragment(repo, 'remove-intel-noise', 'Removed', 102, '**`gsd-intel-updater` no longer emits layout detection noise** — ordinary projects stay quiet.');
  run(['add', '.changeset'], repo, gitEnv);
  run(['commit', '-q', '-m', 'add changesets'], repo, gitEnv);
  run(['tag', 'v1.0.1'], repo, gitEnv);
  return repo;
}

describe('changeset github release notes: tag-range renderer (#3382)', () => {
  let _repo;
  afterEach(() => { helpers.cleanup(_repo); _repo = undefined; });

  test('loads changed changeset slugs from a git tag range', () => {
    const repo = (_repo = createTaggedRepo());
    const result = loadFragmentsFromRange({ repo, fromRef: 'v1.0.0', toRef: 'v1.0.1' });

    assert.deepEqual(result.failures, []);
    assert.deepEqual(
      result.fragments.map((fragment) => ({ slug: fragment.slug, type: fragment.type, pr: fragment.pr })),
      [
        { slug: 'fix-install-sdk', type: 'Fixed', pr: 101 },
        { slug: 'remove-intel-noise', type: 'Removed', pr: 102 },
      ],
    );
  });

  test('builds grouped GitHub release-note IR from parsed fragments', () => {
    const repo = (_repo = createTaggedRepo());
    const { fragments } = loadFragmentsFromRange({ repo, fromRef: 'v1.0.0', toRef: 'v1.0.1' });
    const ir = buildGithubReleaseNotesIr({ fragments });

    assert.deepEqual(
      ir.sections.map((section) => ({
        type: section.type,
        groups: section.groups.map((group) => ({ title: group.title, prs: group.bullets.map((b) => b.pr) })),
      })),
      [
        { type: 'Fixed', groups: [{ title: 'Install & runtime conversion', prs: [101] }] },
        { type: 'Removed', groups: [{ title: 'Intel updater', prs: [102] }] },
      ],
    );
  });

  test('CLI writes a notes file suitable for gh release edit --notes-file', () => {
    const repo = (_repo = createTaggedRepo());
    const output = path.join(repo, 'release-notes.md');
    const result = runNode(
      [
        SCRIPT,
        'github-release-notes',
        '--repo', repo,
        '--from', 'v1.0.0',
        '--to', 'v1.0.1',
        '--repo-slug', 'example/project',
        '--output', output,
        '--json',
      ],
      { timeoutMs: PROBE_TIMEOUT_MS },
    );

    assert.equal(result.exitCode, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      { consumed: report.consumed, output: report.output, hasBodyInJson: report.body !== null },
      { consumed: 2, output, hasBodyInJson: false },
    );

    const generated = renderGithubReleaseNotes({
      repo,
      fromRef: 'v1.0.0',
      toRef: 'v1.0.1',
      repoSlug: 'example/project',
      installCommand: 'npx @opengsd/gsd-core@latest',
    });
    assert.equal(fs.readFileSync(output, 'utf8'), generated.body);
  });

  test('rejects unsafe git refs before rendering a range', () => {
    const repo = (_repo = createTaggedRepo());
    assert.throws(
      () => loadFragmentsFromRange({ repo, fromRef: '--help', toRef: 'v1.0.1' }),
      /Invalid git ref/,
    );
  });

  test('validates PR metadata and repo slug before serializing release notes', () => {
    assert.throws(
      () => serializeGithubReleaseNotes({
        ir: {
          sections: [
            {
              type: 'Fixed',
              groups: [{ title: 'Other fixes', bullets: [{ slug: 'missing-pr', body: 'missing pr' }] }],
            },
          ],
        },
        fromRef: 'v1.0.0',
        toRef: 'v1.0.1',
      }),
      /missing valid pr field/,
    );

    assert.throws(
      () => serializeGithubReleaseNotes({
        ir: { sections: [] },
        fromRef: 'v1.0.0',
        toRef: 'v1.0.1',
        repoSlug: 'owner/repo/extra',
      }),
      /Invalid repoSlug format/,
    );

    assert.throws(
      () => serializeGithubReleaseNotes({
        ir: { sections: [] },
        fromRef: 'v1.0.0',
        toRef: 'v1.0.1',
        installCommand: 'echo `bad`',
      }),
      /installCommand cannot contain backtick/,
    );
  });
});
