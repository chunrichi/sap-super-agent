#!/usr/bin/env node
// Root `pnpm package:vsix` (v1.0 release gate, task-1 deliverable 1).
//
// Builds the VSCode extension as ONE esbuild bundle and packs a VSIX that only
// contains runtime files. The extension package (`packages/clients/vscode`) is
// `"type": "module"` for tsc/vitest, so the shipped bundle is CommonJS
// (`dist/extension.cjs`) — VS Code's extension host loads it through `require`,
// which works on every supported VS Code version (ESM extensions need newer
// hosts). `vscode` stays external; `@sap-superagent/protocol` and `ws` are
// bundled, so no `node_modules`/dependencies ship in the VSIX.
//
// Usage:
//   node scripts/vsix-package.mjs                # bundle + stage + pack VSIX
//   node scripts/vsix-package.mjs --bundle-only  # just refresh dist/extension.cjs
//
// Output: tmp/vsix/sap-superagent-vscode-<version>.vsix (gitignored).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const extensionDir = path.join(root, 'packages', 'clients', 'vscode');
const stageDir = path.join(root, 'tmp', 'vsix-stage');
const outDir = path.join(root, 'tmp', 'vsix');
const bundleOnly = process.argv.includes('--bundle-only');

// Files that must exist inside the VSIX and files that must never appear
// (sources/tests/configs/node_modules would bloat the artifact and leak dev
// state). Keep this list in sync with the staging block below.
const REQUIRED_ENTRIES = [
  'extension/package.json',
  // vsce normalizes these two names inside the VSIX (README.md → readme.md,
  // LICENSE → LICENSE.txt); the repo files keep their canonical names.
  'extension/readme.md',
  'extension/LICENSE.txt',
  'extension/dist/extension.cjs',
];
const FORBIDDEN_ENTRY_PATTERNS = [
  /^extension\/src\//,
  /^extension\/test\//,
  /^extension\/node_modules\//,
  /^extension\/tsconfig/,
  /^extension\/\.vscode\//,
  /\.map$/,
  /^extension\/\.vscodeignore$/,
];

async function readExtensionManifest() {
  return JSON.parse(await readFile(path.join(extensionDir, 'package.json'), 'utf8'));
}

