'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { runMain, ExitError } = require('../lib/cli-exit.cjs');
const { classifyBucket } = require('./conventional-title.cjs');

/**
 * Classify a What's-Changed bullet line into 'Feature', 'Fix', 'Enhancement', or 'Internal'.
 * @param {string} bulletLine - Full bullet line including the leading `* ` or `- ` marker.
 * @returns {'Feature'|'Fix'|'Enhancement'|'Internal'}
 */
function classifyTitle(bulletLine) {
  // Strip leading `* ` or `- ` marker
  const withoutMarker = bulletLine.replace(/^[*-]\s+/, '');

  // Extract title = text before ` by @`
  const byIdx = withoutMarker.indexOf(' by @');
  const title = (byIdx !== -1 ? withoutMarker.slice(0, byIdx) : withoutMarker).trim();

  // Delegate to the shared matcher so the gate and the changelog can never
  // disagree on bucketing (#1549 — single source of truth).
  return classifyBucket(title);
}

/**
 * Reformat GitHub's auto-generated release notes into the repo's hand-curated format.
 *
 * @param {object} opts
 * @param {string} opts.generatedBody - The raw GitHub-generated release body.
 * @param {string} opts.version       - Version string (e.g. "1.3.0-rc.1"), no leading "v".
 * @param {boolean} opts.prerelease   - Whether this is a pre-release.
 * @param {string} opts.packageName   - npm package name (e.g. "@opengsd/gsd-core").
 * @returns {string} Formatted release body (no trailing newline).
 */
function formatReleaseNotes({ generatedBody, version, prerelease, packageName }) {
  const lines = generatedBody.split('\n');

  const featureBullets = [];
  const fixBullets = [];
  const enhancementBullets = [];
  const newContributorBullets = [];
  let fullChangelogLine = null;

  let inWhatsChanged = false;
  let inNewContributors = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headings
    if (trimmed === '## What\'s Changed') {
      inWhatsChanged = true;
      inNewContributors = false;
      continue;
    }

    if (trimmed === '## New Contributors') {
      inWhatsChanged = false;
      inNewContributors = true;
      continue;
    }

    // Full changelog line ends the What's Changed section
    if (trimmed.startsWith('**Full Changelog**:')) {
      inWhatsChanged = false;
      inNewContributors = false;
      fullChangelogLine = trimmed;
      continue;
    }

    // Any other `##` heading ends current section
    if (trimmed.startsWith('## ')) {
      inWhatsChanged = false;
      inNewContributors = false;
      continue;
    }

    // Collect bullets
    if (inWhatsChanged && (trimmed.startsWith('* ') || trimmed.startsWith('- '))) {
      const category = classifyTitle(trimmed);
      if (category === 'Feature') featureBullets.push(trimmed);
      else if (category === 'Fix') fixBullets.push(trimmed);
      else if (category === 'Internal') {
        // #2716: non-user-facing work (test/chore/ci/docs/refactor/perf/revert)
        // is omitted from the user-facing "What's Changed" section entirely.
        continue;
      } else enhancementBullets.push(trimmed);
      continue;
    }

    if (inNewContributors && (trimmed.startsWith('* ') || trimmed.startsWith('- '))) {
      newContributorBullets.push(trimmed);
      continue;
    }
  }

  // Build Install block
  let installBlock;
  if (prerelease) {
    installBlock = [
      '## Install',
      '',
      'This pre-release is published to npm under the `next` dist-tag.',
      '',
      '```bash',
      `npm i ${packageName}@${version}`,
      '# or',
      `npm i ${packageName}@next`,
      '```',
    ].join('\n');
  } else {
    installBlock = [
      '## Install',
      '',
      '```bash',
      `npm i ${packageName}@${version}`,
      '# or',
      `npm i ${packageName}@latest`,
      '```',
    ].join('\n');
  }

  // Assemble groups (omit empty ones)
  const groups = [];

  // Group A: Install
  groups.push(installBlock);

  // Group B: What's Changed heading
  groups.push('## What\'s Changed');

  // Group C: Features
  if (featureBullets.length > 0) {
    groups.push('### Feature\n' + featureBullets.join('\n'));
  }

  // Group D: Enhancements
  if (enhancementBullets.length > 0) {
    groups.push('### Enhancement\n' + enhancementBullets.join('\n'));
  }

  // Group E: Fixes
  if (fixBullets.length > 0) {
    groups.push('### Fix\n' + fixBullets.join('\n'));
  }

  // Group F: New Contributors
  if (newContributorBullets.length > 0) {
    groups.push('## New Contributors\n' + newContributorBullets.join('\n'));
  }

  // Group G: Full Changelog
  if (fullChangelogLine) {
    groups.push(fullChangelogLine);
  }

  return groups.join('\n\n');
}

