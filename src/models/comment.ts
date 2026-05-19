import { z } from 'zod';
import { XPostSchema } from './post.ts';

/**
 * P1.1 classification taxonomy.
 *
 * Stance: the commenter's relation to the ROOT post's claim
 * (a reply that disagrees with another reply but agrees with OP = "agree").
 */
export const StanceEnum = z.enum(['agree', 'disagree', 'neutral', 'question', 'humor', 'meta']);
export type Stance = z.infer<typeof StanceEnum>;

/**
 * Quality: the informational value of the reply.
 * `qualityScore` is a continuous 0.0–1.0 signal; the categorical label is a discretization.
 */
export const QualityEnum = z.enum(['substantive', 'anecdotal', 'noise', 'expert', 'correction']);
export type Quality = z.infer<typeof QualityEnum>;

export const CommentClassificationSchema = z.object({
  stance: StanceEnum,
  quality: QualityEnum,
  qualityScore: z.number().min(0).max(1),
});
export type CommentClassification = z.infer<typeof CommentClassificationSchema>;

const XCommentBase = XPostSchema.extend({
  depth: z.number().int().nonnegative().default(0),
  classification: CommentClassificationSchema.optional(),
});

export type XComment = z.infer<typeof XCommentBase> & {
  replies: XComment[];
};

// Recursive schema — we accept whatever `replies` parses to (incl. defaults) and trust the runtime
// guard from XPostSchema's parents. The exported type above is the source of truth for consumers.
export const XCommentSchema: z.ZodType<XComment> = XCommentBase.extend({
  replies: z.lazy(() => z.array(XCommentSchema)).default([]),
}) as unknown as z.ZodType<XComment>;
