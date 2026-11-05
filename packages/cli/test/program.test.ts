import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_NAME, CLI_VERSION, createProgram } from '../src/program.js';
import { runCli } from '../src/run.js';
import { BufferIo } from '../src/lib/io.js';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sa-cli-program-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function buildProgram(): ReturnType<typeof createProgram> {
  return createProgram({ io: new BufferIo(), cwd: () => '/tmp/sa-test', env: {} });
}

function commandNamed(program: ReturnType<typeof createProgram>, name: string) {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (command === undefined) {
    throw new Error(`missing command: ${name}`);
  }
  return command;
}

describe('createProgram', () => {
  it('exposes the four H0 commands', () => {
    const program = buildProgram();
    expect(program.name()).toBe(CLI_NAME);
    expect(program.version()).toBe(CLI_VERSION);
    expect(program.commands.map((command) => command.name())).toEqual([
      'init',
      'dev',
      'token',
      'doctor',
    ]);
  });

  it('parses init options without executing the action', () => {
    const init = commandNamed(buildProgram(), 'init');
    init.parseOptions([
      '--repo',
      'z-sales',
      '--project-key',
      'SALES',
      '--base-branch',
      'develop',
      '--prepare',
      'pnpm install',
      '--force',
    ]);
    expect(init.opts()).toMatchObject({
      repo: 'z-sales',
      projectKey: 'SALES',
      baseBranch: 'develop',
      prepare: 'pnpm install',
      force: true,
    });
  });

  it('has the documented defaults for dev/token', () => {
    const dev = commandNamed(buildProgram(), 'dev');
    dev.parseOptions(['--port', '3099', '--state-dir', '/tmp/state', '--host', '0.0.0.0']);
    expect(dev.opts()).toEqual({ port: '3099', stateDir: '/tmp/state', host: '0.0.0.0' });

    const token = commandNamed(buildProgram(), 'token');
    token.parseOptions([]);
    expect(token.opts()).toMatchObject({ kind: 'user', user: 'dev', ttl: '24h' });
  });

  it('exposes doctor --json and a port override', () => {
    const doctor = commandNamed(buildProgram(), 'doctor');
    doctor.parseOptions(['--json', '--port', '3099']);
    expect(doctor.opts()).toMatchObject({ json: true, port: '3099' });
  });
});

describe('runCli', () => {
  it('prints help and exits 0 for --help', async () => {
    const io = new BufferIo();
    const exitCode = await runCli(['node', CLI_NAME, '--help'], { io });
    expect(exitCode).toBe(0);
    for (const command of ['init', 'dev', 'token', 'doctor']) {
      expect(io.text).toContain(command);
    }
  });

  it('returns 1 for an unknown command and writes an error', async () => {
    const io = new BufferIo();
    const exitCode = await runCli(['node', CLI_NAME, 'nope'], { io });
    expect(exitCode).toBe(1);
    expect(io.errors.length).toBeGreaterThan(0);
  });

  it('runs init end-to-end with injected cwd/env', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();
    const exitCode = await runCli(['node', CLI_NAME, 'init', '--repo', 'z-sales'], {
      io,
      cwd: () => cwd,
      env: {},
    });

    expect(exitCode).toBe(0);
    const filePath = path.join(cwd, '.sap-superagent', 'workspace.json');
    expect(existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    expect(parsed).toEqual({ repo: 'z-sales', baseBranch: 'main' });
    expect(io.text).toContain('已写入');
  });

  it('runs token end-to-end against a temp state dir', async () => {
    const cwd = await makeTempDir();
    const io = new BufferIo();
    const exitCode = await runCli(['node', CLI_NAME, 'token', '--kind', 'admin'], {
      io,
      cwd: () => cwd,
      env: {},
    });

    expect(exitCode).toBe(0);
    expect(io.text).toContain('kind=admin');
    expect(existsSync(path.join(cwd, '.sap-superagent', 'state', 'auth.secret'))).toBe(true);
  });

  it('maps CliError to a one-line message and exit code', async () => {
    const cwd = await makeTempDir();
    await runCli(['node', CLI_NAME, 'init'], { io: new BufferIo(), cwd: () => cwd, env: {} });
    const io = new BufferIo();

    const exitCode = await runCli(['node', CLI_NAME, 'init'], { io, cwd: () => cwd, env: {} });

    expect(exitCode).toBe(1);
    expect(io.errors[0]).toContain('--force');
  });
});
