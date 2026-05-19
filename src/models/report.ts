import { z } from 'zod';
import { XThreadSchema } from './thread.ts';

export const KeyInsightSchema = z.object({
  insight: z.string(),
  evidencePostIds: z.array(z.string()).default([]),
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type KeyInsight = z.infer<typeof KeyInsightSchema>;

export const NotableReplySchema = z.object({
  postId: z.string(),
  reason: z.string(),
  summary: z.string().optional(),
});
export type NotableReply = z.infer<typeof NotableReplySchema>;

export const ResearchReportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: z.string().datetime(),
  source: z.object({
    url: z.string().url(),
    model: z.string(),
    cacheHit: z.boolean().default(false),
  }),
  thread: XThreadSchema,
  topic: z.string().optional(),
  tldr: z.string(),
  summary: z.string(),
  keyInsights: z.array(KeyInsightSchema).default([]),
  notableReplies: z.array(NotableReplySchema).default([]),
  openQuestions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
