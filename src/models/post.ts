import { z } from 'zod';
import { XExternalLinkSchema } from './link.ts';
import { XMediaSchema } from './media.ts';

export const XAuthorSchema = z.object({
  id: z.string().optional(),
  handle: z.string(),
  displayName: z.string().optional(),
  verified: z.boolean().default(false),
  avatarUrl: z.string().url().optional(),
});
export type XAuthor = z.infer<typeof XAuthorSchema>;

export const XPostMetricsSchema = z.object({
  likes: z.number().int().nonnegative().optional(),
  reposts: z.number().int().nonnegative().optional(),
  replies: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  bookmarks: z.number().int().nonnegative().optional(),
});
export type XPostMetrics = z.infer<typeof XPostMetricsSchema>;

export const XPostSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  author: XAuthorSchema,
  text: z.string(),
  createdAt: z.string().datetime().optional(),
  language: z.string().optional(),
  metrics: XPostMetricsSchema.default({}),
  media: z.array(XMediaSchema).default([]),
  links: z.array(XExternalLinkSchema).default([]),
  isReply: z.boolean().default(false),
  inReplyToPostId: z.string().optional(),
  isQuote: z.boolean().default(false),
  quotedPostId: z.string().optional(),
  raw: z.unknown().optional(),
});
export type XPost = z.infer<typeof XPostSchema>;
