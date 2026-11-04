import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'tmp/**',
      'contracts/**',
      'sap/**',
      'examples/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // Generated JSON payloads and protocol schemas legitimately use `any`
      // only at the zod boundary; keep the rule off for now (see docs/003 §4.1).
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
);
