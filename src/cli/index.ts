import { cac } from 'cac';
import { XRayError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { authCommand } from './commands/auth.ts';
import { cacheClearCommand, cacheInfoCommand } from './commands/cache.ts';
import { mcpCommand } from './commands/mcp.ts';
import { threadCommand } from './commands/thread.ts';

const VERSION = '0.2.1';

export async function runCli(argv: string[]): Promise<number> {
  const cli = cac('xray');

  cli
    .command('thread <url>', 'Research an X thread')
    .option('--json', 'Output JSON instead of Markdown')
    .option('-o, --output <path>', 'Write output to a file')
    .option('--no-cache', 'Skip the local cache for the fetch')
    .option('--raw', 'Skip LLM analysis; emit thread structure only')
    .option(
      '--mode <mode>',
      'Fetch mode: auto | ssr | cookie | auth (default: auto = cookie→SSR→saved auth escalation)',
      { default: 'auto' },
    )
    .option('--depth <n>', 'Max reply nesting depth to walk (default 3)')
    .option('--max-replies <n>', 'Max top-level replies to fetch (default 50)')
    .option('--deep', 'Run deep analysis: per-subtree Kyma calls + synthesis (~10x cost)')
    .action(async (url: string, opts: Parameters<typeof threadCommand>[1]) => {
      await threadCommand(url, opts);
    });

  cli
    .command('auth', 'Log in to X interactively, or inspect available auth sources')
    .option(
      '--status',
      'Print detected cookie sources + storageState presence; never prompts Keychain',
    )
    .action(async (opts: { status?: boolean }) => {
      const code = await authCommand({ status: opts.status });
      if (code !== 0) process.exit(code);
    });

  cli
    .command('cache [action]', 'Cache controls (action: info | clear)')
    .action((action: string | undefined) => {
      const a = (action ?? 'info').toLowerCase();
      if (a === 'clear') return cacheClearCommand();
      if (a === 'info') return cacheInfoCommand();
      throw new Error(`Unknown cache action: ${a}. Use info or clear.`);
    });

  cli.command('mcp', 'Start the XRay MCP server (stdio transport)').action(async () => {
    await mcpCommand();
  });

  cli.help();
  cli.version(VERSION);

  try {
    cli.parse(argv, { run: false });
    if (!cli.matchedCommand) {
      cli.outputHelp();
      return 0;
    }
    await cli.runMatchedCommand();
    return 0;
  } catch (err) {
    if (err instanceof XRayError) {
      logger.error(`${err.code}: ${err.message}`);
    } else if (err instanceof Error) {
      logger.error(err.message);
      if (process.env.XRAY_LOG_LEVEL === 'debug' && err.stack) {
        process.stderr.write(`${err.stack}\n`);
      }
    } else {
      logger.error(String(err));
    }
    return 1;
  }
}
