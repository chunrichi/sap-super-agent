// Shared Vitest aliases: workspace packages resolve to their TypeScript sources
// during tests, so `vitest run` never depends on a prior `pnpm build`.
// TypeScript mirrors this mapping through `paths` in tsconfig.base.json.
const src = (pkg) => new URL(`../packages/${pkg}/src/index.ts`, import.meta.url).pathname;

export const workspaceAliases = {
  '@sap-superagent/protocol': src('protocol'),
  '@sap-superagent/core': src('core'),
  '@sap-superagent/ai': src('ai'),
  '@sap-superagent/server': src('server'),
  '@sap-superagent/sap-adapter': src('sap-adapter'),
  '@sap-superagent/cli': src('cli'),
  '@sap-superagent/testkit': src('testkit'),
};
