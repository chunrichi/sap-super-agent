import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../scripts/vitest-aliases.mjs';

export default defineConfig({
  resolve: { alias: workspaceAliases },
  test: {
    include: ['e2e/**/*.e2e.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
