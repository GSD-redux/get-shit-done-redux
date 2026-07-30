---
type: Changed
pr: 2826
---
**Reviewer lanes are disclosed and consent-gated before install** — a capability that declares a reviewer lane now discloses what it will run and what it will be sent, and blocks on consent before any file is promoted. A spawned lane discloses its binary and its full arguments; an OpenAI-compatible lane discloses its destination host and the config key naming it, including a localhost destination. Both name the egress payload classes — plan text, requirements, research findings, and CONTEXT.md decisions. Changing a lane's binary, arguments, destination, prompt channel, or handler forces re-consent on update; a capability with no reviewer lane is unaffected and its consent record is unchanged. (#2796)
