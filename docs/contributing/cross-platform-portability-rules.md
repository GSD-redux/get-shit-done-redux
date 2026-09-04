# Cross-platform portability lint rules

GSD must run on Windows as well as macOS/Linux. A family of AST-based ESLint rules (the
`local/*` plugin) enforces the `DEFECT.WINDOWS-*` portability classes documented in
[`CONTEXT.md`](../../CONTEXT.md) **at write-time (in your editor) and in CI**, so a
Windows-only defect is caught before it ships — not after it reaches the `windows-latest` CI
lane. The architecture and rationale are in [ADR-1703](../adr/1703-portability-enforcement-architecture.md);
this page is the practical reference + how-to.

> **Adding a new rule?** See [`adding-a-portability-rule.md`](./adding-a-portability-rule.md) —
> the five seams (rule / vocab / platform-guard / disable-ban / ci-scope), the zero-escape-hatch
> contract, and the step-by-step recipe.

These rules are **hard-fail with zero escape hatches**: there is no `// windows-portability-ok:`
comment and no `eslint-disable` for them (a `tests/portability-rule-disable-ban.test.cjs` check,
running outside ESLint, fails the build if you try). Legitimately platform-specific code must be
*structured* so the rule recognizes it (see "Platform guards" below) — not annotated around.

## Reference — the rules

