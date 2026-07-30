"use strict";
/**
 * Reviewer Lane Runner (ADR-2782 Phase 5b, #2799).
 *
 * Executes an invocation plan from `review-lane-invocation.cts`: probes the lane, spawns the binary
 * or calls the HTTP endpoint, applies the empty-output policy, and dispatches the three first-party
 * handlers D6 names. This is the module that replaces ~640 lines of hand-authored per-CLI bash.
 *
 * THREE RUNTIME DEPENDENCIES DISAPPEAR HERE, and that is a correctness win rather than a tidy-up:
 *   - `jq` — five legs needed it on PATH; it is absent on stock Windows/Git-Bash (#2589). Parsing is
 *     `JSON.parse` now.
 *   - `curl` — the three OpenAI-compatible legs shelled out to it. Node's `fetch` replaces it, and
 *     the raw response body (where an OpenAI-compatible server puts its error JSON on a 4xx/5xx
 *     while curl still exits 0) is no longer discarded by a pipe.
 *   - external `timeout` / `gtimeout` — the Antigravity leg probed for one because
 *     `--print-timeout` cannot fire before a session exists, and STOCK MACOS SHIPS NEITHER, so on a
 *     stock Mac that leg ran unbounded. `spawnSync`'s native `timeout` is always available, so D7's
 *     "skip the probe where no bounding mechanism exists" carve-out is no longer needed.
 *
 * EVERY subprocess call in this file passes `timeout` + `killSignal` + `maxBuffer`. This repo has a
 * named `DEFECT.UNBOUNDED-SUBPROCESS` class (`CONTEXT.md:772`) and an unbounded sync spawn is not a
 * slow test, it is a hung one: `--test-force-exit` cannot interrupt a synchronous call, so a frozen
 * spawn hangs the whole CI chunk to its 10-minute kill with `# fail 0` and no `not ok` (#2099).
 *
 * TOTAL. No function here throws for a lane-level failure; every one returns a typed outcome. A
 * reviewer lane that cannot run must produce a diagnosable artifact, because the ambiguity between
 * "failed" and "ran cleanly with nothing to report" IS the defect this epic closes (#2494/#2605).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkEgressHost = checkEgressHost;
exports.probeLane = probeLane;
exports.writeReviewOrStub = writeReviewOrStub;
exports.handleOpencodeOutput = handleOpencodeOutput;
exports.antigravityWatermark = antigravityWatermark;
exports.antigravityTranscriptFallback = antigravityTranscriptFallback;
exports.antigravityPrompt = antigravityPrompt;
exports.antigravityArgv = antigravityArgv;
exports.antigravityDiagnostic = antigravityDiagnostic;
exports.stampBlindReview = stampBlindReview;
exports.runOpenAiCompatible = runOpenAiCompatible;
exports.runLane = runLane;
const review_lane_invocation_cjs_1 = require("./review-lane-invocation.cjs");
/**
 * Compare a lane's re-resolved egress destination against the one the user consented to.
 *
 * ADR-2782 D5 puts this on the invocation path deliberately. `hostConfigKey` names a key in
 * `.planning/config.json`, which is the ONE consent-bound value living outside the SHA-pinned
 * bundle: user- and CI-editable at any time, with no re-install and no integrity check. Without
 * this check a lane consented against `http://localhost:8080` could be silently redirected to a
 * remote host by an ordinary pull request touching a JSON file, and every subsequent review would
 * egress plans, requirements, research and decisions to the new destination with no re-prompt.
 *
 * ABSENCE IS NOT A MISMATCH, and this is the part that must not be "hardened" later by someone who
 * reads only the rule name:
 *   - No consent record at all ⇒ ALLOW. First-party lanes (`ollama`, `lm_studio`, `llama_cpp`) ship
 *     inside the SHA-pinned distribution and are never consent-gated, so blocking on a missing
 *     record would break every existing local-model user on upgrade.
 *   - A consent record predating this feature ⇒ ALLOW. Those records were written before a host was
 *     recorded; treating the absence as a change would force spurious re-consent across every
 *     installed capability, which ADR-2782 D4 rule 5 explicitly forbids.
 *
 * Hosts are compared NORMALIZED, so a trailing slash or an explicit `:80` is not a "destination
 * change". A warning that fires on cosmetic edits is a warning users learn to dismiss.
 */
