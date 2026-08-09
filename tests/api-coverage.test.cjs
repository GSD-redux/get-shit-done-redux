/**
 * Tests for the API-coverage detector + matrix validator (#1562).
 *
 * Two pure functions under test, both returning typed IR (asserted, never
 * text-matched on prose):
 *   - detectApiIntegration(text) -> { detected, signals, terms }
 *   - validateCoverageMatrix(text) -> { valid, errors, counts }
 *
 * Acceptance-criterion mapping:
 *   #2 (opt-out needs reason; un-enumerated blocks) → validateCoverageMatrix suite
 *   #4 (non-API phases unaffected, low false-positive) → false-positive suite
 *   Matrix parse/render bijectivity → fast-check property
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fc = require('fast-check');

const MODULE_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'api-coverage.cjs');

// Shared row-shape generators for the coverage-matrix property tests below
// (the parse/render bijection and the #2371 document-shaped property both
// build matrices from the same canonical row shape — a single declaration
// here means the two properties can't silently desync).
const capabilityGen = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/);
const rowGen = fc.record({
  capability: capabilityGen,
  decision: fc.constantFrom('INTEGRATE', 'OPT-OUT'),
  // Reasons are short prose (e.g. "not needed yet"). The matrix is a
  // markdown table, so cell text is format-safe: no pipes / newlines.
  reason: fc.stringMatching(/^[a-z0-9 ,.\-!?]{0,20}$/),
});
// OPT-OUT rows must carry a non-empty reason for the round-trip to validate.
const validRowGen = rowGen.map((r) =>
  r.decision === 'OPT-OUT' && r.reason.trim() === ''
    ? { ...r, reason: 'because' }
    : { ...r, reason: r.reason.trim() }
);

describe('detectApiIntegration — pure detector (#1562)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(
      `Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`
    );
  }
  const { detectApiIntegration, DEFAULT_API_COVERAGE_TERMS } = mod;

  test('result shape — always carries detected, signals[], terms', () => {
    const r = detectApiIntegration('refactor the login function');
    assert.strictEqual(r.detected, false);
    assert(Array.isArray(r.signals));
    assert.strictEqual(r.signals.length, 0);
    assert.ok(r.terms && Array.isArray(r.terms.verbs));
    assert.ok(Array.isArray(r.terms.nouns));
  });

  test('non-string input degrades to {detected:false} without throwing', () => {
    assert.strictEqual(detectApiIntegration(undefined).detected, false);
    assert.strictEqual(detectApiIntegration(null).detected, false);
    assert.strictEqual(detectApiIntegration(42).detected, false);
    assert.strictEqual(detectApiIntegration({}).detected, false);
  });

  test('empty / whitespace-only input does not fire', () => {
    assert.strictEqual(detectApiIntegration('').detected, false);
    assert.strictEqual(detectApiIntegration('   \n\t  ').detected, false);
  });

  test('terms echo is the effective set actually used', () => {
    const r = detectApiIntegration('nothing relevant here');
    assert.deepStrictEqual(r.terms.verbs, [...DEFAULT_API_COVERAGE_TERMS.verbs]);
    assert.deepStrictEqual(r.terms.nouns, [...DEFAULT_API_COVERAGE_TERMS.nouns]);
  });

  test('terms override — explicit verbs+nouns replace defaults', () => {
    const r = detectApiIntegration('xyzzy the frobninator', { verbs: ['xyzzy'], nouns: ['frobninator'] });
    assert.deepStrictEqual(r.terms.verbs, ['xyzzy']);
    assert.deepStrictEqual(r.terms.nouns, ['frobninator']);
    assert.strictEqual(r.detected, true);
  });

  // ── Positive: compound verb+noun (acceptance #1 trigger) ─────────────────
  for (const scope of [
    'Integrate the Stripe API for payment processing',
    'Wrap the GitHub GraphQL API for issue triage',
    'Connect to the SendGrid REST endpoint for transactional email',
    'Consume the billing service over gRPC',
    'Wire up the Slack webhook for deploy notifications',
    'Onboard the Twilio SDK for SMS',
    'integrate oauth for login',
  ]) {
    test(`POSITIVE fires on: "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `expected detection for: ${scope}`);
      assert.ok(r.signals.length > 0);
      assert.ok(r.signals.every((s) => s.snippet.length > 0));
    });
  }

  // ── Positive: explicit <Service> API|SDK surface (no verb needed) ────────
  for (const scope of ['Add a Spotify API client', 'Ship the Notion SDK helper']) {
    test(`POSITIVE (surface) fires on: "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true);
      assert.ok(r.signals.some((s) => s.verb === '(surface)'));
    });
  }

  // ── Negative: false-positive guards (acceptance #4 — the crux) ───────────
  // Each of these is a phase that is NOT an external-API integration. The
  // detector must stay silent. The "public API of UserController" case is the
  // canonical FP trap: "api" is present but there is no integration verb.
  for (const [label, scope] of [
    ['internal API mention', 'The public API of the UserController should accept pagination params'],
    ['refactor', 'Refactor the authentication module to use bcrypt'],
    ['feature toggle', 'Add a dark mode toggle to the settings page'],
    ['bug fix', 'Fix the off-by-one error in the pagination helper'],
    ['docs', 'Update the README to document the config options'],
    ['internal client code', 'Add a client-side helper to debounce input'],
    ['bare noun no verb', 'We expose a REST-ish JSON shape already'],
    ['bare verb no noun', 'We will integrate the new design system tokens'],
  ]) {
    test(`NEGATIVE does not fire (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  // ── #2784/#3127: negation suppression + its #3127 perf regression ────────
  // PR #3127 added clause-local negation suppression (hasNegatedVerb /
  // hasNegatedNoun) but the noun-side check was O(verbs × nouns) with a
  // slice+split per pair — effectively cubic in clause length. A clause with
  // a few hundred repeated "integrate api" pairs took seconds; fast-check's
  // property test then generated documents large enough to hang the whole
  // file past node:test's 600s timeout (fail 0 / cancelled 1). These two
  // tests pin the O(verbs + nouns) fix at a size (~500 pairs) chosen so that
  // a re-regression to the old quadratic-per-pair behavior makes this file
  // exceed the runner's own timeout — that hang, not a wall-clock assertion
  // (CLAUDE.md forbids those), is the failure signal for a re-regression.
  test('suppresses a negated pair regardless of how many terms precede it', () => {
    const pairs = Array(500).fill('integrate api').join(' ');
    const scope = pairs + ' but we integrate no api here';
    const r = detectApiIntegration(scope);
    assert.strictEqual(r.detected, false);
  });

  test('still detects a genuine pair in a very long clause', () => {
    const pairs = Array(500).fill('integrate api').join(' ');
    const r = detectApiIntegration(pairs);
    assert.strictEqual(r.detected, true);
    assert.ok(r.signals.length > 0);
  });

  test('fenced code blocks are stripped — trigger inside a code fence does not fire', () => {
    const scope = [
      'Refactor the helpers.',
      '',
      '```bash',
      '# integrate the Stripe API (example command in docs)',
      '```',
      '',
      'No integration in this phase.',
    ].join('\n');
    assert.strictEqual(detectApiIntegration(scope).detected, false);
  });

  // ── H1 fix (#1562 code review): capitalized sentence starters must not fire
  // the <Service> API/SDK surface rule. These are common English, not services.
  for (const [label, scope] of [
    ['The API', 'The API documentation needs updating.'],
    ['An SDK', 'An SDK is already present in the repo.'],
    ['Our REST', 'Our REST endpoints return JSON.'],
    ['This GraphQL', 'This GraphQL schema is internal.'],
    ['New API', 'New API surface was added by the refactor.'],
  ]) {
    test(`NEGATIVE (stopword) does not fire (${label}): "${scope}"`, () => {
      assert.strictEqual(detectApiIntegration(scope).detected, false);
    });
  }

  test('compound signal fires when verb and noun are on the same line only', () => {
    const sameLine = 'Phase A integrates things.\nLater we mention an api.';
    const splitLine = 'Phase A integrates things.\nLater we mention an api here too.';
    assert.strictEqual(detectApiIntegration(sameLine).detected, false);
    assert.strictEqual(detectApiIntegration(splitLine).detected, false);
    assert.strictEqual(detectApiIntegration('integrates the api').detected, true);
  });

  // ── #3127 follow-up: hasNegatedVerb offset regression coverage ───────────
  // The `hasNegatedVerb` window previously subtracted `clause.start` a SECOND
  // time from an already clause-local `v.start`, which only accidentally
  // worked for the first clause on a line (clause.start === 0) and silently
  // mis-windowed (via negative-index slice wraparound) every later clause.
  test('suppresses a pair when the verb is directly negated', () => {
    const r = detectApiIntegration('This phase does not integrate any external API.');
    assert.strictEqual(r.detected, false);
  });

  test('suppresses a pair when a negation sits between verb and noun', () => {
    const r = detectApiIntegration('This phase integrates no external API.');
    assert.strictEqual(r.detected, false);
  });

  test('still detects a genuine integration', () => {
    const r = detectApiIntegration('We integrate the Stripe API.');
    assert.strictEqual(r.detected, true);
    const compound = r.signals.find((s) => s.verb !== '(surface)');
    assert.ok(compound, 'expected a compound verb+noun signal');
    assert.strictEqual(compound.verb, 'integrate');
    assert.strictEqual(compound.noun, 'api');
  });

  test('a distant negation does not suppress a genuine pair', () => {
    // #2784's own documented example: "without changing runtime dependencies"
    // inside a long clause must NOT negate an unrelated genuine pairing later
    // in the SAME clause — the negation-window checks are scoped to the
    // verb's immediate context, not a blanket clause-wide scan.
    const r = detectApiIntegration(
      'The migration proceeds without changing runtime dependencies while we integrate the Stripe API for payment processing across the whole checkout flow.'
    );
    assert.strictEqual(r.detected, true);
  });

  test('suppression works for a clause that is not the first on the line', () => {
    // THE REGRESSION TEST for the double-offset bug: before the fix, this
    // failed (wrongly detected === true) because the negation window for the
    // second clause was computed against the wrong index base (v.start was
    // re-based against clause.start even though it was already clause-local),
    // producing an empty/garbage "before" window via negative-index slice()
    // wraparound so the verb-adjacent negation was never seen.
    const r = detectApiIntegration('We ship a thing; this phase does not integrate an external API.');
    assert.strictEqual(r.detected, false);
  });

  test('suppression in an early clause does not mask a genuine pair in a later clause', () => {
    // Intended semantics: negation suppression is scoped PER CLAUSE (matching
    // the "no cross-clause binding" design elsewhere in this module — see the
    // CLAUSE_BOUNDARY_CHARS note). A negated pair in clause 1 must not swallow
    // an independent, unnegated, genuine pair in clause 2: each clause is
    // evaluated on its own, and `detected` is true if ANY clause fires.
    const r = detectApiIntegration('This phase integrates no external API; we also integrate the Stripe API.');
    assert.strictEqual(r.detected, true);
  });

  test('a negation outside the lookback window does not suppress — fail-closed by design', () => {
    // This pins DELIBERATE fail-closed behavior, not an aspiration: "without"
    // sits outside hasNegatedVerb's 2-word lookback before the verb, and the
    // noun ("integration") precedes the verb ("Ships") so hasNegatedNoun's
    // verb-to-noun window never applies either. Widening the lookback to catch
    // this phrase would trade a cheap false positive (a one-line COVERAGE.md
    // declaration) for a silent false negative — a real external-API phase
    // slipping past a blocking gate — which is the dangerous direction.
    const r = detectApiIntegration('Ships without any API integration.');
    assert.strictEqual(r.detected, true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #2365 — detector false positives (first-party paths, unrelated same-line
// clauses, descriptive "API" prose) + the no-integration declaration.
// ──────────────────────────────────────────────────────────────────────────────

describe('#2365 detector false positives + no-integration declaration', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { detectApiIntegration, parseCoverageMatrix, validateCoverageMatrix } = mod;

  // ── acceptance #1: first-party framework route paths are not integration prose
  for (const [label, scope] of [
    ['Next.js route file in prose', 'Run integration tests for src/app/api/profile/route.test.ts'],
    ['route handler path with verb', 'Wire the src/app/api/profile/route.ts handler into the settings page'],
    ['inline-code span', 'Verify the `api` helper wiring end to end'],
  ]) {
    test(`NEGATIVE path/inline-code (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  // ── acceptance #2: verb + noun in unrelated clauses of one line
  test('NEGATIVE unrelated clauses: verb and noun in different clauses do not compound', () => {
    const r = detectApiIntegration(
      'Render the page and prove label endpoint, filename, and CSV/XLSX wiring.'
    );
    assert.strictEqual(r.detected, false);
  });

  // ── acceptance #3: descriptive/local "API" prose (threat-model shape).
  //    NOTE: the detector is FAIL-CLOSED — the classes below stay clean because
  //    they are unambiguously NOT external integration (no integration verb + a
  //    named service, or a first-party-qualified surface). Prose that pairs an
  //    integration VERB with an API noun ("wire … the internal endpoint") is a
  //    fail-closed POSITIVE now (see the "#2365 review — fail-open fixes" group);
  //    a one-line COVERAGE.md declaration dismisses it if it is a false alarm.
  for (const [label, scope] of [
    ['threat-model table cell', '| Tampering | Resolver-only API rejects arbitrary caller URLs. |'],
    ['compound-modifier mid-sentence', 'The Resolver-only API rejects arbitrary caller URLs.'],
    ['clause-initial capitalized prose', 'Internal API surface stays unchanged in this phase.'],
    ['localhost URL', 'Run integration tests against https://localhost:3000/api/profile'],
    ['bare external domain, no path', 'Integrate the design tokens from https://example.com into the theme'],
    ['internal-qualified service (no verb)', 'The internal Payments API remains unchanged.'],
    ['descriptor service + unrelated URL', 'Internal API surface stays unchanged; see https://example.com/style-guide.'],
    ['Windows path', 'Wire tests for src\\app\\api\\profile\\route.ts.'],
    ['loopback shorthand URL', 'Connect tests to http://127.1:3000/api/profile.'],
    ['protocol-only surface', 'Document the REST API behavior for maintainers.'],
    ['protocol-only surface (GraphQL)', 'Review the GraphQL API schema naming conventions.'],
    ['cross-clause coordinate action', 'Wire the header, then update the endpoint docs'],
  ]) {
    test(`NEGATIVE descriptive API prose (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `unexpected detection for [${label}]: ${scope}`);
    });
  }

  // ── acceptance #4: true positives preserved (the fail-open guard — a fix that
  // silences these is strictly worse than the false positives it removes).
  for (const [label, scope] of [
    ['canonical compound', 'integrate the Stripe API'],
    ['compound with trailing prose', 'Integrate the Stripe API for payment processing'],
    ['surface rule, no verb', 'Add a Spotify API client'],
    ['widest default-suite word gap', 'Consume the billing service over gRPC'],
    ['clause-initial service + URL corroboration', 'Stripe API — docs at https://stripe.com/docs/api'],
    ['webhook compound', 'Wire up the Slack webhook for deploy notifications'],
    ['verb + API-naming URL', 'Connect the app to https://api.stripe.com/v1 for charges'],
    ['slashed noun shorthand', 'Integrate the Stripe API/SDK for payments'],
    ['long single-clause gap', "Connect our checkout to Stripe's hosted payment processing service through its v1 endpoints."],
    ['non-http URI scheme', 'Connect the realtime client to wss://api.openai.com/v1/realtime.'],
    ['versioned noun shorthand', 'Integrate Stripe API/v2 for legacy payments.'],
    ['clause-initial service + object follower', 'Stripe API client for payments.'],
    ['inline-code package corroboration', 'Stripe SDK client via `@stripe/stripe-js` for payment intents.'],
    ['inline-code package as only noun', 'Integrate `stripe-sdk` for payment intents.'],
    ['later surface after rejected first candidate', 'Internal API facade around Stripe SDK payment flows.'],
    ['later surface after rejected modifier', 'Resolver-only API facade delegates to Stripe SDK for payments.'],
  ]) {
    test(`POSITIVE still fires (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `true-positive regression [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — fail-open fixes. Codex's second-round review found the
  //    round-2 tightening had over-corrected into FAIL-OPEN false negatives:
  //    realistic external-API prose that a BLOCKING gate silently let through.
  //    Under the fail-closed decision these MUST detect. This is the guard the
  //    handoff flagged in bold — a fix that lets these slip is strictly worse
  //    than the false positives it removes.
  for (const [label, scope] of [
    ['clause-initial service, plain follower (F1)', 'Stripe API for payment processing.'],
    ['external host that names an API vocab word (F2)', 'Connect the client to api.stripe.com/v1 for charges.'],
    ["vendor's first-party SDK (F3)", "Integrate Shopify's first-party SDK for checkout."],
    ['long single integration clause (F4)', "Integrate Stripe's hosted payment processing service into checkout using the vendor-recommended asynchronous flow for recurring subscriptions and one-time card payments through its API."],
    // Fail-closed reversal of the round-2 "internal" negatives: an integration
    // verb bound to an API noun detects even when the noun is "internal"-qualified
    // (Codex: "internal" can name the vendor's own API). Dismissed by declaration.
    ['integration verb + internal noun', 'Wire the settings form to the internal endpoint.'],
    ['coordinated integration verb + internal noun', 'Wire the form and document the internal API.'],
    ['distant same-clause verb+noun', 'Wiring the settings drawer means the profile page the sidebar and the account menu all reach the same internal endpoint'],
    // Qualification must NOT leak across a sentence/clause boundary.
    ['qualifier does not leak across a sentence', 'The cache is private. Stripe API client for payments.'],
    ['qualifier does not leak across a semicolon', 'Keep the cache private; Stripe API client for payments.'],
  ]) {
    test(`POSITIVE fail-open guard (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `fail-open regression [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — false-positive fixes. The reviews found false positives
  //    from over-broad heuristics; these MUST stay clean.
  for (const [label, scope] of [
    ['bare external domain, no path (F6)', 'Integrate the design tokens from https://example.com, document the endpoint terminology.'],
    ['internal UI component, separate action (F7)', 'Wire the SettingsForm, then document the endpoint props.'],
    ['protocol name as service (F8)', 'Document the REST API behavior for maintainers.'],
    ['finite continuation after a period', 'Wire the settings form. Document endpoint props.'],
    ['finite continuation after a semicolon', 'Wire the settings form; document endpoint props.'],
    ['finite continuation after a comma', 'Wire the form, document endpoint props.'],
    // Round-4 review: an external asset/link URL is NOT an API endpoint.
    ['external stylesheet asset URL', 'Wire stylesheet from https://cdn.example.com/assets/theme.css into the page.'],
    ['external URL with a query string', 'Wire the login link to https://example.com?next=/dashboard.'],
    ['external docs/repo link, not an API', 'Wire the docs link to https://github.com/org/repo into the footer'],
    // Round-4 review: an "-ing"-SPELLED noun ("billing") is not a participle.
    ['-ing-spelled noun in an unrelated clause', 'Wire the new settings form component, billing endpoint terminology remains unchanged.'],
    // Round-4 review: qualification survives markdown emphasis.
    ['descriptor qualifies through markdown emphasis', 'The **internal** Payments API remains unchanged.'],
  ]) {
    test(`NEGATIVE fail-closed FP guard (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `new false positive [${label}]: ${scope}`);
    });
  }

  // ── #2365 — DOCUMENTED fail-open LIMITATIONS. Detection is same-clause only
  //    (no cross-clause binding) and an external host is evidence only when it
  //    NAMES an API vocabulary word. Catching the cases below robustly needs a
  //    vendor dictionary + coreference, which the issue rules out in principle;
  //    every lexical rule tried across four review rounds traded a false
  //    negative for a false positive. These are cheaply covered by the
  //    COVERAGE.md declaration and rare in real phase prose. The tests pin the
  //    behavior as INTENTIONAL — a future maintainer re-adding a cross-clause or
  //    every-URL heuristic would reintroduce the false positives above.
  for (const [label, scope] of [
    ['service named only in a following participial clause', 'Integrate Stripe, exposing its endpoints for payment capture.'],
    ['service named only in a following finite clause', 'Integrate Stripe; use its OAuth endpoints for checkout.'],
    ['bare external host naming no vocab word', 'Connect the client to graph.microsoft.com:443/v1.0/me.'],
  ]) {
    test(`DOCUMENTED fail-open limitation stays clean (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, false, `limitation changed [${label}]: ${scope}`);
    });
  }

  // ── #2365 review — DOCUMENTED fail-closed tradeoffs. A clause-initial
  //    capitalized common word before "API" ("Payment API", "Search API") is
  //    treated as a service name, and a long clause pairs a verb with a distant
  //    noun. Codex judged these acceptable because the COVERAGE.md declaration
  //    is a cheap override; these tests exist so the behavior is INTENTIONAL and
  //    a future maintainer does not "fix" it back into a fail-open cap.
  for (const [label, scope] of [
    ['capitalized common word as service', 'Payment API remains unchanged in this refactor.'],
    ['capitalized common word as service (Search)', 'Search API types are generated locally.'],
    ['long clause pairs verb with distant noun', 'Wire the settings form to validation state so the designer can review field behavior and document every public API and endpoint symbol without changing runtime dependencies.'],
  ]) {
    test(`POSITIVE documented fail-closed tradeoff (${label}): "${scope}"`, () => {
      const r = detectApiIntegration(scope);
      assert.strictEqual(r.detected, true, `expected documented fail-closed detection [${label}]: ${scope}`);
    });
  }

  // ── #2365 review finding 7: inline code spans are matched WITHIN a line by
  //    design (phase scope prose is line-oriented). A CommonMark code span that
  //    wraps a newline is NOT recognized, so its contents are treated as prose —
  //    a documented, narrow limitation (fail-closed: a stray detection is
  //    dismissed by the declaration). This test pins the current behavior.
  test('multi-line inline code span is not treated as code (documented limitation)', () => {
    const r = detectApiIntegration('Documentation example: `integrate\nStripe API` only.');
    assert.strictEqual(r.detected, true);
  });

  // ── acceptance #5: a legitimate, non-fabricated "no external API" declaration
  test('declaration-only COVERAGE.md is VALID with zero rows (none_declared)', () => {
    const md = '# API Coverage\n\nNo external API integration: UI-only phase, no third-party surface.\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true, `expected valid, errors: ${v.errors.join('; ')}`);
    assert.strictEqual(v.none_declared, true);
    assert.deepStrictEqual(v.counts, { surface: 0, integrate: 0, optout: 0 });
  });

  test('declaration accepts the bold/em-dash form', () => {
    const md = '**No external API integration** — resolver work is local-only.\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.none_declared, true);
  });

  test('declaration WITHOUT a reason is not recognized (reasoned opt-out, like OPT-OUT rows)', () => {
    const v = validateCoverageMatrix('No external API integration\n');
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('declaration PLUS coverage rows is contradictory → invalid', () => {
    const md = [
      'No external API integration: nothing external here.',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /declar/i.test(e)), `errors: ${v.errors.join('; ')}`);
  });

  test('declaration inside a fenced code block is NOT recognized', () => {
    const md = '```markdown\nNo external API integration: example only.\n```\n';
    const p = parseCoverageMatrix(md);
    assert.notStrictEqual(p.declaration && p.declaration.none, true);
    const v = validateCoverageMatrix(md);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('declaration inside an HTML comment is NOT recognized', () => {
    const md = '<!--\nNo external API integration: quoted example only.\n-->\n';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  test('blockquoted declaration is NOT recognized (quoted text is not a decision)', () => {
    const v = validateCoverageMatrix('> No external API integration: copied from the old PLAN.md.\n');
    assert.strictEqual(v.valid, false);
    assert.notStrictEqual(v.none_declared, true);
  });

  // ── A hostile line repeating one verb+noun pair thousands of times must
  //    collapse to a SINGLE signal — pairing is by distinct term, not a
  //    match×match cross product. Asserting the signal count is a deterministic
  //    proxy for that linearity (no wall-clock timing — Clock Seams rule).
  test('hostile repeated-term line dedups to one signal', () => {
    const s = 'integrate api '.repeat(10000); // 140 KB single line, 10k pairs
    const r = detectApiIntegration(s);
    assert.strictEqual(r.detected, true);
    assert.strictEqual(
      r.signals.length,
      1,
      `repeated verb+noun pair must dedup to one signal, got ${r.signals.length}`
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// #2365 review — hardening-constant boundaries + parser fuzz property
// ──────────────────────────────────────────────────────────────────────────────

describe('#2365 hardening-constant boundaries + parser property', () => {
  const { detectApiIntegration, validateCoverageMatrix } = require(MODULE_PATH);

  // SERVICE_SURFACE_API_RE bounds the service token to `[A-Z][A-Za-z0-9_-]{1,40}`
  // (2..41 chars) so a hostile hyphen run cannot drive O(n^2) backtracking.
  test('surface service name at the 41-char limit still fires', () => {
    const svc = 'S' + 'a'.repeat(40); // exactly 41 chars
    assert.strictEqual(detectApiIntegration(`${svc} API`).detected, true);
  });
  test('surface service name at 42 chars is past the length bound (surface path)', () => {
    const svc = 'S' + 'a'.repeat(41); // 42 chars, no integration verb → surface-only
    assert.strictEqual(detectApiIntegration(`${svc} API`).detected, false);
  });

  // QUALIFIER_LOOKBACK (24): a first-party descriptor only suppresses the surface
  // within the bounded lookback window. Pin the EXACT constant: 8-char "internal"
  // + 16 spaces places its start at offset-24 (the window edge) → still qualifies;
  // + 17 spaces pushes its start one char outside → truncated → no longer
  // qualifies. Both would pass for any lookback in ~9..37, so use the exact pair.
  test('internal qualifier exactly at the 24-char window edge still suppresses the surface', () => {
    const atEdge = 'internal' + ' '.repeat(16) + 'Payments API'; // start at offset-24
    assert.strictEqual(detectApiIntegration(atEdge).detected, false);
  });
  test('internal qualifier one char past the 24-char window no longer qualifies (fires)', () => {
    const pastEdge = 'internal' + ' '.repeat(17) + 'Payments API'; // start at offset-25
    assert.strictEqual(detectApiIntegration(pastEdge).detected, true);
  });

  // REASON_MAX_LEN (200): the no-integration declaration reason is length-bounded.
  test('declaration reason at 200 chars is valid; 201 is rejected', () => {
    const at = 'No external API integration: ' + 'x'.repeat(200) + '\n';
    const over = 'No external API integration: ' + 'x'.repeat(201) + '\n';
    assert.strictEqual(validateCoverageMatrix(at).valid, true);
    const v = validateCoverageMatrix(over);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /exceeds 200 chars/.test(e)), `errors: ${v.errors.join('; ')}`);
  });

  // Fuzz the tokenizer / clause splitter / masking (scanLineTokens, splitClauses,
  // collectTermMatches) with adversarial tokens — slashes, backticks, URLs,
  // clause punctuation. The detector must never throw, keep its typed shape, hold
  // `detected ⇔ signals.length > 0`, and be deterministic on any input.
  test('property: parser is total, shape-stable, and deterministic on arbitrary prose', () => {
    const token = fc.oneof(
      fc.constantFrom(
        'integrate', 'connect', 'wire', 'the', 'Stripe', 'API', 'SDK', 'endpoint',
        'api', 'internal', 'Resolver-only', '/', '//', '`', 'https://api.x.com/v1',
        'src/app/api/x.ts', 'graph.microsoft.com/v1'
      ),
      fc.stringMatching(/^[A-Za-z0-9/.:`_-]{0,12}$/)
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 40 }),
        fc.constantFrom(' ', ', ', '. ', '; ', ' | ', '\n'),
        (words, sep) => {
          const line = words.join(sep);
          const r = detectApiIntegration(line);
          assert.ok(typeof r.detected === 'boolean' && Array.isArray(r.signals), 'typed shape');
          assert.strictEqual(r.detected, r.signals.length > 0, 'detected ⇔ signals present');
          assert.deepStrictEqual(detectApiIntegration(line), r, 'deterministic');
          return true;
        }
      ),
      { numRuns: 300 }
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Matrix parse / validate / render
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — parse / validate (#1562 acceptance #2)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { parseCoverageMatrix, validateCoverageMatrix, renderCoverageMatrix } = mod;

  test('parse markdown table — header + 2 rows', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| playlists | OPT-OUT | not needed yet |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'table');
    assert.strictEqual(p.rows.length, 2);
    assert.strictEqual(p.rows[0].capability, 'search');
    assert.strictEqual(p.rows[0].decision, 'INTEGRATE');
    assert.strictEqual(p.rows[1].decision, 'OPT-OUT');
    assert.strictEqual(p.rows[1].reason, 'not needed yet');
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse fenced ```coverage JSON block', () => {
    const md = [
      'Some prose.',
      '',
      '```coverage',
      '[{"capability":"search","decision":"INTEGRATE","reason":""},',
      ' {"capability":"skip","decision":"OPT-OUT","reason":"out of scope"}]',
      '```',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.strictEqual(p.rows.length, 2);
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse empty / non-matrix input → format none, no rows, no errors', () => {
    const p = parseCoverageMatrix('# Notes\n\nNothing here.');
    assert.strictEqual(p.format, 'none');
    assert.strictEqual(p.rows.length, 0);
    assert.strictEqual(p.errors.length, 0);
  });

  test('parse non-string → empty result, no throw', () => {
    const p = parseCoverageMatrix(undefined);
    assert.strictEqual(p.rows.length, 0);
  });

  test('parse rejects malformed fenced JSON with an error', () => {
    const md = '```coverage\n{not json}\n```';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.ok(p.errors.length > 0);
    assert.strictEqual(p.rows.length, 0);
  });

  test('#2366 bug 1: summary table outside the matrix is not parsed as data', () => {
    const md = [
      '# API Coverage',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '',
      '## Coverage summary',
      '',
      '| tier | INTEGRATE | OPT-OUT |',
      '|---|---|---|',
      '| phase 8 | 12 | 6 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 1, 'only the matrix row, not the summary table');
    assert.strictEqual(p.rows[0].capability, 'search');
    assert.strictEqual(p.errors.length, 0);
  });

  test('#2366 bug 2: multi-section matrix with repeated headers is parsed', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '',
      '## Transferred',
      '',
      '| capability | decision | reason |',
      '|---|---|---|',
      '| widget | OPT-OUT | deferred to 9 |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 2, 'both sections should parse');
    assert.strictEqual(p.rows[0].capability, 'search');
    assert.strictEqual(p.rows[1].capability, 'widget');
    assert.strictEqual(p.errors.length, 0);
  });

  test('#2366 bug 3: markdown emphasis on decision is stripped', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| skip | **OPT-OUT** | not needed yet |',
    ].join('\n');
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.rows.length, 2);
    assert.strictEqual(p.rows[1].decision, 'OPT-OUT', '**OPT-OUT** should parse as OPT-OUT');
    assert.strictEqual(p.errors.length, 0);
  });

  // ── validate: boundaries 0 / 1 / 2 rows (limit-1, limit, limit+1) ────────
  test('validate — empty matrix is invalid (acceptance #1: surface must be enumerated)', () => {
    const v = validateCoverageMatrix('| capability | decision | reason |\n|---|---|---|');
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /empty/i.test(e)));
    assert.strictEqual(v.counts.surface, 0);
  });

  test('validate — single INTEGRATE row is valid (limit)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| search | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 1);
    assert.strictEqual(v.counts.integrate, 1);
    assert.strictEqual(v.counts.optout, 0);
  });

  test('validate — two rows valid (limit+1)', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| playlists | OPT-OUT | not needed |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 2);
    assert.strictEqual(v.counts.optout, 1);
  });

  // ── acceptance #2: every OPT-OUT must carry a reason ─────────────────────
  test('validate — OPT-OUT without reason is INVALID (acceptance #2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| skip | OPT-OUT | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /missing reason/i.test(e)));
  });

  test('validate — OPT-OUT with one-char reason is valid (boundary)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| skip | OPT-OUT | x |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, true);
  });

  test('validate — duplicate capability is invalid (matrix is a set of decisions)', () => {
    const md = [
      '| capability | decision | reason |',
      '|---|---|---|',
      '| search | INTEGRATE | |',
      '| Search | OPT-OUT | dup |',
    ].join('\n');
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /duplicate/i.test(e)));
  });

  test('validate — empty capability name is invalid', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n|  | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /empty capability/i.test(e)));
  });

  // ── review-fix coverage: parser robustness (#1562 code review M1/M2/L1/L2) ──
  test('validate — invalid decision cell in a table row is an error, not silently dropped (M1)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| x | INTEGRAT | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /not in \{INTEGRATE, OPT-OUT\}/i.test(e)));
  });

  test('validate — a pipe in a cell adds extra columns → invalid (M2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| x | OPT-OUT | a|b |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /columns|pipe/i.test(e)));
  });

  test('validate — a pipe in a JSON-fence reason → invalid (M2)', () => {
    const md = '```coverage\n[{"capability":"x","decision":"OPT-OUT","reason":"a|b"}]\n```';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
  });

  test('validate — capability over the length cap → invalid (S3 bound)', () => {
    const longCap = 'x'.repeat(81);
    const md = `| capability | decision | reason |\n|---|---|---|\n| ${longCap} | INTEGRATE | |`;
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.valid, false);
    assert.ok(v.errors.some((e) => /exceeds/i.test(e)));
  });

  test('parse — case-insensitive ```Coverage fence is accepted (L1)', () => {
    const md = '```Coverage\n[{"capability":"a","decision":"INTEGRATE","reason":""}]\n```';
    const p = parseCoverageMatrix(md);
    assert.strictEqual(p.format, 'json');
    assert.strictEqual(p.rows.length, 1);
  });

  test('parse — a single-dash cell is not mistaken for a separator (L2)', () => {
    const md = '| capability | decision | reason |\n|---|---|---|\n| - | INTEGRATE | |';
    const v = validateCoverageMatrix(md);
    assert.strictEqual(v.counts.surface, 1);
    assert.ok(v.valid, 'a capability named "-" is legal');
  });

  // ── render round-trip (manual) ───────────────────────────────────────────
  test('render → parse round-trips a valid matrix', () => {
    const rows = [
      { capability: 'search', decision: 'INTEGRATE', reason: '' },
      { capability: 'playlists', decision: 'OPT-OUT', reason: 'not needed yet' },
    ];
    const rendered = renderCoverageMatrix(rows);
    const v = validateCoverageMatrix(rendered);
    assert.strictEqual(v.valid, true);
    assert.strictEqual(v.counts.surface, 2);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Property test: parse/render bijectivity (RULESET.TESTS property-based)
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — parse/render bijection (fast-check)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib". Underlying: ${err.message}`);
  }
  const { renderCoverageMatrix, validateCoverageMatrix } = mod;

  test('any valid row set renders and re-validates to the same counts', () => {
    const matrixGen = fc.uniqueArray(validRowGen, {
      minLength: 1,
      maxLength: 8,
      selector: (r) => r.capability.toLowerCase(),
    });
    fc.assert(
      fc.property(matrixGen, (rows) => {
        const rendered = renderCoverageMatrix(rows);
        const v = validateCoverageMatrix(rendered);
        // Injected reason guarantees validity; any invalid result is a parser bug.
        assert.strictEqual(v.valid, true);
        assert.strictEqual(v.counts.surface, rows.length);
        return true;
      }),
      { numRuns: 100 }
    );
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Document-shaped property (#2371): the bijection test above generates ROWS and
// renders them through the writer, so the document shape is a constant — it
// cannot generate a second table, a decoy table, or surrounding prose, and so
// cannot fail against #2366's bugs. This property generates the DOCUMENT
// space instead: a canonical matrix interleaved with content a real
// COVERAGE.md may legitimately contain that is NOT the matrix. See
// tests/fixtures/representative/README.md and CONTRIBUTING.md's "Fixture
// provenance" section for the full rationale.
// ──────────────────────────────────────────────────────────────────────────────

describe('coverage matrix — document-shaped fast-check (extract-exactly-canonical, #2371)', () => {
  let mod;
  try {
    mod = require(MODULE_PATH);
  } catch (err) {
    throw new Error(`Could not require ${MODULE_PATH}. Run "npm run build:lib" first. Underlying: ${err.message}`);
  }
  const { parseCoverageMatrix, renderCoverageMatrix } = mod;

  // Uses the shared capabilityGen/rowGen/validRowGen declared at module scope
  // above (same generators the bijection test uses), so the two properties
  // exercise the same canonical-row space and can't silently desync.
  const canonicalMatrixGen = fc.uniqueArray(validRowGen, {
    minLength: 1,
    maxLength: 5,
    selector: (r) => r.capability.toLowerCase(),
  });

  // Decoy blocks: content a document may legitimately contain that is NOT the
  // canonical matrix. Kept to three explicit, independently-readable shapes
  // rather than a generic "random markdown" generator — a combinatorial but
  // opaque generator is exactly the kind of cleverness that's unrunnable to
  // debug when it fails (Kernighan's Law).
  const proseDecoyGen = fc.constantFrom(
    '## Notes\n\nSee the ADR for background.',
    'This phase also touches the auth helper.',
    '## Risks\n\n- Rollout risk is low.',
  );

  const summaryTableDecoyGen = fc
    .record({
      label: fc.stringMatching(/^[a-z][a-z0-9 ]{0,10}$/),
      integrateCount: fc.nat({ max: 50 }),
      optoutCount: fc.nat({ max: 50 }),
    })
    .map(
      ({ label, integrateCount, optoutCount }) =>
        `## Coverage summary\n\n| tier | INTEGRATE | OPT-OUT |\n|---|---|---|\n` +
        `| ${label} | ${integrateCount} | ${optoutCount} |`
    );

  const secondSectionMatrixGen = fc
    .uniqueArray(validRowGen, { minLength: 1, maxLength: 3, selector: (r) => r.capability.toLowerCase() })
    .map((rows) => `## Transferred to a later phase\n\n${renderCoverageMatrix(rows)}`);

  const decoyGen = fc.oneof(proseDecoyGen, summaryTableDecoyGen, secondSectionMatrixGen);

  const documentGen = fc.record({
    canonicalRows: canonicalMatrixGen,
    decoysBefore: fc.array(decoyGen, { maxLength: 2 }),
    decoysAfter: fc.array(decoyGen, { maxLength: 2 }),
  });

  // #2371's own test-runner (gsd-test / gsd-test-runner v1.6.2) has no concept
  // of node:test's `todo` option: its JSONL result parser
  // (internal/pipeline/parse.go's parseJSONL, gsd-test-runner repo) only
  // recognizes `kind: "pass" | "fail"` and hard-errors on anything else, so a
  // `{ todo: true }` test whose body throws is still counted as a failure in
  // the tool's own verdict — verified directly against that source, not
  // assumed. So this property uses fc's non-throwing `fc.check` (returns
  // `RunDetails` instead of throwing — see fast-check's runners docs) and
  // asserts on `.failed` directly: today the invariant genuinely does NOT
  // hold (that is #2366), so `report.failed === true` is an honest,
  // non-vacuous, currently-PASSING characterization of today's known-broken
  // reality — not a fake pass. The moment #2366 makes the invariant hold for
  // real, `report.failed` becomes `false` and THIS assertion fails loudly,
  // forcing whoever's fix landed to notice and flip it. The fix itself stays
  // owned by #2366.
  test(
    'given a document containing exactly one canonical matrix plus arbitrary other content, ' +
      'the parser extracts exactly that matrix\'s rows and ignores everything else ' +
      '(currently violated — #2366)',
    () => {
      const report = fc.check(
        fc.property(documentGen, ({ canonicalRows, decoysBefore, decoysAfter }) => {
          const canonicalBlock = renderCoverageMatrix(canonicalRows);
          const doc = [...decoysBefore, canonicalBlock, ...decoysAfter].join('\n\n');

          const result = parseCoverageMatrix(doc);

          const expectedByCap = new Map(canonicalRows.map((r) => [r.capability.toLowerCase(), r]));
          const actualByCap = new Map(result.rows.map((r) => [r.capability.toLowerCase(), r]));

          if (actualByCap.size !== expectedByCap.size) return false;
          for (const [cap, expected] of expectedByCap) {
            const actual = actualByCap.get(cap);
            if (!actual || actual.decision !== expected.decision) return false;
          }
          return result.errors.length === 0;
        }),
        { numRuns: 100 }
      );
      assert.strictEqual(
        report.failed,
        true,
        'This property is expected to be VIOLATED today (#2366 — a decoy summary table or a ' +
          'second canonical-schema section corrupts the result or spuriously errors). If this ' +
          'assertion fails, the property now HOLDS — #2366 appears fixed; replace this ' +
          'characterization with a real fc.assert of the invariant.'
      );
    }
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// CLI entry point (STDIN → exit codes mirror grep, like assumption-delta)
// ──────────────────────────────────────────────────────────────────────────────

describe('api-coverage CLI — STDIN + exit codes', () => {
  const CLI = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'api-coverage.cjs');

  function runCli(stdin) {
    const r = spawnSync(process.execPath, [CLI, '--json'], {
      input: stdin,
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test('exit 0 + JSON IR when integration detected', () => {
    const r = runCli('Integrate the Stripe API for payments');
    assert.strictEqual(r.exitCode, 0);
    const body = JSON.parse(r.stdout);
    assert.strictEqual(body.detected, true);
    assert.ok(Array.isArray(body.signals));
  });

  test('exit 1 when no integration', () => {
    const r = runCli('Refactor the login helper');
    assert.strictEqual(r.exitCode, 1);
  });
});
