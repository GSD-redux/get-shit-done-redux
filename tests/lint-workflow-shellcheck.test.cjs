'use strict';

/**
 * lint-workflow-shellcheck.test.cjs — unit + property coverage for the
 * hand-rolled shell-text parser/logic functions exported by
 * scripts/lint-workflow-shellcheck.cjs (#4109 follow-up).
 *
 * Per this repo's CLAUDE.md: "Parsers, budget limits, and bijective
 * contracts must include at least one fast-check (`fc`) property test."
 * These functions ARE parsers (shell-text extraction/transformation over
 * workflow-authored markdown), so the property-test requirement below is a
 * binding gate, not optional polish.
 *
 * Note: scripts/lint-workflow-shellcheck.cjs guards its CLI entry point
 * with `if (require.main === module) runMain(main);`, so requiring it here
 * for its exported pure functions does not also trigger a live ShellCheck
 * run against the real gsd-core/workflows/ tree.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');

const {
  substitutePlaceholders,
  stripCommandSubstitutions,
  stripShellComments,
  extractForLoops,
  findBareForLoopSplits,
  findingKey,
  partitionAgainstBaseline,
} = require(path.join(__dirname, '..', 'scripts', 'lint-workflow-shellcheck.cjs'));

/** Minimal block shape findBareForLoopSplits expects (see the source's own
 *  extractBashBlocks for the real shape this stands in for). */
function mkBlock(body, overrides = {}) {
  return { file: 'w.md', blockIdx: 0, firstBodyLine: 1, body, ...overrides };
}

describe('stripCommandSubstitutions', () => {
  test('empty string', () => {
    assert.equal(stripCommandSubstitutions(''), '');
  });

  test('no substitution present leaves the string intact', () => {
    assert.equal(stripCommandSubstitutions('echo hello'), 'echo hello');
  });

  test('substitution at the start', () => {
    assert.equal(stripCommandSubstitutions('$(echo hi) world'), ' world');
  });

  test('substitution in the middle', () => {
    assert.equal(stripCommandSubstitutions('a $(echo hi) b'), 'a  b');
  });

  test('substitution at the end', () => {
    assert.equal(stripCommandSubstitutions('a $(echo hi)'), 'a ');
  });

  test('nested command substitution — $(echo $(nested))', () => {
    assert.equal(stripCommandSubstitutions('pre $(echo $(nested)) post'), 'pre  post');
  });

  test('unterminated substitution does not crash or hang, consumes to end of string', () => {
    assert.equal(stripCommandSubstitutions('a $(echo hi'), 'a ');
  });

  test('malformed nested-unterminated input does not crash or hang', () => {
    assert.equal(stripCommandSubstitutions('a $(echo $(nested'), 'a ');
  });
});

describe('stripShellComments', () => {
  test('strips a full-line comment to spaces, preserving the newline', () => {
    assert.equal(stripShellComments('# a comment\necho hi'), '           \necho hi');
  });

  test('strips a trailing comment after code, preserving preceding code', () => {
    assert.equal(stripShellComments('echo hi # trailing'), 'echo hi           ');
  });

  test('does NOT strip ${VAR#pattern} parameter-expansion # (the false-positive this pass exists to avoid)', () => {
    assert.equal(stripShellComments('sm_raw=${sm_raw#./}'), 'sm_raw=${sm_raw#./}');
  });

  test('does not strip a # immediately following a non-whitespace identifier character', () => {
    assert.equal(stripShellComments('x=${foo#bar} y=1'), 'x=${foo#bar} y=1');
  });

  test('a # inside single quotes is preserved literally, not treated as a comment start', () => {
    assert.equal(stripShellComments("echo 'a # b'"), "echo 'a # b'");
  });
});