function checkEgressHost(consentedHost, currentHost) {
    const consented = typeof consentedHost === 'string' ? (0, review_lane_invocation_cjs_1.normalizeHost)(consentedHost) : '';
    if (!consented)
        return { allowed: true };
    const current = (0, review_lane_invocation_cjs_1.normalizeHost)(currentHost);
    if (consented === current)
        return { allowed: true, consentedHost: consented, currentHost: current };
    return { allowed: false, consentedHost: consented, currentHost: current };
}
/* ------------------------------------------------------------------ *
 * Probe (D7) — every probe bounded, and only for a SELECTED lane
 * ------------------------------------------------------------------ */
async function probeLane(plan, deps) {
    // Prerequisites first: a missing `jq`-style helper is a clearer failure than whatever the tool
    // does without it, and reporting it costs nothing.
    for (const bin of plan.requiresBinaries) {
        if (!deps.hasBinary(bin)) {
            return {
                available: false,
                reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.MISSING_REQUIRED_BINARY,
                detail: `lane '${plan.slug}' requires '${bin}' on PATH`,
            };
        }
    }
    const probe = plan.probe;
    if (!probe || typeof probe !== 'object') {
        return { available: false, reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.PROBE_FAILED, detail: 'lane declares no probe' };
    }
    switch (probe.kind) {
        case 'command-exists':
            return deps.hasBinary(probe.binary)
                ? { available: true }
                : {
                    available: false,
                    reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.MISSING_BINARY,
                    detail: `'${probe.binary}' not found on PATH`,
                };
        case 'command-capability': {
            // Existence alone is structurally insufficient here: `kimi` is claimed by BOTH the Kimi Code
            // CLI and the legacy Python kimi-cli, and an existence-only probe registers the wrong tool.
            if (!deps.hasBinary(probe.binary)) {
                return {
                    available: false,
                    reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.MISSING_BINARY,
                    detail: `'${probe.binary}' not found on PATH`,
                };
            }
            const out = deps.spawn(probe.binary, ['--help'], { timeoutMs: probe.timeoutMs });
            if (out.errorCode === 'ETIMEDOUT') {
                return {
                    available: false,
                    reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.PROBE_TIMEOUT,
                    detail: `'${probe.binary} --help' exceeded ${probe.timeoutMs}ms`,
                };
            }
            const help = `${out.stdout}\n${out.stderr}`;
            return help.includes(probe.needle)
                ? { available: true }
                : {
                    available: false,
                    reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.PROBE_FAILED,
                    detail: `'${probe.binary}' is on PATH but its --help lacks '${probe.needle}' — this is a different tool sharing the name`,
                };
        }
        case 'http-reachable': {
            // Only a STRING config value names a host. `String(unknown)` would turn an object into the
            // literal '[object Object]' and probe that as a URL — a nonsense destination reported as
            // "unreachable" rather than as the misconfiguration it is.
            const configured = deps.configGet(probe.hostConfigKey);
            const base = (0, review_lane_invocation_cjs_1.normalizeHost)((typeof configured === 'string' ? configured : '') ||
                (plan.transport === 'openai-http' ? plan.host : ''));
            if (!base) {
                return { available: false, reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.HOST_UNREACHABLE, detail: 'no host resolved' };
            }
            const r = await deps.httpJson(`${base}${probe.path}`, { method: 'GET', timeoutMs: probe.timeoutMs });
            return r.ok
                ? { available: true }
                : {
                    available: false,
                    reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.HOST_UNREACHABLE,
                    detail: `${base}${probe.path} unreachable: ${r.error ?? `HTTP ${r.status}`}`,
                };
        }
        default:
            return {
                available: false,
                reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.PROBE_FAILED,
                detail: `unknown probe kind '${String(probe.kind)}'`,
            };
    }
}
/* ------------------------------------------------------------------ *
 * Empty-output policy (#2494 / #2605 / #2794)
 * ------------------------------------------------------------------ */
