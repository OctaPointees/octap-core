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
  { languageOptions: { globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' } } },
  ...tseslint.configs.recommended,
  {
    // CLAUDE.md "Code standards": inside api/src, reach another top-level area through its
    // api/package.json subpath import, never a ../../ chain. One level up (a sibling folder in the
    // same feature, e.g. api/rest -> api/dto) stays relative.
    files: ['api/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../*'],
              message: 'Use a subpath import (#api/…, #domain/…, #infra/…) instead of a ../../ relative import.',
            },
          ],
        },
      ],
    },
  },
);
