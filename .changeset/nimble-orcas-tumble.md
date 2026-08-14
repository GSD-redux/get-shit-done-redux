---
type: Security
pr: 0
---
**Capability installs no longer fetch from internal hosts, and unpinned installs say so in the consent prompt** — the URL importer refuses loopback/link-local/metadata hosts (including the cloud metadata addresses and localhost) before any bytes leave, and an http:// tarball URL fails with a clear https-only reason instead of a raw protocol error. Installs without an integrity pin now show a distinct 'NO PINNED HASH — staged unverified' line in the consent disclosure. (#3514)
