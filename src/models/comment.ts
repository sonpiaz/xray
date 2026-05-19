import { z } from 'zod';
import { XPostSchema } from './post.ts';

const XCommentBase = XPostSchema.extend({
  depth: z.number().int().nonnegative().default(0),
});

export type XComment = z.infer<typeof XCommentBase> & {
  replies: XComment[];
};

// Recursive schema — we accept whatever `replies` parses to (incl. defaults) and trust the runtime
// guard from XPostSchema's parents. The exported type above is the source of truth for consumers.
export const XCommentSchema: z.ZodType<XComment> = XCommentBase.extend({
  replies: z.lazy(() => z.array(XCommentSchema)).default([]),
}) as unknown as z.ZodType<XComment>;
