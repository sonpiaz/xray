import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// Parse env-style booleans: "true"/"1" → true, "false"/"0"/"" → false.
// `z.coerce.boolean()` treats any non-empty string as truthy, so "false" becomes true — avoid it.
function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return fallback;
}

const ConfigSchema = z.object({
  kyma: z.object({
    url: z.string().url().default('https://kymaapi.com/v1'),
    key: z.string().optional(),
    model: z.string().default('gemini-2.5-flash'),
  }),
  cache: z.object({
    dir: z.string(),
    ttlSeconds: z.coerce.number().int().nonnegative().default(86400),
  }),
  fetcher: z.object({
    mode: z.enum(['auto', 'ssr', 'cookie', 'auth']).default('auto'),
    timeoutMs: z.coerce.number().int().positive().default(30_000),
    headless: z.boolean().default(true),
    storageStatePath: z.string(),
  }),
  log: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  }),
});

export type XRayConfig = z.infer<typeof ConfigSchema>;

let cached: XRayConfig | undefined;

export function loadConfig(): XRayConfig {
  if (cached) return cached;

  const xrayHome = process.env.XRAY_HOME?.trim() || join(homedir(), '.xray');
  const cacheDir = join(xrayHome, 'cache');
  const storageStatePath = join(xrayHome, 'storageState.json');

  cached = ConfigSchema.parse({
    kyma: {
      url: process.env.KYMA_API_URL,
      key: process.env.KYMA_API_KEY,
      model: process.env.XRAY_MODEL,
    },
    cache: {
      dir: cacheDir,
      ttlSeconds: process.env.XRAY_CACHE_TTL,
    },
    fetcher: {
      mode: process.env.XRAY_FETCH_MODE,
      timeoutMs: process.env.XRAY_FETCH_TIMEOUT_MS,
      headless: envBool(process.env.XRAY_HEADLESS, true),
      storageStatePath,
    },
    log: {
      level: process.env.XRAY_LOG_LEVEL,
    },
  });

  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
