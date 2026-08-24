---
type: Fixed
pr: 3828
---
**`windows append`/`waive`/`fixed` no longer silently erase a hand-edited ledger table** — `.planning/WINDOWS.md` renders its table from the fenced JSON that is its source of truth, and every write regenerated that table without ever checking the two still agreed. A hand-edited cell was reverted and a table-only row vanished entirely, both at exit 0 with nothing on stdout. The write is now refused with a `windows_ledger_table_drift` error naming the offending row ids, and the file is left untouched. (#3689)
