import type { Command } from 'commander';
import { serveStdio } from '@testlease/mcp';
import type { CliContext } from '../context.js';
import { EXIT, reportError } from '../output.js';

export function registerMcpCommand(program: Command, getCtx: () => CliContext): void {
  program
    .command('mcp')
    .description(
      'Serve the Model Context Protocol over stdio, bridging to the TestLease server at --url. Never exposes secret values.',
    )
    .option('--allow-quarantine', 'expose the testlease_quarantine tool to the agent')
    .option('--max-wait <seconds>', 'maximum waitSeconds an agent may request', '120')
    .action(async (opts: { allowQuarantine?: boolean; maxWait: string }) => {
      const ctx = getCtx();
      const client = ctx.client();
      try {
        await client.health();
      } catch (err) {
        process.exitCode = reportError(ctx.out, err, [
          'The MCP bridge needs a running TestLease server. Start one with: testlease serve',
        ]);
        return;
      }
      const owner =
        ctx.env.TESTLEASE_OWNER ?? `mcp:${ctx.owner.replace(/^cli:/, '')}:${process.pid}`;
      const handle = await serveStdio({
        api: client,
        owner,
        allowQuarantine: opts.allowQuarantine ?? false,
        maxWaitSeconds: Math.max(0, Number(opts.maxWait) || 120),
      });
      ctx.out.err(
        ctx.out.paint('dim', `testlease mcp: serving stdio for ${ctx.url} as owner ${owner}`),
      );
      const stop = () => void handle.close();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      await handle.closed;
      process.exitCode = EXIT.OK;
    });
}
