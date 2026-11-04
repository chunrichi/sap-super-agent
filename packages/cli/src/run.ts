// Process entry helper: owns exit codes and turns thrown errors into one
// actionable stderr line (no stack traces for expected CLI failures).
import { CommanderError } from 'commander';
import { createProgram, type ProgramDeps } from './program.js';
import { CliError, messageOf } from './lib/errors.js';
import { consoleIo } from './lib/io.js';

export async function runCli(argv: string[], deps: ProgramDeps = {}): Promise<number> {
  const io = deps.io ?? consoleIo;
  const program = createProgram({ ...deps, io });
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander already wrote help/usage to the configured output; just exit.
      return error.exitCode;
    }
    if (error instanceof CliError) {
      if (error.message !== '') {
        io.err(`错误：${error.message}`);
      }
      return error.exitCode;
    }
    io.err(`错误：${messageOf(error)}`);
    return 1;
  }
}
