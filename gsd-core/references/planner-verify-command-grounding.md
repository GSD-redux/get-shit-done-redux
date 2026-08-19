# Verify Command Grounding (#2401)

> Reference file for gsd-planner agent. Loaded on-demand via `@` reference.

**Inherit the command that already worked.** The planning context carries
`prior_verify_commands` — the `<automated>` commands from the most recent prior phase that had
any, surfaced **at every context window**, not only on 1M-class models. When this phase's build
or test story is the same one a prior phase already proved, **reuse that command verbatim**
rather than re-deriving a path. Re-invention is what produced `cd ../../frontend && npm run
lint` against a directory that holds no `package.json`, and cost two revision cycles.

Ground every path you do author: a command's `cd` target or `npm --prefix` target must be a
directory that exists (or that an earlier task in this phase creates) and, for an npm/make
command, must hold the matching `package.json`/`Makefile`. `npm --prefix <dir> run <script>` is
preferred over `cd <dir> && npm run <script>` — it does not depend on the executor's cwd. If
`prior_verify_commands` is empty and you cannot ground a path, say so in the plan instead of
guessing one.
