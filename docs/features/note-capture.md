---
id: 13
title: Note Capture
group: Planning Features
---

**Command:** `/gsd-capture`

**Purpose:** Zero-friction idea capture without interrupting workflow. Append timestamped notes, list all notes, or promote notes to structured todos.

**Requirements:**
- REQ-NOTE-01: System MUST save timestamped note files with a single Write call
- REQ-NOTE-02: System MUST support `list` subcommand to show all notes from project and global scopes
- REQ-NOTE-03: System MUST support `promote N` subcommand to convert a note into a structured todo
- REQ-NOTE-04: System MUST support `--global` flag for global scope operations
- REQ-NOTE-05: System MUST NOT use Task, AskUserQuestion, or Bash — runs inline only
