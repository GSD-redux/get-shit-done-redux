const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { stripFencedCode } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');
const { cleanup, createTempDir, readFileNormalized } = require('./helpers.cjs');

const SHIP_MD = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');

function extractStep(name) {
  const content = readFileNormalized(SHIP_MD);
  const open = `<step name="${name}">`;
  const start = content.indexOf(open);
  assert.notEqual(start, -1, `ship.md must contain a ${name} step`);
  const end = content.indexOf('</step>', start);
  assert.notEqual(end, -1, `${name} step must close`);
  return content.slice(start, end);
}

function extractTrackShippingScript() {
  const step = extractStep('track_shipping');
  const blocks = [...step.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)];
  const match = blocks.find(block => block[1].includes('mergeStateStatus'));
  assert.ok(match, 'track_shipping must contain an executable merge-state bash block');
  return match[1];
}

function runTrackShipping(responses) {
  const tmpDir = createTempDir('gsd-ship-note-');
  const responsesPath = path.join(tmpDir, 'responses.jsonl');
  const ghCallsPath = path.join(tmpDir, 'gh-calls.log');
  const gitCallsPath = path.join(tmpDir, 'git-calls.log');

  try {
    fs.writeFileSync(
      responsesPath,
      responses.map(response => JSON.stringify(response)).join('\n') + '\n',
      'utf8',
    );
    fs.writeFileSync(ghCallsPath, '', 'utf8');
    fs.writeFileSync(gitCallsPath, '', 'utf8');

    const preamble = [
      'gsd_run() { :; }',
      'sleep() { :; }',
      'git() {',
      '  if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then',
      '    printf "%s\\n" "$EXPECTED_HEAD"',
      '  elif [ "$1" = "log" ]; then',
      '    printf "[ci skip]\\n"',
      '  elif [ "$1" = "commit" ]; then',
      '    printf "commit\\n" >> "$GIT_CALLS"',
      '  elif [ "$1" = "push" ]; then',
      '    printf "push\\n" >> "$GIT_CALLS"',
      '  fi',
      '}',
      'gh() {',
      '  _call=$(wc -l < "$GH_CALLS")',
      '  _call=$((_call + 1))',
      '  printf "call\\n" >> "$GH_CALLS"',
      '  sed -n "${_call}p" "$GH_RESPONSES"',
      '}',
      'jq() {',
      '  "$NODE_BIN" -e "let d=\'\';process.stdin.on(\'data\',c=>d+=c);process.stdin.on(\'end\',()=>{const o=JSON.parse(d);process.stdout.write(String(o[process.argv[1].slice(1)] ?? \'\'));});" "$2"',
      '}',
    ].join('\n');

    const result = spawnSync('bash', ['-c', `${preamble}\n${extractTrackShippingScript()}`], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CURRENT_BRANCH: 'fix/ship-note',
        EXPECTED_HEAD: 'current-head',
        GH_CALLS: ghCallsPath,
        GH_RESPONSES: responsesPath,
        GIT_CALLS: gitCallsPath,
        NODE_BIN: process.execPath,
        PHASE_NUMBER: '1',
        PR_NUMBER: '123',
        padded_phase: '01',
      },
    });

    assert.strictEqual(result.status, 0, `track_shipping failed: ${result.stderr}`);
    return {
      ghCalls: fs.readFileSync(ghCallsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean),
      gitCalls: fs.readFileSync(gitCallsPath, 'utf8').trim().split(/\r?\n/).filter(Boolean),
    };
  } finally {
    cleanup(tmpDir);
  }
}

