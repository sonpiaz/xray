import { z } from 'zod';

export const XExternalLinkSchema = z.object({
  url: z.string().url(),
  expandedUrl: z.string().url().optional(),
  domain: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
});
export type XExternalLink = z.infer<typeof XExternalLinkSchema>;
