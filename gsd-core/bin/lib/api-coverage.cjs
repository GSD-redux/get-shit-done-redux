"use strict";
/**
 * API-Coverage detector + matrix validator (#1562).
 *
 * The enforcement half of "Full API Coverage by Default — Opt Out, Never Opt In."
 * When a phase integrates an external API/service/SDK, the planner must produce a
 * coverage matrix (COVERAGE.md) enumerating the API's capability surface; every
 * non-integrated capability is an explicit, reasoned opt-out. The seal-time gate
 * (capabilities/ai-integration, verify:pre) consumes this module to (a) detect
 * whether a phase integrates an external API and (b) validate the produced matrix.
 *
 * Design notes (rubber-duck'd):
 *  - DETERMINISTIC + TYPED IR. Both the "does this phase integrate an external
 *    API?" decision and the "is this matrix complete?" decision are pure
 *    functions returning typed IR, not LLM judgments — so the low-false-positive
 *    guarantee (acceptance criterion #4) and the completeness guarantee
 *    (acceptance #2) are testable. Mirrors assumption-delta.cts (#1561).
 *  - COMPOUND SIGNAL for low false positives. A bare word like "api" appears in
 *    countless non-integration phases ("the public API of UserController"). The
 *    detector requires an INTEGRATION VERB and an EXTERNAL-API NOUN in the SAME
 *    CLAUSE (#2365 — same-line co-occurrence across unrelated clauses over-fired;
 *    the clause boundary, not a word-gap cap, is the relationship test), or an
 *    explicit "<Service> API/SDK" phrase naming a real service. Single weak
 *    tokens do not fire. This is the issue's "low false-positive trigger" made
 *    mechanical.
 *  - CODE AND PATHS ARE NOT PROSE. Fenced code blocks and inline code spans are
 *    stripped first (markdown-sectionizer seam), and path-shaped tokens
 *    (`src/app/api/...`, URLs) are masked, so a trigger term inside code or a
 *    first-party route path does not fire (#2365).
 *  - NO-INTEGRATION DECLARATION (#2365 acceptance #5). A COVERAGE.md consisting
 *    of `No external API integration: <reason>` is a valid, reasoned way for a
 *    phase to state that no external surface exists — the alternative to
 *    fabricating a matrix row when the detector is overruled by a human.
 *  - THE DETECTOR IS A FALLBACK. The primary path is the plan:pre contribution
 *    prompting COVERAGE.md creation. The detector runs only when COVERAGE.md is
 *    ABSENT, to catch the "nobody decided" case (acceptance #1). Its precision
 *    therefore matters but is not the only line of defense.
 *  - MATRIX FORMAT. The matrix is a markdown table (human-editable, diff-friendly)
 *    with a header row `| capability | decision | reason |` and one row per
 *    capability. decision ∈ {INTEGRATE, OPT-OUT}. An OPT-OUT row MUST carry a
 *    non-empty reason. A fenced ```coverage JSON block is also accepted for
 *    machine-generated matrices. This dual shape is bijective (parse/render
 *    round-trip) and covered by a fast-check property test.
 *  - ADDITIVE-ONLY VOCABULARY (Hyrum's Law). Once shipped, the verb/noun sets
 *    are depended-upon interfaces; they only grow. Tunable via the `terms`
 *    parameter so teams can widen them without forking.
 *
 * Public API:
 *   detectApiIntegration(text, terms?) -> { detected, signals, terms }
 *   parseCoverageMatrix(text) -> { rows, errors, format }
 *   validateCoverageMatrix(text) -> { valid, errors, counts }
 *   renderCoverageMatrix(rows) -> string
 *   DEFAULT_API_COVERAGE_TERMS
 *
 * CLI:
 *   echo "$SCOPE" | node gsd-core/bin/lib/api-coverage.cjs [--json]
 *     exit 0 = integration detected, 1 = none, 2 = startup error
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_API_COVERAGE_TERMS = void 0;
exports.detectApiIntegration = detectApiIntegration;
exports.parseCoverageMatrix = parseCoverageMatrix;
exports.validateCoverageMatrix = validateCoverageMatrix;
exports.renderCoverageMatrix = renderCoverageMatrix;
const markdown_sectionizer_cjs_1 = require("./markdown-sectionizer.cjs");
/**
 * Curated default trigger vocabulary. ADDITIVE-ONLY (Hyrum's Law). Tunable via
 * the `terms` parameter.
 *
 * VERBS are deliberately conservative: common verbs like "add", "use", "call",
 * "implement" are EXCLUDED because they appear in nearly every phase and would
 * make the gate fire on prose that has nothing to do with an external API. The
 * verbs kept all connote BRINGING IN an external surface.
 *
 * NOUNS name an external-API surface. Bare "client" is excluded — too ambiguous
 * (client-side UI vs API client). "service" alone is excluded (internal
 * services); a phase integrating an external service virtually always pairs it
 * with "API"/"SDK"/"REST"/etc., which the compound verb+noun rule captures.
 */
