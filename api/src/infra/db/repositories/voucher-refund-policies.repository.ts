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
import { organizations } from '../schema/organizations.schema.js';
import { voucherRefundPolicies } from '../schema/voucher-refund-policies.schema.js';

export class RefundPolicyOrganizationNotFoundError extends Error {}

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
/** The publisher's access check, run on the publishing transaction. Throws to refuse. */
export type RefundPolicyAuthorize = (tx: Tx) => Promise<unknown>;

function toPolicyDto(row: typeof voucherRefundPolicies.$inferSelect): VoucherRefundPolicyDto {
  return {
    ...row.policy,
    version: row.version,
    reason: row.reason,
    createdByUserId: row.createdByUserId,
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
            createdByUserId: null,
            createdByCredentialId: null,
            createdAt: null,
          };
    });
  }

  /**
   * Publishes the next version as `userId`. `authorize` runs on the server connection right after the
   * organization lock and before anything is written, so the caller checks the actor's role while the
   * organization is held (the console passes its Owner check).
   */
  async publish(
    organizationId: string,
    userId: string,
    request: SetVoucherRefundPolicyRequest,
    authorize: RefundPolicyAuthorize,
  ) {
    return this.db.transaction(async (tx) => {
      // Serialize version allocation per tenant, including its first publication. Taken first, ahead of
      // `authorize`'s own FOR SHARE on the same row: two publishers that both held FOR SHARE and then
      // asked for this lock would deadlock each other.
      // NO KEY UPDATE, because FOR UPDATE would also block every insert referencing this organization.
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .for('no key update');
      // The actor check answers first, so a missing organization reads like any other one the caller
      // cannot reach.
      await authorize(tx);
      if (!organization) throw new RefundPolicyOrganizationNotFoundError();
      return withRls(tx, { tenantId: organizationId }, async (tx) => {
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
            createdByUserId: userId,
          })
          .returning();
        return toPolicyDto(row);
      });
    });
  }
}
