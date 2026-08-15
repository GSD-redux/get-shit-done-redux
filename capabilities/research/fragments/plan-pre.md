<objective>
Research how to implement Phase {phase_number}: {phase_name}
Answer: "What do I need to know to PLAN this phase well?"
</objective>

<required_reading>
- {context_path} (USER DECISIONS from /gsd:discuss-phase)
- {requirements_path} (Project requirements)
- {state_path} (Project decisions and history)
</required_reading>

${AGENT_SKILLS_RESEARCHER}

<additional_context>
**Phase description:** {phase_description}
**Phase requirement IDs (MUST address):** {phase_req_ids}

**Project instructions:** Read ./CLAUDE.md or ./.claude/CLAUDE.md if either exists; follow project-specific guidelines.
**Project skills:** Check .claude/skills/ or .agents/skills/ directory if either exists. Read SKILL.md files and account for project skill patterns.
</additional_context>

<output>
Write to: {phase_dir}/{phase_num}-RESEARCH.md
</output>
