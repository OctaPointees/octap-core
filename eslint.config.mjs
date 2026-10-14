import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/next-env.d.ts',
      // @mysten/codegen output (ts-sdks/packages/chain) — generated, "DO NOT MODIFY", not our style.
      'ts-sdks/packages/*/src/contracts/**',
    ],
  },
  js.configs.recommended,
  { languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  ...tseslint.configs.recommended,
);
