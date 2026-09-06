#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Secret Read Guard — PreToolUse hook (Read | Grep | Bash)
//
// Blocks reads of secret files — `.env`, `.env.<suffix>`, `.secrets` — by any
// of the three tools that can put file contents into the conversation: the
// Read tool (file_path), the Grep tool (an explicit path or a glob that
// selects the secret namespace), and Bash (a command whose operands or input
// redirects name a secret file, including inside `$( )`, backticks, `<( )`,
// `bash -c '…'` / `eval "…"` bodies, and `git show <ref>:<path>` shapes).
//
// Why a hook and not permission rules (#4221): since #768 the installer wrote
// three `Read(.env)` / `Read(.env.*)` / `Read(.secrets)` deny rules into
// settings.json. Claude Code 2.1.259 hardened the Bash-side enforcement of
// Read() deny rules so that ANY `cd DIR && cat/grep relative-path` compound
// prompts for approval whenever any Read() deny rule exists — even in `auto`
// permission mode. GSD subagents emit hundreds of those per session. A
// PreToolUse denial is not a permission rule, so it never arms that check,
// and it applies in `auto` and `bypassPermissions` modes alike. The three
// installer-written strings are retired by the same installer change (they
// are filtered out as legacy entries on install and uninstall).
//
// What counts as a secret name (basename match, no path resolution, matched
// case-INSENSITIVELY so `.ENV` / `.Secrets` are caught on the macOS/Windows
// filesystems where they ARE the secret file — the write guard's `/i` stance):
//   .env, .secrets, and .env.<suffix> — EXCEPT .env.example / .env.sample /
//   .env.template / .env.dist, which are the non-secret templates GSD's own
//   phase prompt tells executors to read.
//   Stated cost: this is narrower than the retired `Read(.env.*)` rule — a
//   real secret stored in `.env.example` is not protected.
//   A token containing `:` is also tested on the part after its LAST `:`,
//   so `git show HEAD:.env`, `origin/main:config/.env` and `C:\proj\.env`
//   are caught without git-specific parsing. No whitespace trimming: the
//   commit message `fix: .env parsing` yields ` .env parsing`, not a name.
//
// Bash analysis is a two-pass token scan, not a shell:
//   pass 1 tokenizes with quote state, comments, redirect operators (with fd
//   digits and `>&N` dups), separators (recording the operator text), `$( )` /
//   backtick / `<( )` / `>( )` spans (recursed as nested commands, depth ≤ 3),
//   and heredocs (one token per body, carrying its `<<` segment). A heredoc
//   body is only ever run as a script when its segment's command is a shell
//   interpreter (below); a DATA heredoc — `cat <<EOF … EOF`, the agent-
//   populated bodies in GSD's own workflows, `git commit -m "$(cat <<'EOF' …
//   EOF)"` — is never operand-checked, so prose mentioning `.env` is safe.
//   pass 2 groups tokens by segment and evaluates each on its own:
//   input redirect targets (`<`, `N<`) are always checked; the command word is
//   located past `sudo`/`env VAR=x`/`nohup`-style prefixes; a closed set of
//   NON-READING commands (test/[/ls/stat/rm/touch/echo/…) exempts that
//   segment's operands — `[ -f .env ]` and `ls .env*` are existence checks
//   GSD's own agents run — while `cp`/`mv`/`ln`/`git` are deliberately NOT
//   exempt (`cp .env x && cat x` launders the name; `git show HEAD:.env`
//   reads). A shell interpreter (bash/sh/zsh/dash/ksh/su) has its script scanned
//   whether it arrives via `-c '…'`, a `<( )` file operand, a heredoc /
//   here-string, or a pipe from a knowable `echo`/`printf` source
//   (`echo cat .env | bash`); `eval` scans its joined operands; `source`/`.`
//   scans a `<( )` operand; and `find … | xargs cat` infers the upstream
//   segment's names as the sub-command's read operands.
//
// Grep globs are judged per brace alternative (never on the whole glob, so
// `{.env.local,zzz.ts}` cannot hide behind a benign sibling): a pure-wildcard
// alternative (`*`, `**`) is allowed — Grep already skips gitignored files,
// so it is equivalent to no glob; any other alternative is denied when its
// literal prefix is a prefix of `.env.`/`.secrets` (`.e*`, `.env*`, `.s*`) or
// when it matches a probe secret name (`*.local`, `*.*`, `*.env*`). More than
// 64 alternatives is denied as `glob-too-complex` (cheap to retry narrower).
//
// Documented gaps (none are statically resolvable by a hook, and Claude
// Code's own 2.1.259 Bash-side enforcement does not resolve them either):
//   `$VAR` indirection (`bash -c "$TEST_CMD"`, `cat "$F"`), shell globs
//   (`cat .e*`), interpreter one-liners (`python -c "open('.env')"`), a piped
//   script from a non-echo source (`cat gen.sh | bash`, `curl … | sh`), reads
//   inside scripts the agent executes, and `glob: '*'` reaching a
//   NON-gitignored `.env`. The promise is "no looser than the retired rules
//   on plain commands, without arming the compound-`cd` prompt". Writes to
//   secret files are out of scope (Write/Edit were never gated). Commands
//   over 1 MiB are denied outright (`command-too-large`) rather than
//   scanned partially or waved through.
//
// Triggers on: Read, Grep, Bash tool calls (Kimi: ReadFile, Grep, Shell)
// Action: BLOCK (decision: 'block', exit 2) — codes secret-read |
//         glob-too-complex | command-too-large
// No-op: other tools, non-secret targets, hook errors (fail open — a parser
//        bug in a hook that runs on EVERY Bash call must never brick a
//        session; the crash policy is declared once below).

'use strict';

const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');

// Fail open on a hook-internal error (see header). Declared ONCE so the
// outer catch states its policy explicitly (#3911).
const ON_CRASH = HOOK_ON_CRASH.ALLOW;

