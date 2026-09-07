---
type: Changed
pr: 34
---
**`gsd install` and `/gsd-update` now verify every GSD-managed runtime entrypoint before reporting success** — a hook script or its interpreter that is missing, unreadable, or not executable now fails the install with the offending paths named, instead of printing `Done!` over a configuration whose hooks can never fire.
