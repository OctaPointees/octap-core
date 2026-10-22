import type { SuiCodegenConfig } from '@mysten/codegen';
import { TESTNET_OCTAP_PACKAGE_CONFIG } from './src/constants.ts';

const config: SuiCodegenConfig = {
  output: './src/contracts',
  generateSummaries: true,
  prune: true,
  includePhantomTypeParameters: false,
  packages: [
    {
      // Generated from local source so an upgraded package keeps `octap` as
      // the module path while still emitting calls against the id in
      // constants.ts. Every runtime caller passes `package:` explicitly from
      // that network config (see client.ts), so the id baked in here is only
      // a default moveCall target, not something every consumer must trust.
      package: TESTNET_OCTAP_PACKAGE_CONFIG.packageId,
      packageName: 'octap',
      path: '../../../contracts/sui',
    },
  ],
};

export default config;
