# Security Policy

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via a **private GitHub security advisory**:

**https://github.com/open-gsd/gsd-core/security/advisories/new**

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested fixes (optional)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix timeline**: Depends on severity, but we aim for:
  - Critical: 24-48 hours
  - High: 1 week
  - Medium/Low: Next release

## Scope

Security issues in the GSD codebase that could:
- Execute arbitrary code on user machines
- Expose sensitive data (API keys, credentials)
- Compromise the integrity of generated plans/code

## Recognition

We appreciate responsible disclosure and will credit reporters in release notes (unless you prefer to remain anonymous).

## Org-level security baseline

This file covers how to report individual vulnerabilities. For the broader
org-wide security posture — scanner controls, incident-audit checklists,
ownership model, and rollout plan — see:

[`docs/security/baseline.md`](docs/security/baseline.md)

## Secret-Scan Exclusion Governance

Secret-scanning exclusions (`.secretscanignore`) require structured annotations. Bare paths are accepted in default mode with a deprecation warning but are rejected in strict mode. The lint runs on every PR.

### Annotation format

```
# allow: <pattern>  reason="..."  owner="..."  expires="YYYY-MM-DD"  [rule-id="..."]
<pattern>
```

Required keys: `reason`, `owner`, `expires`. Wildcard patterns (`**`, `*.ext`) also require `rule-id`.

Lint locally: `scripts/secret-scan-lint.sh --file .secretscanignore`

### Periodic reduced-exclusion scan (release and security-review lanes)

Run this during every release and scheduled security review:

```bash
scripts/secret-scan.sh --diff origin/main --strict
```

The `--strict` flag:
- Does **not** honour grandfathered (un-annotated) exclusions — those files are scanned.
- Skips any exclusion whose `expires` date is in the past — those files are scanned.
- Is intended to surface accumulated exclusion debt that default mode masks.

If `--strict` finds findings that default mode does not, those findings represent either (a) an entry that should have been annotated and renewed, or (b) an actual secret that was only hidden by a stale exclusion. In both cases: investigate, remediate, and update the exclusion annotation.

### Exit codes

`secret-scan.sh`, `base64-scan.sh`, and `prompt-injection-scan.sh` share one contract, registered in `gsd-core/bin/shared/exit-codes.json` (ADR-3889):

| Code | Meaning |
|--:|---|
| `0` | Clean — files were scanned, no findings. |
| `1` | Findings detected. |
| `64` (`USAGE`) | Bad argv — unknown mode, or a `--file`/`--dir` target that does not exist. |
| `66` (`NO_INPUT`) | Ran; the scope was established and is genuinely empty (e.g. a diff touching only image files, or an all-docs PR). Not a failure. |
| `69` (`UNAVAILABLE`) | Could not establish scope — a nonexistent `--diff` ref, running outside a git repository, a repository with no commits, or an unreadable `--dir`. Distinct from `NO_INPUT`: the scanner never actually ran. |

CI (`.github/workflows/security-scan.yml`) treats `0` and `66` as passing steps and `1`/`69` as failing steps — a scan that could not run is a build failure, not a silent clean pass.

References:
- GitGuardian exclusion annotation convention: https://docs.gitguardian.com/internal-repositories-monitoring/integrations/cli/secrets
- CNCF Security TAG threat-model exception lifecycle: https://github.com/cncf/tag-security/blob/main/community/working-groups/threat-modeling/templates/threats.md

---

## Dependency Integrity Verification

### Purpose

The `scripts/check-npm-integrity.cjs` gate detects three classes of dependency
drift that can silently introduce security or reliability risk:

- **Invalid** — an installed package version does not satisfy the declared semver
  range (e.g., `ws@8.20.0` installed when `8.20.1` is declared). This was the
  original incident that prompted this gate.
- **Missing** — a declared dependency is absent from `node_modules/`.
- **Extraneous** — a package is present in `node_modules/` but not declared as a
  dependency.

This aligns with NIST SSDF PW.4.1 (use components from well-governed, secure
sources: https://csrc.nist.gov/publications/detail/sp/800-218/final) and the
OpenSSF Scorecard "Pinned-Dependencies" check
(https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies).

### Invoking locally

```bash
node scripts/check-npm-integrity.cjs
# or via npm script:
npm run check:integrity
```

The script exits 0 on a clean install and 1 on any finding, with a structured
report to stderr listing every offender and both the declared and installed
versions for invalid packages.

Options:
- `--ignore-extraneous` — suppress extraneous-only failures (useful when
  intentionally adding packages before updating the lockfile)
- `--help` — print usage and exit 0

### Remediation

The canonical fix for any drift is:

```bash
rm -rf node_modules && npm ci
```

Then verify with `npm run check:integrity` before committing.

### Bypass policy

There is no bypass flag. If the gate must be skipped for a specific commit
(e.g., during a lockfile migration), document the reason in the commit message.
CI workflow steps can be skipped via `if: false` with a comment explaining why
and a follow-up issue number. Any such skip must be reversed in a subsequent
commit before the PR is merged.

### Scope

The gate runs `npm ls --all --json` at the repository root. The `sdk/`
sub-directory is a separate, non-workspace package and is out of scope for this
single invocation. If `sdk/` is ever declared as a workspace in root
`package.json`, it will be covered automatically (npm >=7 traverses workspaces
by default).

### CI coverage

The gate runs in:
- `test.yml` — all matrix jobs and the coverage job, after `npm ci`
- `release.yml` — rc and finalize jobs, after `npm ci`
- `security-scan.yml` — before all diff-based source scans