| Rule | Flags | Surface |
|---|---|---|
| `local/no-path-literal-in-assert` | An `assert.equal`/`strictEqual`/`deepEqual`/`deepStrictEqual` or `expect(...).toBe`/`toEqual`/`toStrictEqual` where one operand is a **path-returning function call** and the other is a **hardcoded `/`-string literal** not normalized to POSIX. | `tests/**/*.test.cjs` |
| `local/no-posix-mode-bit-assert` | An equality assertion comparing a file **`.mode`** (e.g. `statSync(p).mode & 0o777`) to an **octal literal** — Windows reports `0o666`/`0o444`, never the requested mode. | `tests/**/*.test.cjs` |
| `local/no-unguarded-nonportable-exec` | A file that **both** sets a chmod exec-bit (`chmod`/`chmodSync` with `0oNNN & 0o111 !== 0`) **and** invokes `sh`/`bash` with a `-c` flag (`execFileSync`/`spawnSync`/`spawn`/`exec`/`execSync`) without a Windows platform guard — Windows Git Bash ignores the exec bit for extension-less PATH-executed scripts. | `tests/**/*.test.cjs` |
| `local/no-crlf-fragile-split` | A `.split('\n')` or `.split("\n")` call on `readFileSync` content, **or** a regex literal containing a bare `\n` used against `readFileSync` content — Windows `git-autocrlf` yields `\r\n` line endings so a literal `\n` split or regex will mismatch. | `tests/**/*.test.cjs` |
| `local/no-hardcoded-tmp` | A hardcoded `/tmp/` string passed as the first argument to an `fs.*` function or `path.join` — `/tmp` does not exist on Windows. Use `os.tmpdir()` instead. | `tests/**/*.test.cjs` |
| `local/no-bare-npm-exec` | An `execFileSync`/`spawnSync`/`spawn` call with `"npm"` as the command and no `{ shell: true }` option (or a platform-guarded equivalent) — `npm` is a `.cmd` batch wrapper on Windows and is not found without a shell. (`execSync`/`exec` already run via a shell, so they are not flagged.) | `tests/**/*.test.cjs` |
| `local/require-userprofile-with-home` | A `process.env.HOME = <x>` assignment in a test file with no corresponding `process.env.USERPROFILE` **assignment** — Windows uses `USERPROFILE` as the home directory environment variable, not `HOME`. | `tests/**/*.test.cjs` |
| `local/normalize-path-in-content` | A path-returning fn result (excluding `path.basename`, which returns a separator-less filename) interpolated **directly** into content without `.replace(/\\/g,'/')` normalization — backslash paths leak into generated content on Windows (`RULESET.CONTENT-PATH-NORMALIZATION`). Two content shapes are detected: (a) the template/string contains an `@`-reference marker (`@~/`, `@$`, `@/`), `$HOME`, or `~/`; (b) the quasi immediately following the interpolation starts with `/…\.md` or `/…\.json`. **Indirect data-flow** (path stored in a variable/field then interpolated) is not detected — normalize at source. Fix: `String(resolvedTarget).replace(/\\/g, '/')`. | `src/**/*.cts` |
| `local/require-fs-op-fallback` | An unguarded `fs.rename` / `fs.renameSync` (the atomic-publish primitive) that is NOT inside a `try`/`catch` whose handler references a transient errno (`'EPERM'`/`'EBUSY'`/`'EACCES'`, or a `*RETRY_ERRNOS` set) AND is NOT behind a Windows platform guard — on Windows a concurrent reader / antivirus scanner can transiently hold the target open and throw. A `catch (e) {}` that silently swallows, or a catch that cleans-up-and-rethrows without an errno check, does **not** satisfy the rule. `fs.copyFile` / `fs.unlink` are deliberately **not** flagged (they are the *fallback primitives* named by the defect's own fix-forward, and `unlink` has many intentional best-effort cleanup sites). | `src/**/*.cts`, `bin/install.js`, `scripts/build-hooks.js` |
| `local/require-full-tmpdir-triad` | A `process.env.TMPDIR = …` assignment (direct, or as a property in an object literal passed as the `env:` option to `spawn`/`spawnSync`/`exec`/`execSync`/`execFile`/`execFileSync`/`fork`, or this repo's `runNode(...)` test helper) that is not accompanied by `TEMP` and `TMP` in the same scope — `os.tmpdir()` never reads `TMPDIR` on Windows (only `TEMP`, then `TMP`), so a TMPDIR-only redirect silently no-ops there. | `tests/**/*.test.cjs` |
| `local/no-unbounded-dirname-walk` | A `while`/`do-while` loop that reassigns its condition variable from `dirname(...)` (bare, `path.`, `.posix.`/`.win32.`) with no fixed-point conjunct (`dirname(cur) !== cur`, or `path.parse(cur).root`) in the loop test — `path.dirname()` is a no-op at the platform root, but on win32 that fixed-point value (`'D:\\'`, length 3) fails a POSIX-shaped length or equality check that would have caught a POSIX root (`'/'`, length 1), so the walk spins forever there. | `tests/**/*.test.cjs`, `scripts/**/*.cjs` |

(See ADR-1703's catalog and [epic #1702](https://github.com/open-gsd/gsd-core/issues/1702) for the full phase history.)

The set of path-returning functions is single-sourced in
[`eslint-rules/lib/portability-vocab.cjs`](../../eslint-rules/lib/portability-vocab.cjs) as
`PATH_RETURNING_FNS` (Node's `path.*`/`os.homedir`/`os.tmpdir` plus the project resolvers such as
`getGlobalConfigDir`, `resolveAgentDir`, `computePathPrefix`, …). A drift-guard test
(`tests/portability-vocab-drift.test.cjs`) parses `src/runtime-homes.cts` and **fails CI if a new
path resolver is added but not registered** in that list.

## How-to — fix a `no-path-literal-in-assert` violation

Why it fails on Windows: `path.join('a','b')` returns `a/b` on POSIX but `a\b` on Windows, so
`assert.equal(path.join('a','b'), '/a/b')` passes on your Mac/Linux machine and the docker gate,
then fails only on the `windows-latest` lane.

**Fix: normalize the ACTUAL operand to POSIX before comparing** — this is idempotent on POSIX
(a no-op when there are no backslashes) and *reveals* a malformed return rather than masking it:

```js
// ❌ flagged
assert.strictEqual(getGlobalConfigDir('claude'), '/custom/claude');

// ✅ compliant
assert.strictEqual(String(getGlobalConfigDir('claude')).replace(/\\/g, '/'), '/custom/claude');
```

Do **not** instead wrap the *expected* literal in `path.join(...)` to match the platform
separator — that passes everywhere but masks a wrong backslash-on-POSIX return (both sides wrong
together). Recognized normalizers: `.replace(/\\/g,'/')`, `.replace(/[\\/]/g,'/')`,
`.replaceAll('\\','/')`, `.replaceAll(path.sep,'/')`, `.split(path.sep).join('/')`,
`toPosixPath(...)`.

## How-to — fix a `no-posix-mode-bit-assert` violation

Windows does not honor POSIX file modes — `fs.statSync(p).mode` reads back `0o666` (writable) or
`0o444` (readonly), never the `0o644`/`0o755` you wrote. A mode-bit assertion is therefore a
POSIX-only precondition. **Gate it behind a platform check and keep the real behavioral assertion
running on every OS** (do not delete it — scope it):

```js
// ❌ flagged
assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);

// ✅ scope the POSIX-only precondition; keep the behavioral assertion cross-platform
if (process.platform !== 'win32') {
  assert.strictEqual(fs.statSync(p).mode & 0o777, 0o644);
}
assert.match(hookCommand, /^node /); // behavioral assertion — runs everywhere
```

Prefer asserting the *behavior* (command shape, runnability) over the raw mode bit where you can.

## How-to — fix a `no-unguarded-nonportable-exec` violation

Why it fails on Windows: Windows Git Bash (msys2) does not honour Node's chmod exec bit for
extension-less scripts that are invoked by searching PATH. A test that makes a fixture executable
with `chmodSync(p, 0o755)` and then runs it with `execFileSync('bash', ['-c', '...'])` passes on
macOS/Linux but fails only on the `windows-latest` CI lane (DEFECT.WINDOWS-TEST-PORTABILITY).

**Fix option A: gate the `sh`/`bash -c` invocation behind a platform check**

```js
// ❌ flagged
fs.chmodSync(fixture, 0o755);
execFileSync('bash', ['-c', './fixture run']);

// ✅ platform-guarded
fs.chmodSync(fixture, 0o755);
if (process.platform !== 'win32') {
  execFileSync('bash', ['-c', './fixture run']);
}
```

**Fix option B: invoke the script with an explicit interpreter (no -c flag)**

```js
// ✅ passes the script path directly — exec bit not needed
execFileSync('sh', [fixturePath]);
```

## Platform guards (the only "escape" — by structure, not annotation)

If an assertion is *genuinely* POSIX-only, gate it behind a Windows platform check the rule
recognizes — it then won't flag the guarded code. Recognized shapes:

```js
if (process.platform !== 'win32') {
  assert.equal(path.join(a, b), '/a/b');               // guarded → not flagged
}

if (process.platform === 'win32') return;              // early-return guard
assert.equal(path.join(a, b), '/a/b');                 // → not flagged

const isWindows = process.platform === 'win32';        // hoisted boolean (any name, binding-resolved)
if (!isWindows) assert.equal(path.join(a, b), '/a/b'); // → not flagged
```

The guard is recognized by control-dependence (it must actually dominate the assertion), is
binding-aware (a reassigned or `false`-initialized variable is not trusted), and handles
`os.platform()` and `node:test` skip returns. See
[`eslint-rules/lib/platform-guard.cjs`](../../eslint-rules/lib/platform-guard.cjs).

> **Note:** the `node:test` `test(name, { skip: isWindows ? … : false }, fn)` *option* object is
> NOT recognized as a platform guard. To scope a POSIX-only assertion use an
> `if (process.platform !== 'win32')` guard (or early-return) **inside** the callback.

## How-to — fix a `no-crlf-fragile-split` violation

Windows `git-autocrlf=true` (the default on Windows) rewrites `\n` to `\r\n` in checked-out files.
A test that reads a file with `readFileSync` and then splits on `'\n'` (or uses a regex with a bare
`\n`) will silently miscalculate line counts on Windows.

**Fix: use `/\r?\n/` everywhere you split or match lines in file content:**

```js
// ❌ flagged
const lines = fs.readFileSync(p, 'utf8').split('\n');
assert.match(content, /^---\n/m);
assert.match(content, /```bash\n/);

// ✅ CRLF-safe
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
assert.match(content, /^---\r?\n/m);
assert.match(content, /```bash\r?\n/);
```

The `/\r?\n/` form is a no-op on POSIX (matches only `\n`) and correct on Windows (matches `\r\n`).

## How-to — fix a `no-hardcoded-tmp` violation

`/tmp` does not exist on Windows. Use `os.tmpdir()` to get the platform-appropriate temp directory:

```js
// ❌ flagged
const dir = path.join('/tmp/my-test-dir', 'sub');
env.MY_VAR = '/tmp/custom-dir';

// ✅ portable
const dir = path.join(os.tmpdir(), 'my-test-dir', 'sub');
const customDir = path.join(os.tmpdir(), 'custom-dir');
env.MY_VAR = customDir;
```

When the same `/tmp/...` value is used both as a fixture env var and in an assertion, update both
sides consistently so they still match:

```js
// ❌ fragile — assertion tied to /tmp/ literal
const customDir = path.join(os.tmpdir(), 'custom-dir');
env.MY_VAR = customDir;
assert.strictEqual(String(fn()).replace(/\\/g, '/'), '/tmp/custom-dir'); // ← still wrong

// ✅ assertion uses the same derived constant
assert.strictEqual(String(fn()).replace(/\\/g, '/'), customDir.replace(/\\/g, '/'));
```

## How-to — fix a `no-bare-npm-exec` violation

On Windows, `npm` is installed as `npm.cmd` (a CMD batch script). Without `{ shell: true }`,
`execFileSync('npm', ...)` fails because the OS cannot find an executable named `npm` (no `.cmd`
extension). Add `shell: true` or gate the call behind a platform check:

```js
// ❌ flagged
execFileSync('npm', ['ci'], { cwd: dir });

// ✅ shell: true — works on all platforms
execFileSync('npm', ['ci'], { cwd: dir, shell: true });

// ✅ platform-guarded alternative
execFileSync('npm', ['ci'], { cwd: dir, shell: process.platform === 'win32' });
```

## How-to — fix a `require-userprofile-with-home` violation

Windows uses `USERPROFILE` as the home directory environment variable, not `HOME`. Whenever a test
sets `process.env.HOME`, it must also set `process.env.USERPROFILE` to the same value (so that
code under test that calls `os.homedir()` or reads `process.env.USERPROFILE` gets the isolated
directory on Windows too). Mirror the teardown as well:

```js
// ❌ flagged — Windows code-under-test reads USERPROFILE, not HOME
const origHome = process.env.HOME;
process.env.HOME = isolatedDir;
// …
process.env.HOME = origHome;   // restore

// ✅ set and restore both
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;
process.env.HOME = isolatedDir;
process.env.USERPROFILE = isolatedDir;
// …
if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
if (origUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = origUserProfile;
```

## How-to — fix a `require-fs-op-fallback` violation

Why it fails on Windows: `fs.renameSync(tmp, target)` (the atomic-publish primitive) uses Windows
`MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, which throws `EPERM`/`EBUSY`/`EACCES` when an
antivirus scanner, indexer, or concurrent reader transiently holds the target open. On macOS/Linux
`rename(2)` atomically replaces regardless of open handles, so the bare call passes everywhere
except the `windows-latest` CI lane (DEFECT.WINDOWS-FS-OPS).

**Fix option A (preferred for production): route through `retryRenameSync`** — the shared drop-in
from `shell-command-projection.cjs` that retries the transient errnos a bounded number of times
before rethrowing. It is idempotent on POSIX (the transient errnos do not occur there):

```js
import { retryRenameSync } from './shell-command-projection.cjs';

// ❌ flagged — EPERM/EBUSY propagates unhandled on Windows
fs.renameSync(tmpPath, target);

// ✅ drop-in — retries transient locks, throws on persistent failure
retryRenameSync(tmpPath, target);
```

**Fix option B: inline the `RENAME_RETRY_ERRNOS` loop** (the convention already used by
`capability-ledger`, `capability-consent`, and `shell-command-projection`'s own `atomicRenameWithRetry`):

```js
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    fs.renameSync(tmpPath, target);
    break;
  } catch (err) {
    if (attempt < 3 && RENAME_RETRY_ERRNOS.has(err.code)) { backoff(); continue; }
    throw err;
  }
}
```

**Fix option C: gate behind a platform check** when the rename is genuinely POSIX-only:

```js
// ✅ platform-guarded — not flagged
if (process.platform !== 'win32') {
  fs.renameSync(tmpPath, target);
}
```

> **`copyFile` / `unlink` are not flagged.** Per the defect's own fix-forward, they are the
> *fallback primitives* ("catch EPERM/EBUSY/EACCES, fall back to copy + unlink with retry"), not
> separate defect sites. A retry delegated to a helper that itself wraps `renameSync` in the
> `RENAME_RETRY_ERRNOS` loop is compliant because the helper's own `renameSync` is recognized; a
> bare `fs.renameSync(...)` call is what gets flagged.

## How-to — fix a `require-full-tmpdir-triad` violation

Per Node's own docs, `os.tmpdir()` on Windows consults `TEMP` then `TMP` — it never reads
`TMPDIR` there. On every other platform `TMPDIR` is checked first. A child-process `env:` override
that redirects only `TMPDIR` therefore does nothing on Windows: the child inherits the parent's
ambient `TEMP`/`TMP` and its `os.tmpdir()` resolves to the wrong directory, silently.

```js
// ❌ flagged — no-op on Windows
const r = runNode(['-e', probe], { env: { ...process.env, TMPDIR: outer } });

// ✅ set all three to the same value
const r = runNode(['-e', probe], {
  env: { ...process.env, TMPDIR: outer, TEMP: outer, TMP: outer },
});
```

The same applies to a direct `process.env.TMPDIR = …` assignment — set `process.env.TEMP` and
`process.env.TMP` alongside it (and restore all three in the teardown), mirroring the
`require-userprofile-with-home` HOME/USERPROFILE convention above.

## How-to — fix a `no-unbounded-dirname-walk` violation

`path.dirname()` is a fixed point at the filesystem root on both platforms, but the fixed-point
*value* differs: `path.posix.dirname('/') === '/'` (length 1), while
`path.win32.dirname('C:\\') === 'C:\\'` (length 3). A walk that terminates on a POSIX-shaped
sentinel — a hardcoded length threshold or an equality check against a target that the walk may
never reach — spins forever at 100% CPU on a Windows drive root, since the string simply stops
changing while the sentinel condition never fires.

```js
// ❌ flagged — never terminates on Windows when cur can't reach root
let cur = file;
while (cur && cur !== root && cur.length > 1) {
  protectSet.add(cur);
  cur = dirname(cur);
}

// ✅ add the fixed-point conjunct — terminates on POSIX, win32 drive roots, and UNC roots alike
let cur = file;
while (cur && cur !== root && dirname(cur) !== cur) {
  protectSet.add(cur);
  cur = dirname(cur);
}
```

`path.parse(cur).root` is the other recognized portable sentinel: `while (cur !== path.parse(cur).root)`.
Whichever form you use, prefer breaking out of the loop the moment `dirname(cur) === cur` (as
`scripts/run-tests.cjs`'s `computeSweepProtectSet` does) over relying purely on the condition, so
the loop body never re-adds the fixed point.

## How-to — add a new path resolver

When you add a function that returns a filesystem path (e.g. in `src/runtime-homes.cts`), add its
name to `PATH_RETURNING_FNS` in `eslint-rules/lib/portability-vocab.cjs`. The drift-guard test
will fail until you do.

## Known boundaries

The rule matches by spelling and inspects the direct operand (or a `String(<pathcall>)` wrapper):

- It assumes `path`/`os` are the standard modules and the resolver names are the project's — a
  local variable that *shadows* one of those names in a test file is out of scope.
- Deeper wrapping (e.g. `realpathSync(path.join(...))`, `.toLowerCase()` on a path) is not
  inspected; assert against the path call directly or its `String(...)` wrap.
- For a genuine explicit-dir *pass-through* assertion (a resolver that returns its input
  verbatim), the `String(...).replace(/\\/g,'/')` remedy is a harmless no-op.
- **The rule catches a path-returning call interpolated *directly* into `${ }`.** It does NOT
  track **indirect data-flow** — a path stored in a variable or object field, then interpolated
  (e.g. `${globalSkillDir}/SKILL.md` → `@${entry.ref}`). Indirect content-path-leaks rely on
  `RULESET.CONTENT-PATH-NORMALIZATION` discipline (normalize at source) and code review.
  The one known indirect leak (`src/init.cts` `cmdAgentSkills` `entry.ref` building) is fixed
  by normalizing at the content-emit site: `- @${String(entry.ref).replace(/\\/g, '/')}`.
- **Content detection shape (b)** fires when the quasi *immediately following* the interpolation
  starts with `/…\.md` or `/…\.json`. A bare `.md` or `.json` token in the *middle* of prose
  (e.g. `: see README.md`) does NOT qualify — the quasi must start with the forward slash.
  Config-dir substrings (`/.claude`, `/commands`, `/skills`, etc.) are deliberately NOT content
  markers — they caused false positives on log/error/diagnostic strings mentioning config dirs.
