import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { LicenseOrderDto } from '@octap/contracts';
import {
  ConsoleAccessError,
  ConsoleOrganizationsRepository,
} from '#infra/db/repositories/console-organizations.repository.js';
import { LicensesRepository } from '#infra/db/repositories/licenses.repository.js';
import {
  isExpired,
  LicenseOrdersRepository,
  type LicenseOrder,
} from '#infra/db/repositories/license-orders.repository.js';

const OWNER_ONLY = 'Only the Owner can buy or renew the license';

/** Where transfers go: read when used, so an unset account answers 503 instead of stopping the API. */
function bankAccount(): { account: string; bankCode: string } {
  const account = process.env.SEPAY_BANK_ACCOUNT;
  const bankCode = process.env.SEPAY_BANK_CODE;
  if (!account || !bankCode) throw new ServiceUnavailableException('License payments are not configured');
  return { account, bankCode };
}

/**
 * The VietQR image SePay renders for a transfer of exactly `amountVnd` to OctaP's account, with the
 * payment code as the transfer content. Built here, so no call to SePay is needed.
 */
export function vietQrUrl(order: Pick<LicenseOrder, 'amountVnd' | 'paymentCode'>, bank = bankAccount()): string {
  const url = new URL('https://qr.sepay.vn/img');
  url.searchParams.set('acc', bank.account);
  url.searchParams.set('bank', bank.bankCode);
  url.searchParams.set('amount', String(order.amountVnd));
  url.searchParams.set('des', order.paymentCode);
  return url.toString();
}

function toOrderDto(order: LicenseOrder, now: Date, bank = bankAccount()): LicenseOrderDto {
  return {
    id: order.id,
    organizationId: order.organizationId,
    planId: order.planId,
    tier: order.tier,
    planName: order.planName,
    termMonths: order.termMonths,
    amountVnd: order.amountVnd,
    paymentCode: order.paymentCode,
    state: isExpired(order, now) ? 'EXPIRED' : order.status,
    qrUrl: vietQrUrl(order, bank),
    bankAccount: bank.account,
    bankCode: bank.bankCode,
    expiresAt: order.expiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * An Owner's orders to buy or renew the license (OCT-330 part 1). The order says how much to
 * transfer and with which code; the payment itself arrives through SePay (part 2).
 */
@Injectable()
export class LicenseOrderService {
  constructor(
    private readonly orders: LicenseOrdersRepository,
    private readonly licenses: LicensesRepository,
    private readonly access: ConsoleOrganizationsRepository,
  ) {}

  private async asOwner<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof ConsoleAccessError) throw new ForbiddenException(OWNER_ONLY);
      throw error;
    }
  }

  /** `planId` and `termMonths` were checked by the controller; what they mean is checked here. */
  async place(userId: string, organizationId: string, planId: string, termMonths: number): Promise<LicenseOrderDto> {
    const bank = bankAccount();
    const plan = await this.licenses.findPlan(planId);
    if (!plan || !plan.active || !plan.purchasable) throw new BadRequestException('This plan is not on sale');
    if (!plan.termMonthsAllowed.includes(termMonths))
      throw new BadRequestException(
        `termMonths must be one of ${plan.termMonthsAllowed.join(', ')} for the ${plan.name} plan`,
      );
    const now = new Date();
    // FOR UPDATE on the organization (the Owner check): two orders at once queue up.
    const { order } = await this.asOwner(() =>
      this.access.withAccess(userId, organizationId, true, (tx) =>
        this.orders.place(tx, { organizationId, plan, termMonths, createdById: userId, now }),
      ),
    );
    return toOrderDto(order, now, bank);
  }

  async list(userId: string, organizationId: string): Promise<LicenseOrderDto[]> {
    const bank = bankAccount();
    // Checked, then read after the check's transaction ends: one pooled connection at a time.
    await this.asOwner(() => this.access.withOwnerAccess(userId, organizationId, async () => undefined));
    const now = new Date();
    return (await this.orders.list(organizationId)).map((order) => toOrderDto(order, now, bank));
  }

  async get(userId: string, organizationId: string, orderId: string): Promise<LicenseOrderDto> {
    const bank = bankAccount();
    await this.asOwner(() => this.access.withOwnerAccess(userId, organizationId, async () => undefined));
    const order = await this.orders.find(organizationId, orderId);
    if (!order) throw new NotFoundException('Order not found');
    return toOrderDto(order, new Date(), bank);
  }

  /** A PENDING order, expired or not, can be canceled; a paid or canceled one is a 409. */
  async cancel(userId: string, organizationId: string, orderId: string): Promise<LicenseOrderDto> {
    const bank = bankAccount();
    const now = new Date();
    const result = await this.asOwner(() =>
      this.access.withAccess(userId, organizationId, true, (tx) =>
        this.orders.cancel(tx, organizationId, orderId, now),
      ),
    );
    if (!result) throw new NotFoundException('Order not found');
    if (!result.canceled)
      throw new ConflictException(
        result.order.status === 'PAID' ? 'This order is already paid' : 'This order is already canceled',
      );
    return toOrderDto(result.order, now, bank);
  }
}
