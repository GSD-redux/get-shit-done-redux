---
type: Changed
pr: 3272
---
**`runtime.hostBehaviors` is now a closed vocabulary** — the capability-manifest field that carries per-host install and adaptation switches was validated by nothing, so a typo'd or invented key was silently ignored forever. Its 59 keys are now enumerated, and a key outside the vocabulary is ignored with a non-fatal warning naming the capability and the key. It is never a validation error: a manifest authored against a newer GSD degrades visibly rather than failing the build, and an out-of-tree runtime descriptor carrying a bespoke key keeps installing. No shipped capability is affected. (#2801)