// CLI entry point
function main() {
  try {
    const argv = process.argv.slice(2);

    let tag = null;
    let repo = null;
    let packageName = null;
    let prerelease = null;
    let useStdin = false;
    let doApply = false;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--tag') {
        tag = argv[++i];
      } else if (arg === '--repo') {
        repo = argv[++i];
      } else if (arg === '--package') {
        packageName = argv[++i];
      } else if (arg === '--prerelease') {
        prerelease = true;
      } else if (arg === '--latest') {
        prerelease = false;
      } else if (arg === '--stdin') {
        useStdin = true;
      } else if (arg === '--apply') {
        doApply = true;
      }
    }

    // Derive version from tag
    const version = tag ? tag.replace(/^v/, '') : null;

    // Resolve package name if not provided
    if (!packageName) {
      const repoRoot = path.resolve(__dirname, '..', '..');
      const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
      packageName = pkgJson.name;
    }

    let generatedBody;

    if (useStdin) {
      // Read from stdin
      if (!version) {
        throw new Error('--stdin mode requires --tag or --version to derive version');
      }
      if (prerelease === null) {
        throw new Error('--stdin mode requires --prerelease or --latest');
      }
      generatedBody = fs.readFileSync('/dev/stdin', 'utf8');
    } else {
      // Fetch from gh
      if (!tag) {
        throw new Error('--tag <tag> is required');
      }

      const ghArgs = ['release', 'view', tag, '--json', 'body', '-q', '.body'];
      if (repo) ghArgs.push('--repo', repo);

      generatedBody = execFileSync('gh', ghArgs, { encoding: 'utf8' });

      // Determine prerelease if not forced
      if (prerelease === null) {
        try {
          const ghPreArgs = ['release', 'view', tag, '--json', 'isPrerelease', '-q', '.isPrerelease'];
          if (repo) ghPreArgs.push('--repo', repo);
          const result = execFileSync('gh', ghPreArgs, { encoding: 'utf8' }).trim();
          prerelease = result === 'true';
        } catch (_e) {
          // Final fallback: check if tag contains `-` after version digits
          prerelease = /-/.test(version);
        }
      }
    }

    const formatted = formatReleaseNotes({ generatedBody, version, prerelease, packageName });

    if (doApply) {
      const tmpFile = path.join(os.tmpdir(), `release-notes-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, formatted, 'utf8');
      try {
        const ghArgs = ['release', 'edit', tag, '--notes-file', tmpFile];
        if (repo) ghArgs.push('--repo', repo);
        execFileSync('gh', ghArgs, { encoding: 'utf8' });
        process.stderr.write(`Release notes updated for ${tag}\n`);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    } else {
      process.stdout.write(formatted + '\n');
    }
  } catch (err) {
    if (err instanceof ExitError) throw err;
    throw new ExitError(1, err && err.message ? err.message : String(err));
  }
}

if (require.main === module) {
  runMain(main);
}

module.exports = { formatReleaseNotes, classifyTitle };
