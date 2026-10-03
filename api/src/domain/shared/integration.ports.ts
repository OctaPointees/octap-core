/**
 * Structural ports only. Method contracts are intentionally deferred.
 * Adapters must depend on these boundaries; core must not import vendor SDKs.
 */
export abstract class CommandStorePort { abstract readonly kind: 'command-store'; }
export abstract class ProjectionStorePort { abstract readonly kind: 'projection-store'; }
export abstract class CachePort { abstract readonly kind: 'cache'; }
export abstract class SuiPort { abstract readonly kind: 'sui'; }
export abstract class SponsorPort { abstract readonly kind: 'sponsor'; }
export abstract class AnalyticsPort { abstract readonly kind: 'analytics'; }
export abstract class EvidenceStorePort { abstract readonly kind: 'evidence-store'; }
export abstract class EvidenceAccessPort { abstract readonly kind: 'evidence-access'; }
export abstract class BillingPort { abstract readonly kind: 'billing'; }
export abstract class WebhookDeliveryPort { abstract readonly kind: 'webhook-delivery'; }