exports.DEFAULT_API_COVERAGE_TERMS = {
    verbs: [
        'integrate',
        'integrates',
        'integrating',
        'integration',
        'wrap',
        'wraps',
        'wrapping',
        'connect',
        'connects',
        'connecting',
        'consume',
        'consumes',
        'consuming',
        'wire',
        'wires',
        'wiring',
        'onboard',
        'onboarding',
        'adopt',
        'adopts',
        'adopting',
    ],
    nouns: [
        'api',
        'apis',
        'sdk',
        'sdks',
        'rest',
        'graphql',
        'grpc',
        'endpoint',
        'endpoints',
        'oauth',
        'oauth2',
        'webhook',
        'webhooks',
        'mcp',
    ],
};
/** Hardening caps for the tunable vocabulary (hostile `--terms` defense). */
const MAX_TERMS_PER_KIND = 200;
const MAX_TERM_LEN = 32;
/**
 * Field-length caps for matrix cell values. Cell content flows from a
 * semi-trusted COVERAGE.md into the gate `message` that the orchestrator LLM
 * reads, so it is bounded to keep the prompt-injection surface small and to
 * document the format contract (short, single-line prose — not paragraphs).
 */
const CAPABILITY_MAX_LEN = 80;
const REASON_MAX_LEN = 200;
function normalizeTerms(list) {
    if (!Array.isArray(list))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of list) {
        if (typeof raw !== 'string')
            continue;
        const t = raw.trim().toLowerCase().slice(0, MAX_TERM_LEN);
        if (!t || !/[a-z0-9]/.test(t))
            continue;
        if (seen.has(t))
            continue;
        seen.add(t);
        out.push(t);
        if (out.length >= MAX_TERMS_PER_KIND)
            break;
    }
    return out;
}
function resolveTerms(terms) {
    const merge = (key) => {
        const t = terms && terms[key];
        return Array.isArray(t) ? normalizeTerms(t) : [...exports.DEFAULT_API_COVERAGE_TERMS[key]];
    };
    return { verbs: merge('verbs'), nouns: merge('nouns') };
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function makeSnippet(line, anchor) {
    const cleaned = line.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= 120)
        return cleaned;
    const idx = cleaned.toLowerCase().indexOf(anchor);
    if (idx < 0)
        return cleaned.slice(0, 120);
    const start = Math.max(0, idx - 50);
    const end = Math.min(cleaned.length, idx + anchor.length + 50);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < cleaned.length ? '…' : '';
    return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}
/** `<Service> API` / `<Service> SDK` — a capitalized proper noun immediately
 *  followed by API/SDK. Strong signal on its own (no verb required).
 *
 *  STOPWORDS guard against the false positive where an ordinary capitalized
 *  sentence starter ("The API …", "An SDK …", "Our REST …") matches the
 *  `[A-Z]\w+ API` shape. Those are common English, not a service name, so they
 *  are rejected before counting as a surface signal (acceptance #4 — low false
 *  positives). */
// Service-name length is bounded ({1,40}) so a hostile "A-A-A-…-A-x" run cannot
// drive the greedy group into O(n^2) backtracking (#2365 review). Nearly all
// vendor names fit; a >41-char service token before API/SDK would be missed by
// this surface path (it would still fire via the compound verb+noun rule) —
// an accepted bound.
const SERVICE_SURFACE_API_RE = /\b([A-Z][A-Za-z0-9_-]{1,40})\s+(API|SDK|REST|GraphQL)\b/;
const SERVICE_STOPWORDS = new Set([
    'the', 'an', 'a', 'our', 'this', 'these', 'that', 'those', 'new', 'add',
    'use', 'your', 'my', 'no', 'some', 'any', 'all', 'each', 'every', 'both',
    'if', 'when', 'while', 'with', 'via', 'using', 'into', 'its', 'their',
    'we', 'you', 'they', 'it',
]);
/** #2365 — the detector is FAIL-CLOSED: it leans toward detecting, because a
 *  false positive is cheaply dismissed by a one-line COVERAGE.md "no external
 *  API integration" declaration, whereas a false NEGATIVE silently lets a real
 *  external-API phase past a BLOCKING gate. So the only prose the detector
 *  actively suppresses is the classes that are unambiguously NOT external
 *  integration: first-party route paths, verb/noun in unrelated clauses, and
 *  descriptive/protocol "<Word> API" prose with no named service.
 *
 *  CLAUSE_BOUNDARY_RE: a verb and a noun form ONE compound action only inside
 *  one grammatical clause — sentence punctuation and table-cell walls (`|`)
 *  end a clause. `-` is deliberately absent (it would split hyphenated words).
 *  There is deliberately NO word-gap cap inside a clause: a cap cannot separate
 *  a genuine long integration clause (F4, 21 words) from a long internal-UI
 *  clause (18 words) — the clause boundary is the only sound signal, and the
 *  declaration handles the residual false positives. */