describe('substitutePlaceholders', () => {
  test('substitutes a single-token placeholder ({run_dir}) to a shell-safe bareword', () => {
    assert.equal(substitutePlaceholders('cd {run_dir}'), 'cd PLACEHOLDER_run_dir');
  });

  test('substitutes a multi-word prose placeholder ({discovered test command})', () => {
    assert.equal(
      substitutePlaceholders('run {discovered test command}'),
      'run PLACEHOLDER_discovered_test_command',
    );
  });

  test('does NOT substitute real ${VAR} parameter expansion', () => {
    assert.equal(substitutePlaceholders('echo ${VAR}'), 'echo ${VAR}');
  });

  test('does NOT clobber {1..5} POSIX numeric brace expansion (pinning the corrected behavior)', () => {
    assert.equal(substitutePlaceholders('echo {1..5}'), 'echo {1..5}');
  });

  test('does NOT clobber {a,b,c} POSIX brace-expansion list (pinning the corrected behavior)', () => {
    assert.equal(substitutePlaceholders('echo {a,b,c}'), 'echo {a,b,c}');
  });

  test('does NOT clobber { cmd1; cmd2; } compound-command grouping (pinning the corrected behavior)', () => {
    const input = '{ echo hi; echo bye; }';
    assert.equal(substitutePlaceholders(input), input);
  });
});

describe('extractForLoops', () => {
  test('captures loopVar and listExpr for a simple for-header', () => {
    const [loop] = extractForLoops('for x in $VAR; do\n  echo "$x"\ndone\n');
    assert.equal(loop.loopVar, 'x');
    assert.equal(loop.listExpr, '$VAR');
  });

  test('does not truncate the list-expr at a `;` nested inside $( ... )', () => {
    const [loop] = extractForLoops('for x in $(echo a; echo b); do\n  echo "$x"\ndone\n');
    assert.equal(loop.listExpr, '$(echo a; echo b)');
  });

  test('finds multiple for-loops in one body', () => {
    const loops = extractForLoops('for a in 1 2; do :; done\nfor b in $Y; do :; done\n');
    assert.equal(loops.length, 2);
    assert.equal(loops[0].loopVar, 'a');
    assert.equal(loops[1].loopVar, 'b');
  });
});

describe('findBareForLoopSplits — the core #4109 detector', () => {
  test('POSITIVE: bare unquoted `for x in $VAR; do ... done` is flagged', () => {
    const findings = findBareForLoopSplits([mkBlock('for x in $VAR; do\n  echo "$x"\ndone\n')]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].loopVar, 'x');
    assert.equal(findings[0].varName, 'VAR');
  });

  test('POSITIVE: bare unquoted `${VAR}` braced form is also flagged', () => {
    const findings = findBareForLoopSplits([mkBlock('for x in ${VAR}; do\n  echo "$x"\ndone\n')]);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].varName, 'VAR');
  });

  test('NEGATIVE: command-substitution-wrapped form (the actual #4109 fix pattern) is NOT flagged', () => {
    const findings = findBareForLoopSplits([
      mkBlock('for x in $(printf \'%s\' "$VAR"); do\n  echo "$x"\ndone\n'),
    ]);
    assert.equal(findings.length, 0);
  });

  test('NEGATIVE: quoted `"$VAR"` form is NOT flagged', () => {
    const findings = findBareForLoopSplits([mkBlock('for x in "$VAR"; do\n  echo "$x"\ndone\n')]);
    assert.equal(findings.length, 0);
  });

  test('NEGATIVE: literal words (no variable at all) are NOT flagged', () => {
    const findings = findBareForLoopSplits([mkBlock('for x in a b c; do\n  echo "$x"\ndone\n')]);
    assert.equal(findings.length, 0);
  });

  test('a for-loop shape quoted inside a `#` comment (prose referencing a past bug) is NOT flagged', () => {
    const findings = findBareForLoopSplits([
      mkBlock('# old bug: for x in $VAR; do ... done\necho ok\n'),
    ]);
    assert.equal(findings.length, 0);
  });

  // --- fast-check property test (CLAUDE.md-mandated for parsers) ---
  //
  // Property: for any generated loop-var/var-name pair and any of the SAFE
  // forms (quoted, command-substitution-wrapped, literal-words), the
  // detector reports zero findings; for either UNSAFE bare form (bare $VAR
  // or braced ${VAR}), it reports exactly one finding naming that variable.
  const identArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,6}$/);
  const formArb = fc.constantFrom('bare', 'braced', 'quoted', 'substituted', 'literal');

  function buildLoopBody(loopVar, varName, form) {
    let listExpr;
    switch (form) {
      case 'bare':
        listExpr = `$${varName}`;
        break;
      case 'braced':
        listExpr = `\${${varName}}`;
        break;
      case 'quoted':
        listExpr = `"$${varName}"`;
        break;
      case 'substituted':
        listExpr = `$(printf '%s' "$${varName}")`;
        break;
      case 'literal':
        listExpr = 'a b c';
        break;
      default:
        throw new Error(`unreachable form: ${form}`);
    }
    return `for ${loopVar} in ${listExpr}; do\n  echo "$${loopVar}"\ndone\n`;
  }

  test('property: bare/braced forms are flagged naming the variable; quoted/substituted/literal forms never are', () => {
    fc.assert(
      fc.property(identArb, identArb, formArb, (loopVar, varName, form) => {
        const body = buildLoopBody(loopVar, varName, form);
        const findings = findBareForLoopSplits([mkBlock(body)]);
        if (form === 'bare' || form === 'braced') {
          assert.equal(findings.length, 1);
          assert.equal(findings[0].varName, varName);
        } else {
          assert.equal(findings.length, 0);
        }
      }),
    );
  });
});

