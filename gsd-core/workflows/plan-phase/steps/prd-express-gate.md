## 3.5. Handle PRD Express Path

**Skip if:** No `--prd` flag in arguments.

**If `--prd <filepath>` provided:**

Read and execute `gsd-core/workflows/plan-phase/steps/prd-express-path.md` — it reads the PRD (`$PRD_FILE`), generates `CONTEXT.md` (every PRD requirement/story/criterion → locked decision, uncovered areas → "Claude's Discretion", canonical refs extracted from ROADMAP.md + PRD-referenced specs), commits it, sets `context_content`, and bypasses step 4 (Load CONTEXT.md). The rest of the workflow proceeds normally with the PRD-derived context.

