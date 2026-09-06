// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

// #2994 fragmentization moved the automated_ui_verification step out of
// verify-work.md into gsd-core/workflows/verify-work/steps/automated-ui-verification.md
// behind a section marker (`state:ui-phase-active`). The host no longer
// contains any "playwright" mention at all — reading the host alone now
// only passes these two assertions via unrelated substring coincidences
// ("automated"/"UI" from the section-marker id and an unrelated "User-facing
// changes - UI" bullet; "fall back" from an unrelated subagent-dispatch
// line), which is vacuous. Read the step file directly — it is the sole
// remaining source of the real Playwright content.
const AUTOMATED_UI_VERIFICATION_STEP_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'verify-work', 'steps', 'automated-ui-verification.md'
);

describe('Playwright-MCP UI verification integration', () => {
  test('verify-work.md mentions automated UI verification', () => {
    const content = fs.readFileSync(AUTOMATED_UI_VERIFICATION_STEP_PATH, 'utf-8');
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('automated') && content.includes('UI'),
      'verify-work.md (or its extracted verify-work/steps/automated-ui-verification.md) should mention automated UI verification option'
    );
  });

  test('ui-review.md mentions Playwright-MCP when available', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'ui-review.md'), 'utf-8'
    );
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('mcp__playwright'),
      'ui-review.md should reference Playwright-MCP'
    );
  });

  test('gsd-ui-auditor.md includes automated screenshot guidance', () => {
    const content = fs.readFileSync(
      path.join(__dirname, '..', 'agents', 'gsd-ui-auditor.md'), 'utf-8'
    );
    assert.ok(
      content.toLowerCase().includes('playwright') || content.includes('screenshot') || content.includes('automated'),
      'gsd-ui-auditor.md should mention automated screenshot verification'
    );
  });

  test('automated verification is optional/conditional (falls back to manual)', () => {
    const verifyContent = fs.readFileSync(AUTOMATED_UI_VERIFICATION_STEP_PATH, 'utf-8');
    // Must include a fallback / "if available" conditional
    const hasConditional =
      verifyContent.includes('if available') ||
      verifyContent.includes('when available') ||
      verifyContent.includes('if Playwright') ||
      verifyContent.includes('fall back');
    assert.ok(hasConditional, 'Playwright integration must be conditional with manual fallback');
  });
});

// #4176: the auditor's sole screenshot path had three defects — a 200-only
// probe that misread a redirecting dev server as absent, an unconditional
// "Screenshots captured" echo that survived total capture failure, and a
// documented 3000 -> 5173 -> 8080 fallback the control flow never attempted.
// These assert against the <screenshot_approach> BASH BLOCK specifically, not
// the whole file: the pre-fix bug was precisely that the fallback existed as
// a guidance sentence while the code hard-coded one port, so a whole-file
// grep for "5173" passed on the broken version.
const AUDITOR_PATH = path.join(__dirname, '..', 'agents', 'gsd-ui-auditor.md');

// Line-based rather than a fence regex: an unbounded [\s\S]*? over readFileSync
// content is a backtracking risk (local/no-unbounded-quantifier), a triple-fence
// body regex is ad-hoc markdown parsing (local/no-adhoc-markdown-parsing), and a
// bare \n split is CRLF-fragile on Windows checkouts (local/no-crlf-fragile-split).
// splitLines() handles the line endings; the scan below handles the fence.
function screenshotApproachLines() {
  const lines = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf-8'));
  const FENCE = '`'.repeat(3);
  const OPENER = FENCE + 'bash';
  const body = [];
  let inSection = false;
  let inFence = false;
  for (const line of lines) {
    if (!inSection) {
      if (line.includes('<screenshot_approach>')) inSection = true;
      continue;
    }
    if (line.includes('</screenshot_approach>')) break;
    if (!inFence) {
      if (line.trim() === OPENER) inFence = true;
      continue;
    }
    if (line.trim() === FENCE) break;
    body.push(line);
  }
  assert.ok(body.length > 0, '<screenshot_approach> must contain a non-empty bash fence');
  return body;
}

function screenshotApproachBlock() {
  return screenshotApproachLines().join('\n');
}