const CLAUSE_BOUNDARY_RE = /[,;:.!?|()—–]/;
/** Same character class as CLAUSE_BOUNDARY_RE, as a set — for scanning a token's
 *  trailing punctuation without an unanchored `[…]+$` regex, whose backtracking
 *  is O(n^2) on a long punctuation run (#2365 review). */
const CLAUSE_BOUNDARY_CHARS = new Set([',', ';', ':', '.', '!', '?', '|', '(', ')', '—', '–']);
/*  DELIBERATELY NO cross-clause binding. Detection is same-clause only. Binding
 *  a verb in one clause to a noun in another ("Integrate Stripe, exposing its
 *  endpoints"; "Integrate Stripe; use its endpoints") requires knowing "Stripe"
 *  is a vendor and "its" refers to it — a vendor dictionary + coreference, which
 *  trek-e's brief rules out in principle. Every lexical cross-clause rule tried
 *  (word-gap cap, participle continuation) traded a false negative for a false
 *  positive across four review rounds. So a service named ONLY in a clause
 *  separate from its API noun, with no explicit `<Service> API` surface, is a
 *  DOCUMENTED fail-open limitation — cheaply covered by the COVERAGE.md
 *  declaration and rare in real phase prose, which says "integrate the X API". */
/** In the `<Service> API|SDK` surface position, these capture words are NOT a
 *  named third-party service: locality/scope descriptors ("Internal API",
 *  "Public API") and bare protocol names ("REST API", "GraphQL API"). A real
 *  vendor name (Stripe, Shopify) is none of these, so rejecting them costs no
 *  true positives while killing the descriptive-prose false positives (#2365
 *  acceptance #3, review F8). */
const SURFACE_DESCRIPTOR_WORDS = new Set([
    'internal', 'external', 'public', 'private', 'local', 'in-house', 'first-party',
    'generic', 'shared', 'common', 'legacy', 'rest', 'restful', 'graphql', 'grpc',
    'soap', 'rpc', 'http', 'https', 'json', 'xml',
]);
/** Locality qualifiers that, when they immediately precede a `<Service> API`,
 *  mark it as first-party ("internal Payments API") — negative evidence for an
 *  EXTERNAL-API surface signal. Only unambiguously-internal words: "external"
 *  is deliberately absent (an external API IS external). */
const INTERNAL_DESCRIPTORS = new Set(['internal', 'in-house', 'local', 'first-party', 'private']);
/** A capitalized compound modifier ("Resolver-only", "Read-only", "E-commerce"
 *  — lowercase letter right after the hyphen) is an adjective phrase, not a
 *  service name. Real hyphenated services capitalize the second segment
 *  ("T-Mobile"). */
