# Infrastructure
- db/repositories: PostgreSQL implementations and durable transactions.
- cache: disposable Redis cache and rate limits.
- clients: Sui, Enoki, Stripe, ClickHouse, Walrus, Seal and merchant webhook adapters.
- queue: dispatch/consumer mechanics; domain jobs stay with their feature.
- realtime: Socket.IO notifications; snapshots remain API-owned.

No connections, DB schemas or domain port bindings are implemented.
Migrations belong in api/db, operational scripts in api/scripts.
