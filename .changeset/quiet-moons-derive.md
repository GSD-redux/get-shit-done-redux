---
type: Added
pr: 2677
---
**`runtime-homes` now exports its non-registry config-home descriptors** — `KIMI_HOOKS_TOML_DESCRIPTOR`, `NON_REGISTRY_CONFIG_HOME_DESCRIPTORS`, `GSD_LOCATION_ENV_KEYS`, and the `ConfigHomeDescriptor` type are public, so consumers that need the *set* of config-location env vars (rather than a single resolved path) can derive it instead of hand-maintaining a copy. `resolveKimiHooksTomlDir()` behaviour is unchanged; its descriptor is simply named rather than inline (#3156).

**The test-instrumentation scripts no longer ship in the npm package** — `scripts/run-tests.cjs`, `scripts/live-config-guard.cjs`, `scripts/affected-tests-lib.cjs`, and `scripts/run-affected-tests.cjs` are now excluded from the tarball (they are one closed require chain of repo-only test tooling). `npm test` in an installed package was already inoperable (`tests/` has never shipped); a deep import of `scripts/run-tests.cjs` from the published package — an unsupported surface — will now be `MODULE_NOT_FOUND` (#3156).
