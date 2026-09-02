---
type: Fixed
pr: 3744
---
**`phase complete` now warns when the ROADMAP `**Requirements**:` line under-selects REQ-IDs** — a range (`REQ-01 … REQ-05`), a glued `;` or `:` delimiter (`REQ-01; REQ-02`), and any non-placeholder wording that selects nothing (`Deferred`, `N/A`) all marked fewer requirements than the line names while still reporting `requirements_updated: true` with zero warnings, and each now emits a warning naming what was selected and what was skipped, carrying a machine-readable kind, without expanding ranges or changing which IDs get marked. (#3697)
