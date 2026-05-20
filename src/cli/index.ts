import { cac } from 'cac';
import { XRayError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { articleCommand } from './commands/article.ts';
import { authCommand } from './commands/auth.ts';
import { cacheClearCommand, cacheEmbedCommand, cacheInfoCommand } from './commands/cache.ts';
import { mcpCommand } from './commands/mcp.ts';
import { profileCommand } from './commands/profile.ts';
import { searchCommand } from './commands/search.ts';
import { threadCommand } from './commands/thread.ts';
import { videoCommand } from './commands/video.ts';
import { warmupCommand } from './commands/warmup.ts';

export const VERSION = '1.0.1';

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
    .option(
      '--video',
      'Run video analysis on any X-native videos in the thread (~$0.05-0.50 per video)',
    )
    .option(
      '--articles',
      'Run article analysis (X Articles + external links + cross-reference) on linked content. Opt-in, ~$0.04-0.30 per article, cap 5 per thread.',
    )
    .action(async (url: string, opts: Parameters<typeof threadCommand>[1]) => {
      await threadCommand(url, opts);
    });

  cli
    .command('video <url>', 'Analyze a video URL (X-native, YouTube, TikTok, Vimeo, LinkedIn)')
    .option('--json', 'Output JSON instead of Markdown')
    .option('-o, --output <path>', 'Write output to a file')
    .option('--no-cache', 'Skip the local cache for download/transcribe/vision')
    .option('--raw', 'Skip LLM synthesis; emit transcript + frame descriptions only')
    .option('--model <name>', 'Override Kyma synthesis model')
    .option('--frames <n>', 'Fix the frame count (1-24, default: scene-detect with 4-12 clamp)')
    .action(async (url: string, opts: Parameters<typeof videoCommand>[1]) => {
      await videoCommand(url, opts);
    });

  cli
    .command(
      'article <url>',
      'Analyze an article URL (X Article, Substack, Medium, dev.to, any HTML)',
    )
    .option('--json', 'Output JSON instead of Markdown')
    .option('-o, --output <path>', 'Write output to a file')
    .option('--no-cache', 'Skip the local cache for body + summary')
    .option('--raw', 'Skip LLM summarization; emit extracted body only')
    .option('--model <name>', 'Override Kyma summarization model')
    .action(async (url: string, opts: Parameters<typeof articleCommand>[1]) => {
      await articleCommand(url, opts);
    });

  cli
    .command('search <query>', 'Semantic search across cached XRay content (uses local embeddings)')
    .option('--json', 'Output JSON instead of Markdown')
    .option('-o, --output <path>', 'Write output to a file')
    .option('--limit <n>', 'Max results (default 10)', { default: 10 })
    .option('--threshold <n>', 'Minimum cosine similarity 0-1 (default: no filter)')
    .option('--type <t>', 'Filter by entity type: comment | post | thread | article-passage')
    .option('--rerank', 'LLM rerank top candidates (~$0.005 extra)')
    .option('--model <name>', 'Override Kyma rerank model')
    .action(async (query: string, opts: Parameters<typeof searchCommand>[1]) => {
      await searchCommand(query, opts);
    });

  cli
    .command('profile <handle>', 'Build a profile from cached threads for an X handle')
    .option('--json', 'Output JSON instead of Markdown')
    .option('-o, --output <path>', 'Write output to a file')
    .option('--no-cache', 'Skip profile_cache; force re-synthesis')
    .option(
      '--fresh <n>',
      'Fetch N recent tweets first (P5+, currently logs warning and falls back to cache)',
    )
    .option('--model <name>', 'Override Kyma synthesis model')
    .action(async (handle: string, opts: Parameters<typeof profileCommand>[1]) => {
      await profileCommand(handle, opts);
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
    .command('cache [action]', 'Cache controls (action: info | clear | embed)')
    .option(
      '--no-resume',
      'For `embed`: force a full re-embed even when content_hash is unchanged.',
    )
    .option(
      '--profiles',
      'For `clear`: clear only profile_cache (preserves posts/threads/embeddings)',
    )
    .action(async (action: string | undefined, opts: { resume?: boolean; profiles?: boolean }) => {
      const a = (action ?? 'info').toLowerCase();
      if (a === 'clear') return cacheClearCommand({ profilesOnly: opts.profiles });
      if (a === 'info') return cacheInfoCommand();
      // cac parses --no-resume into { resume: false }; pass through.
      if (a === 'embed') return cacheEmbedCommand({ resume: opts.resume });
      throw new Error(`Unknown cache action: ${a}. Use info, clear, or embed.`);
    });

  cli.command('mcp', 'Start the XRay MCP server (stdio transport)').action(async () => {
    await mcpCommand();
  });

  cli
    .command(
      'warmup',
      'Preheat: download embedding model + launch Playwright + open cache. Eliminates first-run cold-start surprise.',
    )
    .option('--json', 'Output JSON instead of human-readable')
    .action(async (opts: Parameters<typeof warmupCommand>[0]) => {
      await warmupCommand(opts);
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