describe('#2783 ship.md track_shipping self-heals wedged PRs', () => {
  const step = extractStep('track_shipping');

  test('track_shipping inspects mergeStateStatus post-push', () => {
    assert.ok(
      /mergeStateStatus/.test(step),
      'track_shipping must query mergeStateStatus to detect wedged PRs (#2783)'
    );
  });

  test('track_shipping self-heals BLOCKED PRs by pushing a recovery commit without skip token', () => {
    assert.ok(
      /BLOCKED/.test(step),
      'track_shipping must check for BLOCKED merge state (#2783)'
    );
    assert.ok(
      /trigger CI/.test(step) || /allow-empty/.test(step),
      'track_shipping must push a recovery commit to trigger CI when wedged (#2783)'
    );
  });

  test('track_shipping and the following step remain outside balanced code fences', () => {
    const content = fs.readFileSync(SHIP_MD, 'utf8');
    const stripped = stripFencedCode(content);
    assert.strictEqual(stripped.unterminatedFence, false, 'ship.md must not contain an unterminated code fence');
    assert.match(
      stripped.text,
      /<step name="track_shipping">[\s\S]*?<\/step>\s*<step name="ship_post_capability_dispatch">/,
      'the track_shipping boundary and following step must remain visible after stripping code fences',
    );
  });
});

describe('#2783 ship-note recovery decisions use current GitHub state', { skip: process.platform === 'win32' }, () => {
  test('ignores a stale BLOCKED response until headRefOid matches the pushed commit', () => {
    const result = runTrackShipping([
      { head: 'stale-head', status: 'BLOCKED', checks: 0, review: '' },
      { head: 'current-head', status: 'CLEAN', checks: 0, review: '' },
    ]);

    assert.strictEqual(result.ghCalls.length, 2, 'must poll through the stale PR response');
    assert.strictEqual(
      result.gitCalls.filter(call => call === 'commit').length,
      0,
      'must not recover from merge state attached to an older head',
    );
  });

  test('does not recover when review requirements are the BLOCKED reason', () => {
    for (const review of ['REVIEW_REQUIRED', 'CHANGES_REQUESTED']) {
      const result = runTrackShipping([
        { head: 'current-head', status: 'BLOCKED', checks: 0, review },
      ]);
      assert.strictEqual(
        result.gitCalls.filter(call => call === 'commit').length,
        0,
        `${review} must not create an empty CI-recovery commit`,
      );
    }
  });

  test('still recovers a current BLOCKED head with zero checks and no review gate', () => {
    const result = runTrackShipping([
      { head: 'current-head', status: 'BLOCKED', checks: 0, review: 'APPROVED' },
    ]);

    assert.strictEqual(
      result.gitCalls.filter(call => call === 'commit').length,
      1,
      'a confirmed skip-token wedge must create exactly one recovery commit',
    );
  });

  test('recovers successfully on the 4th polling attempt', () => {
    const result = runTrackShipping([
      { head: 'stale-head', status: 'BLOCKED', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'BLOCKED', checks: 0, review: '' },
    ]);
    assert.strictEqual(result.ghCalls.length, 4, 'must poll exactly 4 times');
    assert.strictEqual(
      result.gitCalls.filter(call => call === 'commit').length,
      1,
      'must recover after resolving on the 4th attempt',
    );
  });

  test('recovers successfully on the 5th (final) polling attempt', () => {
    const result = runTrackShipping([
      { head: 'stale-head', status: 'BLOCKED', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'BLOCKED', checks: 0, review: '' },
    ]);
    assert.strictEqual(result.ghCalls.length, 5, 'must poll exactly 5 times');
    assert.strictEqual(
      result.gitCalls.filter(call => call === 'commit').length,
      1,
      'must recover after resolving on the 5th attempt',
    );
  });

  test('exhausts the polling bound after 5 attempts and warns without recovering (attempt 6)', () => {
    const result = runTrackShipping([
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'UNKNOWN', checks: 0, review: '' },
      { head: 'current-head', status: 'BLOCKED', checks: 0, review: '' },
    ]);
    assert.strictEqual(result.ghCalls.length, 5, 'must exhaust after exactly 5 polling attempts');
    assert.strictEqual(
      result.gitCalls.filter(call => call === 'commit').length,
      0,
      'must not recover if the status is unresolved when polling exhausts',
    );
  });
});
