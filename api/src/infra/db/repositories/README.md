# Repositories
Implement PostgreSQL access here after reviewing the physical schema. Services own business rules;
repositories own SQL/ORM access and transactions. Commands, idempotency and outbox share a durable commit.
Ports and method signatures belong to the owning domain. No queries, tables or RLS policies exist yet.
