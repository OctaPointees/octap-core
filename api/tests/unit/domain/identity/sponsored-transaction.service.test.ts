import { describe, expect, it, vi } from 'vitest';
import { SponsoredTransactionService } from '../../../../src/domain/identity/sponsored-transaction.service.js';
import type { EnokiClient } from '../../../../src/infra/clients/enoki/enoki.client.js';
import type { SuiTransactionBuilderClient } from '../../../../src/infra/clients/sui/sui-transaction-builder.client.js';
import { stub } from '../../../helpers/stub.js';

const REDEEM_TARGET = '0xpkg::credit_account::redeem';

describe('SponsoredTransactionService', () => {
  it('previewSponsoredRedeem builds the kind and sponsors with exactly one allowed target', async () => {
    const createSponsoredTransaction = vi.fn(async () => ({ bytes: 'full-tx-bytes', digest: 'digest-1' }));
    const buildRedeemTransactionKind = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const service = new SponsoredTransactionService(
      stub<EnokiClient>({ createSponsoredTransaction }),
      stub<SuiTransactionBuilderClient>({ redeemMoveCallTarget: REDEEM_TARGET, buildRedeemTransactionKind }),
    );
    const params = {
      beneficiaryAddress: '0xbeneficiary',
      accountId: 'account-1',
      cost: 50n,
      reference: new Uint8Array([9]),
    };

    const result = await service.previewSponsoredRedeem(params);

    expect(buildRedeemTransactionKind).toHaveBeenCalledWith(params);
    expect(createSponsoredTransaction).toHaveBeenCalledWith({
      transactionKindBytes: new Uint8Array([1, 2, 3]),
      sender: '0xbeneficiary',
      allowedMoveCallTargets: [REDEEM_TARGET],
    });
    expect(result).toEqual({ transactionBytes: 'full-tx-bytes', digest: 'digest-1' });
  });

  it('there is no parameter that can widen the sponsorship allowlist', async () => {
    const createSponsoredTransaction = vi.fn(async () => ({ bytes: 'bytes', digest: 'digest' }));
    const service = new SponsoredTransactionService(
      stub<EnokiClient>({ createSponsoredTransaction }),
      stub<SuiTransactionBuilderClient>({
        redeemMoveCallTarget: REDEEM_TARGET,
        buildRedeemTransactionKind: async () => new Uint8Array(),
      }),
    );

    // The only parameters are domain values; extra keys a caller smuggles in are never forwarded.
    await service.previewSponsoredRedeem({
      beneficiaryAddress: '0xbeneficiary',
      accountId: 'account-99',
      cost: 1n,
      reference: new Uint8Array(),
      allowedMoveCallTargets: ['0xevil::drain::all'],
    } as Parameters<SponsoredTransactionService['previewSponsoredRedeem']>[0]);

    expect(createSponsoredTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMoveCallTargets: [REDEEM_TARGET] }),
    );
  });

  it('executeSponsoredRedeem submits the signature for an already-sponsored digest', async () => {
    const executeSponsoredTransaction = vi.fn(async () => ({ digest: 'digest-1' }));
    const service = new SponsoredTransactionService(
      stub<EnokiClient>({ executeSponsoredTransaction }),
      stub<SuiTransactionBuilderClient>(),
    );

    expect(await service.executeSponsoredRedeem({ digest: 'digest-1', signature: 'sig' })).toEqual({
      digest: 'digest-1',
    });
    expect(executeSponsoredTransaction).toHaveBeenCalledWith({ digest: 'digest-1', signature: 'sig' });
  });
});
