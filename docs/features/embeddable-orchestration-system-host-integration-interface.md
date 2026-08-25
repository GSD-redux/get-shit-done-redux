---
id: 149
title: Embeddable Orchestration System (Host-Integration Interface)
group: v1.7.0 Features
---

**Purpose:** Express every host integration against one public, versioned contract (ADR-1239 Phase A, #1690) instead of bespoke per-host wiring, so onboarding a new host becomes additive descriptor work.

**Behavior:** The interface exposes six interface points (`command`, `dispatch`, `model`, `hooks`, `state`, `artifact`), eight negotiated axes, and a `PROTOCOL_VERSION` handshake that negotiates down to `min(host, engine)`. In 1.7.0, 14 runtimes were migrated onto the interface via imperative adapters (OpenCode #2087, Cursor #2089, Cline #2090, Hermes #2091, Qwen #2092, Kilo #2093, Trae #2094, Kimi #2095, Antigravity #2096, Augment #2097), a declarative adapter (Codex #2088), plus full lifecycle-hook wiring for CodeBuddy (#2098), GitHub Copilot (#2099), and Windsurf (#2100). Descriptors gained an `extensionEvents` vocabulary (#1946), and `/gsd-surface` now reproduces a runtime's agent output byte-for-byte from the installer's descriptors (#1575).

**New runtimes:** ZCode (Z.ai — Agentic Development Environment for GLM-5.2, #1925), pi (`npx @opengsd/gsd-core --pi`, #2102), and a repo-local VS Code extension driven through the adapter (#2103). The retired Gemini CLI now redirects to Antigravity CLI, its official successor (#1928).

**Reference:** [The Embeddable Orchestration System](explanation/embeddable-orchestration-system.md) · [Host-Integration Interface](reference/host-integration-interface.md) · [Interface versioning policy](explanation/interface-versioning-policy.md)
