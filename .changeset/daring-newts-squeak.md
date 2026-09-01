---
type: Security
pr: 4121
---
**Removed a critical unpatched supply-chain vulnerability from the `lint:ci` toolchain** — the `shellcheck` devDependency pulled in `decompress@4.2.1`, which carries an unpatched critical zip-slip flaw (GHSA-mp2f-45pm-3cg9); replaced with a small dependency-free downloader that fetches a pinned ShellCheck release directly and extracts it without the vulnerable extraction library. (#4120)
