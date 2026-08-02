---
type: Fixed
pr: 3010
---
**Package-legitimacy docs now match the registry-API gate** — `security-model.md`, `USER-GUIDE.md`, `ARCHITECTURE.md`, `COMMANDS.md`, `FEATURES.md`, and the planner's STRIDE template described the pre-ADR-0656 design (slopcheck as the install-or-degrade gate, unavailability degrading every package to [ASSUMED]). Docs now describe the actual registry-API verdict gate (npm/PyPI/crates.io), with slopcheck as an optional escalate-only adapter. The `ja-JP` mirror is fully aligned, and the mechanical portion of the same drift (command strings, table headers, and already-attested-term swaps) is corrected in the `zh-CN`, `ko-KR`, and `pt-BR` mirrors as well; the prose-composition remainder in those three locales is tracked separately in #3002. (#2775)
