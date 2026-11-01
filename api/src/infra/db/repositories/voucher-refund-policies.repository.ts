import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt } from 'drizzle-orm';
import type {
  SetVoucherRefundPolicyRequest,
  VoucherRefundPolicyDto,
  ListVoucherRefundPolicyHistoryRequest,
} from '@octap/contracts';
import { DEFAULT_VOUCHER_REFUND_POLICY } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { withRls } from '../rls.js';
import { apiCredentials, organizations } from '../schema/organizations.schema.js';
import { voucherRefundPolicies } from '../schema/voucher-refund-policies.schema.js';

export class RefundPolicyOrganizationNotFoundError extends Error {}

function toPolicyDto(row: typeof voucherRefundPolicies.$inferSelect): VoucherRefundPolicyDto {
  return {
    ...row.policy,
    version: row.version,
    reason: row.reason,
    createdByCredentialId: row.createdByCredentialId,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class VoucherRefundPoliciesRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}

  async history(
    organizationId: string,
    query: ListVoucherRefundPolicyHistoryRequest = {},
  ): Promise<VoucherRefundPolicyDto[]> {
    return withRls(this.db, { tenantId: organizationId }, async (tx) => {
      const rows = await tx
        .select()
        .from(voucherRefundPolicies)
        .where(
          and(
            eq(voucherRefundPolicies.organizationId, organizationId),
            ...(query.beforeVersion === undefined ? [] : [lt(voucherRefundPolicies.version, query.beforeVersion)]),
          ),
        )
        .orderBy(desc(voucherRefundPolicies.version))
        .limit(query.limit ?? 50);
      return rows.map(toPolicyDto);
    });
  }

  async current(organizationId: string): Promise<VoucherRefundPolicyDto> {
    return withRls(this.db, { tenantId: organizationId }, async (tx) => {
      const [latest] = await tx
        .select()
        .from(voucherRefundPolicies)
        .where(eq(voucherRefundPolicies.organizationId, organizationId))
        .orderBy(desc(voucherRefundPolicies.version))
        .limit(1);
      return latest
        ? toPolicyDto(latest)
        : {
            ...DEFAULT_VOUCHER_REFUND_POLICY,
            reason: 'Default refund policy',
            createdByCredentialId: null,
            createdAt: null,
          };
    });
  }

  async publish(organizationId: string, credentialId: string, request: SetVoucherRefundPolicyRequest) {
    return this.db.transaction(async (tx) => {
      // Serialize version allocation per tenant, including its first publication.
      // Lock before entering API-key RLS: organizations exposes human memberships,
      // not API-credential tenants. Policy/credential reads and writes remain under RLS.
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('update');
      if (!organization) throw new RefundPolicyOrganizationNotFoundError();
      return withRls(tx, { tenantId: organizationId }, async (tx) => {
        const [credential] = await tx
          .select({ id: apiCredentials.id })
          .from(apiCredentials)
          .where(and(eq(apiCredentials.id, credentialId), eq(apiCredentials.organizationId, organizationId)));
        if (!credential) throw new RefundPolicyOrganizationNotFoundError();
        const [latest] = await tx
          .select({ version: voucherRefundPolicies.version })
          .from(voucherRefundPolicies)
          .where(eq(voucherRefundPolicies.organizationId, organizationId))
          .orderBy(desc(voucherRefundPolicies.version))
          .limit(1);
        const { reason, ...policy } = request;
        const [row] = await tx
          .insert(voucherRefundPolicies)
          .values({
            organizationId,
            version: (latest?.version ?? 0) + 1,
            policy,
            reason: reason.trim(),
            createdByCredentialId: credentialId,
          })
          .returning();
        return toPolicyDto(row);
      });
    });
  }
}
