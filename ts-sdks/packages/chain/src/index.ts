export {
  OctapChainClient,
  eventField,
  signerFromPrivateKey,
  type OctapNetwork,
  type OctapChainClientOptions,
  type OpenAccountParams,
  type EarnParams,
  type RedeemParams,
  type PublishPolicyParams,
  type ActivatePolicyAndIssueCapParams,
  type CreateShardsParams,
  type SubmittedChainTransaction,
} from './client.js';
export {
  TESTNET_OCTAP_PACKAGE_CONFIG,
  MAINNET_OCTAP_PACKAGE_CONFIG,
  TESTNET_OCTAP_DEMO_PROGRAM_CONFIG,
  MAINNET_OCTAP_DEMO_PROGRAM_CONFIG,
  type OctapPackageConfig,
  type OctapDemoProgramConfig,
} from './constants.js';
export { operationShardIndex } from './shards.js';