// Commands longer than this are denied rather than scanned (see header).
const MAX_COMMAND_LENGTH = 1024 * 1024;

// Recursion budget for `$( )` / backtick / `<( )` / nested-shell rescans.
const MAX_NESTING_DEPTH = 3;

// Brace-alternative budget for a Grep glob before it is denied as too complex.
const MAX_GLOB_ALTERNATIVES = 64;

// `.env.<suffix>` names that are templates, not secrets (case-insensitive).
const NON_SECRET_ENV_SUFFIXES = new Set(['example', 'sample', 'template', 'dist']);

// Command-prefix wrappers to look through when locating the command word at
// the head of a segment (same set as hooks/gsd-windsurf-pre-command.js).
const CMD_PREFIXES = new Set(['sudo', 'env', 'command', 'nice', 'nohup', 'time', 'doas']);

// Commands whose ordinary operands are file NAMES, never file CONTENTS. A
// closed set on purpose: anything not listed is assumed to read.
const NON_READING_COMMANDS = new Set([
  'test', '[', '[[', 'ls', 'stat', 'touch', 'rm', 'chmod', 'chown', 'mkdir',
  'basename', 'dirname', 'realpath', 'file', 'echo', 'printf',
]);

// Shell interpreters that run a script from `-c`, a file operand, or stdin
// (heredoc / here-string / piped `echo`|`printf`). `su` is here for its `-c`
// form (`su [user] -c 'cmd'`); a bare `su user` resolves to file mode, which
// only runs the ordinary operand check. `eval`, `source`/`.` and `xargs` are
// their own cases below; they are not in this set.
const SHELL_INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'su']);

// Shell flags whose VALUE is the next operand (`bash -o pipefail`,
// `bash --rcfile x <<EOF`): skipped when locating a script-file operand, so a
// flag value is not mistaken for the script and stdin mode still applies.
const SHELL_VALUE_FLAGS = new Set(['-o', '-O', '+o', '+O', '--rcfile', '--init-file']);

// Value-taking `xargs` flags (long `--flag=value` forms are single words).
// `-a`/`--arg-file` additionally replaces stdin, so it suppresses the pipeline
// inference below.
const XARGS_VALUE_FLAGS = new Set(['-n', '-I', '-i', '-L', '-l', '-P', '-s', '-d', '-E', '-a']);

// Probe names a Grep glob alternative is matched against. `.env` and
// `.secrets` are the exact names; the rest stand in for the open-ended
// `.env.<suffix>` family so empty-literal-prefix selectors (`*.local`,
// `*.production`, `*env.*`) are caught. Residual, stated in the header:
// an alternative like `*.ts` matches no probe and is allowed even though a
// `.env.foo.ts` would satisfy the name predicate.
const GLOB_PROBES = [
  '.env', '.secrets', '.env.local', '.env.development', '.env.production',
  '.env.staging', '.env.test', '.env.development.local', '.env.production.local',
  '.env.zzq',
];

// ---------------------------------------------------------------------------
// Secret-name predicate
// ---------------------------------------------------------------------------

function isSecretBasename(name) {
  if (name === '.env' || name === '.secrets') return true;
  if (name.startsWith('.env.')) {
    const suffix = name.slice('.env.'.length);
    return suffix !== '' && !NON_SECRET_ENV_SUFFIXES.has(suffix.toLowerCase());
  }
  return false;
}

// Last `/`- or `\`-separated segment, ignoring trailing separators.
function lastSegment(tok) {
  const s = tok.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

// True when the token's basename — or the basename of the part after its
// last `:` (git `<ref>:<path>`, Windows drive) — is a secret name. Folded to
// lower case once at the top so `.ENV` / `.Secrets` match on the
// case-insensitive filesystems (macOS, Windows) where they ARE the secret file
// — the same stance as the write guard's `/i` patterns.
function namesSecret(tok) {
  if (typeof tok !== 'string' || tok === '') return false;
  const lower = tok.toLowerCase();
  if (isSecretBasename(lastSegment(lower))) return true;
  const colon = lower.lastIndexOf(':');
  return colon !== -1 && isSecretBasename(lastSegment(lower.slice(colon + 1)));
}

// ---------------------------------------------------------------------------
// Grep glob analysis
// ---------------------------------------------------------------------------

// Expand `{a,b,…}` (nested allowed) into the list of alternatives, or null
// when the list would exceed MAX_GLOB_ALTERNATIVES. Malformed braces are
// treated literally.
function expandBraces(glob) {
  const open = glob.indexOf('{');
  if (open === -1) return [glob];
  let depth = 0;
  let close = -1;
  const commas = [];
  for (let i = open; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { close = i; break; }
    } else if (ch === ',' && depth === 1) commas.push(i);
  }
  if (close === -1) return [glob];
  const pre = glob.slice(0, open);
  const post = glob.slice(close + 1);
  const inner = glob.slice(open + 1, close);
  const parts = [];
  let start = 0;
  for (const c of commas) {
    parts.push(inner.slice(start, c - open - 1));
    start = c - open;
  }
  parts.push(inner.slice(start));
  const out = [];
  for (const part of parts) {
    const expanded = expandBraces(pre + part + post);
    if (expanded === null) return null;
    for (const alt of expanded) {
      out.push(alt);
      if (out.length > MAX_GLOB_ALTERNATIVES) return null;
    }
  }
  return out;
}

