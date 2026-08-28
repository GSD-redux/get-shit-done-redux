---
type: Changed
pr: 0
---
**Fixed an unhandled-rejection crash trace on profile-pipeline CLI failures** — extract-messages and profile-sample could dump a raw Node stack trace on top of the clean error line when a non-terminator failure occurred, because the async pipeline's rejection handler threw from inside a detached promise .catch(). Errors now print once and exit 1 as before. (#3910)
