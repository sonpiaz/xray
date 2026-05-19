import { z } from 'zod';

/**
 * P2.0 — Video understanding data model.
 *
 * Walking-skeleton scope: X-native videos only. Subsequent P2.x sub-phases
 * add external platforms (yt-dlp), LRU eviction, CLI / MCP surfaces, and
 * markdown rendering. The schemas here are written to forward-cover the
 * full Phase 2 surface so later sub-phases just fill in optional fields.
 */
export const VideoSourceSchema = z.enum([
  'x-native',
  'youtube',
  'tiktok',
  'vimeo',
  'linkedin',
  'unknown',
]);
export type VideoSource = z.infer<typeof VideoSourceSchema>;

export const TranscriptSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  text: z.string(),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const FrameAnalysisSchema = z.object({
  timestampMs: z.number().int().nonnegative(),
  description: z.string(),
  sceneScore: z.number().min(0).max(1).optional(),
});
export type FrameAnalysis = z.infer<typeof FrameAnalysisSchema>;

export const KeyMomentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  description: z.string(),
  type: z
    .enum(['introduction', 'key-point', 'demonstration', 'transition', 'conclusion', 'highlight'])
    .optional(),
});
export type KeyMoment = z.infer<typeof KeyMomentSchema>;

export const VideoCostBreakdownSchema = z.object({
  transcription: z.number().nonnegative().optional(),
  vision: z.number().nonnegative().optional(),
  synthesis: z.number().nonnegative().optional(),
});
export type VideoCostBreakdown = z.infer<typeof VideoCostBreakdownSchema>;

/**
 * Per spec §6.1 — transcript wrapper. `segments` may be empty when the
 * Kyma provider doesn't return word/segment-level timestamps for the
 * selected model (Whisper-turbo via Groq returns segments; other providers
 * may degrade to plain text). `empty` is true when the audio yielded no
 * recognizable speech (music-only, silence) — frame analysis still runs.
 */
export const TranscriptSchema = z.object({
  text: z.string(),
  segments: z.array(TranscriptSegmentSchema).default([]),
  language: z.string().optional(),
  empty: z.boolean().default(false),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const VideoFramesSchema = z.object({
  count: z.number().int().nonnegative(),
  method: z.enum(['scene-detect', 'evenly-spaced']),
  threshold: z.number().optional(),
  analyses: z.array(FrameAnalysisSchema).default([]),
});
export type VideoFrames = z.infer<typeof VideoFramesSchema>;

export const VideoReportSchema = z.object({
  url: z.string().url(),
  platform: VideoSourceSchema,
  durationMs: z.number().int().nonnegative().optional(),
  durationFormatted: z.string().optional(),

  transcript: TranscriptSchema.optional(),
  frames: VideoFramesSchema.optional(),

  // Synthesis output — absent when --raw, when Kyma key is missing, or when
  // the synthesis call fails (the report still ships with raw transcript +
  // frame descriptions in that case, with `partial: true`).
  keyMoments: z.array(KeyMomentSchema).optional(),
  visualContext: z.array(z.string()).optional(),
  summary: z.string().optional(),
  topic: z.string().optional(),

  // Cost tracking — per Son's explicit decision (Round 2): no hard caps,
  // surface cost. Agents read these and decide whether to expose to user.
  estimatedCostUsd: z.number().nonnegative().optional(),
  costBreakdown: VideoCostBreakdownSchema.optional(),

  partial: z.boolean().default(false),
  errors: z.array(z.string()).default([]),

  generatedAt: z.string().datetime(),
});
export type VideoReport = z.infer<typeof VideoReportSchema>;