// Join backslash continuations, so a capture invocation or an `if ... ; then` spread
// over four physical lines is ONE logical line. Without this, a structural read of the
// block sees `if npx playwright screenshot "$DEV_URL" \` — a header with no `then` —
// and silently declines to open a scope.
function logicalLines(lines) {
  const joined = [];
  let buf = null;
  for (const raw of lines) {
    const piece = buf === null ? raw : `${buf} ${raw.trim()}`;
    const trimmedEnd = piece.replace(/[\t ]+$/, '');
    if (trimmedEnd.endsWith('\\')) {
      buf = trimmedEnd.slice(0, -1).replace(/[\t ]+$/, '');
      continue;
    }
    buf = null;
    joined.push(piece);
  }
  if (buf !== null) joined.push(buf);
  return joined;
}

// Every logical line paired with the shell conditions actually GOVERNING it — the
// `if`/`elif`/`else` conditions of the enclosing scopes, innermost last. Loops and
// `case` open a scope with no condition of their own, so a line inside one is still
// correctly reported as ungoverned unless an `if` encloses it too.
//
// This is what a "the echo is gated" assertion has to read. Asking instead whether some
// token appears EARLIER IN THE BLOCK TEXT than the echo answers a different question
// entirely, and `CAPTURED=0` near the top of the block makes that question true forever:
// moving the success echo back outside its `if [ "$CAPTURED" -eq 3 ]` branch — which is
// precisely the #4176 bug — would not disturb it.
function guardedLines(lines) {
  const stack = [];
  const rows = [];
  for (const line of logicalLines(lines)) {
    const t = line.trim();
    const ifMatch = /^if[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (ifMatch) { stack.push(ifMatch[1]); continue; }
    const elifMatch = /^elif[\t ]+(.{1,4000}?)[\t ]*;[\t ]*then$/.exec(t);
    if (elifMatch) { if (stack.length) stack[stack.length - 1] = elifMatch[1]; continue; }
    if (t === 'else') { if (stack.length) stack[stack.length - 1] = `!(${stack[stack.length - 1]})`; continue; }
    if (t === 'fi') { stack.pop(); continue; }
    if (/^(for|while|until)\b/.test(t) && /;[\t ]*do$/.test(t)) { stack.push(''); continue; }
    if (t === 'do') { stack.push(''); continue; }
    if (t === 'done') { stack.pop(); continue; }
    if (/^case\b/.test(t) && /\bin$/.test(t)) { stack.push(''); continue; }
    if (t === 'esac') { stack.pop(); continue; }
    rows.push({ line: t, guards: stack.slice() });
  }
  return rows;
}

// Capture INVOCATIONS, not every line that mentions one. The block documents its own flags in
// comments, and a comment naming `playwright screenshot` — the one explaining --timeout does
// exactly this — is prose, not a call site. Reading it as one inflates the invocation count and,
// worse, lets an assertion pass on the DOCUMENTATION of a property instead of the property: the
// --timeout check below was satisfied in part by a comment containing the string `--timeout`.
// That is the same class as the whole-block substring defect the port assertion names, which is
// why the exclusion lives here once rather than in each caller.
// logicalLines first: the invocation spans four physical lines, so its flags are only all on one
// line after continuations are joined.
// Comments are dropped from the PHYSICAL lines, BEFORE continuations are joined. Doing it after
// is a false clean: a comment ending in a backslash splices the following real invocation onto
// itself, the joined line then starts with `#`, and the invocation disappears from the set — so
// the assertions over it pass on an empty selection. Filtering first makes that shape impossible
// rather than merely unlikely. (A trailing comment on a real code line is still selected; that
// direction over-fires, which is the safe one.)
// Inline comments are stripped too, not just whole-line ones. `--timeout=30000` moved into a
// trailing comment is an ordinary edit, not sabotage, and it would otherwise keep satisfying the
// time-bound assertion while no longer being passed to the command. Strip from ` #` to end of
// line BEFORE joining, which also closes the splice via a trailing comment.
//
// KNOWN LIMIT, stated because the regex does not enforce what a looser comment here once claimed:
// this is QUOTE-BLIND. It cannot tell a comment from a `#` inside a string, so a line such as
// `--user-agent=" # " \` has its quoted `#` read as a comment start, taking the real continuation
// backslash with it. The consequence is direction-dependent: an assertion REQUIRING a flag then
// over-fires (safe), but a BAN — the `localhost:\d+` check below — would stop seeing a hard-coded
// port that moved onto the hidden continuation line, which is a false clean. No line in the block
// this reads contains a quoted ` #` today. Making it quote-aware means lexing bash, which is more
// than a confirmed-bug fix should carry, so the limit is recorded rather than closed.
function stripComment(line) {
  const stripped = line.replace(/\s+#.*$/, '');
  if (stripped === line) return line; // nothing removed — leave real continuations alone
  // A `\` that the removed text was hiding did NOT continue the line in bash, so this reader
  // must not treat it as one. Driven: `echo one \ # x` followed by `--timeout=30000` runs the
  // second line as its OWN command (`--timeout=30000: command not found`) — bash never joins
  // them. Stripping the comment and keeping the backslash would make logicalLines() join what
  // bash does not, so a flag on the following line would satisfy an assertion the real command
  // never receives. That is a bypass this stripping would have CREATED, not one it inherited.
  return stripped.replace(/\\+$/, '');
}
function captureInvocations(lines) {
  return logicalLines(lines.map(stripComment).filter((l) => !/^[\t ]*#/.test(l) && l.trim() !== ''))
    .map((l) => l.trim())
    .filter((l) => l.includes('playwright screenshot'));
}

describe('#4176 — gsd-ui-auditor screenshot capture is honest', () => {
  test('dev-server probe follows redirects and is time-bounded', () => {
    const block = screenshotApproachBlock();
    const usesCurlL = /curl[\t ]+(-[A-Za-z]{0,10}L|--location)\b/.test(block);
    const usesFetch = /\bfetch\(/.test(block);
    assert.ok(usesCurlL || usesFetch, 'probe must issue its request via curl or fetch()');
    // Redirect-FOLLOWING is the property, and the bare presence of `fetch(` cannot
    // express it: fetch's own default is already redirect:"follow", so a regression to
    // redirect:"manual" — which reinstates the 307-read-as-absent bug #4176 is about —
    // satisfies a `block.includes('fetch(')` check exactly as well as the fix does.
    // Ban the non-following forms, and require the contract to be stated rather than
    // inherited from a default a future runtime is free to change.
    assert.ok(
      !/redirect[\t ]*:[\t ]*["'](manual|error)["']/.test(block),
      'probe must not disable redirect following — a redirecting dev server is not an absent one'
    );
    assert.ok(
      usesCurlL || /redirect[\t ]*:[\t ]*["']follow["']/.test(block),
      'a fetch()-based probe must state redirect:"follow" explicitly, so the redirect contract is pinned rather than inherited'
    );
    const timeBounded = /--max-time|AbortSignal\.timeout|run-with-timeout|--connect-timeout/.test(block);
    assert.ok(timeBounded, 'probe must be time-bounded — an accepting-but-unresponsive port must not hang the audit');
  });

  test('probe accepts any 2xx rather than exact-matching 200', () => {
    const block = screenshotApproachBlock();
    assert.ok(
      !/=[\s]*"200"/.test(block),
      'probe must not exact-match "200" — that misreads redirects and other 2xx as no-server'
    );
    // Banning one literal idiom is not the same as requiring a range. `case "$PROBE" in
    // 200) ... ;; esac` carries no `=` at all, so it reintroduces the same
    // 2xx-but-not-200 misread while passing the ban above. Assert positively that a 2xx
    // RANGE is what the probe accepts.
    const acceptsRange =
      /2\?\?\)/.test(block) ||               // case glob:  2??)
      /2\[0-9\]\[0-9\]\)/.test(block) ||     // case class: 2[0-9][0-9])
      /-ge[\t ]+200\b/.test(block) ||        // arithmetic lower bound
      /\br\.ok\b/.test(block);               // fetch's own 2xx predicate
    assert.ok(
      acceptsRange,
      'probe must accept a 2xx RANGE (a 2?? / 2[0-9][0-9] case glob, a >= 200 comparison, or r.ok) — not an enumerated status'
    );
  });

  test('capture success is checked, not assumed', () => {
    const block = screenshotApproachBlock();
    // `CAPTURED=` is deliberately NOT an alternative here. It matches the unconditional
    // `CAPTURED=0` initialisation, so a future block that keeps the counter and drops every
    // real outcome check would still satisfy this — the counter's EXISTENCE is not evidence
    // that anything was observed. (It does not weaken the regression this test names: the
    // pre-fix block declared no counter at all, so every alternative below is absent from it
    // and the test fails there either way. Removing it costs nothing and closes the forward
    // hole.) The remaining alternatives each name an actual observation: the captured file is
    // non-empty, or the capture command's own exit status is consumed.
    const checksOutcome = /\[ -s "?\$SCREENSHOT_DIR|\[ -s |if npx |\$\?/.test(block);
    assert.ok(checksOutcome, 'an exit-status or file-existence check must gate the captured/not-captured signal');
  });

  // The structural half of the assertion above. A "captured" claim is a claim about an
  // outcome, so what has to be true is that the branch printing it could only have been
  // reached by observing that outcome — a property of the block's CONTROL FLOW, which a
  // substring-proximity check cannot express and cannot fail on the regression it names.
  test('every capture-success claim is governed by a conditional testing the capture count', () => {
    const rows = guardedLines(screenshotApproachLines());
    const CLAIM = /^echo "Screenshots (captured|PARTIALLY captured)\b/;
    const claims = rows.filter((r) => CLAIM.test(r.line));
    assert.ok(
      claims.length > 0,
      'expected the capture block to echo a success or partial-success claim'
    );
    for (const claim of claims) {
      assert.ok(
        claim.guards.some((cond) => /CAPTURED/.test(cond)),
        'a capture-success claim must sit inside a conditional that tests the capture count; ' +
          `governing conditions for ${JSON.stringify(claim.line)} were ${JSON.stringify(claim.guards)}`
      );
    }
  });

  test('all three documented ports are tried in the control flow', () => {
    // Self-found, same class as finding 1: `block.includes(port)` is satisfied by a port
    // named only in a comment. The pre-fix bug WAS a port documented in prose beside code
    // that hard-coded 3000, so a whole-block substring check cannot distinguish the fix
    // from the bug it replaced — it can only see that the digits exist somewhere. Read
    // the iteration line itself.
    // logicalLines, not guardedLines: a `for ... ; do` line OPENS a scope, so it is
    // consumed by the guard walker and never appears among the governed lines.
    const iteration = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .find((l) => /^for[\t ]+PORT[\t ]+in\b/i.test(l));
    assert.ok(iteration, 'ports must be iterated, not hard-coded to one');
    // And drop any trailing comment before reading it, or the check regresses to the
    // whole-block substring form one line down: `for PORT in 3000; do # 5173, 8080 too`
    // would otherwise satisfy it. (Measured — that mutation passed before this strip.)
    const iterationCode = iteration.split(/[\t ]#/)[0];
    for (const port of ['3000', '5173', '8080']) {
      assert.ok(
        iterationCode.includes(port),
        `port ${port} must be in the port iteration itself, not only in guidance prose: ${iterationCode}`
      );
    }
  });

  test('the auth-gated port is recorded first-wins, matching the documented precedence', () => {
    // The ports carry a documented ORDER, and the reported reason should name the same
    // port that order would have picked. An unguarded assignment inside the loop reports
    // whichever gated port was tried last.
    const assignments = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .filter((l) => /DEV_GATED=/.test(l) && !/^DEV_GATED=""$/.test(l));
    assert.ok(assignments.length > 0, 'expected the port loop to record an auth-gated server');
    for (const line of assignments) {
      assert.ok(
        /\[[\t ]+-[nz][\t ]+"?\$DEV_GATED"?[\t ]+\]/.test(line),
        `the auth-gated port must be recorded first-wins, or the reason names the LAST gated port: ${line}`
      );
    }
  });

  // Self-found by the round's guard-shape census, not by the review: the case arm above
  // FIXES A SET at author time (the statuses that count as auth-gated) while the domain it
  // rules on — what a local dev server may answer — is owned by the server, so the set can
  // fall behind without this code changing. 407 (proxy authentication required) and 511
  // (network authentication required) each mean the server ANSWERED and demanded
  // credentials; omitting them reports a PRESENT server as an absent one, which is the very
  // defect #4176 names, one status family over.
  // Read the case LABEL that governs the assignment, not the block text: `block.includes('407')`
  // would be satisfied by the comment explaining it — the same substring defect as finding 1.
  test('the whole auth-required status class is recorded as gated, not misreported as absent', () => {
    const gatedArms = logicalLines(screenshotApproachLines())
      .map((l) => l.trim())
      .filter((l) => /DEV_GATED=/.test(l) && !/^DEV_GATED=""$/.test(l));
    assert.ok(gatedArms.length > 0, 'expected a case arm recording an auth-gated server');
    const labels = gatedArms
      .map((l) => l.split(')')[0])
      .map((lab) => lab.split('|').map((s) => s.trim()));
    for (const status of ['401', '403', '407', '511']) {
      assert.ok(
        labels.some((lab) => lab.includes(status)),
        `HTTP ${status} means authentication is required, so a server answering it is PRESENT and gated — not absent: case labels were ${JSON.stringify(labels)}`
      );
    }
  });

  test('the resolved port — not a hard-coded 3000 — is what gets captured', () => {
    const captureLines = captureInvocations(screenshotApproachLines());
    assert.ok(captureLines.length > 0, 'expected at least one capture invocation');
    for (const line of captureLines) {
      // Negative-only was the hole, and it is the SAME defect class the test above names:
      // banning the one literal `localhost:3000` leaves a hard-coded `localhost:5173` or
      // `localhost:8080` passing, while the defect #4176 names is "the capture targets a
      // hard-coded port", not "the capture targets 3000". Ban the shape, then require the
      // resolved variable positively — a ban alone cannot say what the line SHOULD contain.
      assert.ok(
        !/localhost:\d+/.test(line),
        `capture must not hard-code any port: ${line.trim()}`
      );
      assert.ok(
        line.includes('$DEV_URL'),
        `capture must use the resolved URL variable: ${line.trim()}`
      );
    }
  });

  test('capture invocations are time-bounded, as the probe is', () => {
    // `playwright screenshot` forwards --timeout to context.setDefaultTimeout() and
    // defaults it to 0, i.e. NO timeout — so this CLI path drops the bound the
    // Playwright library applies by default. An unbounded capture reinstates the
    // hang the probe's own time bound exists to prevent, one step later.
    // captureInvocations, not a bare filter: the comment four lines above the call site names
    // both `playwright screenshot` and `--timeout`, so a bare filter counted it as an invocation
    // and it satisfied this assertion by quoting the flag rather than passing it.
    const captures = captureInvocations(screenshotApproachLines());
    assert.ok(captures.length > 0, 'expected at least one capture invocation');
    for (const line of captures) {
      assert.ok(
        /--timeout[= ]/.test(line),
        `capture must be time-bounded — playwright screenshot defaults to no timeout: ${line}`
      );
    }
  });

  test('a total capture failure removes its stray files, not just an empty directory', () => {
    // rmdir alone cannot honour a "leaves nothing behind" claim: it succeeds only on a
    // genuinely empty directory and its stderr is discarded, so a zero-byte or partial
    // .png from a crashed browser — which `[ -s ]` correctly scores as a failure —
    // leaves BOTH the file and the directory in place, silently.
    const rows = guardedLines(screenshotApproachLines());
    const removesDir = rows.filter((r) => /^rmdir\b/.test(r.line));
    assert.ok(removesDir.length > 0, 'expected the all-failed branch to remove the review directory');
    const removesFiles = rows.filter((r) => /\brm -f[\t ].*\$SCREENSHOT_DIR/.test(r.line));
    assert.ok(
      removesFiles.length > 0,
      'the all-failed branch must remove the files a crashed capture wrote, or rmdir cannot clean up after one'
    );
    for (const row of removesFiles) {
      assert.ok(
        row.guards.some((cond) => /CAPTURED/.test(cond)),
        `stray-file removal must be confined to the capture-failure branch; governing conditions were ${JSON.stringify(row.guards)}`
      );
    }
  });

  test('report surfaces can express partial capture', () => {
    // Was a whole-FILE substring check — the same defect class as the Major finding and as the
    // port check above, and shipped by this PR rather than inherited. The template prose alone
    // satisfied it, so deleting the block's partial branch outright would not have failed it.
    // Pin both ends positively instead: the block must PRODUCE a partial status, and a report
    // surface outside the block must CONSUME the variable — a status computed and never
    // rendered is not a surface that can express anything.
    const block = screenshotApproachBlock();
    assert.ok(
      /CAPTURE_STATUS=["']?partially captured/i.test(block),
      'the capture block must PRODUCE a partial status — full/none alone cannot describe 2 of 3'
    );
    // Name the consuming surface POSITIVELY rather than subtracting the block from the file.
    // `content.replace(block, '')` was two bugs in one: String#replace with a string argument
    // drops only the FIRST occurrence, and the block is joined with '\n' by splitLines() while
    // readFileSync returns the file's own '\r\n' on a Windows checkout — so the match fails
    // outright, the block stays in the haystack, and the assertion is then satisfied by the
    // block's own text. That is a false clean, and CRLF-fragility is a class this repo lints
    // for (local/no-crlf-fragile-split). Assert on the Screenshots report field itself.
    const surfaces = splitLines(fs.readFileSync(AUDITOR_PATH, 'utf-8'))
      .filter((l) => /^\*\*Screenshots:\*\*/.test(l.trim()));
    assert.ok(surfaces.length > 0, 'expected a Screenshots report field in the agent output template');
    assert.ok(
      surfaces.every((l) => l.includes('$CAPTURE_STATUS')),
      'every Screenshots report field must render $CAPTURE_STATUS, or the status is computed and dropped'
    );
  });
});
