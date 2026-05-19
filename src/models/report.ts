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

/**
 * P1.0: coverage metadata describing how much of the conversation we walked.
 * Added as an optional field on ResearchReport so Phase 0 outputs remain valid.
 */
export const ThreadCoverageSchema = z.object({
  targetDepth: z.number().int(),
  achievedDepth: z.number().int(),
  targetReplies: z.number().int(),
  fetchedReplies: z.number().int(),
  classifiedReplies: z.number().int().default(0),
  paginationCursors: z.array(z.string()).default([]),
  status: z.enum(['ok', 'partial', 'failed']).default('ok'),
  failureReason: z.string().optional(),
});
export type ThreadCoverage = z.infer<typeof ThreadCoverageSchema>;

export const ResearchReportSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]).default(1),
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
  coverage: ThreadCoverageSchema.optional(),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
