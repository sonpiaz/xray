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
 *
 * P1.2: extended with prefilter telemetry so callers can see how the heuristic
 * engagement pre-filter narrowed the classification batch. Absent when no
 * prefilter ran (e.g. fetched ≤ MAX_REPLIES_IN_PROMPT).
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
  // P1.2 prefilter telemetry — all optional so P1.0/P1.1 outputs remain valid.
  prefilterApplied: z.boolean().optional(),
  candidatePool: z.number().int().nonnegative().optional(),
  classifiedFromPool: z.number().int().nonnegative().optional(),
});
export type ThreadCoverage = z.infer<typeof ThreadCoverageSchema>;

/**
 * P1.1: aggregate stance counts across all classified replies in the thread.
 * Optional on ResearchReport — absent if no classification ran.
 */
export const StanceDistributionSchema = z.object({
  agree: z.number().int().nonnegative().default(0),
  disagree: z.number().int().nonnegative().default(0),
  neutral: z.number().int().nonnegative().default(0),
  question: z.number().int().nonnegative().default(0),
  humor: z.number().int().nonnegative().default(0),
  meta: z.number().int().nonnegative().default(0),
});
export type StanceDistribution = z.infer<typeof StanceDistributionSchema>;

/**
 * P1.3 — Deep mode per-subtree summary. One entry per top-level reply for which
 * a `DEEP_SUBTREE_PROMPT` Kyma call succeeded.
 *
 * The shape intentionally mirrors what an agent needs to decide which subtree to
 * "jump into" — a one-line headline + a handful of bullets + an explicit dissent
 * channel so disagreement isn't buried under the bullets.
 */
export const SubtreeSummarySchema = z.object({
  rootReplyPostId: z.string(),
  rootReplyHandle: z.string(),
  replyCount: z.number().int().nonnegative(),
  headline: z.string(),
  keyPoints: z.array(z.string()).default([]),
  dissent: z.array(z.string()).default([]),
});
export type SubtreeSummary = z.infer<typeof SubtreeSummarySchema>;

/**
 * P1.3 — Cross-subtree synthesis output. Produced by the final synthesis Kyma
 * call in deep mode. Maps the structure of the debate across subtrees.
 *
 * `evidenceSubtreeIds` reference `subtreeSummaries[].rootReplyPostId` so a
 * downstream agent can follow each top-level argument back to the subtree
 * that voiced it.
 */
export const TopArgumentSchema = z.object({
  argument: z.string(),
  voicedBy: z.array(z.string()).default([]),
  evidenceSubtreeIds: z.array(z.string()).default([]),
});
export type TopArgument = z.infer<typeof TopArgumentSchema>;

export const DissentEntrySchema = z.object({
  claim: z.string(),
  againstOp: z.boolean().default(false),
  voicedBy: z.array(z.string()).default([]),
  evidenceSubtreeIds: z.array(z.string()).default([]),
});
export type DissentEntry = z.infer<typeof DissentEntrySchema>;

export const SubThreadPointerSchema = z.object({
  rootReplyPostId: z.string(),
  handle: z.string(),
  reason: z.string(),
});
export type SubThreadPointer = z.infer<typeof SubThreadPointerSchema>;

export const DeepSynthesisSchema = z.object({
  topArguments: z.array(TopArgumentSchema).default([]),
  dissentMap: z.array(DissentEntrySchema).default([]),
  subThreadsWorthReading: z.array(SubThreadPointerSchema).default([]),
});
export type DeepSynthesis = z.infer<typeof DeepSynthesisSchema>;

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
  stanceDistribution: StanceDistributionSchema.optional(),
  // P1.3 — present only when `--deep` / `deep: true` ran. Absent on shallow runs
  // so existing P0/P1.1/P1.2 outputs remain byte-identical.
  subtreeSummaries: z.array(SubtreeSummarySchema).optional(),
  deepSynthesis: DeepSynthesisSchema.optional(),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;
