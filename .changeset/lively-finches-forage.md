---
type: Security
pr: 2655
---
**Dev-tooling `js-yaml` bumped past the merge-key DoS advisory** — `js-yaml` was pinned `^4.2.0`, inside the vulnerable `4.0.0 - 4.2.0` range of GHSA-52cp-r559-cp3m (quadratic CPU on YAML merge-key chains). It is a devDependency with no shipped-runtime reachability, but `scripts/workflow-policy.cjs` parses workflow frontmatter in CI, which is attacker-controlled on a fork PR. Now `^4.2.1`. (#2654)
