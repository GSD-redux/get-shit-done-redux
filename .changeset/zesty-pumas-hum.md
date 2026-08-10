---
type: Fixed
pr: 3341
---
**Installer no longer crashes when a source file disappears mid-copy.** `copyWithPathReplacement` used to throw an unhandled ENOENT if a listed workflow/command file was deleted between its directory listing and the actual read — a rare filesystem race that could abort an entire install. It now skips the vanished file and continues installing everything else. (#3333)
