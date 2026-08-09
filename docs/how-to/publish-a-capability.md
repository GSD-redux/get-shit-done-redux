# How to publish a capability so others can install it

This guide is for capability authors who want to distribute their work so other GSD users can install it with `gsd capability install`. It covers preparing the manifest, validating locally, and releasing through each supported distribution channel.

Before publishing, make sure your capability works locally by following [Develop a Capability](./develop-a-capability.md).

---

## Add the required publishing fields

Open your `capabilities/<id>/capability.json` and add these fields if they are not already present.

### `version` (required)

```json
"version": "1.0.0"
```

Use [Semantic Versioning](https://semver.org/). Every published capability must carry a version; GSD will reject installation of a manifest that omits it.

### `engines.gsd` (required)

```json
"engines": {
  "gsd": ">=1.6.0"
}
```

Declare the minimum GSD version your capability requires. GSD checks this constraint at both install time and load time and refuses to activate the capability on an incompatible installation. Be as permissive as correctness allows — a tighter range blocks more users.

If you need to offer a graceful downgrade path for users on older GSD versions, you can also declare `compatVersions`:

```json
"compatVersions": {
  "1.0.0": ">=1.6.0",
  "0.9.0": ">=1.5.0"
}
```

`compatVersions` is only meaningful when your distribution channel enumerates available versions (a registry or a package feed). For Git and tarball releases, the installer downloads the version you point to directly.

### Author and provenance fields (recommended)

These fields are displayed in the pre-install summary that users see before they consent to installation. Filling them in builds trust.

```json
"author": {
  "name": "Your Name",
  "email": "you@example.com",
  "url": "https://example.com"
},
"homepage": "https://github.com/your-org/gsd-cap-example",
"repository": "https://github.com/your-org/gsd-cap-example",
"license": "MIT"
```

`license` must be a valid [SPDX expression](https://spdx.org/licenses/). `keywords` is optional but helps discoverability on registries.

For the full list of manifest fields and their validation rules, see [Capability manifest](../reference/capability-manifest.md).

---

## Namespace reservation

The prefixes `gsd-`, `gsd-core-`, and `anthropic-` are reserved for first-party capabilities. Do not use them as the `id` or package name of a third-party capability.

---

## Validate locally before publishing

Run the registry check to confirm the manifest is well-formed:

```bash
node scripts/gen-capability-registry.cjs --check
```

If you are developing outside the core repo, use the standalone validator when it is available, or install your capability locally and check that `gsd capability list` shows it without errors:

```bash
gsd capability install ./path/to/your-capability --scope project
gsd capability list
```

Fix any validation errors before proceeding.

Validation checks the manifest's *shape*. It does not read your skill bodies — nothing does. If your capability ships skills, re-read them before you publish: they are copied verbatim into every installing user's agent instruction surface and are never content-scanned. See [Ship skills — and know what you are shipping](develop-a-capability.md#ship-skills--and-know-what-you-are-shipping) for the author's side of that boundary, and [ADR-2363](../adr/2363-capability-instruction-surface-trust.md) for why it is drawn there.

---

## Choose a distribution channel

### Git repository (recommended for open-source capabilities)

Push your capability to a public Git host. Tag each release:

```bash
git tag v1.0.0
git push origin v1.0.0
```

Consumers install by pointing at the tag:

```bash
gsd capability install https://github.com/your-org/gsd-cap-example.git#v1.0.0
```

For a reproducible pin that cannot be moved, consumers can use a commit SHA instead:

```bash
gsd capability install https://github.com/your-org/gsd-cap-example.git#sha:abc123def456...
```

Publish release notes on your Git host so users know what changed between versions.

### npm package

Publish your capability as an npm package. The package name becomes the npm spec consumers use. Use a scoped package name to make the origin clear:

```bash
npm publish
```

Consumers install using the `npm:` prefix:

```bash
gsd capability install npm:@your-org/gsd-cap-example@1.0.0
```

A version range is also accepted:

```bash
gsd capability install npm:@your-org/gsd-cap-example@^1.0.0
```

### Tarball release

Build a tarball of the capability directory and attach it to a GitHub release or host it on any HTTPS URL:

```bash
tar -czf gsd-cap-example-1.0.0.tgz capabilities/example/
```

Consumers install using the tarball URL:

```bash
gsd capability install https://github.com/your-org/gsd-cap-example/releases/download/v1.0.0/gsd-cap-example-1.0.0.tgz
```

For tarball releases, publishing an integrity hash is strongly recommended (see below).

---

## Compute and publish an integrity hash (recommended for tarballs)

An `sha512` integrity hash lets consumers verify the download has not been tampered with. Compute it with:

```bash
openssl dgst -sha512 -binary gsd-cap-example-1.0.0.tgz | openssl base64 -A | sed 's/^/sha512-/'
```

Publish the resulting string in your release notes. Consumers pass it at install time:

```bash
gsd capability install https://example.com/gsd-cap-example-1.0.0.tgz \
  --integrity sha512-<hash>
```

GSD verifies the hash before extracting the archive and aborts if it does not match.

---

## Add provenance (optional)

If your release process produces a provenance record — for example, a GitHub Actions attestation — you can embed it in the manifest so that audit tools can surface it:

```json
"provenance": {
  "sourceRepo": "https://github.com/your-org/gsd-cap-example",
  "commit": "abc123def456..."
}
```

This is optional metadata. It does not change the install-time trust model.

---

## Next steps

- [Import a capability from a URL](./import-a-capability-from-a-url.md) — walk through installation from the consumer's perspective.
- [Version and update a capability](./version-a-capability.md) — manage `version`, `engines.gsd`, and `compatVersions` across releases.
- [Capability manifest](../reference/capability-manifest.md) — full field reference.
- [Capability trust model](../explanation/capability-trust-model.md) — how GSD treats third-party capabilities at install time.
