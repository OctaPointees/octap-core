export {
  OctapChainClient,
  eventField,
  transactionExpirationEpoch,
  signerFromPrivateKey,
  type OctapNetwork,
  type OctapChainClientOptions,
  type OctapProgramConfig,
  type OpenAccountParams,
  type EarnParams,
  type RedeemParams,
  type PublishPolicyParams,
  type ActivatePolicyAndIssueCapParams,
  type CreateShardsParams,
  type TopUpBudgetParams,
  type SubmittedChainTransaction,
  type SignedChainTransaction,
  type CreditAccountEvent,
  type CreditAccountEventPage,
} from './client.js';
export { TESTNET_OCTAP_PACKAGE_CONFIG, MAINNET_OCTAP_PACKAGE_CONFIG, type OctapPackageConfig } from './constants.js';
export { operationShardIndex } from './shards.js';
