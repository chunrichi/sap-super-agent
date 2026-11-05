import { defineConfig } from 'vitest/config';
import { workspaceAliases } from '../../../scripts/vitest-aliases.mjs';

export default defineConfig({
  resolve: {
    alias: {
      ...workspaceAliases,
      // Tests never load the real VSCode API; use a local mock module instead.
      vscode: new URL('./test/mocks/vscode.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20000,
  },
});