/**
 * Write the review, or a diagnostic stub when the lane produced nothing usable.
 *
 * The stub is not cosmetic. Before #2494/#2605 a failed lane left a zero-byte file, `write_reviews`
 * rendered it as "a reviewer that ran cleanly with nothing to report", and the lane vanished from
 * the cross-AI consensus while `present_results` reported success — a review blind in one eye. The
 * stub keeps its "failed or returned empty output" header precisely so it can never be mistaken for
 * a real review.
 *
 * `extraDiagnostics` carries the raw HTTP response body for the OpenAI-compatible lanes: an error
 * from such a server arrives with HTTP 4xx/5xx and the JSON in the BODY, so stderr alone is empty
 * and the body is the only evidence.
 */
function writeReviewOrStub(plan, content, deps, extraDiagnostics) {
    if (!(0, review_lane_invocation_cjs_1.isEmptyReview)(content)) {
        deps.writeFile(plan.reviewPath, content.endsWith('\n') ? content : `${content}\n`);
        return { stubbed: false };
    }
    const stderr = deps.exists(plan.errPath) ? deps.readFile(plan.errPath) : '';
    const parts = [`${plan.slug} review failed or returned empty output. stderr:`, stderr];
    if (extraDiagnostics)
        parts.push('Raw response body:', extraDiagnostics);
    deps.writeFile(plan.reviewPath, `${parts.join('\n')}\n`);
    return { stubbed: true };
}
/* ------------------------------------------------------------------ *
 * Handlers (D6) — named first-party code, never conditionals in data
 * ------------------------------------------------------------------ */
/**
 * `opencode` — reconstruct the review from the assistant `text` parts of a `--format json` stream.
 *
 * `--format json` is the PRIMARY invocation, not a fallback: OpenCode's default `build` agent is an
 * agentic coder, and on a large review prompt it may run a few `read` tool calls then end its turn
 * with ZERO output tokens, so `--format default` yields empty stdout and the reviewer is silently
 * lost (#1936). When no assistant text was emitted, surface the stop reason and output-token count
 * so the failure is diagnosable rather than a generic empty stub.
 *
 * The stream is JSONL-ish: one JSON value per line. A line that does not parse is SKIPPED rather
 * than failing the lane — a partial stream still carries usable review text, and losing the whole
 * review to one malformed line would be strictly worse than the bug this handler exists to fix.
 */