// Anchored regex for one brace-free glob alternative (`*` → `[^/]*`,
// `?` → `[^/]`, `[…]` classes passed through with `[!` → `[^`).
function globAltToRegex(alt) {
  let out = '^';
  for (let i = 0; i < alt.length; i++) {
    const ch = alt[i];
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const j = alt.indexOf(']', i + 1);
      if (j === -1) out += '\\[';
      else {
        const body = alt.slice(i + 1, j);
        out += '[' + (body.startsWith('!') ? '^' + body.slice(1) : body).replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

// Does this single alternative select any secret name? (See header.)
function globAltSelectsSecret(alt) {
  if (alt === '') return false;
  if (/^[*?]+$/.test(alt)) return false; // pure wildcard: equivalent to no glob
  const wild = alt.search(/[*?[]/);
  const lit = wild === -1 ? alt : alt.slice(0, wild);
  if (lit.startsWith('.env.')) return true;
  if (lit !== '' && ('.env.'.startsWith(lit) || '.secrets'.startsWith(lit))) return true;
  let re;
  try {
    re = globAltToRegex(alt);
  } catch {
    return true; // an unparsable class — Grep would reject it too; deny is the safe side
  }
  return GLOB_PROBES.some((probe) => re.test(probe));
}

// Returns null (allowed), 'secret-read', or 'glob-too-complex'.
function classifyGrepGlob(glob) {
  const segIdx = glob.replace(/\/+$/, '').lastIndexOf('/');
  // Case-fold the last segment (GLOB_PROBES are lower case) so `.ENV*` and
  // `*.ENV` select the secret namespace on case-insensitive filesystems.
  const segment = (segIdx === -1 ? glob : glob.slice(segIdx + 1)).toLowerCase();
  const alts = expandBraces(segment);
  if (alts === null) return 'glob-too-complex';
  return alts.some(globAltSelectsSecret) ? 'secret-read' : null;
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 1: tokenizer
// ---------------------------------------------------------------------------

// Index of the `)` closing a `$(` / `<(` / `>(` opened just before `i`, or
// str.length when unterminated. Quote- and heredoc-aware so a `)` inside a
// quoted string or a heredoc body never closes the span early.
function findParenClose(str, i) {
  let depth = 1;
  let heredocTags = [];
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === "'") {
      const j = str.indexOf("'", i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < str.length && str[i] !== '"') {
        if (str[i] === '\\') { i += 2; continue; }
        if (str[i] === '$' && str[i + 1] === '(') { i = findParenClose(str, i + 2) + 1; continue; }
        if (str[i] === '`') {
          const j = str.indexOf('`', i + 1);
          i = j === -1 ? str.length : j + 1;
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '`') {
      const j = str.indexOf('`', i + 1);
      i = j === -1 ? str.length : j + 1;
      continue;
    }
    if (ch === '<' && str[i + 1] === '<' && str[i + 2] !== '<') {
      const tag = readHeredocTag(str, i + 2);
      heredocTags.push(tag);
      i = tag.end;
      continue;
    }
    if (ch === '\n' && heredocTags.length) {
      i = consumeHeredocBodies(str, i + 1, heredocTags).end;
      heredocTags = [];
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return str.length;
}

// Reads the tag word after `<<` / `<<-` starting at `i`.
function readHeredocTag(str, i) {
  let stripTabs = false;
  if (str[i] === '-') { stripTabs = true; i++; }
  while (str[i] === ' ' || str[i] === '\t') i++;
  let quoted = false;
  let tag = '';
  if (str[i] === "'" || str[i] === '"') {
    const q = str[i];
    const j = str.indexOf(q, i + 1);
    tag = str.slice(i + 1, j === -1 ? str.length : j);
    quoted = true;
    i = j === -1 ? str.length : j + 1;
  } else {
    if (str[i] === '\\') { quoted = true; i++; }
    while (i < str.length && !/[\s;&|<>()]/.test(str[i])) tag += str[i++];
  }
  return { tag, quoted, stripTabs, end: i };
}

// From `i` (start of the line after the heredoc-opening line), consume one
// body per pending tag in order. Returns every body with its `quoted`/`seg`
// (the caller emits a token per body and recurses substitutions only for
// unquoted ones) and the index just past the last terminator line. An
// unterminated body consumes to end of input.
function consumeHeredocBodies(str, i, tags) {
  const bodies = [];
  for (const t of tags) {
    let body = '';
    let terminated = false;
    while (i < str.length) {
      const nl = str.indexOf('\n', i);
      const lineEnd = nl === -1 ? str.length : nl;
      const line = str.slice(i, lineEnd);
      i = nl === -1 ? str.length : nl + 1;
      const probe = t.stripTabs ? line.replace(/^\t+/, '') : line;
      if (probe === t.tag) { terminated = true; break; }
      body += line + '\n';
    }
    bodies.push({ body, quoted: t.quoted, seg: t.seg });
    if (!terminated) break;
  }
  return { bodies, end: i };
}

// `$( )` and backtick spans inside an unquoted heredoc body.
function collectSubstitutions(body, nested) {
  let i = 0;
  while (i < body.length) {
    if (body[i] === '$' && body[i + 1] === '(') {
      const e = findParenClose(body, i + 2);
      nested.push(body.slice(i + 2, e));
      i = e + 1;
      continue;
    }
    if (body[i] === '`') {
      const j = body.indexOf('`', i + 1);
      const e = j === -1 ? body.length : j;
      nested.push(body.slice(i + 1, e));
      i = e + 1;
      continue;
    }
    i++;
  }
}

// Tokens: { kind: 'word'|'op'|'sep', text, quoted: 'none'|'single'|'double', seg }.
// `op` tokens carry `read` (an input redirect) and `dup` (`>&N`, consumes no
// target). Nested command strings are collected separately.
function tokenize(str) {
  const tokens = [];
  const nested = [];
  let buf = '';
  let quoted = 'none';
  let hasWord = false;
  let seg = 0;
  let heredocs = [];
  let expectTag = null;

  const flush = () => {
    if (!hasWord) return;
    if (expectTag) {
      // Record the current seg (still the `<<` segment — flush runs before the
      // newline sep increments it) so pass 2 can attach the body to the shell.
      heredocs.push({ tag: buf, quoted: quoted !== 'none', stripTabs: expectTag.stripTabs, seg });
      expectTag = null;
    } else {
      tokens.push({ kind: 'word', text: buf, quoted, seg });
    }
    buf = '';
    quoted = 'none';
    hasWord = false;
  };
  // The operator text ends segment `seg`; pass 2 reads it to tell `a | bash`
  // (pipe inference) from `a || bash` and to skip grouping seps.
  const sep = (text) => {
    flush();
    tokens.push({ kind: 'sep', text, quoted: 'none', seg });
    seg++;
  };
  const op = (text, read, dup) => {
    tokens.push({ kind: 'op', text, quoted: 'none', seg, read, dup });
  };

  let i = 0;
  while (i < str.length) {
    const ch = str[i];

    if (ch === "'") {
      hasWord = true;
      if (quoted === 'none') quoted = 'single';
      const j = str.indexOf("'", i + 1);
      const end = j === -1 ? str.length : j;
      buf += str.slice(i + 1, end);
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      hasWord = true;
      if (quoted === 'none') quoted = 'double';
      i++;
      while (i < str.length && str[i] !== '"') {
        const c = str[i];
        if (c === '\\' && i + 1 < str.length && '"\\$`\n'.includes(str[i + 1])) {
          if (str[i + 1] !== '\n') buf += str[i + 1];
          i += 2;
          continue;
        }
        if (c === '$' && str[i + 1] === '(') {
          const e = findParenClose(str, i + 2);
          nested.push(str.slice(i + 2, e));
          i = e + 1;
          continue;
        }
        if (c === '`') {
          const j = str.indexOf('`', i + 1);
          const e = j === -1 ? str.length : j;
          nested.push(str.slice(i + 1, e));
          i = e + 1;
          continue;
        }
        buf += c;
        i++;
      }
      i++;
      continue;
    }

    if (ch === '\\') {
      if (str[i + 1] === '\n') { i += 2; continue; } // line continuation
      hasWord = true;
      if (i + 1 < str.length) buf += str[i + 1];
      i += 2;
      continue;
    }

    if (ch === '$' && str[i + 1] === '(') {
      hasWord = true;
      const e = findParenClose(str, i + 2);
      nested.push(str.slice(i + 2, e));
      i = e + 1;
      continue;
    }

    if (ch === '$' && str[i + 1] === '{') {
      hasWord = true;
      const j = str.indexOf('}', i);
      const e = j === -1 ? str.length - 1 : j;
      buf += str.slice(i, e + 1);
      i = e + 1;
      continue;
    }

    if (ch === '`') {
      hasWord = true;
      const j = str.indexOf('`', i + 1);
      const e = j === -1 ? str.length : j;
      nested.push(str.slice(i + 1, e));
      i = e + 1;
      continue;
    }

    if ((ch === '<' || ch === '>') && str[i + 1] === '(') {
      flush();
      const e = findParenClose(str, i + 2);
      const inner = str.slice(i + 2, e);
      nested.push(inner);
      // Emit a word carrying the inner script so a shell / `source` operand
      // (`sh <(echo 'cat .env')`) can reconstruct it; the bare nested recursion
      // above only sees `echo …`, whose operands are not read.
      tokens.push({ kind: 'word', text: str.slice(i, e + 1), quoted: 'none', seg, procsub: inner });
      i = e + 1;
      continue;
    }

    if (ch === '\n') {
      sep('\n');
      i++;
      if (heredocs.length) {
        const r = consumeHeredocBodies(str, i, heredocs);
        for (const b of r.bodies) {
          // Emit a heredoc token per body (quoted included) — the body is the
          // stdin script only a shell interpreter runs. Kept out of `words`.
          tokens.push({ kind: 'heredoc', text: b.body, quoted: b.quoted, seg: b.seg });
          if (!b.quoted) collectSubstitutions(b.body, nested); // bash expands $( ) here
        }
        heredocs = [];
        i = r.end;
      }
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\r') {
      flush();
      i++;
      continue;
    }

    if (ch === '#' && !hasWord) {
      const j = str.indexOf('\n', i);
      i = j === -1 ? str.length : j;
      continue;
    }

    if (ch === '<' || ch === '>' || (ch === '&' && str[i + 1] === '>')) {
      let fd = '';
      if (hasWord && quoted === 'none' && /^\d+$/.test(buf)) {
        fd = buf;
        buf = '';
        hasWord = false;
      } else {
        flush();
      }
      let j = i;
      let text;
      if (str.startsWith('<<<', j)) { text = '<<<'; j += 3; }
      else if (str.startsWith('<<-', j)) { text = '<<-'; j += 3; }
      else if (str.startsWith('<<', j)) { text = '<<'; j += 2; }
      else if (str.startsWith('&>>', j)) { text = '&>>'; j += 3; }
      else if (str.startsWith('&>', j)) { text = '&>'; j += 2; }
      else if (str.startsWith('>>', j)) { text = '>>'; j += 2; }
      else if (str.startsWith('>|', j)) { text = '>|'; j += 2; }
      else { text = ch; j += 1; }
      if (text === '<<' || text === '<<-') {
        expectTag = { stripTabs: text === '<<-' };
        i = j;
        continue;
      }
      let dup = false;
      if ((text === '<' || text === '>') && str[j] === '&' && /[\d-]/.test(str[j + 1] || '')) {
        let k = j + 1;
        while (k < str.length && /[\d-]/.test(str[k])) k++;
        text += str.slice(j, k);
        j = k;
        dup = true;
      }
      op(fd + text, text[0] === '<' && text !== '<<<', dup);
      i = j;
      continue;
    }

    // Lookahead first, THEN record the full operator, so `a || bash` reports
    // `||` (no pipe inference) and `a | bash` reports `|` (pipe inference).
    if (ch === ';') {
      let text = ';';
      i++;
      if (str[i] === ';') { text = ';;'; i++; }
      sep(text);
      continue;
    }
    if (ch === '|') {
      let text = '|';
      i++;
      if (str[i] === '|') { text = '||'; i++; }
      else if (str[i] === '&') { text = '|&'; i++; }
      sep(text);
      continue;
    }
    if (ch === '&') {
      let text = '&';
      i++;
      if (str[i] === '&') { text = '&&'; i++; }
      sep(text);
      continue;
    }
    if (ch === '(' || ch === ')') {
      sep(ch);
      i++;
      continue;
    }
    if ((ch === '{' || ch === '}') && !hasWord && (i + 1 >= str.length || /[\s;&|)]/.test(str[i + 1]))) {
      sep(ch);
      i++;
      continue;
    }

    hasWord = true;
    buf += ch;
    i++;
  }
  flush();
  return { tokens, nested };
}

// ---------------------------------------------------------------------------
// Bash command scan — pass 2: per-segment evaluation
// ---------------------------------------------------------------------------

// `@file` (curl -d), `--flag=value`, `-Xvalue` → the operand that names the file.
function normalizeOperand(text) {
  let v = text;
  if (v.startsWith('@')) v = v.slice(1);
  if (v.startsWith('--')) {
    const eq = v.indexOf('=');
    if (eq !== -1) v = v.slice(eq + 1);
  } else if (/^-[A-Za-z]./.test(v)) {
    v = v.slice(2);
  }
  return v;
}

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

// `-c`, or a combined short flag ending in `c` (`-lc`, `-ec`, `-euc`): mode c.
const DASH_C_RE = /^-[A-Za-z]*c$/;

const GROUPING_SEPS = new Set(['(', ')', '{', '}']);

// Command base + operands after leading `VAR=val` assignments and prefix
// wrappers (`sudo`, `env VAR=x`, …), or null when nothing but prefixes remain.
function resolveCommand(words) {
  let idx = 0;
  while (idx < words.length && ASSIGNMENT_RE.test(words[idx].text)) idx++;
  while (idx < words.length) {
    const base = lastSegment(words[idx].text).toLowerCase();
    if (!CMD_PREFIXES.has(base)) break;
    idx++;
    if (base === 'env') {
      while (idx < words.length && ASSIGNMENT_RE.test(words[idx].text)) idx++;
    }
  }
  if (idx >= words.length) return null;
  return { base: lastSegment(words[idx].text).toLowerCase(), operands: words.slice(idx + 1) };
}

// The statically-knowable stdin a segment writes: `echo`/`printf` operands
// joined by a space (for `echo`, leading `-neE` flags dropped). Any other
// source (`cat gen.sh | bash`, `curl … | sh`) is not knowable → null.
function reconstructedScript(words) {
  const cmd = resolveCommand(words);
  if (!cmd) return null;
  if (cmd.base === 'echo') {
    let start = 0;
    while (start < cmd.operands.length && /^-[neE]+$/.test(cmd.operands[start].text)) start++;
    return cmd.operands.slice(start).map((w) => w.text).join(' ');
  }
  if (cmd.base === 'printf') return cmd.operands.map((w) => w.text).join(' ');
  return null;
}

// Same rule applied to a `<( … )` / `>( … )` inner script's first segment.
function reconstructedProcsub(inner) {
  const { tokens } = tokenize(inner);
  const words = [];
  for (const t of tokens) {
    if (t.kind === 'sep') break;
    if (t.kind === 'word') words.push(t);
  }
  return reconstructedScript(words);
}

// The operator connecting segment `s` to the nearest PRECEDING segment that has
// word tokens, skipping empty grouping segments (`(echo cat .env) | bash` has an
// empty segment between `)` and `|`). Returns { op, prevSeg }.
function precedingOp(s, bySeg, sepAfter) {
  let p = s - 1;
  while (p >= 0 && !(bySeg.get(p) || []).some((t) => t.kind === 'word')) p--;
  if (p < 0) return { op: undefined, prevSeg: -1 };
  let op;
  for (let q = p; q < s; q++) {
    const text = sepAfter.get(q);
    if (text !== undefined && !GROUPING_SEPS.has(text)) op = text; // last non-grouping wins
  }
  return { op, prevSeg: p };
}

// Returns the offending token text, or null.
function findSecretRead(command, depth) {
  const { tokens, nested } = tokenize(command);

  for (const sub of nested) {
    if (depth < MAX_NESTING_DEPTH) {
      const hit = findSecretRead(sub, depth + 1);
      if (hit) return hit;
    }
  }

  // Group by seg, not separator order: heredoc tokens carry their `<<`
  // segment's seg and must reach the shell even though a data heredoc sits
  // between other separators. Heredocs are kept OUT of `words` so a data body
  // is never operand-checked (`cat <<EOF\n.env\nEOF` stays allowed).
  const bySeg = new Map();
  const heredocsBySeg = new Map();
  const sepAfter = new Map();
  let maxSeg = 0;
  for (const t of tokens) {
    if (t.seg > maxSeg) maxSeg = t.seg;
    if (t.kind === 'sep') {
      sepAfter.set(t.seg, t.text);
    } else if (t.kind === 'heredoc') {
      if (!heredocsBySeg.has(t.seg)) heredocsBySeg.set(t.seg, []);
      heredocsBySeg.get(t.seg).push(t);
    } else {
      if (!bySeg.has(t.seg)) bySeg.set(t.seg, []);
      bySeg.get(t.seg).push(t);
    }
  }

  for (let s = 0; s <= maxSeg; s++) {
    const segTokens = bySeg.get(s);
    if (!segTokens) continue;

    const words = [];
    const hereStrings = [];
    for (let k = 0; k < segTokens.length; k++) {
      const t = segTokens[k];
      if (t.kind === 'op') {
        if (t.dup) continue;
        const target = segTokens[k + 1];
        if (target && target.kind === 'word') {
          k++;
          if (t.text.endsWith('<<<')) hereStrings.push(target.text); // stdin data for a shell
          // Input redirects are reads regardless of the command's exemption.
          else if (t.read && namesSecret(target.text)) return target.text;
        }
        continue;
      }
      words.push(t);
    }
    if (!words.length) continue;

    const cmd = resolveCommand(words);
    if (!cmd) continue;
    const { base, operands } = cmd;
    const heredocs = heredocsBySeg.get(s) || [];

    // eval concatenates ALL its operands and runs the result.
    if (base === 'eval') {
      if (depth < MAX_NESTING_DEPTH) {
        const hit = findSecretRead(operands.map((w) => w.text).join(' '), depth + 1);
        if (hit) return hit;
      }
      continue;
    }

    // `source` / `.` reads a file (or a process-substitution script).
    if (base === 'source' || base === '.') {
      for (const w of operands) {
        if (w.procsub !== undefined && depth < MAX_NESTING_DEPTH) {
          const src = reconstructedProcsub(w.procsub);
          if (src !== null) {
            const hit = findSecretRead(src, depth + 1);
            if (hit) return hit;
          }
        } else if (namesSecret(normalizeOperand(w.text))) return w.text;
      }
      continue;
    }

    // xargs turns stdin file names into a sub-command's operands.
    if (base === 'xargs' && depth < MAX_NESTING_DEPTH) {
      const hit = scanXargsPipe(operands, s, bySeg, sepAfter, depth);
      if (hit) return hit;
      // `.env` given to xargs itself (`xargs -a .env cat`) is an ordinary
      // operand — fall through to the operand check below.
    }

    if (SHELL_INTERPRETERS.has(base) && depth < MAX_NESTING_DEPTH) {
      const hit = scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth);
      if (hit) return hit;
      // `bash .env` (file mode) is caught by the operand check below.
    }

    if (NON_READING_COMMANDS.has(base)) continue;

    for (const w of operands) {
      if (namesSecret(normalizeOperand(w.text))) return w.text;
    }
  }
  return null;
}

// A shell interpreter's script comes from `-c`, a file operand, or stdin.
function scanShellInterpreter(operands, heredocs, hereStrings, s, bySeg, sepAfter, depth) {
  const cIdx = operands.findIndex((w) => DASH_C_RE.test(w.text));
  if (cIdx !== -1) {
    // Mode c: the next operand is the script; stdin is DATA (not scanned).
    const script = operands[cIdx + 1];
    if (script) return findSecretRead(script.text, depth + 1);
    return null;
  }
  let fileTok;
  for (let m = 0; m < operands.length; m++) {
    if (SHELL_VALUE_FLAGS.has(operands[m].text)) { m++; continue; }
    if (!operands[m].text.startsWith('-')) { fileTok = operands[m]; break; }
  }
  if (fileTok) {
    // Mode file: `bash <(echo 'cat .env')`; a plain file is checked as an operand.
    if (fileTok.procsub !== undefined) {
      const src = reconstructedProcsub(fileTok.procsub);
      if (src !== null) return findSecretRead(src, depth + 1);
    }
    return null;
  }
  // Mode stdin: heredoc bodies, here-strings, and a piped echo/printf source.
  for (const h of heredocs) {
    const hit = findSecretRead(h.text, depth + 1);
    if (hit) return hit;
  }
  for (const hs of hereStrings) {
    const hit = findSecretRead(hs, depth + 1);
    if (hit) return hit;
  }
  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if ((op === '|' || op === '|&') && prevSeg >= 0) {
    const src = reconstructedScript((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
    if (src !== null) return findSecretRead(src, depth + 1);
  }
  return null;
}

// `find … | xargs cat`: the upstream segment's operands become file names the
// sub-command reads. Only inferred across a real pipe and when stdin is not
// redirected by `-a`/`--arg-file`. A sub-command that is itself a shell
// (`xargs -I{} sh -c 'cat .env'`) carries a literal script and is scanned in
// mode c whether or not a pipe feeds it.
function scanXargsPipe(operands, s, bySeg, sepAfter, depth) {
  let argFile = false;
  let subIdx = -1;
  for (let m = 0; m < operands.length; m++) {
    const t = operands[m].text;
    if (t === '-a' || t === '--arg-file') { argFile = true; m++; continue; }
    if (t.startsWith('--arg-file=')) { argFile = true; continue; }
    if (XARGS_VALUE_FLAGS.has(t)) { m++; continue; }
    if (t.startsWith('--') && t.includes('=')) continue;
    if (t.startsWith('-')) continue; // no-value flag (-0 -r -t -p) or long flag
    subIdx = m;
    break;
  }
  if (subIdx === -1) return null; // no sub-command: xargs defaults to echo

  const subBase = lastSegment(operands[subIdx].text).toLowerCase();
  if (SHELL_INTERPRETERS.has(subBase)) {
    // Heredocs/here-strings belong to xargs, not the sub-shell; pass none.
    const hit = scanShellInterpreter(operands.slice(subIdx + 1), [], [], s, bySeg, sepAfter, depth);
    if (hit) return hit;
  }
  if (argFile) return null; // stdin replaced by a file — no pipeline inference
  if (NON_READING_COMMANDS.has(subBase)) return null;

  const { op, prevSeg } = precedingOp(s, bySeg, sepAfter);
  if (op !== '|' && op !== '|&') return null;
  if (prevSeg < 0) return null;

  // Every upstream operand is a candidate file name — the NON_READING
  // exemption is bypassed for it, but the `.env.example|…` suffix exemption in
  // isSecretBasename still holds.
  const prevCmd = resolveCommand((bySeg.get(prevSeg) || []).filter((t) => t.kind === 'word'));
  if (!prevCmd) return null;
  for (const w of prevCmd.operands) {
    if (namesSecret(normalizeOperand(w.text))) return w.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emission
// ---------------------------------------------------------------------------

const PATTERN_TEXT = '.env, .env.<suffix> (except .env.example/.sample/.template/.dist), .secrets';

function reasonFor(code, tool, target) {
  if (code === 'command-too-large') {
    return `Secret read guard: this Bash command is over ${MAX_COMMAND_LENGTH} characters and ` +
      'cannot be checked for secret-file reads. Split it into smaller commands.';
  }
  if (code === 'glob-too-complex') {
    return `Secret read guard: the Grep glob '${target}' expands to more than ${MAX_GLOB_ALTERNATIVES} ` +
      'alternatives and cannot be checked for secret-file matches. Use a narrower glob.';
  }
  return `Secret read guard: ${tool} would read '${target}', which matches a protected secret-file ` +
    `pattern (${PATTERN_TEXT}). Secret values must not be read into the conversation. ` +
    'If you need a specific value, ask the user for it; if you need the variable NAMES, ' +
    'read the non-secret template (.env.example) instead.';
}

// stdout gets the typed JSON block; stderr gets the plain reason string
// (Kimi's hook bus reads stderr verbatim back to the model — #3911).
function emitBlock(code, tool, target) {
  const reason = reasonFor(code, tool, target);
  deny({ decision: 'block', code, tool, path: target, reason }, reason);
}

// Strips a `module:` prefix so Kimi's `kimi_cli.tools.file:Grep` (not in the
// KIMI_TOOL_NAMES map — Grep has the same name on both buses) matches.
function bareToolName(raw) {
  return typeof raw === 'string' ? raw.slice(raw.lastIndexOf(':') + 1) : '';
}

// #2304: Kimi's native hook bus delivers Kimi's tool vocabulary in the
// payload (ReadFile / Shell) and `path` instead of `file_path`; the map and
// normalizer below are the byte-identical copy every guard carries (bound by
// tests/kimi-guard-normalization-parity.test.cjs — do not edit locally).
// Grep keeps its name on Kimi and is not in the map; bareToolName() above
// strips the module prefix for it.
const KIMI_TOOL_NAMES = new Map([['WriteFile', 'Write'], ['StrReplaceFile', 'Edit'], ['ReadFile', 'Read'], ['Shell', 'Bash']]);
function normalizeKimiPayload(data) {
  // #2595 (review nit): `JSON.parse('null')` is null, and null/primitive
  // payloads reached the `data.tool_name` read below and threw — falsifying
  // this function's own "total over the inputs JSON can express" claim, which
  // property (e) now tests directly. Harmless in practice (a null payload has
  // nothing to guard, and the throw landed in the same fail-open catch as the
  // exit-0 it now takes deliberately) but the claim should be true as stated.
  if (data === null || typeof data !== 'object') return data;
  const raw = data.tool_name;
  if (typeof raw !== 'string') return data;
  const mapped = KIMI_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (data.tool_response === undefined && data.tool_output !== undefined) {
    data.tool_response = data.tool_output;
  }
  const input = data.tool_input;
  if (input && typeof input === 'object') {
    // #2547 (review): Kimi's `path` is AUTHORITATIVE — it must win outright,
    // not merely fill in when `file_path` happens to be absent. kimi-cli's file
    // tools carry no `file_path` field at all (src/kimi_cli/tools/file/write.py,
    // replace.py, @ 4a550ef — the SHA #2547 pins), and soul/toolset.py hands the
    // model's raw json-parsed
    // arguments to PreToolUse verbatim, doing typed validation only later inside
    // tool.call() — after the hook has already decided. So a `file_path` in a
    // Kimi payload is ALWAYS model-supplied, and under the old `=== undefined`
    // condition it SHADOWED the field kimi-cli actually executes on. A payload
    // pairing a cross-root `path` with a spurious `file_path: ""` left every
    // guard reading an empty string and exiting 0, while the identical write
    // without the extra key blocked — a bypass needing no crash at all. The same
    // shadowing also preserved a NON-STRING `file_path` (`[]`), which threw
    // inside gsd-worktree-path-guard's path.isAbsolute() and reached its outer
    // `catch { process.exit(0) }`: the same crash-to-allow this fix closes
    // elsewhere, reached through the guard's own read rather than through
    // normalization. Overwriting can only ever narrow what a guard inspects to
    // the path that will actually be written, so it cannot under-block.
    if (typeof input.path === 'string') {
      input.file_path = input.path;
    }
    const edits = Array.isArray(input.edit) ? input.edit
      : (input.edit && typeof input.edit === 'object') ? [input.edit] : [];
    if (edits.length) {
      // #2547: `e?.old`, not `e.old` — `??` guards the value, not the
      // dereference, so a NULLISH entry (`edit: [null]`) threw a TypeError
      // here. normalizeKimiPayload runs before any tool dispatch, so that throw
      // reached each guard's outer `catch { process.exit(0) }` and silently
      // downgraded a should-BLOCK call into an allow. (A string/number entry
      // never threw — `('x').old` is a legal read yielding undefined.)
      //
      // The String() coercion is guarded for the same reason: `{"toString":
      // null}` is valid JSON that throws "Cannot convert object to primitive
      // value", which is the identical crash-to-allow with a different
      // trigger. Degrading only the non-coercible entry to '' keeps
      // stringification intact for every value that CAN coerce (numbers,
      // arrays, plain objects), so nothing downstream — including
      // gsd-prompt-guard's scan of new_string — loses content it saw before.
      const editText = (v) => { try { return String(v ?? ''); } catch { return ''; } };
      // #2595 (review Major 2): reconstruct UNCONDITIONALLY, mirroring the
      // `path` decision above rather than merely filling in when the field
      // happens to be absent. kimi-cli's StrReplaceFile schema is `path` +
      // `edit` only (src/kimi_cli/tools/file/replace.py @ 4a550ef) — it carries
      // no `old_string`/`new_string` at all, so either field appearing in a
      // Kimi payload is ALWAYS model-supplied, exactly like `file_path`. Under
      // the old `=== undefined` condition a model-supplied `new_string: ""`
      // SHADOWED the reconstruction, leaving gsd-prompt-guard's injection scan
      // reading '' and exiting at its `if (!content)` before it ever saw the
      // real `edit[].new` — a one-key bypass of the very scan this fix's
      // guarded coercion exists to keep fed. A `typeof` test would NOT close
      // it: a benign non-empty string shadows just as effectively as ''.
      input.old_string = edits.map((e) => editText(e?.old)).join('\n');
      input.new_string = edits.map((e) => editText(e?.new)).join('\n');
    }
  }
  return data;
}

// #4332: Antigravity's hook bus is the #2304 defect one runtime over, plus a
// layer. `install --antigravity` registers 13 hooks whose EVENT names are
// translated (BeforeTool/AfterTool — ADR-857/1016, #1077) but whose matchers
// and payload reads were left in Claude Code's vocabulary, so every guard was
// spawned and then exited 0 on `data.tool_name === undefined`. Antigravity
// does not merely rename the tools the way Kimi does — it NESTS the call and
// uses PascalCase argument keys:
//   { toolCall: { name: 'write_to_file', args: { AbsolutePath, TargetFile } },
//     conversationId: '…' }
// so a name map alone (the #2507 shape) is not enough; the envelope needs
// lifting too. `AbsolutePath` is authoritative and wins outright over
// `TargetFile`, for the same reason Kimi's `path` wins over a model-supplied
// `file_path` (#2547/#2752): overwriting can only narrow what a guard inspects
// to the path that will actually be written, so it cannot under-block.
// Runs BEFORE normalizeKimiPayload and is a no-op on every other runtime — a
// payload with no `toolCall` object is returned untouched, so a Claude Code or
// Kimi payload never enters this path. Inlined per guard, not hooks/lib/, for
// the reason stated above the Kimi block.
const ANTIGRAVITY_TOOL_NAMES = new Map([['write_to_file', 'Write'], ['replace_file_content', 'Edit'], ['multi_replace_file_content', 'Edit'], ['view_file', 'Read'], ['run_command', 'Bash'], ['grep_search', 'Grep']]);
function normalizeAntigravityPayload(data) {
  if (data === null || typeof data !== 'object') return data;
  const call = data.toolCall;
  if (call === null || typeof call !== 'object') return data;
  const raw = call.name;
  if (typeof raw !== 'string') return data;
  const mapped = ANTIGRAVITY_TOOL_NAMES.get(raw.slice(raw.lastIndexOf(':') + 1));
  if (!mapped) return data;
  data.tool_name = mapped;
  if (typeof data.session_id !== 'string' && typeof data.conversationId === 'string') {
    data.session_id = data.conversationId;
  }
  const args = call.args;
  if (args !== null && typeof args === 'object') {
    const input = (data.tool_input !== null && typeof data.tool_input === 'object') ? data.tool_input : {};
    // Only documented keys are lifted, and only from a string: a bulk copy of
    // `args` would carry an attacker-chosen `__proto__` key into a plain
    // object, and would invent field names this runtime has not been observed
    // to send. A key that is absent leaves the guard reading `undefined` and
    // failing open exactly as it does today — never worse than dormant.
    if (typeof args.TargetFile === 'string') input.file_path = args.TargetFile;
    if (typeof args.AbsolutePath === 'string') input.file_path = args.AbsolutePath;
    for (const key of ['CommandLine', 'Command']) {
      if (typeof args[key] === 'string') { input.command = args[key]; break; }
    }
    data.tool_input = input;
  }
  return data;
}

let input = '';
const stdinTimeout = setTimeout(() => allow(undefined), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = normalizeKimiPayload(normalizeAntigravityPayload(JSON.parse(input)));

    // A null/primitive payload has nothing to guard — exit deliberately
    // rather than throwing into the fail-open catch below (#2595 class).
    if (data === null || typeof data !== 'object') {
      allow(undefined);
    }

    const tool = bareToolName(data.tool_name);
    if (tool !== 'Read' && tool !== 'Grep' && tool !== 'Bash') {
      allow(undefined);
    }
    if (!data.tool_input || typeof data.tool_input !== 'object') {
      allow(undefined);
    }

    // Every payload field is read TYPED in a single statement (#2547 class):
    // `[]`/`{}` are truthy and a non-string degrades to '' here.
    if (tool === 'Read') {
      const filePath = typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '';
      if (namesSecret(filePath)) emitBlock('secret-read', tool, filePath);
      allow(undefined);
    }

    if (tool === 'Grep') {
      const grepPath = typeof data.tool_input.path === 'string' ? data.tool_input.path
        : (typeof data.tool_input.file_path === 'string' ? data.tool_input.file_path : '');
      if (namesSecret(grepPath)) emitBlock('secret-read', tool, grepPath);
      const glob = typeof data.tool_input.glob === 'string' ? data.tool_input.glob : '';
      if (glob !== '') {
        const verdict = classifyGrepGlob(glob);
        if (verdict) emitBlock(verdict, tool, glob);
      }
      allow(undefined);
    }

    // Bash
    const command = typeof data.tool_input.command === 'string' ? data.tool_input.command : '';
    if (command === '') allow(undefined);
    if (command.length > MAX_COMMAND_LENGTH) emitBlock('command-too-large', tool, '');
    const hit = findSecretRead(command, 0);
    if (hit !== null) emitBlock('secret-read', tool, hit);
    allow(undefined);
  } catch {
    // Fail open — never block valid tool calls due to hook errors.
    // ON_CRASH is declared ALLOW at module top (#3911).
    crash(ON_CRASH, undefined);
  }
});
