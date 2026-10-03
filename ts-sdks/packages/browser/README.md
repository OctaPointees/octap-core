# Browser SDK
Separate browser-safe boundary for Google/zkLogin login, customer transaction signing,
snapshot reads and offline earn-intent buffering. `src/auth`, `src/signing` and `src/offline`
reserve those helper locations. `src/client.ts` only defines draft public options.
No private credentials, signing logic, intent persistence or network calls are implemented.
