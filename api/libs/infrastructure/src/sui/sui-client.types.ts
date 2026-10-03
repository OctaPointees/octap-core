import type { SuiGrpcClient } from '@mysten/sui/grpc';
/** Reserved SDK boundary; no client is instantiated or connected. */
export interface SuiAdapterOptions {
  network: 'testnet' | 'devnet' | 'mainnet';
  grpcUrl: string;
  packageId: string;
}
export type SuiClientBoundary = Pick<SuiGrpcClient, 'core'>;
