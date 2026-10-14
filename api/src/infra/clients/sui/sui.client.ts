import { Injectable, Logger } from '@nestjs/common';
import { OctapChainClient, signerFromPrivateKey, type OctapNetwork, type SubmittedChainTransaction } from '@octap/chain';
import type { Signer } from '@mysten/sui/cryptography';

export interface ChainCallResult extends SubmittedChainTransaction {
  /** Convenience lookup: the first value of `field` on any event named `::<eventSuffix>`. */
  eventField<T = unknown>(eventSuffix: string, field: string): T | undefined;
}

function toChainCallResult(result: SubmittedChainTransaction): ChainCallResult {
  return {
    ...result,
    eventField(eventSuffix, field) {
      const event = result.events.find((e) => e.type.endsWith(`::${eventSuffix}`));
      return (event?.parsedJson as Record<string, unknown> | undefined)?.[field] as never;
    },
  };
}

/**
 * Worker-only adapter to `@octap/chain`. Registered in `worker.module.ts`, never in
 * `infra/infrastructure.module.ts` — `AppModule` (the internet-facing HTTP process) has no reason
 * to hold `SUI_ISSUER_PRIVATE_KEY` in memory at all, only the worker process that actually
 * dispatches chain transactions does.
 *
 * Demo-scoped: one program/policy/IssuerCap from env, applied to every organization, until
 * `domain/programs` (docs/roadmap.md) exists to look these up per organization instead.
 */
@Injectable()
export class SuiClientService {
  private readonly logger = new Logger(SuiClientService.name);
  private chainClient?: OctapChainClient;
  private signer?: Signer;

  private get client(): OctapChainClient {
    if (!this.chainClient) {
      const network = (process.env.SUI_NETWORK ?? 'testnet') as OctapNetwork;
      const packageId = process.env.SUI_PACKAGE_ID;
      this.chainClient = new OctapChainClient({
        network,
        package: packageId ? { packageId } : undefined,
      });
    }
    return this.chainClient;
  }

  private get issuerSigner(): Signer {
    if (!this.signer) {
      this.signer = signerFromPrivateKey(requireEnv('SUI_ISSUER_PRIVATE_KEY'));
    }
    return this.signer;
  }

  /** The address every call in this service signs with — for stamping `blockchainTransactions.sender`. */
  issuerAddress(): string {
    return this.issuerSigner.getPublicKey().toSuiAddress();
  }

  async openAccount(beneficiary: string): Promise<ChainCallResult> {
    const tx = this.client.buildOpenAccountTransaction({
      issuerCapId: requireEnv('SUI_ISSUER_CAP_ID'),
      programId: requireEnv('SUI_PROGRAM_CONTROL_ID'),
      beneficiary,
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`opening credit account for ${beneficiary}`);
    return toChainCallResult(await this.client.signAndExecute(tx, this.issuerSigner));
  }

  async earn(params: { accountId: string; purchaseAmount: number; operationKey: string }): Promise<ChainCallResult> {
    const tx = this.client.buildEarnTransaction({
      issuerCapId: requireEnv('SUI_ISSUER_CAP_ID'),
      programId: requireEnv('SUI_PROGRAM_CONTROL_ID'),
      policyId: requireEnv('SUI_POLICY_VERSION_ID'),
      accountId: params.accountId,
      purchaseAmount: params.purchaseAmount,
      operationKey: new TextEncoder().encode(params.operationKey),
    });
    tx.setGasBudget(50_000_000);
    this.logger.log(`earn ${params.purchaseAmount} purchase units -> account ${params.accountId}`);
    return toChainCallResult(await this.client.signAndExecute(tx, this.issuerSigner));
  }

  // No `redeem()` wrapper here, deliberately: `credit_account::redeem` requires
  // `sender == beneficiary` (contracts/sui/credit_account.move), and this service only ever signs
  // with the IssuerCap holder's key. A worker calling redeem would abort on-chain with
  // `ENotBeneficiary` every single time — not an edge case to handle, a guarantee the beneficiary
  // consent invariant is actually enforced. Submitting a redeem needs the end user's own
  // signature (zkLogin — docs/roadmap.md "Identity", not started), which means building the
  // unsigned transaction via `OctapChainClient.buildRedeemTransaction` for the client to sign is
  // an HTTP-request-shaped feature, not a worker job; add it there once zkLogin exists instead of
  // routing it through this service.
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name} for the Sui chain adapter`);
  }
  return value;
}
