#!/usr/bin/env node
// `sap-superagent` bin entry. All logic lives in `runCli` (unit-testable).
import { runCli } from './run.js';

const exitCode = await runCli(process.argv);
if (exitCode !== 0) {
  process.exitCode = exitCode;
}
