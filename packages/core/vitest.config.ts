import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../scripts/vitest-aliases.mjs';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
