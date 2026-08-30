'use strict';
/**
 * Profile-pipeline command router — CLI dispatcher for gsd-tools profiling commands.
 *
 * ADR-857 phase 6 / ADR-959: profile-pipeline capability command cutover.
 * Extracted from hardcoded case arms in gsd-tools.cjs (lines 1324-1410).
 * Dispatch path: default → dispatchCapabilityCommand →
 *   require(profile-pipeline-command-router.cjs) → route<X>.
 *
 * Router signature: { args, cwd, raw, error } — identical to existing routers.
 * Test seams: _pipeline / _output inject mock modules; _core injects mock core.
 *
 * Async note: cmdExtractMessages and cmdProfileSample are async functions.
 * dispatchCapabilityCommand (gsd-tools.cjs:366-371) explicitly errors if a
 * router returns a Promise. Therefore these router functions call the async
 * function WITHOUT await and WITHOUT returning the Promise; the event loop
 * drains once the returned promise settles. Since ADR-3889 (#3910), the
 * pipeline functions terminate by THROWING ExitError (never process.exit()
 * directly), so a rejection surfacing here can carry either a genuine error
 * OR a declared ExitError termination — the `.catch()` below must
 * distinguish them: an ExitError sets process.exitCode directly (mirroring
 * cli-exit.cjs's own runMain, the only other place ExitError is caught),
 * while any other rejection is surfaced via the `error()` callback exactly
 * as before. Calling `error(exitErr.message)` for an ExitError would be
 * wrong on two counts: it discards the real exit code (error() always
 * terminates at 1) and it re-derives a message from ExitError's generic
 * "process exit N" constructor default rather than the (already emitted, or
 * intentionally absent) stderr output the throwing call site controls.
 */
const { ERROR_REASON, getJsonErrorMode } = require('./io.cjs');
const { ExitError } = require('./cli-exit.cjs');

/**
 * Interpret a rejection from a fire-and-forget async pipeline call: an
 * ExitError sets process.exitCode (and, for a non-zero code carrying a user
 * message, writes it to stderr) exactly like runMain does; anything else
 * reproduces io.cjs's error() stderr output byte-for-byte and sets
 * process.exitCode directly instead of calling error() itself.
 *
 * error() (src/io.cts) is `never`-typed: it always throws ExitError(1) after
 * writing to stderr. Calling it from inside this `.catch()` callback would
 * throw from a detached promise chain that nothing awaits or re-catches —
 * an unhandled promise rejection that Node (>=15, this repo's
 * engines.node >= 24 default is --unhandled-rejections=throw) dumps as a
 * raw stack trace on top of the clean line error() already wrote. Writing
 * the same bytes directly and setting process.exitCode = 1 in place gets
 * the identical observable stderr + exit code without ever throwing here.
 */
function _handlePipelineRejection(e, error) {
  void error;
  if (e instanceof ExitError) {
    if (e.hasUserMessage && e.code !== 0) process.stderr.write(`${e.message}\n`);
    process.exitCode = e.code;
    return;
  }
  const message = e && e.message ? e.message : String(e);
  if (getJsonErrorMode()) {
    const payload = JSON.stringify({ ok: false, reason: ERROR_REASON.UNKNOWN, message }) + '\n';
    process.stderr.write(payload);
  } else {
    process.stderr.write('Error: ' + message + '\n');
  }
  process.exitCode = 1;
}

// ─── Pipeline phase commands ───────────────────────────────────────────────────

function routeScanSessions({ args, cwd, raw, error, _pipeline }) {
  void cwd; void error;
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  const verboseFlag = args.includes('--verbose');
  const jsonFlag = args.includes('--json');
  // cmdScanSessions is synchronous — call directly.
  p.cmdScanSessions(sessionsPath, { verbose: verboseFlag, json: jsonFlag }, raw);
}