function handleOpencodeOutput(rawStdout) {
    const texts = [];
    let stopReason = '?';
    let outputTokens = '?';
    for (const line of String(rawStdout ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        let evt;
        try {
            evt = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        if (evt === null || typeof evt !== 'object')
            continue;
        const e = evt;
        const part = (e.part ?? {});
        if (e.type === 'text' && typeof part.text === 'string') {
            // An EMPTY string is kept, not skipped. The shipped jq was `.part.text // empty`, and `//`
            // only substitutes for `false`/`null` — an empty string is truthy in jq, so it survived and
            // contributed a blank line. Dropping it here would quietly close up blank lines between
            // parts, which is a real (if cosmetic) divergence from the behaviour being ported.
            texts.push(part.text);
        }
        else if (e.type === 'step_finish') {
            if (typeof part.reason === 'string')
                stopReason = part.reason;
            const tokens = (part.tokens ?? {});
            if (typeof tokens.output === 'number')
                outputTokens = String(tokens.output);
        }
    }
    return {
        review: texts.join('\n'),
        diagnostic: `stop reason=${stopReason}, output tokens=${outputTokens}`,
    };
}
/**
 * `antigravity` — three layers, a two-level timeout, and a stale-response watermark.
 *
 * Layer 1 is stdout, which works on macOS/Linux/WSL. On native Windows `agy -p` silently produces
 * no stdout despite the API call succeeding (an upstream `text_drip.go` non-TTY flush bug), so
 * layer 2 reads the transcript `agy` always persists to disk. Layer 3 is a diagnostic stub.
 *
 * THE WATERMARK IS THE SUBTLE PART. Without it, layer 2 reads the last `PLANNER_RESPONSE` in the
 * transcript regardless of when it was written — including one from a PREVIOUS invocation in the
 * same workspace, silently presenting a stale review as this run's. So the transcript line count is
 * snapshotted BEFORE the spawn and only lines appended after it are considered. If the conversation
 * id changed, `agy` started a fresh session and every line is new (skip 0).
 *
 * `takeWatermark` must therefore be called before `runAntigravity`; the plan's outer timeout is the
 * external wall-clock cap that `--print-timeout` cannot provide (it cannot fire before a session
 * exists — a process can stall pre-session and outlive its own native timeout, #2073 mode 3).
 *
 * KNOWN LIMIT — the watermark is sequential, not concurrent. `last_conversations.json` is keyed by
 * WORKSPACE, so two `/gsd:review` runs against the same repo at the same time resolve the same
 * conversation id and share one transcript. The fallback then takes "the latest DONE
 * PLANNER_RESPONSE after the watermark" with nothing to tell the two runs apart, so one run could
 * read the other's response. This cannot be closed here: `agy` exposes no per-invocation id to
 * filter on, and the transcript carries none. It is stated rather than silently tolerated because
 * the guarantee this function advertises ("never stale") holds only for sequential use, and a
 * future reader deserves to know which half is actually guaranteed.
 */
function antigravityWatermark(workspace, deps) {
    const cachePath = `${deps.homeDir}/.gemini/antigravity-cli/cache/last_conversations.json`;
    if (!deps.exists(cachePath))
        return { convId: '', lines: 0 };
    let cache;
    try {
        cache = JSON.parse(deps.readFile(cachePath));
    }
    catch {
        return { convId: '', lines: 0 };
    }
    const convId = resolveConvId(cache, workspace);
    if (!convId)
        return { convId: '', lines: 0 };
    const tx = transcriptPath(deps.homeDir, convId);
    if (!deps.exists(tx))
        return { convId, lines: 0 };
    try {
        return { convId, lines: deps.readFile(tx).split(/\r?\n/).filter((l) => l.trim()).length };
    }
    catch {
        return { convId, lines: 0 };
    }
}
/** Workspace lookup is case-insensitive — the leg's jq did `ascii_downcase` on both sides. */
function resolveConvId(cache, workspace) {
    if (Object.prototype.hasOwnProperty.call(cache, workspace)) {
        const direct = cache[workspace];
        if (typeof direct === 'string' && direct)
            return direct;
    }
    const target = workspace.toLowerCase();
    for (const [k, v] of Object.entries(cache)) {
        if (k.toLowerCase() === target && typeof v === 'string' && v)
            return v;
    }
    return '';
}
function transcriptPath(homeDir, convId) {
    return `${homeDir}/.gemini/antigravity-cli/brain/${convId}/.system_generated/logs/transcript.jsonl`;
}
/**
 * Layer 2: the newest `PLANNER_RESPONSE` written AFTER the watermark, or `''`.
 *
 * Returning `''` rather than the newest entry overall is the whole point — an empty result lets
 * layer 3 fire with an honest diagnostic, where a stale one would be indistinguishable from a
 * successful review.
 */
function antigravityTranscriptFallback(workspace, mark, deps) {
    const cachePath = `${deps.homeDir}/.gemini/antigravity-cli/cache/last_conversations.json`;
    if (!deps.exists(cachePath))
        return '';
    let cache;
    try {
        cache = JSON.parse(deps.readFile(cachePath));
    }
    catch {
        return '';
    }
    const convId = resolveConvId(cache, workspace);
    if (!convId)
        return '';
    const tx = transcriptPath(deps.homeDir, convId);
    if (!deps.exists(tx))
        return '';
    let lines;
    try {
        lines = deps.readFile(tx).split(/\r?\n/).filter((l) => l.trim());
    }
    catch {
        return '';
    }
    // Same conv-id ⇒ only lines beyond the watermark are this run's. Different id ⇒ fresh session,
    // so every line is new.
    const skip = convId === mark.convId ? mark.lines : 0;
    let latest = '';
    for (const line of lines.slice(skip)) {
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.source === 'MODEL' &&
            entry.status === 'DONE' &&
            entry.type === 'PLANNER_RESPONSE' &&
            typeof entry.content === 'string') {
            latest = entry.content;
        }
    }
    return latest;
}
/**
 * Antigravity's prompt variant (#2176).
 *
 * Differs from the standard `argv-file-ref` text by one clause, and that clause is load-bearing:
 * it REQUIRES the reviewer to self-report when it cannot read the repo. Without it a blind review
 * is indistinguishable from a grounded one — the reviewer happily reviews the plan text in
 * isolation and its verdict is counted at full weight in the consensus. `stampBlindReview` reads
 * this self-report back out.
 */
function antigravityPrompt(promptPath, repoRoot) {
    return (`Read the file at ${promptPath} in full and carry out the review request it contains. ` +
        `The repository under review is at ${repoRoot} — resolve every relative file path in the ` +
        `review request against that absolute root and verify claims against those files. ` +
        `If you cannot read files under ${repoRoot}, begin your output with the exact line ` +
        `REVIEWED-WITHOUT-REPO-ACCESS before the review. Output only the resulting markdown review. ` +
        `Do not edit any files.`);
}
/**
 * Antigravity's argv adjustments — the two things data cannot express for this lane.
 *
 * 1. `--add-dir <repo>`, CAPABILITY-PROBED. Without it agy's permission context never receives the
 *    cwd repo: the agent anchors on its own `~/.gemini/antigravity-cli/scratch` dir and reviews the
 *    plan text in isolation, which is exactly what the Review Instructions forbid (#2176). It is
 *    probed rather than assumed because older agy builds reject the unknown flag outright, and a
 *    lane that fails to start is worse than one that runs on the prompt anchor alone.
 * 2. The self-report prompt variant above, swapped in for the standard file-ref text.
 *
 * Both are argv shape, so they belong here rather than in the descriptor: expressing "add this flag
 * only if the binary's --help mentions it" as data would need a conditional, which is precisely
 * what the named-handler seam exists to absorb (ADR-2782 D6).
 */
function antigravityArgv(argv, promptPath, repoRoot, deps) {
    const standard = (0, review_lane_invocation_cjs_1.fileRefPrompt)(promptPath, repoRoot);
    const out = argv.map((a) => (a === standard ? antigravityPrompt(promptPath, repoRoot) : a));
    let supportsAddDir = false;
    try {
        const help = deps.spawn('agy', ['--help'], { timeoutMs: 5_000 });
        supportsAddDir = `${help.stdout}\n${help.stderr}`.includes('--add-dir');
    }
    catch {
        supportsAddDir = false;
    }
    if (!supportsAddDir)
        return out;
    // Insert before the trailing `-p <prompt>` pair so the prompt stays last, as the leg had it.
    const pIdx = out.lastIndexOf('-p');
    if (pIdx === -1)
        return [...out, '--add-dir', repoRoot];
    return [...out.slice(0, pIdx), '--add-dir', repoRoot, ...out.slice(pIdx)];
}
/**
 * Layer 3's diagnostic: what `agy` itself logged, when both stdout and the transcript were empty.
 *
 * #2073 mode 2 is invisible without this. A pinned model that 404s server-side exits **0** with
 * empty stdout AND an empty transcript — every signal the other two layers read says "clean run,
 * nothing to report". The only evidence is in `agy`'s own log, so a bare generic stub would leave
 * the user with a silently missing reviewer and nothing to diagnose.
 *
 * Mode 3 (a pre-session stall, which `--print-timeout` cannot bound because it cannot fire before a
 * session exists) leaves no log line at all, so its tell is stated rather than searched for.
 */
function antigravityDiagnostic(deps) {
    const lines = [
        'Antigravity review failed or returned empty output.',
    ];
    const logPath = `${deps.homeDir}/.gemini/antigravity-cli/cli.log`;
    if (deps.exists(logPath)) {
        try {
            const hits = deps
                .readFile(logPath)
                .split(/\r?\n/)
                .filter((l) => /agent executor error|NOT_FOUND|Publisher model/i.test(l))
                .slice(-3);
            if (hits.length) {
                lines.push("agy log hint (pinned model may be unavailable — run 'agy models' and set review.models.agy):", ...hits);
            }
        }
        catch {
            /* an unreadable log is not worth failing the lane over */
        }
    }
    lines.push('If no agy run started, that is the pre-session-stall case: check whether a new ' +
        '~/.gemini/antigravity-cli/brain/<conv-id>/ dir appeared within ~30s of launch.');
    return lines.join('\n');
}
/**
 * Stamp a machine-readable marker when the reviewer plainly ran without repo access (#2176).
 *
 * BOTH tells are ANCHORED, and that anchoring is load-bearing: a grounded review that merely QUOTES
 * `REVIEWED-WITHOUT-REPO-ACCESS` — reviewing this very file, say — must never be mis-stamped. So
 * the self-report is only honoured in the first five lines, and the scratch-dir tell only in a
 * workspace-DECLARATION phrasing.
 */
function stampBlindReview(review) {
    if ((0, review_lane_invocation_cjs_1.isEmptyReview)(review))
        return review;
    const head = review.split(/\r?\n/).slice(0, 5).join('\n');
    const selfReported = head.includes('REVIEWED-WITHOUT-REPO-ACCESS');
    const scratchTell = /(workspace|working) (directory|dir)[\s\S]{0,40}antigravity-cli\/scratch/i.test(review);
    if (!selfReported && !scratchTell)
        return review;
    return ('> [reviewed-without-repo-access] This reviewer ran without visibility into the repo under ' +
        'review — down-weight its verdict in the Consensus Summary.\n\n' +
        review);
}
/**
 * `openai-compatible` — model discovery, the chat-completions round trip, and the served-model
 * mismatch warning.
 *
 * The raw body is returned alongside the content because an OpenAI-compatible server reports errors
 * with an HTTP 4xx/5xx and the JSON in the BODY. The bash piped the response straight into `jq`,
 * which discarded exactly that evidence; the stub appends it now.
 */
async function runOpenAiCompatible(plan, promptText, deps) {
    let model = plan.model;
    if (!model && plan.modelsUrl) {
        const listed = await deps.httpJson(plan.modelsUrl, { method: 'GET', timeoutMs: 2_000 });
        if (listed.ok) {
            try {
                const parsed = JSON.parse(listed.body);
                const first = Array.isArray(parsed.data) ? parsed.data[0] : undefined;
                if (first && typeof first.id === 'string' && first.id)
                    model = first.id;
            }
            catch {
                /* fall through to the declared fallback */
            }
        }
    }
    if (!model)
        model = plan.fallbackModel;
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: promptText }] });
    const res = await deps.httpJson(plan.url, { method: 'POST', body, timeoutMs: plan.timeoutMs });
    if (!res.ok && !res.body) {
        return { review: '', rawBody: res.error ?? `HTTP ${res.status}` };
    }
    let review = '';
    try {
        const parsed = JSON.parse(res.body);
        // A server that quietly serves a different model than requested produces a review the user
        // will attribute to the wrong system. Warn rather than fail — the review is still real.
        if (typeof parsed.model === 'string' && parsed.model && parsed.model !== model) {
            deps.warn(`${plan.slug} served model '${parsed.model}' but '${model}' was requested. ` +
                `Review may be from a different model.`);
        }
        const content = parsed.choices?.[0]?.message?.content;
        if (typeof content === 'string')
            review = content;
    }
    catch {
        /* leave review empty — the raw body carries the diagnosis */
    }
    return { review, rawBody: res.body };
}
/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */
/**
 * Run one resolved lane end to end.
 *
 * Order is deliberate: egress re-verification happens BEFORE the probe and before any spawn, so a
 * lane whose destination changed never receives the plan text even once.
 */
