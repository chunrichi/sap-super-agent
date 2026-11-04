// @sap-superagent/cli — H0 §1.6: init / dev / token / doctor.
export { CLI_NAME, CLI_VERSION, createProgram, diagnose, printDoctorReport, runDev, runDoctor, runInit, runToken } from './program.js';
export type { ProgramDeps } from './program.js';
export { runCli } from './run.js';

export { runInit as initWorkspace } from './commands/init.js';
export type { InitOptions, InitResult } from './commands/init.js';
export { issueCliToken, runToken as printToken } from './commands/token.js';
export type { IssuedToken, TokenOptions } from './commands/token.js';
export { startDevServer } from './commands/dev.js';
export type { DevHandle, DevOptions } from './commands/dev.js';
export { isPortFree, isStateDirWritable } from './commands/doctor.js';
export type { DoctorCheck, DoctorOptions, DoctorReport } from './commands/doctor.js';

export { BufferIo, consoleIo } from './lib/io.js';
export type { CliIo } from './lib/io.js';
export { CliError, messageOf } from './lib/errors.js';
export { DEFAULT_TTL, formatDurationMs, parseDurationMs } from './lib/duration.js';
export { NODE_REQUIREMENT, parseNodeVersion, satisfiesNodeRequirement } from './lib/node-version.js';
export { BYOK_REQUIRED_VARS, FAKE_PROVIDER, describeAiConfig } from './lib/ai-config.js';
export type { AiConfigSummary } from './lib/ai-config.js';
export {
  DEFAULT_BASE_BRANCH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_STATE_DIR,
  ENV_EXAMPLE_FILE_NAME,
  ENV_FILE_NAME,
  WORKSPACE_DIR_NAME,
  WORKSPACE_FILE_NAME,
  envFilePath,
  findEnvExample,
  findTemplatesDir,
  resolvePort,
  resolveStateDir,
  workspaceDir,
  workspaceFilePath,
} from './lib/paths.js';
export { readWorkspaceConfig, writeWorkspaceConfig } from './lib/workspace-config.js';
export type { WorkspaceConfig, WorkspaceConfigInput, WorkspaceConfigWriteResult } from './lib/workspace-config.js';
