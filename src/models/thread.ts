import { z } from 'zod';
import { XCommentSchema } from './comment.ts';
import { XPostSchema } from './post.ts';

export const XThreadSchema = z.object({
  rootPost: XPostSchema,
  authorPosts: z.array(XPostSchema).default([]),
  quoteTweets: z.array(XPostSchema).default([]),
  comments: z.array(XCommentSchema).default([]),
  fetchedAt: z.string().datetime(),
  partial: z.boolean().default(false),
  partialReason: z.string().optional(),
});
export type XThread = z.infer<typeof XThreadSchema>;
