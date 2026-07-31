---
type: Fixed
pr: 2897
---
**Fallow structural pre-pass no longer silently no-ops on Windows** — `run-with-timeout` now mediates `.cmd`/`.bat`/`.exe` spawns via an explicit `cmd.exe /c` argv array (Node's CVE-2024-27980 hardening requires a shell for these on Windows), and the fallow pre-pass names the failure kind so a Windows spawn failure is not mistaken for an absent binary. The existing `bash -c` callers and POSIX behavior are unchanged. (#2667)