/** Bundle the extension entrypoint into a single CommonJS file. */
async function bundleExtension(manifest) {
  const outfile = path.join(extensionDir, 'dist', 'extension.cjs');
  const result = await build({
    absWorkingDir: root,
    entryPoints: [path.join(extensionDir, 'src', 'extension.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    // `vscode` is injected by the extension host; optional native ws add-ons are
    // not installed and ws already falls back to its pure-JS implementation.
    external: ['vscode', 'bufferutil', 'utf-8-validate'],
    // Bundle the workspace protocol from source so packaging does not depend on
    // a previous `pnpm build` of another package.
    alias: {
      '@sap-superagent/protocol': path.join(root, 'packages', 'protocol', 'src', 'index.ts'),
    },
    logLevel: 'silent',
    sourcemap: false,
  });
  if (result.errors.length > 0) {
    throw new Error(`esbuild reported ${result.errors.length} error(s)`);
  }
  const stats = await stat(outfile);
  console.log(`[vsix] bundle ok: ${path.relative(root, outfile)} (${formatBytes(stats.size)})`);
  if (manifest.main !== './dist/extension.cjs') {
    throw new Error(`package.json main must be ./dist/extension.cjs, got ${String(manifest.main)}`);
  }
  return outfile;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kiB = bytes / 1024;
  return kiB < 1024 ? `${kiB.toFixed(1)} KiB` : `${(kiB / 1024).toFixed(2)} MiB`;
}

/** Copy only runtime files into a clean staging directory. */
async function stageExtension(manifest) {
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(path.join(stageDir, 'dist'), { recursive: true });

  // Manifest: drop monorepo-only fields so the VSIX manifest is clean; the
  // bundle is self-contained (no `dependencies` to resolve at install time).
  const staged = {
    name: manifest.name,
    displayName: manifest.displayName,
    description: manifest.description,
    version: manifest.version,
    publisher: manifest.publisher,
    license: manifest.license,
    repository: manifest.repository,
    engines: manifest.engines,
    categories: manifest.categories,
    main: manifest.main,
    type: manifest.type,
    activationEvents: manifest.activationEvents,
    contributes: manifest.contributes,
  };
  await writeFile(
    path.join(stageDir, 'package.json'),
    `${JSON.stringify(staged, null, 2)}\n`,
    'utf8',
  );

  await cp(path.join(extensionDir, 'README.md'), path.join(stageDir, 'README.md'));
  // README/LICENSE are copied read-only from the repo root / extension dir;
  // their content is never edited here (task-1 constraint).
  const licensePath = path.join(extensionDir, 'LICENSE');
  const rootLicensePath = path.join(root, 'LICENSE');
  await cp(existsSync(licensePath) ? licensePath : rootLicensePath, path.join(stageDir, 'LICENSE'));
  await cp(path.join(extensionDir, 'dist', 'extension.cjs'), path.join(stageDir, 'dist', 'extension.cjs'));
  await cp(path.join(extensionDir, '.vscodeignore'), path.join(stageDir, '.vscodeignore'));
}

/** Run `vsce package` through its JS API with dependencies disabled. */
async function packVsix(manifest) {
  const { createVSIX } = await import('@vscode/vsce');
  await mkdir(outDir, { recursive: true });
  const packagePath = path.join(outDir, `${manifest.name}-${manifest.version}.vsix`);

  const warnings = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  console.error = (...args) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    await createVSIX({ cwd: stageDir, packagePath, dependencies: false });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  if (warnings.length > 0) {
    for (const warning of warnings) console.warn(`[vsix] vsce warning: ${warning}`);
  } else {
    console.log('[vsix] vsce warnings: none');
  }
  const stats = await stat(packagePath);
  return { packagePath, warnings, size: stats.size };
}

/** List and validate the files inside the produced VSIX. */
function listArchiveEntries(packagePath) {
  const unzip = spawnSync('unzip', ['-Z1', packagePath], { encoding: 'utf8' });
  if (unzip.error === undefined && unzip.status === 0) {
    return unzip.stdout;
  }
  // Windows ships bsdtar instead of unzip; bsdtar can list zip entries too.
  const tar = spawnSync('tar', ['-tf', packagePath], { encoding: 'utf8' });
  if (tar.error === undefined && tar.status === 0) {
    return tar.stdout;
  }
  throw new Error(
    `unable to inspect VSIX (neither unzip nor tar could list it): ` +
      `${unzip.error?.message ?? unzip.stderr ?? ''} ${tar.error?.message ?? tar.stderr ?? ''}`,
  );
}

function inspectVsix(packagePath) {
  const rawListing = listArchiveEntries(packagePath);
  const entries = rawListing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.endsWith('/'));
  const missing = REQUIRED_ENTRIES.filter((required) => !entries.includes(required));
  if (missing.length > 0) {
    throw new Error(`VSIX is missing required files: ${missing.join(', ')}`);
  }
  const forbidden = entries.filter((entry) =>
    FORBIDDEN_ENTRY_PATTERNS.some((pattern) => pattern.test(entry)),
  );
  if (forbidden.length > 0) {
    throw new Error(`VSIX contains files that must not ship: ${forbidden.join(', ')}`);
  }
  return entries;
}

async function main() {
  const manifest = await readExtensionManifest();
  await bundleExtension(manifest);
  if (bundleOnly) {
    console.log(`[vsix] OK (bundle only) — version ${manifest.version}`);
    return;
  }
  if (!existsSync(path.join(extensionDir, 'README.md'))) {
    throw new Error('packages/clients/vscode/README.md is missing; vsce requires it');
  }
  await stageExtension(manifest);
  const { packagePath, warnings, size } = await packVsix(manifest);
  const entries = inspectVsix(packagePath);
  const relativePath = path.relative(root, packagePath);
  console.log(
    `[vsix] packaged: ${relativePath} (${formatBytes(size)}, ${entries.length} files) for v${manifest.version}`,
  );
  console.log(`[vsix] contents: ${entries.join(', ')}`);
  if (warnings.length > 0) {
    throw new Error(`vsce emitted ${warnings.length} warning(s); clean packaging is a release gate`);
  }
  await rm(stageDir, { recursive: true, force: true });
  console.log('[vsix] OK');
}

main().catch((error) => {
  console.error(`[vsix] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
