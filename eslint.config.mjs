import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  { languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  ...tseslint.configs.recommended,
);
