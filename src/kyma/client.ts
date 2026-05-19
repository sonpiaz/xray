import { request } from 'undici';
import { getCachedKyma, hashPrompt, putCachedKyma } from '../cache/kyma.ts';
import { loadConfig } from '../core/config.ts';
import { KymaError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';

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

  const text = await res.body.text();

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new KymaError(`Kyma returned ${res.statusCode}: ${text.slice(0, 500)}`, {
      status: res.statusCode,
      transient: res.statusCode >= 500 || res.statusCode === 429,
    });
  }

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
