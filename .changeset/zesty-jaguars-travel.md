---
type: Fixed
pr: 3107
---
**`graphify` version detection now verifies tool identity** — a foreign binary named `graphify` on PATH that printed a plausible version string would silently report `compatible: true` with no warning. The check now confirms the `graphifyy` Python package via `importlib.metadata` before trusting the version, emitting a clear warning naming the mismatch when identity cannot be confirmed. (#3020)
