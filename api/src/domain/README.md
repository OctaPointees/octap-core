# Domain/application layer
Feature folders own use cases and business invariants. Nest services remain empty scaffold slots.
Core operations have explicit earn, redemption, reversal, expiry, outbox and recovery service slots.
Feature modules compose services; the API and worker processes both import DomainModule.
Workers/processors live next to their owning feature, and only WorkerModule registers them.
Use [the implementation guide](../../../docs/implementation-guide.md) to select a destination.
