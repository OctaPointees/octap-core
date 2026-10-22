import type { OctapNetwork } from '@octap/chain';

/**
 * Picks `@octap/chain`'s committed per-network constant for `network` — object ids, not secrets,
 * so `SUI_NETWORK` is the only env knob. Mainnet constants stay `undefined` until deployed there.
 */
export function configForNetwork<T>(
  network: OctapNetwork,
  configs: { testnet: T; mainnet: T | undefined },
  what: string,
): T {
  if (network === 'testnet') {
    return configs.testnet;
  }
  if (network === 'mainnet' && configs.mainnet) {
    return configs.mainnet;
  }
  throw new Error(`No ${what} configured for Sui network "${network}"`);
}