const COMPOUND_MODIFIER_RE = /^[A-Z][A-Za-z0-9]*-[a-z]/;
const URL_TOKEN_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_URL_RE = /^[([<"'`]*[a-z][a-z0-9+.-]*:\/\/(?:localhost|127(?:\.\d{1,3}){1,3}|0\.0\.0\.0|\[::1\])(?=[:/?#]|$)/i;
/** A scheme-less token that STARTS with a dotted hostname whose final label is
 *  alphabetic ("api.stripe.com/v1") — a bare external API host. A first-party
 *  route path ("src/app/api/…") has no dotted head, and an IP host ("127.1/…")
 *  has a numeric final label, so neither matches (#2365 review F2). */
const DOMAIN_HEAD_RE = /^[([<"'`]*(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?=[:/?#]|$)/i;
/** Mask whitespace-delimited tokens with an interior `/` — file paths, framework
 *  routes (`src/app/api/...`), URLs. They are references, not integration prose
 *  (#2365 root cause 2: `/` counted as a word boundary, so first-party route
 *  paths matched the noun vocabulary). Two carve-outs keep genuine signals:
 *   - a slashed token whose segments are ALL noun-vocabulary words ("API/SDK",
 *     "REST/GraphQL") is prose shorthand, not a path — left unmasked;
 *   - a non-local URL is masked, but noun terms inside it are collected as
 *     compound-rule evidence (the old detector caught "connect to
 *     https://api.stripe.com" via the `api` segment; losing that would
 *     fail-open). */
function scanLineTokens(line, nounRe, nounSet) {
    const urlNouns = [];
    let masked = '';
    const tokenRe = /\S+/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(line)) !== null) {
        const rawTok = m[0];
        masked += line.slice(last, m.index);
        last = m.index + rawTok.length;
        // Peel trailing clause-boundary punctuation off the token and keep it
        // LITERAL in `masked` — masking it away would erase a clause split and pair
        // unrelated verb/noun across it (#2365 review F6: "…example.com, document…").
        // A backward char scan (not a `[…]+$` regex) keeps this linear.
        let trailLen = 0;
        while (trailLen < rawTok.length && CLAUSE_BOUNDARY_CHARS.has(rawTok[rawTok.length - 1 - trailLen])) {
            trailLen++;
        }
        const trail = trailLen ? rawTok.slice(rawTok.length - trailLen) : '';
        const tok = trailLen ? rawTok.slice(0, rawTok.length - trailLen) : rawTok;
        if (!/\S[\\/]\S/.test(tok)) {
            masked += rawTok;
            continue;
        }
        const segments = tok.split(/[\\/]/).map((s) => s.replace(/[^A-Za-z0-9]/g, ''));
        if (segments.every((s) => s.length > 0 && (nounSet.has(s.toLowerCase()) || /^v\d+$/i.test(s))) &&
            segments.some((s) => nounSet.has(s.toLowerCase()))) {
            masked += rawTok; // "API/SDK", "API/v2" — noun shorthand, not a path
            continue;
        }
        // A scheme URL or a bare external hostname is an external dependency
        // reference: mask it from prose but keep it as compound-rule evidence. A
        // first-party route path has neither a scheme nor a dotted host, so it is
        // masked WITHOUT contributing nouns (#2365 root cause 2).
        // A non-local URL that NAMES an API vocabulary word ("api.stripe.com/v1")
        // is external-dependency evidence, so its vocab nouns feed the compound
        // rule. We deliberately do NOT treat every path-bearing URL as an endpoint:
        // that fired on ordinary asset/link URLs ("…/theme.css", "…?next=/x") and
        // recreated routine UI-phase false positives (#2365 review). A bare external
        // host that names no vocabulary word ("graph.microsoft.com") and is not
        // written as "<Service> API" is therefore a DOCUMENTED fail-open limitation.
        const isSchemeUrl = URL_TOKEN_RE.test(tok) && !LOCAL_URL_RE.test(tok);
        const isDomainUrl = !URL_TOKEN_RE.test(tok) && DOMAIN_HEAD_RE.test(tok);
        if (nounRe && (isSchemeUrl || isDomainUrl)) {
            for (const f of collectTermMatches(nounRe, tok)) {
                urlNouns.push({ term: f.term, start: m.index, end: m.index + tok.length });
            }
        }
        masked += ' '.repeat(tok.length) + trail;
    }
    masked += line.slice(last);
    return { masked, urlNouns };
}
/** All term matches in a clause, with offsets. `re` must be global with the
 *  term in group 2 and a consumed leading boundary in group 1. */
function collectTermMatches(re, clause) {
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(clause)) !== null) {
        const start = m.index + (m[1] || '').length;
        out.push({ term: (m[2] || '').toLowerCase(), start, end: start + (m[2] || '').length });
        if (m[0].length === 0)
            re.lastIndex++;
    }
    return out;
}
/** Split a line into clause segments, keeping each segment's start offset so
 *  line-level spans (masked URL tokens) can be mapped into their clause. */
function splitClauses(masked) {
    const out = [];
    let start = 0;
    for (let i = 0; i <= masked.length; i++) {
        if (i === masked.length || CLAUSE_BOUNDARY_RE.test(masked[i])) {
            out.push({ text: masked.slice(start, i), start });
            start = i + 1;
        }
    }
    return out;
}
/**
 * Detect whether phase-scope prose describes integrating an external API/SDK.
 *
 * FAIL-CLOSED: it leans toward detecting, because a false positive is dismissed
 * by a one-line COVERAGE.md declaration while a false negative silently slips a
 * real external-API phase past a blocking gate. It fires when EITHER:
 *   (a) an integration VERB and an API NOUN share one CLAUSE ("integrate the
 *       Stripe API", "Connect … to api.stripe.com") — the clause boundary is the
 *       whole relationship test, so verb/noun in DIFFERENT clauses do not pair
 *       (#2365 acceptance #2). There is NO cross-clause binding: a service named
 *       only in a clause separate from its API noun is a documented limitation.
 *   (b) an explicit `<Service> API|SDK|REST|GraphQL` surface names a service
 *       that is not a stopword, a locality/protocol descriptor, a compound
 *       modifier, or first-party-qualified ("Stripe API", "Spotify SDK").
 *
 * Fenced code, inline code spans, and path-shaped tokens are excluded before
 * matching. A package-shaped inline span (`@stripe/stripe-js`, `stripe-sdk`)
 * and a URL that NAMES an API vocab word ("api.stripe.com/v1") still count as
 * noun/dependency evidence; a bare host that names none does not.
 *
 * Non-string inputs degrade to `{ detected: false }` without throwing.
 */
function detectApiIntegration(text, terms) {
    const effective = resolveTerms(terms);
    if (typeof text !== 'string') {
        return { detected: false, signals: [], terms: effective };
    }
    const stripped = (0, markdown_sectionizer_cjs_1.stripFencedCode)(text.replace(/\r\n/g, '\n')).text;
    if (stripped.trim().length === 0) {
        return { detected: false, signals: [], terms: effective };
    }
    const signals = [];
    const seen = new Set();
    const lines = stripped.split('\n');
    const hasCompoundTerms = effective.verbs.length > 0 && effective.nouns.length > 0;
    // Trailing boundary is a LOOKAHEAD (not consumed) so back-to-back terms
    // separated by one boundary char are both found.
    const verbRe = hasCompoundTerms
        ? new RegExp('(^|[^a-zA-Z0-9])(' + effective.verbs.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)', 'gi')
        : null;
    const nounRe = hasCompoundTerms
        ? new RegExp('(^|[^a-zA-Z0-9])(' + effective.nouns.map(escapeRegex).join('|') + ')(?=[^a-zA-Z0-9]|$)', 'gi')
        : null;
    const surfaceRe = new RegExp(SERVICE_SURFACE_API_RE.source, 'g');
    const nounSet = new Set(effective.nouns);
    const emitPair = (vTerm, nTerm, snippetLine) => {
        const key = `${vTerm}+${nTerm}`;
        if (seen.has(key))
            return;
        seen.add(key);
        signals.push({ verb: vTerm, noun: nTerm, snippet: makeSnippet(snippetLine, nTerm) });
    };
    for (const rawLine of lines) {
        // Inline code spans are code, not prose — mask them (length-preserving so
        // offsets keep lining up), but keep package-shaped span content as noun
        // evidence (#2365 review FN-4: `stripe-sdk` names a dependency).
        const inlineSpans = (0, markdown_sectionizer_cjs_1.scanInlineCodeSpans)(rawLine);
        let line = rawLine;
        const spanNouns = [];
        for (const s of inlineSpans) {
            line = line.slice(0, s.start) + ' '.repeat(s.end - s.start) + line.slice(s.end);
            const content = s.content.trim();
            if (content.length === 0 || /\s/.test(content))
                continue;
            const segs = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
            if (segs.length < 2)
                continue; // a bare `api` span is a code identifier
            const hit = segs.find((seg) => nounSet.has(seg));
            if (hit)
                spanNouns.push({ term: hit, start: s.start, end: s.end });
        }
        // Path-shaped tokens (routes, file names, URLs) are references, not prose.
        const { masked, urlNouns } = scanLineTokens(line, nounRe, nounSet);
        const clauses = splitClauses(masked);
        const extraNouns = urlNouns.concat(spanNouns);
        // (a) compound verb+noun — SAME CLAUSE ONLY. There is no word-gap cap (a cap
        // cannot tell a long genuine clause from a long internal one) and no
        // cross-clause binding (see the note by CLAUSE_BOUNDARY_CHARS): the clause
        // boundary is the whole relationship test. Nouns are NOT filtered on
        // "internal" qualification here — "integrate the internal API" is a
        // fail-closed positive; the declaration dismisses it if wrong.
        if (verbRe && nounRe) {
            for (const clause of clauses) {
                const verbs = collectTermMatches(verbRe, clause.text);
                if (verbs.length === 0)
                    continue;
                const nouns = collectTermMatches(nounRe, clause.text);
                const nounTerms = new Set(nouns.map((t) => t.term));
                for (const u of extraNouns) {
                    if (u.start >= clause.start && u.end <= clause.start + clause.text.length) {
                        nounTerms.add(u.term);
                    }
                }
                if (nounTerms.size === 0)
                    continue;
                for (const vTerm of new Set(verbs.map((t) => t.term))) {
                    for (const nTerm of nounTerms)
                        emitPair(vTerm, nTerm, rawLine);
                }
            }
        }
        // (b) explicit <Service> API|SDK|REST|GraphQL surface — scan every candidate
        // in every clause (a rejected first candidate must not shadow a later
        // genuine service; #2365 review C-1).
        for (const clause of clauses) {
            surfaceRe.lastIndex = 0;
            let m;
            while ((m = surfaceRe.exec(clause.text)) !== null) {
                const svc = m[1] || '';
                const svcLower = svc.toLowerCase();
                // Reject capitalized sentence starters ("The API"), locality/protocol
                // descriptors ("Internal API", "REST API"), compound modifiers
                // ("Resolver-only API"), and services qualified first-party
                // ("internal Payments API"). A real vendor name is none of these.
                if (SERVICE_STOPWORDS.has(svcLower))
                    continue;
                if (SURFACE_DESCRIPTOR_WORDS.has(svcLower))
                    continue;
                if (COMPOUND_MODIFIER_RE.test(svc))
                    continue;
                if (isInternallyQualified(masked, clause.start + m.index))
                    continue;
                const noun = (m[2] || '').toLowerCase();
                const key = `surface+${noun}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                signals.push({ verb: '(surface)', noun, snippet: makeSnippet(rawLine, svc) });
            }
        }
    }
    return { detected: signals.length > 0, signals, terms: effective };
}
/** True when the word IMMEDIATELY ADJACENT before `offset` is a locality
 *  descriptor ("internal Payments API") — first-party qualification is negative
 *  evidence for an EXTERNAL-API signal. Only plain spaces/tabs may separate the
 *  descriptor from the service: any intervening punctuation means the descriptor
 *  belongs to a prior clause/sentence and must NOT qualify ("The cache is
 *  private. Stripe API …" — `private` is a different sentence; #2365 review).
 *  Looks back through a BOUNDED window, not the whole prefix, to stay linear. */
const QUALIFIER_LOOKBACK = 24; // longest descriptor ("first-party") + separators
function isInternallyQualified(masked, offset) {
    const from = offset > QUALIFIER_LOOKBACK ? offset - QUALIFIER_LOOKBACK : 0;
    const window = masked.slice(from, offset);
    // Only whitespace and markdown emphasis/wrapper markers (`*_~\`) may separate
    // the descriptor from the service, so "The **internal** Payments API" still
    // qualifies — but NOT a clause/sentence boundary, so "…is private. Stripe API"
    // does not (the descriptor is a different sentence; #2365 review).
    const m = /([A-Za-z0-9'-]+)[\s*_~`]*$/.exec(window);
    if (!m)
        return false;
    // A word truncated by the window start is not a descriptor match (its real
    // start lies before the window) — fail toward detection.
    if (from > 0 && m.index === 0 && /[A-Za-z0-9'-]/.test(masked[from - 1]))
        return false;
    return INTERNAL_DESCRIPTORS.has(m[1].toLowerCase());
}
/** Matches a declaration line such as
 *  `No external API integration: <reason>` (also `**bold**` and em-dash
 *  separators). The reason is REQUIRED — a bare declaration does not parse.
 *  Deliberately NOT matched: blockquoted lines (`> No external …` is quoted
 *  text, not a declaration) and anything inside fenced code or HTML comments
 *  (both stripped before the scan; #2365 review C-3). */
const NO_INTEGRATION_DECLARATION_RE = /^\s*(?:\*\*)?no external api integration(?:\*\*)?\s*(?:[:—–-]|--)\s*(\S[^\n]*)$/im;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const VALID_DECISIONS = new Set(['INTEGRATE', 'OPT-OUT']);
/**
 * Parse a coverage matrix from COVERAGE.md. Accepts two bijective formats:
 *
 *  1. Markdown table (canonical, human-editable):
 *       | capability | decision | reason |
 *       |---|---|---|
 *       | search | INTEGRATE | |
 *       | playlists | OPT-OUT | not needed yet |
 *
 *  2. Fenced ```coverage JSON block (machine-generated):
 *       ```coverage
 *       [ {"capability":"search","decision":"INTEGRATE","reason":""}, ... ]
 *       ```
 *
 * Rows are trimmed; decisions upper-cased; missing reason → "". Returns
 * `{ rows: [], errors: [], format: 'none' }` for empty/non-matrix input.
 */
function parseCoverageMatrix(text) {
    const out = { rows: [], errors: [], format: 'none', declaration: null };
    if (typeof text !== 'string')
        return out;
    const src = text.replace(/\r\n/g, '\n');
    // #2365 acceptance #5: a "no external API integration" declaration. Scanned
    // on fence-stripped, comment-stripped text so an example inside a code block
    // or an HTML comment does not count.
    const declMatch = NO_INTEGRATION_DECLARATION_RE.exec((0, markdown_sectionizer_cjs_1.stripFencedCode)(src).text.replace(HTML_COMMENT_RE, ''));
    if (declMatch) {
        out.declaration = { none: true, reason: (declMatch[1] || '').trim() };
    }
    // (1) fenced ```coverage JSON block takes precedence if present.
    // Case-insensitive info string (```coverage and ```Coverage are both legal CommonMark).
    const fenceBody = (0, markdown_sectionizer_cjs_1.extractFencedBlock)(src, 'coverage');
    if (fenceBody) {
        out.format = 'json';
        let parsed;
        try {
            parsed = JSON.parse(fenceBody);
        }
        catch {
            out.errors.push('fenced ```coverage block is not valid JSON');
            return out;
        }
        if (!Array.isArray(parsed)) {
            out.errors.push('fenced ```coverage block must be a JSON array');
            return out;
        }
        for (let i = 0; i < parsed.length; i++) {
            const row = rowFromJson(parsed[i]);
            if ('error' in row) {
                out.errors.push(`row[${i}]: ${row.error}`);
                continue;
            }
            out.rows.push(row);
        }
        return out;
    }
    // (2) markdown table — collect rows from coverage matrix tables only (#2366).
    // Track whether we are inside a recognized coverage matrix (after a header
    // row, before a non-pipe line ends the table). This prevents summary tables
    // elsewhere in the file from being parsed as data (#2366 bug 1) and allows
    // multi-section matrices with repeated headers (#2366 bug 2).
    const lines = src.split('\n');
    let inMatrix = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('|')) {
            inMatrix = false;
            continue;
        }
        const cells = trimmed.slice(1, trimmed.endsWith('|') ? -1 : trimmed.length).split('|');
        if (cells.length < 2)
            continue;
        const cleaned = cells.map((c) => c.trim());
        // skip separator rows (|---|---|); require ≥3 dashes so a literal "-" cell
        // is not mistaken for a separator.
        if (cleaned.every((c) => /^:?-{3,}:?$/.test(c)))
            continue;
        // Strip markdown emphasis (**, *, __, _, `) from the decision cell before
        // comparison so **OPT-OUT** parses correctly (#2366 bug 3).
        const decisionCell = (cleaned[1] || '').replace(/[*_`]/g, '').trim().toUpperCase();
        // header detection — recognized by 'capability' in column 0; allows multiple
        // headers for multi-section matrices (#2366 bug 2).
        if (cleaned[0].toLowerCase() === 'capability') {
            inMatrix = true;
            if (out.format === 'none')
                out.format = 'table';
            continue;
        }
        // Only parse data rows from inside a recognized coverage matrix table.
        // A pipe-table outside the matrix (e.g., a summary table) is ignored (#2366 bug 1).
        if (!inMatrix)
            continue;
        if (!VALID_DECISIONS.has(decisionCell)) {
            // A row that otherwise looks like data (≥3 cells, non-empty capability)
            // but carries a malformed decision is a real error, not a row to skip
            // silently — otherwise a single typo'd row collapses the matrix to
            // "empty" and the user sees a confusing message.
            if (cleaned.length >= 3 && cleaned[0]) {
                out.errors.push(`row: decision "${decisionCell}" not in {INTEGRATE, OPT-OUT}`);
            }
            continue;
        }
        if (out.format === 'none')
            out.format = 'table';
        // A coverage row has exactly 3 cells. Extra cells mean an unescaped pipe in
        // a value silently corrupted the row — surface it rather than parse garbage.
        if (cleaned.length > 3) {
            out.errors.push(`row: ${cleaned.length} columns (expected 3 — unescaped pipe in a cell?)`);
        }
        out.rows.push({
            capability: cleaned[0] || '',
            decision: decisionCell,
            reason: (cleaned[2] ?? '').trim(),
        });
    }
    return out;
}
function rowFromJson(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return { error: 'not an object' };
    const o = v;
    const capability = typeof o['capability'] === 'string' ? o['capability'].trim() : '';
    if (!capability)
        return { error: 'missing/empty "capability"' };
    const dRaw = typeof o['decision'] === 'string' ? o['decision'].trim().toUpperCase() : '';
    if (!VALID_DECISIONS.has(dRaw)) {
        return { error: `decision "${dRaw}" not in {INTEGRATE, OPT-OUT}` };
    }
    const reason = typeof o['reason'] === 'string' ? o['reason'].trim() : '';
    return { capability, decision: dRaw, reason };
}
/**
 * Validate a parsed matrix. A matrix is valid when:
 *   - it is non-empty (acceptance #1: "enumerating the API surface"),
 *   - every capability name is non-empty,
 *   - every decision is INTEGRATE or OPT-OUT (enforced by parser, re-checked
 *     here for defense-in-depth),
 *   - every OPT-OUT row carries a non-empty reason (acceptance #2).
 *
 * Un-enumerated remainder is not representable in the format — the gate blocks
 * when an integration is detected and NO matrix exists. This validator catches
 * a malformed/partial matrix that does exist.
 */
function validateCoverageMatrix(text) {
    const parsed = parseCoverageMatrix(text);
    const errors = [...parsed.errors];
    const rows = parsed.rows;
    // #2365 acceptance #5: a reasoned no-integration declaration with no rows
    // satisfies the gate. A declaration ALONGSIDE rows is contradictory — the
    // file must say one thing.
    if (parsed.declaration) {
        if (rows.length > 0) {
            errors.push('declares "no external API integration" but also contains coverage rows — remove the declaration or the rows');
        }
        else {
            if (parsed.declaration.reason.length > REASON_MAX_LEN) {
                errors.push(`declaration reason exceeds ${REASON_MAX_LEN} chars`);
            }
            const valid = errors.length === 0;
            return {
                valid,
                errors,
                counts: { surface: 0, integrate: 0, optout: 0 },
                none_declared: valid,
            };
        }
    }
    if (rows.length === 0) {
        if (errors.length === 0)
            errors.push('matrix is empty — no capabilities enumerated');
        return { valid: false, errors, counts: { surface: 0, integrate: 0, optout: 0 } };
    }
    const seen = new Set();
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row.capability) {
            errors.push(`row[${i}]: empty capability name`);
        }
        else {
            // Format contract + prompt-injection bound: cell values must be short,
            // single-line, pipe-free prose (the matrix is a markdown table whose
            // content flows into the gate message). Pipes/newlines would corrupt the
            // table and let a COVERAGE.md inject unbounded text into the seal message.
            if (/[|\n\r]/.test(row.capability)) {
                errors.push(`row[${i}]: capability contains a pipe or newline (unsupported in a table cell)`);
            }
            if (row.capability.length > CAPABILITY_MAX_LEN) {
                errors.push(`row[${i}]: capability exceeds ${CAPABILITY_MAX_LEN} chars`);
            }
        }
        if (row.reason && /[|\n\r]/.test(row.reason)) {
            errors.push(`row[${i}]: reason contains a pipe or newline (unsupported in a table cell)`);
        }
        if (row.reason.length > REASON_MAX_LEN) {
            errors.push(`row[${i}]: reason exceeds ${REASON_MAX_LEN} chars`);
        }
        const key = row.capability.toLowerCase();
        if (key && seen.has(key))
            errors.push(`row[${i}]: duplicate capability`);
        if (key)
            seen.add(key);
        if (!VALID_DECISIONS.has(row.decision)) {
            errors.push(`row[${i}]: decision not in {INTEGRATE, OPT-OUT}`);
        }
        if (row.decision === 'OPT-OUT' && !row.reason) {
            errors.push(`row[${i}]: OPT-OUT missing reason`);
        }
    }
    const counts = {
        surface: rows.length,
        integrate: rows.filter((r) => r.decision === 'INTEGRATE').length,
        optout: rows.filter((r) => r.decision === 'OPT-OUT').length,
    };
    return { valid: errors.length === 0, errors, counts };
}
/** Render rows back to the canonical markdown-table format (bijective with parse). */
function renderCoverageMatrix(rows) {
    const body = rows
        .map((r) => `| ${r.capability} | ${r.decision} | ${r.reason} |`)
        .join('\n');
    return `| capability | decision | reason |\n|---|---|---|\n${body}`;
}
// ── CLI entry point ──────────────────────────────────────────────────────────
// Reads phase-scope text from STDIN (not argv) to avoid OS ARG_MAX limits.
// Invoked by workflow bash as: echo "$SCOPE" | node .../api-coverage.cjs [--json]
// Exit 0 = integration detected, 1 = none, 2 = startup error. Mirrors
// assumption-delta.cjs / ui-safety-gate.cjs.
if (require.main === module) {
    const argv = process.argv.slice(2);
    const wantJson = argv.includes('--json');
    let termsOverride;
    const verbsIdx = argv.indexOf('--verbs');
    const verbsVal = verbsIdx !== -1 ? argv[verbsIdx + 1] : undefined;
    const nounsIdx = argv.indexOf('--nouns');
    const nounsVal = nounsIdx !== -1 ? argv[nounsIdx + 1] : undefined;
    // A non-empty, non-flag value is an override. An EMPTY value ("") restores
    // the curated defaults (does NOT silently zero the vocabulary).
    const verbsOverride = typeof verbsVal === 'string' && verbsVal.length > 0 && !verbsVal.startsWith('-');
    const nounsOverride = typeof nounsVal === 'string' && nounsVal.length > 0 && !nounsVal.startsWith('-');
    if (verbsOverride || nounsOverride) {
        termsOverride = {};
        if (verbsOverride) {
            termsOverride.verbs = verbsVal.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        }
        if (nounsOverride) {
            termsOverride.nouns = nounsVal.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
        }
    }
    const chunks = [];
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
        const input = chunks.join('');
        const result = detectApiIntegration(input, termsOverride);
        if (wantJson) {
            process.stdout.write(JSON.stringify(result) + '\n');
        }
        process.exit(result.detected ? 0 : 1);
    });
    process.stdin.on('error', (err) => {
        process.stderr.write(`ERROR: api-coverage.cjs stdin read failed: ${err.message}\n`);
        process.exit(2);
    });
}
