import { z } from 'zod';
import { ParseError } from '../core/errors.ts';
import type { XThread } from '../models/thread.ts';
import { chat } from './client.ts';
import { REPORT_JSON_INSTRUCTION, renderThreadForPrompt, systemPrompt } from './prompts.ts';

const AnalysisSchema = z.object({
  topic: z.string().optional(),
  tldr: z.string(),
  summary: z.string(),
  keyInsights: z
    .array(
      z.object({
        insight: z.string(),
        evidencePostIds: z.array(z.string()).default([]),
        confidence: z.enum(['low', 'medium', 'high']).default('medium'),
      }),
    )
    .default([]),
  notableReplies: z
    .array(
      z.object({
        postId: z.string(),
        reason: z.string(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  openQuestions: z.array(z.string()).default([]),
});

export type ThreadAnalysis = z.infer<typeof AnalysisSchema> & {
  model: string;
  cached: boolean;
};

function stripJsonFence(s: string): string {
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence?.[1]) return fence[1].trim();
  return s.trim();
}

export async function analyzeThread(thread: XThread): Promise<ThreadAnalysis> {
  const rendered = renderThreadForPrompt(thread);
  const userMsg = `${rendered}\n\n---\n\n${REPORT_JSON_INSTRUCTION}`;

  const result = await chat({
    messages: [
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: userMsg },
    ],
    jsonMode: true,
    temperature: 0.3,
    cacheKey: `analyze:${thread.rootPost.id}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(result.content));
  } catch (err) {
    throw new ParseError(`Kyma returned non-JSON: ${result.content.slice(0, 200)}`, err);
  }

  const analysis = AnalysisSchema.safeParse(parsed);
  if (!analysis.success) {
    throw new ParseError(`Kyma analysis failed schema: ${analysis.error.message}`);
  }

  return { ...analysis.data, model: result.model, cached: result.cached };
}
