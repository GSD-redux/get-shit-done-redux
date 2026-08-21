---
type: Fixed
pr: 3733
---
**`windows` ledger commands survive a formatter pass** — the WINDOWS.md ledger's JSON block is written with a four-backtick fence, which Prettier and other CommonMark formatters legally narrow to three; the reader then rejected the file and every `gsd-tools windows` subcommand (status/append/waive/fixed) failed with "Ledger missing JSON code block". The reader now accepts any CommonMark-legal fence width (the writer still emits four), resolves the real block past fences planted in entry descriptions, and preserves user prose below the ledger; the refactor-trigger proposal reader gets the same fence tolerance. (#3657)
