/** Text output sink; commands never write to the console directly so tests can capture. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: CliIo = {
  out: (line) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line) => {
    process.stderr.write(`${line}\n`);
  },
};

/** In-memory IO used by unit tests and by callers that need the output as data. */
export class BufferIo implements CliIo {
  readonly lines: string[] = [];
  readonly errors: string[] = [];

  out(line: string): void {
    this.lines.push(line);
  }

  err(line: string): void {
    this.errors.push(line);
  }

  get text(): string {
    return this.lines.join('\n');
  }
}
