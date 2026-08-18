---
type: Changed
pr: 0
---
**The installer module no longer re-exports internals it does not own.** `bin/install.js` exported 197 names, 70 of which were either dead or plain pass-throughs to the modules that actually implement them — kept for "existing consumers" that turned out not to exist, since no production code has ever required the file. Those 70 are gone and their tests now import the owning modules directly. No installed output changes. (#2876)