describe('findingKey / partitionAgainstBaseline', () => {
  test('findingKey matches on {file, code, message} only — ignores line number', () => {
    const a = { file: 'w.md', code: '2086', message: 'msg', line: 10 };
    const b = { file: 'w.md', code: '2086', message: 'msg', line: 999 };
    assert.equal(findingKey(a), findingKey(b));
  });

  test('a finding shifted to a different line, same file/code/message, still matches the baseline (drift tolerance)', () => {
    const baseline = [{ file: 'w.md', code: '2086', message: 'msg' }];
    const current = [{ file: 'w.md', code: '2086', message: 'msg', line: 999 }];
    const { newFindings, baselinedFindings } = partitionAgainstBaseline(current, baseline);
    assert.equal(newFindings.length, 0);
    assert.equal(baselinedFindings.length, 1);
  });

  test('a THIRD occurrence of a message with only two accepted baseline instances is reported new (multiset semantics)', () => {
    const baseline = [
      { file: 'w.md', code: '2086', message: 'msg' },
      { file: 'w.md', code: '2086', message: 'msg' },
    ];
    const current = [
      { file: 'w.md', code: '2086', message: 'msg', line: 1 },
      { file: 'w.md', code: '2086', message: 'msg', line: 2 },
      { file: 'w.md', code: '2086', message: 'msg', line: 3 },
    ];
    const { newFindings, baselinedFindings } = partitionAgainstBaseline(current, baseline);
    assert.equal(newFindings.length, 1);
    assert.equal(baselinedFindings.length, 2);
  });

  test('a finding with a different code (same file/message) is NOT matched against the baseline', () => {
    const baseline = [{ file: 'w.md', code: '2086', message: 'msg' }];
    const current = [{ file: 'w.md', code: '2046', message: 'msg', line: 1 }];
    const { newFindings } = partitionAgainstBaseline(current, baseline);
    assert.equal(newFindings.length, 1);
  });

  test('an empty baseline reports every current finding as new', () => {
    const current = [{ file: 'w.md', code: '2086', message: 'msg', line: 1 }];
    const { newFindings, baselinedFindings } = partitionAgainstBaseline(current, []);
    assert.equal(newFindings.length, 1);
    assert.equal(baselinedFindings.length, 0);
  });
});