function routeExtractMessages({ args, cwd, raw, error, _pipeline }) {
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const sessionIdx = args.indexOf('--session');
  const sessionId = sessionIdx !== -1 ? args[sessionIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  // args[0] = 'extract-messages' (family name), args[1] = project positional
  const projectArg = args[1];
  if (!projectArg || projectArg.startsWith('--')) {
    error('Usage: gsd-tools extract-messages <project> [--session <id>] [--limit N] [--path <dir>]\nRun scan-sessions first to see available projects.', ERROR_REASON.USAGE);
    return;
  }
  // cmdExtractMessages is async — do NOT return the Promise.
  // The function ends with output() or process.exit(); the event loop will drain.
  void cwd;
  p.cmdExtractMessages(projectArg, { sessionId, limit }, raw, sessionsPath)
    .catch(e => { _handlePipelineRejection(e, error); });
}

function routeProfileSample({ args, cwd, raw, error, _pipeline }) {
  void cwd; void error;
  const p = _pipeline ?? require('./profile-pipeline.cjs');
  const pathIdx = args.indexOf('--path');
  const sessionsPath = pathIdx !== -1 ? args[pathIdx + 1] : null;
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 150;
  const maxPerIdx = args.indexOf('--max-per-project');
  const maxPerProject = maxPerIdx !== -1 ? parseInt(args[maxPerIdx + 1], 10) : null;
  const maxCharsIdx = args.indexOf('--max-chars');
  const maxChars = maxCharsIdx !== -1 ? parseInt(args[maxCharsIdx + 1], 10) : 500;
  // cmdProfileSample is async — do NOT return the Promise.
  p.cmdProfileSample(sessionsPath, { limit, maxPerProject, maxChars }, raw)
    .catch(e => { _handlePipelineRejection(e, error); });
}

// ─── Output phase commands ─────────────────────────────────────────────────────

function routeWriteProfile({ args, cwd, raw, error, _output }) {
  const o = _output ?? require('./profile-output.cjs');
  const inputIdx = args.indexOf('--input');
  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : null;
  if (!inputPath) {
    error('--input <analysis-json-path> is required', ERROR_REASON.USAGE);
    return;
  }
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  o.cmdWriteProfile(cwd, { input: inputPath, output: outputPath }, raw);
}

function routeProfileQuestionnaire({ args, cwd, raw, error, _output }) {
  void cwd; void error;
  const o = _output ?? require('./profile-output.cjs');
  const answersIdx = args.indexOf('--answers');
  const answers = answersIdx !== -1 ? args[answersIdx + 1] : null;
  o.cmdProfileQuestionnaire({ answers }, raw);
}

function routeGenerateDevPreferences({ args, cwd, raw, error, _output }) {
  void error;
  const o = _output ?? require('./profile-output.cjs');
  const analysisIdx = args.indexOf('--analysis');
  const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const stackIdx = args.indexOf('--stack');
  const stack = stackIdx !== -1 ? args[stackIdx + 1] : null;
  o.cmdGenerateDevPreferences(cwd, { analysis: analysisPath, output: outputPath, stack }, raw);
}

function routeGenerateClaudeProfile({ args, cwd, raw, error, _output }) {
  void error;
  const o = _output ?? require('./profile-output.cjs');
  const analysisIdx = args.indexOf('--analysis');
  const analysisPath = analysisIdx !== -1 ? args[analysisIdx + 1] : null;
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const globalFlag = args.includes('--global');
  o.cmdGenerateClaudeProfile(cwd, { analysis: analysisPath, output: outputPath, global: globalFlag }, raw);
}

function routeGenerateClaudeMd({ args, cwd, raw, error, _output }) {
  void error;
  const o = _output ?? require('./profile-output.cjs');
  const outputIdx = args.indexOf('--output');
  const outputPath = outputIdx !== -1 ? args[outputIdx + 1] : null;
  const autoFlag = args.includes('--auto');
  const forceFlag = args.includes('--force');
  o.cmdGenerateClaudeMd(cwd, { output: outputPath, auto: autoFlag, force: forceFlag }, raw);
}

module.exports = {
  routeScanSessions,
  routeExtractMessages,
  routeProfileSample,
  routeWriteProfile,
  routeProfileQuestionnaire,
  routeGenerateDevPreferences,
  routeGenerateClaudeProfile,
  routeGenerateClaudeMd,
};
