# Queue infrastructure
Reserved for transport-specific dispatch, consumer lifecycle and bounded retry configuration.
Domain workers/processors live in src/domain, registered only by WorkerModule.
A Redis enqueue is never durable command acceptance. No queue backend has been selected or connected.