async function runLane(plan, deps, opts) {
    const base = { slug: plan.slug, stubbed: false };
    if (plan.transport === 'openai-http') {
        const egress = checkEgressHost(opts.consentedHost, plan.host);
        if (!egress.allowed) {
            const detail = `lane '${plan.slug}' was consented to send plans to ${egress.consentedHost} but ` +
                `${plan.hostConfigKey} now resolves to ${egress.currentHost}. Re-consent to allow the new ` +
                `destination — this lane will not run against a host you did not approve.`;
            deps.warn(detail);
            return { ...base, ok: false, reason: review_lane_invocation_cjs_1.LANE_UNAVAILABLE.EGRESS_HOST_CHANGED, detail };
        }
    }
    const probed = await probeLane(plan, deps);
    if (!probed.available) {
        // D4's carve-out: not finding a lane nobody asked for is normal; failing to run a lane somebody
        // asked for is an ERROR. Both are visible; only the second is fatal to the run.
        if (opts.explicitlyRequested)
            deps.warn(`explicitly requested reviewer '${plan.slug}': ${probed.detail}`);
        return { ...base, ok: false, reason: probed.reason, detail: probed.detail };
    }
    return plan.transport === 'spawn'
        ? runSpawnLane(plan, deps, opts.repoRoot)
        : runHttpLane(plan, deps);
}
function runSpawnLane(plan, deps, repoRoot) {
    const input = plan.stdin && deps.exists(plan.stdin) ? deps.readFile(plan.stdin) : undefined;
    const mark = plan.handler === 'antigravity' ? antigravityWatermark(repoRoot, deps) : { convId: '', lines: 0 };
    const argv = plan.handler === 'antigravity'
        ? antigravityArgv(plan.argv, plan.promptPath, repoRoot, deps)
        : plan.argv;
    const out = deps.spawn(plan.binary, argv, { input, timeoutMs: plan.timeoutMs });
    deps.writeFile(plan.errPath, out.stderr ?? '');
    // `file-arg` lanes write the review themselves and their stdout is deliberately discarded (#1698).
    let review = plan.outputTarget.kind === 'file'
        ? deps.exists(plan.outputTarget.path)
            ? deps.readFile(plan.outputTarget.path)
            : ''
        : (out.stdout ?? '');
    let extra;
    if (plan.handler === 'opencode') {
        const rebuilt = handleOpencodeOutput(review);
        if (!(0, review_lane_invocation_cjs_1.isEmptyReview)(rebuilt.review)) {
            review = rebuilt.review;
        }
        else {
            review = '';
            extra = `OpenCode review returned no assistant text (#1936: agent ended its turn with no final message).\nDiagnostic: ${rebuilt.diagnostic}`;
        }
    }
    if (plan.handler === 'antigravity') {
        // A non-zero exit (timeout kill, crash) discards partial output so the transcript fallback and
        // the diagnostic stub can take over.
        if (out.status !== 0)
            review = '';
        if ((0, review_lane_invocation_cjs_1.isEmptyReview)(review))
            review = antigravityTranscriptFallback(repoRoot, mark, deps);
        review = stampBlindReview(review);
        // Layer 3. `emptyOutput: 'handler-owned'` means the generic stub does not fire for this lane,
        // so if nothing is written here the lane goes out empty — the #2073 failure itself.
        if ((0, review_lane_invocation_cjs_1.isEmptyReview)(review)) {
            deps.writeFile(plan.reviewPath, `${antigravityDiagnostic(deps)}\n`);
            return { slug: plan.slug, ok: true, stubbed: true };
        }
    }
    const { stubbed } = writeReviewOrStub(plan, review, deps, extra);
    return { slug: plan.slug, ok: true, stubbed };
}
async function runHttpLane(plan, deps) {
    const promptText = deps.exists(plan.promptPath) ? deps.readFile(plan.promptPath) : '';
    const { review, rawBody } = await runOpenAiCompatible(plan, promptText, deps);
    deps.writeFile(plan.errPath, '');
    const { stubbed } = writeReviewOrStub(plan, review, deps, rawBody);
    return { slug: plan.slug, ok: true, stubbed };
}
