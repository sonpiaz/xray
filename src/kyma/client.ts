import { request } from 'undici';
import { getCachedKyma, hashPrompt, putCachedKyma } from '../cache/kyma.ts';
import { loadConfig } from '../core/config.ts';
import { KymaError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { parseRetryAfter, withRetry } from '../core/retry.ts';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatOptions = {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  cacheKey?: string;
};

export type ChatResult = {
  content: string;
  model: string;
  cached: boolean;
  usage?: { promptTokens?: number; completionTokens?: number };
};

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const cfg = loadConfig();
  if (!cfg.kyma.key) {
    throw new KymaError('KYMA_API_KEY is not set. See .env.example.');
  }

  const model = opts.model ?? cfg.kyma.model;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const promptHash = hashPrompt(JSON.stringify({ model, body }));
  const cacheKey = opts.cacheKey ?? promptHash;

  const cached = getCachedKyma(cacheKey);
  if (cached) {
    logger.debug('kyma cache hit', { cacheKey, model });
    return { content: cached, model, cached: true };
  }

  const url = `${cfg.kyma.url.replace(/\/$/, '')}/chat/completions`;
  logger.debug('kyma request', { url, model, messageCount: opts.messages.length });

  // P5.1 — retry transient failures (HTTP 429, 5xx, network errors). Sits
  // BELOW the cache check above so cached hits never trigger retries.
  // Retry-After is parsed from the response when the server provides it.
  const text = await withRetry(
    async () => {
      let res: Awaited<ReturnType<typeof request>>;
      try {
        res = await request(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.kyma.key}`,
          },
          body: JSON.stringify(body),
          bodyTimeout: 120_000,
          headersTimeout: 30_000,
        });
      } catch (err) {
        throw new KymaError('Kyma request failed (network).', { transient: true, cause: err });
      }

      const responseText = await res.body.text();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        const retryAfter = res.headers['retry-after'];
        const retryAfterStr = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
        throw new KymaError(`Kyma returned ${res.statusCode}: ${responseText.slice(0, 500)}`, {
          status: res.statusCode,
          transient: res.statusCode >= 500 || res.statusCode === 429,
          retryAfter: retryAfterStr,
        });
      }
      return responseText;
    },
    {
      label: 'kyma',
      retryAfterMs: (err) => {
        if (err instanceof KymaError) return parseRetryAfter(err.retryAfter);
        return undefined;
      },
    },
  );

  let parsed: ChatCompletionResponse;
  try {
    parsed = JSON.parse(text) as ChatCompletionResponse;
  } catch (err) {
    throw new KymaError('Kyma returned invalid JSON.', { cause: err });
  }

  const content = parsed.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new KymaError('Kyma returned empty content.');
  }

  putCachedKyma({ cacheKey, model, promptHash, response: content });

  return {
    content,
    model: parsed.model ?? model,
    cached: false,
    usage: {
      promptTokens: parsed.usage?.prompt_tokens,
      completionTokens: parsed.usage?.completion_tokens,
    },
  };
}
