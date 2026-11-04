import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, or } from 'drizzle-orm';
import type { ProvisionOrganizationInput } from '@octap/contracts';
import { DRIZZLE_DB, type DrizzleDb } from '../postgres.provider.js';
import { organizations } from '../schema/organizations.schema.js';
import { programs } from '../schema/programs.schema.js';
import { systemUsers } from '../schema/auth.schema.js';
import { operations } from '../schema/operations.schema.js';
import { acceptCommand } from './operations.repository.js';
import { ConsoleConflictError, ConsoleNotFoundError, requireSystemAdmin } from './console-access.js';
export const ORGANIZATION_PROVISION_COMMAND = 'ORGANIZATION_PROGRAM_PROVISION';
type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const fields = {
  id: organizations.id,
  name: organizations.name,
  slug: organizations.slug,
  status: organizations.status,
  organizationType: organizations.organizationType,
  legalName: organizations.legalName,
  taxId: organizations.taxId,
  representativeName: organizations.representativeName,
  createdAt: organizations.createdAt,
  programStatus: programs.status,
  programControlId: programs.programControlId,
};
@Injectable()
export class OrganizationsRepository {
  constructor(@Inject(DRIZZLE_DB) private readonly db: DrizzleDb) {}
  private admin = requireSystemAdmin;
  private async progress(tx: Tx, ids: string[]) {
    if (!ids.length) return [];
    return tx
      .selectDistinctOn([operations.tenantId], {
        tenantId: operations.tenantId,
        operationId: operations.id,
        status: operations.status,
        errorMessage: operations.errorMessage,
        updatedAt: operations.updatedAt,
      })
      .from(operations)
      .where(and(inArray(operations.tenantId, ids), eq(operations.commandType, ORGANIZATION_PROVISION_COMMAND)))
      .orderBy(operations.tenantId, desc(operations.createdAt), desc(operations.id));
  }
  list(actor: string, query: { limit: number; cursor?: string; status?: string; q?: string }) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const pattern = query.q ? `%${query.q.replace(/[\\%_]/g, '\\$&')}%` : undefined;
      const rows = await tx
        .select(fields)
        .from(organizations)
        .leftJoin(programs, eq(programs.organizationId, organizations.id))
        .where(
          and(
            query.cursor ? gt(organizations.id, query.cursor) : undefined,
            query.status ? eq(organizations.status, query.status as 'ACTIVE') : undefined,
            pattern ? or(ilike(organizations.name, pattern), ilike(organizations.slug, pattern)) : undefined,
          ),
        )
        .orderBy(asc(organizations.id))
        .limit(query.limit + 1);
      const more = rows.length > query.limit;
      if (more) rows.pop();
      const progress = await this.progress(
        tx,
        rows.map((row) => row.id),
      );
      return {
        items: rows.map((row) => ({ ...row, provisioning: progress.find((job) => job.tenantId === row.id) ?? null })),
        nextCursor: more ? rows.at(-1)!.id : null,
      };
    });
  }
  detail(actor: string, orgId: string) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const [org] = await tx
        .select(fields)
        .from(organizations)
        .leftJoin(programs, eq(programs.organizationId, organizations.id))
        .where(eq(organizations.id, orgId));
      if (!org) throw new ConsoleNotFoundError('Organization not found');
      return { ...org, provisioning: (await this.progress(tx, [orgId]))[0] ?? null };
    });
  }
  owners(actor: string, q: string) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      return tx
        .select({ id: systemUsers.id, email: systemUsers.email, fullName: systemUsers.fullName })
        .from(systemUsers)
        .where(
          and(
            isNotNull(systemUsers.googleSubject),
            or(ilike(systemUsers.email, pattern), ilike(systemUsers.fullName, pattern)),
          ),
        )
        .orderBy(asc(systemUsers.email))
        .limit(25);
    });
  }
  async resolve(slug: string) {
    const [org] = await this.db
      .select({ organizationId: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(and(eq(organizations.slug, slug), eq(organizations.status, 'ACTIVE')));
    if (!org) throw new ConsoleNotFoundError('Active organization not found');
    return org;
  }
  enqueue(actor: string, orgId: string, input: ProvisionOrganizationInput) {
    return this.db.transaction(async (tx) => {
      await this.admin(tx, actor);
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
      if (!org) throw new ConsoleNotFoundError('Organization not found');
      if (org.status !== 'ACTIVE')
        throw new ConsoleConflictError('Approve or reinstate this organization before provisioning');
      const existing = await tx.query.operations.findFirst({
        where: and(eq(operations.tenantId, orgId), eq(operations.idempotencyKey, input.idempotencyKey)),
      });
      if (existing && existing.commandType !== ORGANIZATION_PROVISION_COMMAND)
        throw new ConsoleConflictError('Idempotency key belongs to another command');
      if (!existing) {
        const program = await tx.query.programs.findFirst({ where: eq(programs.organizationId, orgId) });
        if (program) throw new ConsoleConflictError('Organization already has a program or an unresolved reservation');
        const pending = await tx.query.operations.findFirst({
          where: and(
            eq(operations.tenantId, orgId),
            eq(operations.commandType, ORGANIZATION_PROVISION_COMMAND),
            inArray(operations.status, ['PENDING', 'PROCESSING', 'UNKNOWN']),
          ),
        });
        if (pending)
          throw new ConsoleConflictError(
            'Provisioning is pending or requires reconciliation; do not submit another command',
          );
      }
      const { idempotencyKey, ...config } = input;
      const result = await acceptCommand(tx, {
        tenantId: orgId,
        idempotencyKey,
        commandType: ORGANIZATION_PROVISION_COMMAND,
        payload: config,
      });
      if (result.isNew)
        await tx
          .update(operations)
          .set({ payload: { ...config, requestedById: actor } })
          .where(eq(operations.id, result.operation.id));
      return { operationId: result.operation.id, status: result.operation.status };
    });
  }
  async finish(id: string, status: 'SUBMITTED' | 'FAILED', errorMessage: string | null = null) {
    await this.db
      .update(operations)
      .set({ status, errorMessage, updatedAt: new Date() })
      .where(
        and(
          eq(operations.id, id),
          eq(operations.commandType, ORGANIZATION_PROVISION_COMMAND),
          inArray(operations.status, ['PROCESSING', 'UNKNOWN']),
        ),
      );
  }
  async active(orgId: string) {
    const org = await this.db.query.organizations.findFirst({
      where: eq(organizations.id, orgId),
      columns: { status: true },
    });
    return org?.status === 'ACTIVE';
  }
}
