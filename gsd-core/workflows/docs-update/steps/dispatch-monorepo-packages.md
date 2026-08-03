<step name="dispatch_monorepo_packages" condition="monorepo_workspaces is non-empty">
After Wave 2 collection, generate per-package READMEs for each monorepo workspace.

**Condition:** Only run this step if `monorepo_workspaces` from the init JSON is non-empty.

**Resolve workspace packages from glob patterns:**

```bash
# Expand workspace globs to actual package directories
for pattern in {monorepo_workspaces}; do
  ls -d $pattern 2>/dev/null
done
```

**For each resolved directory that contains a `package.json`:**

Determine mode:
- If `{package_dir}/README.md` exists: mode = `update`, read existing content
- Else: mode = `create`

Spawn a `gsd-doc-writer` agent with `run_in_background=true`:

```
Agent(
  subagent_type="gsd-doc-writer",
  model="{doc_writer_model}",
  run_in_background=true,
  description="Generate per-package README for {package_dir}",
  prompt="<doc_assignment>
type: readme
mode: {create|update}
scope: per_package
package_dir: {absolute path to package directory}
project_context: {INIT JSON with project_root set to package directory}
{existing_content: | (include full README.md content here if mode is update, else omit)}
</doc_assignment>

{AGENT_SKILLS}

Write {package_dir}/README.md directly. Return confirmation only — do not return doc content."
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling all per-package Agent() calls above with `run_in_background=true`, do NOT generate any package READMEs independently while the subagents are active. Wait for all agents to complete before proceeding. This prevents duplicate work and wasted context.

Collect confirmations by reading each package agent's `outputFile` once it reports completion — each `run_in_background=true` Agent call returns an `async_launched` result carrying an `outputFile` path (with `canReadOutputFile: true`). Note failures in the final report.

**Fallback when Task tool is unavailable:** Generate per-package READMEs sequentially inline after the `sequential_generation` step. For each package directory with a `package.json`, construct the equivalent `doc_assignment` block and generate the README following gsd-doc-writer instructions.

Continue to commit_docs.
</step>
