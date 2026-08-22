---
type: Fixed
pr: 0
---
**A malformed config section no longer destroys the value it holds — or gets written back to disk.** If `.planning/config.json` had a `git` or `planning` key holding a string instead of an object, migrating a legacy top-level key into it expanded that string into numbered character keys (`"main"` became `{"0":"m","1":"a","2":"i","3":"n"}`), and the result was saved over the original file — so the value could not be recovered. Numbers and booleans were dropped outright. The migration is now declined instead: the section, the legacy key, and the file are left exactly as written, and a warning names the file so it can be fixed by hand. (#3760)
