---
type: Fixed
pr: 4182
---
**Global Runtime Surface materialization no longer breaks after the installing package disappears** — source-dependent global installs provision manifest-owned raw command and agent corpora below `gsd-core/`, while agents-only and empty layouts receive only what their descriptors require. Source selection uses one complete provider for the whole layout, retains the complete legacy marker path, rejects corpora observed during provider selection as missing, hash-mismatched, symlink-escaped, or unexpectedly extended, and preserves local-install behavior.

Surface materialization now stages every artifact kind before mutation and publishes the candidate surface state last. A source or staging failure therefore leaves the prior state and artifacts untouched. Fresh and upgraded Codex/Claude installs can materially change a surface using only deployed modules and the installed corpus, while an unmigrated source-less deployment fails with an install/upgrade diagnostic before changing state or artifacts.
