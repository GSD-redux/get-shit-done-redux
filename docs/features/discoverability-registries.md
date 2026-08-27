---
id: 150
title: Discoverability Registries
group: v1.7.0 Features
---

**Purpose:** Two non-endorsing catalogs for third-party extensions (#2182).

**Behavior:** The **Community Capability Registry** (#2188) lists third-party Feature Capabilities installed with `gsd capability install`; the **EoS Registry** (#2193) lists third-party host integrations built on the ADR-1239 interface. Every entry embeds a live release badge and links to a GitHub Discussion. Registration is a documentation PR, regenerated with `npm run gen:registry`.

**Reference:** [GSD Registries](registries/README.md)
