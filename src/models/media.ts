import { z } from 'zod';

export const XMediaTypeSchema = z.enum(['image', 'video', 'gif']);
export type XMediaType = z.infer<typeof XMediaTypeSchema>;

export const XMediaSchema = z.object({
  type: XMediaTypeSchema,
  url: z.string().url(),
  previewUrl: z.string().url().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  altText: z.string().optional(),
});
export type XMedia = z.infer<typeof XMediaSchema>;
