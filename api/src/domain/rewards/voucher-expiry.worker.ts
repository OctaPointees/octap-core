import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { RewardsRepository, VOUCHER_EXPIRY_BATCH_SIZE } from '#infra/db/repositories/rewards.repository.js';

const SWEEP_INTERVAL_MS = Number(process.env.VOUCHER_EXPIRY_SWEEP_INTERVAL_MS ?? 60_000);

/**
 * Marks vouchers `EXPIRED` once their deadline passes, and sends `voucher.expired` /
 * `voucher.member_expired` for each (`expireDueVouchers`). Runs once at start, to catch up on what
 * expired while no worker ran, then every `VOUCHER_EXPIRY_SWEEP_INTERVAL_MS`: batch after batch
 * until one comes back short, so a burst (many vouchers closing at the same midnight) clears in one
 * sweep. Several workers can run it at once: rows another one holds are skipped. Reads expire their
 * organization's vouchers themselves (`RewardsRepository.expireDueFor`), so the interval only bounds
 * how late the webhook is.
 */
@Injectable()
export class VoucherExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VoucherExpiryWorker.name);
  private timer?: NodeJS.Timeout;
  private sweeping = false;

  constructor(private readonly rewards: RewardsRepository) {}

  onModuleInit(): void {
    void this.sweepOnce();
    this.timer = setInterval(() => void this.sweepOnce(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sweep; returns how many rows it expired. Public for tests; the interval calls it. */
  async sweepOnce(now = new Date()): Promise<{ vouchers: number; memberVouchers: number }> {
    const total = { vouchers: 0, memberVouchers: 0 };
    if (this.sweeping) return total;
    this.sweeping = true;
    try {
      for (;;) {
        const done = await this.rewards.expireDue(VOUCHER_EXPIRY_BATCH_SIZE, now);
        total.vouchers += done.vouchers;
        total.memberVouchers += done.memberVouchers;
        if (done.vouchers < VOUCHER_EXPIRY_BATCH_SIZE && done.memberVouchers < VOUCHER_EXPIRY_BATCH_SIZE) break;
      }
      if (total.vouchers + total.memberVouchers > 0)
        this.logger.log(`expired ${total.vouchers} vouchers and ${total.memberVouchers} customer vouchers`);
    } catch (error: unknown) {
      this.logger.error(`sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.sweeping = false;
    }
    return total;
  }
}
