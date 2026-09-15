import { Command, CommanderError } from 'commander';
import { createContext, type CliContext, type GlobalOptions } from './context.js';
import { EXIT, reportError } from './output.js';
import { registerReadCommands } from './commands/read.js';
import { registerWriteCommands } from './commands/write.js';
import { registerExecCommand } from './commands/exec.js';
import { CLI_VERSION, registerServeCommand } from './commands/serve.js';
import { runDoctor } from './doctor.js';

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

export function buildProgram(io: CliIo): { program: Command; getCtx: () => CliContext } {
  const program = new Command();
  let ctx: CliContext | undefined;
  const getCtx = () => {
    ctx ??= createContext(program.opts<GlobalOptions>(), io);
    return ctx;
  };

  program
    .name('testlease')
    .description(
      'Exclusive, expiring leases for shared test resources.\n\nShared test resources are infrastructure. Treat them like infrastructure.',
    )
    .version(CLI_VERSION)
    .option('-u, --url <url>', 'server URL (default: $TESTLEASE_URL or http://127.0.0.1:4747)')
    .option('--token <token>', 'API token (default: $TESTLEASE_TOKEN)')
    .option(
      '-o, --owner <owner>',
      'logical owner for lease operations (default: $TESTLEASE_OWNER or cli:<user>@<host>)',
    )
    .option('--json', 'machine-readable JSON output')
    .option('--no-color', 'disable colors')
    .configureOutput({
      writeOut: (s) => io.stdout.write(s),
      writeErr: (s) => io.stderr.write(s),
    })
    .exitOverride()
    .showHelpAfterError('(run with --help for usage)');

  registerReadCommands(program, getCtx);
  registerWriteCommands(program, getCtx);
  registerExecCommand(program, getCtx);
  registerServeCommand(program, getCtx);

  program
    .command('doctor')
    .description('Check configuration, secrets, connectivity and authentication')
    .option('-c, --config <path>', 'configuration file to check')
    .option('--no-server', 'skip server connectivity checks')
    .action(async (opts: { config?: string; server: boolean }) => {
      process.exitCode = await runDoctor(getCtx(), {
        config: opts.config,
        skipServer: !opts.server,
      });
    });

  return { program, getCtx };
}

/** Entry point used by the bin shim and by tests. Returns the process exit code. */
export async function main(
  argv: string[],
  io: CliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  },
): Promise<number> {
  const { program, getCtx } = buildProgram(io);
  process.exitCode = EXIT.OK;
  try {
    await program.parseAsync(argv, { from: 'user' });
    return typeof process.exitCode === 'number' ? process.exitCode : EXIT.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      if (
        err.code === 'commander.helpDisplayed' ||
        err.code === 'commander.version' ||
        err.code === 'commander.help'
      )
        return EXIT.OK;
      return EXIT.USAGE;
    }
    return reportError(getCtx().out, err);
  }
}
