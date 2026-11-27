import type {
  VoucherActorRef,
  VoucherLifecycleEventData,
  VoucherReturnedEventData,
  VoucherSubmittedEventData,
} from '@octap/contracts';
import type { DrizzleDb } from '../postgres.provider.js';
import type { voucherApprovalRequests, vouchers } from '../schema/rewards.schema.js';
import { recordEvent } from './events.repository.js';

type Voucher = typeof vouchers.$inferSelect;
type VoucherApprovalRequest = typeof voucherApprovalRequests.$inferSelect;

/** Who acted, from the `*_user_id` / `*_credential_id` pair a voucher or a request records. */
export function voucherActorRef(userId: string | null, credentialId: string | null): VoucherActorRef {
  if (credentialId) return { type: 'API_CREDENTIAL', id: credentialId };
  return userId ? { type: 'USER', id: userId } : null;
}

function lifecycleData(voucher: Voucher): VoucherLifecycleEventData {
  return {
    voucherId: voucher.id,
    code: voucher.code,
    title: voucher.title,
    batchId: voucher.importBatchId,
    status: voucher.status,
    publishStatus: voucher.publishStatus,
    suiTermsId: voucher.suiTermsId,
    createdBy: voucherActorRef(voucher.createdByUserId, voucher.createdByCredentialId),
    activatedBy: voucherActorRef(voucher.activatedByUserId, voucher.activatedByCredentialId),
    activatedAt: voucher.activatedAt?.toISOString() ?? null,
    updatedAt: voucher.updatedAt.toISOString(),
  };
}

/**
 * Records a voucher lifecycle event (OCT-325) for `voucher` as it is now, on the caller's `tx`. Call
 * it right after the write that made the change, with the row that write returned.
 */
export function recordVoucherEvent(
  tx: DrizzleDb,
  type:
    | 'voucher.created'
    | 'voucher.activated'
    | 'voucher.publish.failed'
    | 'voucher.paused'
    | 'voucher.archived'
    | 'voucher.expired',
  voucher: Voucher,
) {
  return recordEvent(tx, { organizationId: voucher.organizationId, type, payload: lifecycleData(voucher) });
}

/** `voucher.submitted`: `request` is the approval request just queued for `voucher`. */
export function recordVoucherSubmitted(tx: DrizzleDb, voucher: Voucher, request: VoucherApprovalRequest) {
  const payload: VoucherSubmittedEventData = {
    ...lifecycleData(voucher),
    approvalRequestId: request.id,
    submittedBy: voucherActorRef(request.submittedByUserId, request.submittedByCredentialId),
  };
  return recordEvent(tx, { organizationId: voucher.organizationId, type: 'voucher.submitted', payload });
}

/** `voucher.returned`: `request` left the queue as `outcome`, and `voucher` is back to DRAFT. */
export function recordVoucherReturned(
  tx: DrizzleDb,
  voucher: Voucher,
  request: VoucherApprovalRequest,
  outcome: VoucherReturnedEventData['outcome'],
  reviewedById: string,
  reason: string | null,
) {
  const payload: VoucherReturnedEventData = {
    ...lifecycleData(voucher),
    approvalRequestId: request.id,
    outcome,
    reason,
    reviewedById,
  };
  return recordEvent(tx, { organizationId: voucher.organizationId, type: 'voucher.returned', payload });
}
