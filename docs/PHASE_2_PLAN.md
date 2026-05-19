# Phase 2 — Video Understanding

**Status:** Draft
**Date:** 2026-05-19
**Owner:** sonpiaz
**Version target:** v0.3.0
**Depends on:** v0.2.0 (Phase 0 + Phase 1 + Phase 1.5 complete), Kyma multimodal + audio API endpoints, yt-dlp (external), ffmpeg (external)

---

## 0. The Principle

> Video understanding is a parallel-but-separate intelligence pipeline. It ships alongside thread research but never runs without explicit intent.

**The rule:** Video analysis is always opt-in. `xray thread <url>` default behavior remains unchanged — text research only. Video processing triggers only when:
1. The user passes `--video` on `xray thread`, or
2. The user invokes the standalone `xray video <url>` command, or
3. An MCP caller passes `video: true` to `xray_thread` or calls the new `xray_video` tool.

This ensures no surprise cost. A single long video can cost more than an entire thread analysis. The opt-in design is a deliberate counterpart to P1.5's invisible-auth principle: auth should be invisible, but cost-bearing operations must be visible.

---

## 1. Goals

1. Enable deep understanding of video content in X posts — extract transcript, key frames, visual context, and synthesize them into structured insight.
2. Support all major video sources embedded in X threads: X-native video, YouTube, TikTok, Vimeo, LinkedIn.
3. Provide a standalone `xray video <url>` command that returns a lean `VideoReport` without requiring a full thread analysis.
4. Surface video analysis as a nested section within `ResearchReport` when `--video` is used on `xray thread`.
5. Cache transcripts and vision analysis separately so repeat queries on the same video skip expensive re-processing.

## 2. Non-Goals (deferred)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| X Spaces audio analysis | Indefinite | Different pipeline (live/recorded audio-only, no frames). Requires separate streaming approach. |
| Live stream support | Indefinite | Requires real-time frame capture, fundamentally different architecture. |
| OCR / text-in-video extraction | Phase 5+ | Useful but separate from scene understanding. Needs specialized OCR models. |
| Multi-language transcript routing | Phase 5+ | Current Kyma audio API handles language detection automatically. Manual routing adds complexity for marginal gain. |
| Video-to-video comparison | Phase 5+ | Interesting for fact-checking but requires a higher-level orchestration layer. |
| Embedded video in quote tweets | Phase 3+ | Focus Phase 2 on root post and direct reply videos only. |

---

## 3. User-Facing Changes

### 3.1 CLI Surface

| Flag / Command | Type | Default | Behavior (P2) | Change from P1.5 |
|---|---|---|---|---|
| `xray thread <url>` (no flags) | - | Text-only research (unchanged) | No video processing. Same as v0.2.0. | **Unchanged** |
| `xray thread <url> --video` | boolean | `false` | Detect video(s) in root post, download, run full video pipeline, embed `VideoReport` in `ResearchReport`. | **NEW** |
| `xray video <url>` | command | - | Standalone video analysis. Accepts any URL: X post with video, YouTube, TikTok, Vimeo, LinkedIn video. Returns a lean `VideoReport`. | **NEW command** |
| `--json` | boolean | `false` | JSON output (applies to both `thread` and `video`). | Unchanged |
| `-o, --output <path>` | string | - | Write output to file. | Unchanged |
| `--no-cache` | boolean | `false` | Skip video cache (re-download, re-transcribe, re-analyze). | Unchanged |
| `--raw` | boolean | `false` | Skip LLM synthesis; return transcript + frame descriptions only. | Unchanged |

### 3.2 MCP Surface

| Tool | Args | Type | Default | Description |
|---|---|---|---|---|
| `xray_thread` | `video` | `z.boolean().optional()` | `false` | **NEW arg.** When true, detect and analyze video in the thread. |
| `xray_video` | `url` | `z.string().url()` | required | **NEW tool.** Standalone video analysis. |
| `xray_video` | `noCache` | `z.boolean().optional()` | `false` | Skip video cache. |
| `xray_video` | `raw` | `z.boolean().optional()` | `false` | Skip LLM synthesis. |
| `xray_video` | `format` | `z.enum(['markdown','json','both'])` | `'markdown'` | Output format. |

### 3.3 Markdown Output Changes

When `--video` is used on `xray thread` and video is found, a new section appears in the report:

```markdown
## Video Analysis

**Source:** X-native · 2m34s · 8 frames extracted (scene-detect)
**Estimated cost:** $0.12

### Transcript
> Full transcript text here, preserving paragraph breaks...

### Key Moments
1. **0:00-0:15** — Introduction: speaker introduces the topic of...
2. **0:42-1:10** — Core argument: demonstrates that...
3. **1:55-2:10** — Counter-example: shows an edge case where...

### Visual Context
- Frame analysis reveals code editor (VS Code) with TypeScript...
- Speaker uses hand gestures to emphasize scale...
- Screen transitions from slides to live demo at 1:10...

### Video Summary
One-paragraph synthesis of transcript + visual context...
```

For standalone `xray video <url>`:

```markdown
# Video Analysis — @handle

**URL:** https://x.com/user/status/123
**Platform:** X-native · Duration: 2m34s
**Frames:** 8 extracted (scene-detect, threshold 0.3)
**Estimated cost:** $0.12

## Transcript
...

## Key Moments
...

## Visual Context
...

## Summary
...
```

---

## 4. Pipeline Architecture

```
                    xray video <url>  /  xray thread <url> --video
                              |
                              v
                   +-----------------------+
                   |   URL Detection &     |
                   |   Platform Routing    |
                   |   (X-native? YT?     |
                   |    TikTok? etc.)      |
                   +-----------+-----------+
                               |
              +----------------+----------------+
              |                                 |
    X-native video URL               External video URL
    (mp4 from parser/SSR)            (YouTube/TikTok/etc.)
              |                                 |
              v                                 v
    +-------------------+             +-------------------+
    |  Direct Download  |             |  yt-dlp Download  |
    |  (undici fetch)   |             |  (subprocess)     |
    +--------+----------+             +--------+----------+
             |                                 |
             +----------------+----------------+
                              |
                              v
                   +----------+-----------+
                   |   Local .mp4 file    |
                   |   ~/.xray/cache/     |
                   |   video/{hash}.mp4   |
                   +----------+-----------+
                              |
              +---------------+---------------+
              |                               |
              v                               v
    +-------------------+           +-------------------+
    |  Audio Extract    |           |  Frame Extract    |
    |  (ffmpeg → .mp3)  |           |  (ffmpeg scene-   |
    |                   |           |   detect hybrid)  |
    +--------+----------+           +--------+----------+
             |                               |
             v                               v
    +-------------------+           +-------------------+
    |  Transcribe       |           |  Vision Analysis  |
    |  (Kyma /v1/audio/ |           |  (Kyma multimodal |
    |   transcriptions) |           |   batch vision)   |
    +--------+----------+           +--------+----------+
             |                               |
             +---------------+---------------+
                             |
                             v
                  +----------+-----------+
                  |  Synthesis           |
                  |  (Kyma chat:         |
                  |   transcript +       |
                  |   frame descriptions |
                  |   → VideoReport)     |
                  +----------+-----------+
                             |
                             v
                  +----------+-----------+
                  |  VideoReport         |
                  |  (Zod-validated)     |
                  +----------------------+
```

---

## 5. Per-Stage Specification

### 5.1 URL Detection & Platform Routing

**File:** `src/video/download.ts`

**Trigger:** `xray video <url>` or `xray thread <url> --video` when root post contains media of type `'video'`.

**Logic:**
1. If the URL is an X post URL (`x.com/*/status/*`): check the fetched `XThread.rootPost.media[]` for entries with `type === 'video'`. The `url` field on `XMedia` already contains the direct CDN mp4 URL (parsed from GraphQL `video_info.variants` in `parser.ts`).
2. If the URL is a direct video URL (YouTube, TikTok, Vimeo, LinkedIn): route to yt-dlp.
3. If the URL is an X post URL but fetched via SSR (no media URLs available): attempt yt-dlp on the X post URL as fallback (yt-dlp supports X/Twitter natively).

**Platform detection:**

| Platform | URL pattern | Download method |
|---|---|---|
| X-native | `x.com/*/status/*` with `media[].type === 'video'` | Direct `undici` fetch of CDN mp4 URL |
| X-native (SSR fallback) | `x.com/*/status/*` without media URLs | yt-dlp |
| YouTube | `youtube.com/watch?v=*`, `youtu.be/*` | yt-dlp |
| TikTok | `tiktok.com/@*/video/*`, `vm.tiktok.com/*` | yt-dlp |
| Vimeo | `vimeo.com/*` | yt-dlp |
| LinkedIn | `linkedin.com/posts/*`, `linkedin.com/feed/*` | yt-dlp |

**Inputs:** URL string
**Outputs:** `{ platform: VideoSource, localPath: string, durationMs?: number }`
**Dependencies:** undici (X-native), yt-dlp binary (external)
**Cost:** Free (download only)
**Failure modes:**
- yt-dlp not installed → throw `DependencyError` with install instructions
- Download timeout (120s) → throw `FetchError`
- Region-locked / login-walled video → throw `FetchError` with platform-specific guidance
- Rate-limited by platform → throw `FetchError` with retry guidance

### 5.2 Audio Extraction

**File:** `src/video/audio.ts`

**Trigger:** After successful download. Always runs — transcript is the cheapest and most valuable signal.

**What it does:**
1. Extract audio track from mp4 using ffmpeg:
   ```
   ffmpeg -i input.mp4 -vn -acodec libmp3lame -ar 16000 -ac 1 -q:a 6 output.mp3
   ```
2. Downsample to 16kHz mono mp3 to minimize upload size (Kyma audio API has a 25MB cap per request).
3. If the resulting mp3 exceeds 25MB (roughly ~50 minutes of audio at 16kHz mono), split into segments and transcribe each. This is unlikely for X-native videos (max 2:20 for most users, 10 min for Premium) but possible for YouTube.

**Inputs:** `localPath: string` (mp4)
**Outputs:** `{ audioPath: string, durationMs: number, sizeBytes: number }`
**Dependencies:** ffmpeg binary (external)
**Cost:** Free (local processing)
**Failure modes:**
- ffmpeg not installed → throw `DependencyError` with install instructions
- No audio track in video (silent video) → return `{ audioPath: null, durationMs, sizeBytes: 0 }` with a flag
- Corrupt video file → throw `ProcessingError`

### 5.3 Transcription

**File:** `src/video/transcribe.ts`

**Trigger:** After audio extraction succeeds and audio is non-empty.

**What it does:**
1. POST the mp3 file to Kyma `/v1/audio/transcriptions` endpoint.
2. Request `response_format: 'verbose_json'` to get word-level timestamps.
3. Parse the response into a structured transcript with timestamp segments.

**API contract (Kyma audio endpoint — OpenAI-compatible):**
```
POST /v1/audio/transcriptions
Content-Type: multipart/form-data

file: <audio.mp3>
model: whisper-large-v3-turbo
response_format: verbose_json
```

**Inputs:** `audioPath: string`
**Outputs:** `{ text: string, segments: TranscriptSegment[], language: string, durationSec: number }`
**Dependencies:** Kyma API key, Kyma `/v1/audio/transcriptions` endpoint
**Cost:** ~$0.006/minute (Groq whisper pricing via Kyma). A 10-minute video costs ~$0.06.
**Failure modes:**
- Kyma API key not set → throw `KymaError` (same as thread analysis)
- Audio too large (>25MB after downsample) → split and transcribe segments sequentially
- Transcription returns empty text (music-only, ambient noise) → set `transcript.empty = true`, continue with frames-only analysis
- API rate limit → retry with exponential backoff (max 3 retries)
- Network timeout → throw `KymaError` with `transient: true`

### 5.4 Frame Extraction (Hybrid Scene-Detect)

**File:** `src/video/frames.ts`

**Trigger:** After download succeeds. Runs in parallel with audio extraction.

**Algorithm — scene-detect with clamp (pseudocode):**

```
function extractFrames(videoPath, opts = {}):
  threshold = opts.threshold ?? 0.3
  minFrames = opts.minFrames ?? 4
  maxFrames = opts.maxFrames ?? 12

  // Step 1: Run ffmpeg scene-detect filter
  sceneFrames = ffmpeg(
    -i videoPath
    -vf "select='gt(scene,{threshold})',showinfo"
    -vsync vfr
    -frame_pts 1
    outputDir/scene_%04d.jpg
  )

  // Step 2: Clamp results
  if sceneFrames.length === 0:
    // Fallback: scene-detect found nothing (static video, slideshow)
    // Use N-evenly-spaced as fallback
    return extractEvenlySpaced(videoPath, minFrames)

  if sceneFrames.length < minFrames:
    // Pad with evenly-spaced frames from gaps between scene frames
    // to reach minFrames. Avoids redundancy with existing scene frames.
    additional = fillGaps(videoPath, sceneFrames, minFrames - sceneFrames.length)
    return [...sceneFrames, ...additional].sort(byTimestamp)

  if sceneFrames.length > maxFrames:
    // Too many scene changes (e.g., rapid montage).
    // Keep the maxFrames most visually distinct by selecting frames
    // with the highest scene scores.
    return sceneFrames
      .sort(bySceneScoreDesc)
      .slice(0, maxFrames)
      .sort(byTimestamp)

  return sceneFrames
```

**Scene-detect threshold: 0.3** — chosen per Son's Round 2 decision. This value means a frame is considered a "scene change" when more than 30% of the pixels change significantly. Lower values (0.1-0.2) would capture subtle transitions (pan, zoom) and yield too many frames; higher values (0.5+) would miss dialogue cuts. 0.3 is a reasonable middle ground for X-native video (short, high-cut-rate content). May need tuning for longer-form YouTube content (lower threshold) vs TikTok (higher threshold, since every frame is a jump cut).

**Inputs:** `videoPath: string, opts?: { threshold?: number, minFrames?: number, maxFrames?: number }`
**Outputs:** `{ frames: ExtractedFrame[], method: 'scene-detect' | 'evenly-spaced' }`
  where `ExtractedFrame = { path: string, timestampMs: number, sceneScore?: number }`
**Dependencies:** ffmpeg binary (external)
**Cost:** Free (local processing). Typically completes in <2s for videos under 10 minutes.
**Failure modes:**
- ffmpeg not installed → throw `DependencyError`
- Video has no video track (audio-only) → return empty frames, proceed with transcript-only analysis
- Corrupt video → throw `ProcessingError`

### 5.5 Vision Analysis

**File:** `src/video/vision.ts`

**Trigger:** After frame extraction yields at least 1 frame.

**What it does:**
1. For each extracted frame, send to Kyma multimodal endpoint as a vision request.
2. Batch frames into a single multimodal request when possible (Kyma supports multiple images in a single chat completion).
3. Use a focused prompt: "Describe what you see in this video frame. Focus on: people, text on screen, UI elements, diagrams, code, products, environment. Be specific and concise."

**API contract (Kyma multimodal — OpenAI-compatible):**
```
POST /v1/chat/completions
{
  "model": "gemini-2.5-flash",
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Describe each frame..." },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
      { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,..." } },
      ...
    ]
  }]
}
```

**Inputs:** `frames: ExtractedFrame[]`
**Outputs:** `{ descriptions: FrameDescription[] }`
  where `FrameDescription = { timestampMs: number, description: string }`
**Dependencies:** Kyma API key, Kyma multimodal endpoint
**Cost:** Variable by frame count. Each frame is ~1000-2000 tokens as base64 JPEG. With gemini-2.5-flash:
  - 4 frames: ~$0.01-0.02
  - 8 frames: ~$0.03-0.05
  - 12 frames: ~$0.05-0.08
**Failure modes:**
- Kyma multimodal not available → skip vision, proceed with transcript-only synthesis
- Individual frame too large → resize to max 1024px longest edge before encoding
- Rate limit → retry with backoff
- Total payload too large (>20MB base64) → split into 2 batches of frames

### 5.6 Synthesis

**File:** `src/intelligence/video.ts`

**Trigger:** After both transcription and vision analysis complete (or just transcription if vision failed/skipped).

**What it does:**
1. Combine transcript + frame descriptions into a single synthesis prompt.
2. Send to Kyma chat completion (same `chat()` client as thread analysis).
3. Parse response into `VideoReport` schema.

**Synthesis prompt structure:**
```
System: You are analyzing a video. Produce a structured analysis with:
- key_moments: 3-8 timestamped moments with descriptions
- visual_context: what the frames reveal that the transcript doesn't
- summary: one paragraph synthesizing audio + visual content

User:
## Transcript
{transcript with timestamps}

## Frame Descriptions
- 0:00 — {frame 1 description}
- 0:42 — {frame 2 description}
...

Respond in JSON matching the VideoReport schema.
```

**Inputs:** `transcript: Transcript, frameDescriptions: FrameDescription[], metadata: VideoMetadata`
**Outputs:** `VideoReport`
**Dependencies:** Kyma API key
**Cost:** ~$0.01-0.03 per synthesis call (depends on transcript length).
**Failure modes:**
- Kyma returns invalid JSON → retry once with stricter prompt
- Kyma key not set → return raw transcript + frame descriptions as `VideoReport` with `analysis: null`

---

## 6. Data Model Deltas

### 6.1 VideoReport (NEW)

```typescript
// src/models/video-report.ts

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

export const KeyMomentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  description: z.string(),
  type: z.enum([
    'introduction',
    'key-point',
    'demonstration',
    'transition',
    'conclusion',
    'highlight',
  ]).optional(),
});
export type KeyMoment = z.infer<typeof KeyMomentSchema>;

export const FrameAnalysisSchema = z.object({
  timestampMs: z.number().int().nonnegative(),
  description: z.string(),
  sceneScore: z.number().min(0).max(1).optional(),
});
export type FrameAnalysis = z.infer<typeof FrameAnalysisSchema>;

export const VideoReportSchema = z.object({
  url: z.string().url(),
  platform: VideoSourceSchema,
  durationMs: z.number().int().nonnegative().optional(),
  durationFormatted: z.string().optional(), // "2m34s"

  // Transcript
  transcript: z.object({
    text: z.string(),
    segments: z.array(TranscriptSegmentSchema).default([]),
    language: z.string().optional(),
    empty: z.boolean().default(false),
  }).optional(),

  // Frame analysis
  frames: z.object({
    count: z.number().int().nonnegative(),
    method: z.enum(['scene-detect', 'evenly-spaced']),
    threshold: z.number().optional(), // scene-detect threshold used
    analyses: z.array(FrameAnalysisSchema).default([]),
  }).optional(),

  // Synthesis (absent when --raw or Kyma key not set)
  keyMoments: z.array(KeyMomentSchema).optional(),
  visualContext: z.array(z.string()).optional(),
  summary: z.string().optional(),

  // Cost tracking (per Son's explicit decision: NO CAPS, but surface cost)
  estimatedCostUsd: z.number().nonnegative().optional(),
  costBreakdown: z.object({
    transcription: z.number().nonnegative().optional(),
    vision: z.number().nonnegative().optional(),
    synthesis: z.number().nonnegative().optional(),
  }).optional(),

  // Partial results + errors
  partial: z.boolean().default(false),
  errors: z.array(z.string()).default([]),

  generatedAt: z.string().datetime(),
});
export type VideoReport = z.infer<typeof VideoReportSchema>;
```

### 6.2 ResearchReport Extension

```typescript
// In src/models/report.ts — add to ResearchReportSchema:

export const ResearchReportSchema = z.object({
  // ... all existing fields ...

  // P2 — present only when `--video` ran and at least one video was found.
  // Absent on text-only runs so existing P0/P1/P1.5 outputs remain valid.
  videoAnalysis: VideoReportSchema.optional(),
});
```

### 6.3 ResearchOptions Extension

```typescript
// In src/intelligence/analyze-thread.ts:

export type ResearchOptions = {
  // ... existing fields ...
  /** P2 — when true, detect and analyze video in the thread. Default false. */
  video?: boolean;
};
```

---

## 7. Architecture Changes

### 7.1 New Files

| File | Purpose |
|------|---------|
| `src/video/download.ts` | Platform detection + download orchestrator. yt-dlp wrapper for external platforms + direct undici fetch for X-native CDN URLs. Returns local file path. |
| `src/video/frames.ts` | Hybrid scene-detect frame extractor with min/max clamps. ffmpeg subprocess. Returns extracted frame paths + timestamps. |
| `src/video/audio.ts` | Audio track extraction via ffmpeg. Downsamples to 16kHz mono mp3. Handles oversized files via splitting. |
| `src/video/transcribe.ts` | Kyma `/v1/audio/transcriptions` client. Sends mp3, receives timestamped transcript. |
| `src/video/vision.ts` | Kyma multimodal batch vision. Sends frame JPEGs as base64, receives per-frame descriptions. |
| `src/video/index.ts` | Re-exports for the video module. |
| `src/intelligence/video.ts` | Video synthesis orchestrator. Combines transcript + frame descriptions into VideoReport via Kyma chat. Orchestrates the full pipeline. |
| `src/cli/commands/video.ts` | CLI handler for `xray video <url>`. |
| `src/mcp/tools/video.ts` | MCP tool definition for `xray_video`. |
| `src/models/video-report.ts` | Zod schemas for VideoReport, KeyMoment, VideoSource, etc. |
| `src/render/video-markdown.ts` | Markdown renderer for VideoReport (standalone + embedded). |
| `src/video/cache.ts` | Video-specific SQLite cache tables + LRU eviction logic. |
| `src/video/dependencies.ts` | Dependency checker for yt-dlp and ffmpeg. |

### 7.2 Modified Files

| File | Changes |
|------|---------|
| `src/intelligence/analyze-thread.ts` | Add `video?: boolean` to `ResearchOptions`. When true + root post has video media, run video pipeline and attach `videoAnalysis` to report. |
| `src/cli/index.ts` | Register `xray video <url>` command. |
| `src/cli/commands/thread.ts` | Add `--video` flag. Pass `video: true` to research options. |
| `src/mcp/server.ts` | Add `video` arg to `xray_thread` tool. Register new `xray_video` tool. |
| `src/models/report.ts` | Import `VideoReportSchema`, add `videoAnalysis` optional field to `ResearchReportSchema`. |
| `src/render/markdown.ts` | When `report.videoAnalysis` is present, render the `## Video Analysis` section. |
| `src/cache/db.ts` | Add migration for `video_transcripts` and `video_vision` tables. |
| `package.json` | Version bump to 0.3.0. No new npm dependencies — yt-dlp and ffmpeg are system binaries. |

---

## 8. Cost Surfacing

### 8.1 Deliberate Design Decision: No Cost Limits

**This is an explicit product decision by Son (Round 2, 2026-05-18):** XRay imposes no hard cost caps on video processing. Any video, any duration, any cost. This was not an oversight — it was a deliberate rejection of estimate-and-confirm UX in favor of trust-the-user simplicity.

The rationale: XRay is a power tool for researchers and AI agents. Agents cannot click "confirm $1.50 charge" dialogs. Researchers who invoke `--video` on a 2-hour YouTube lecture accept the cost. Adding interactive confirmation breaks the invisible-default principle and makes MCP automation impossible.

### 8.2 What XRay Does Instead

1. **Surface cost in output:** Every `VideoReport` includes `estimatedCostUsd` and `costBreakdown` fields. The agent caller (Grok, Claude, etc.) can read these and decide whether to surface them to its user.

2. **Log cost at debug level:** Each pipeline stage logs its estimated cost:
   ```
   DEBUG video:transcribe cost=$0.06 duration=10m model=whisper-large-v3-turbo
   DEBUG video:vision cost=$0.04 frames=8 model=gemini-2.5-flash
   DEBUG video:synthesis cost=$0.02 model=gemini-2.5-flash
   DEBUG video:total cost=$0.12
   ```

3. **Warn on long videos:** Videos over 10 minutes emit a WARN-level log:
   ```
   WARN video:download duration=32m — this video may cost >$0.50 to analyze
   ```
   This is informational. The pipeline does NOT pause or prompt.

### 8.3 Cost Reference Table

Approximate per-minute costs based on Kyma pricing (via Groq/Google):

| Stage | Cost driver | Per-minute estimate | 2-min X video | 10-min YouTube | 30-min lecture |
|---|---|---|---|---|---|
| Download | Free | $0.00 | $0.00 | $0.00 | $0.00 |
| Audio extract | Free (local) | $0.00 | $0.00 | $0.00 | $0.00 |
| Transcription | Whisper via Kyma | ~$0.006/min | $0.01 | $0.06 | $0.18 |
| Frame extract | Free (local) | $0.00 | $0.00 | $0.00 | $0.00 |
| Vision (per frame) | Kyma multimodal | ~$0.005/frame | $0.02 (4f) | $0.04 (8f) | $0.06 (12f) |
| Synthesis | Kyma chat | ~$0.02 flat | $0.02 | $0.02 | $0.03 |
| **Total** | | | **~$0.05** | **~$0.12** | **~$0.27** |

Notes:
- Frame count is bounded by the min/max clamp (4-12), so vision cost does not scale linearly with duration.
- Transcription is the only truly duration-linear cost.
- A 2-hour lecture would cost approximately $0.75-1.00 — expensive but not catastrophic.
- Multiple videos in a single `xray thread --video` call compound these costs per video.

---

## 9. Caching Strategy

### 9.1 Cache Location

`~/.xray/cache/video/` — separate from the main thread cache.

### 9.2 SQLite Tables

New tables added to the existing `~/.xray/cache/xray.db`:

```sql
CREATE TABLE IF NOT EXISTS video_transcripts (
  url TEXT PRIMARY KEY,
  transcript_json TEXT NOT NULL,
  language TEXT,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS video_vision (
  url TEXT PRIMARY KEY,
  frame_count INTEGER NOT NULL,
  frame_method TEXT NOT NULL,
  vision_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_video_transcripts_created
  ON video_transcripts(created_at);
CREATE INDEX IF NOT EXISTS idx_video_vision_created
  ON video_vision(created_at);
```

### 9.3 Cache Keys

- **X-native videos:** Cache key is canonicalized X post URL (`https://x.com/{handle}/status/{id}`). X CDN URLs are stable per upload — the underlying mp4 URL doesn't change.
- **YouTube:** Cache key is canonicalized to `https://youtube.com/watch?v={videoId}`. Query params (t=, list=, etc.) stripped.
- **TikTok:** Cache key is `https://tiktok.com/@{user}/video/{id}`.
- **Other platforms:** Full URL after stripping query params.

### 9.4 LRU Eviction

1GB total cap on `~/.xray/cache/video/` directory (downloaded mp4 + extracted frames).

**Eviction logic:**
1. After each download, check total directory size.
2. If over 1GB, delete oldest files (by `mtime`) until under 900MB (10% buffer).
3. SQLite cache rows are NOT evicted by LRU — they're tiny (JSON text). They follow the same 24h TTL as thread cache.
4. Downloaded mp4 files are the main space consumer. Extracted audio/frames are deleted after processing (only the analysis results are cached in SQLite).

### 9.5 Cache Behavior

| Scenario | Behavior |
|---|---|
| Same video URL, within 24h TTL | Return cached transcript + vision from SQLite. Skip download/extract/transcribe/vision. Only re-run synthesis if not cached. |
| Same video URL, beyond 24h TTL | Re-download and re-process. Overwrite cache. |
| `--no-cache` flag | Skip all cache reads. Re-download, re-process, overwrite. |
| Video deleted from platform | Download fails → throw error. Cached result (if any) is still served until TTL expires. |

---

## 10. Failure Modes & Partial Results

Every `VideoReport` carries `partial: boolean` and `errors: string[]`. The pipeline degrades gracefully:

| Failure | Result | `partial` | `errors[]` entry |
|---|---|---|---|
| yt-dlp not installed | Pipeline cannot start for external videos. X-native still works (direct download). | N/A | `"yt-dlp not installed. Install: brew install yt-dlp"` |
| ffmpeg not installed | Pipeline cannot extract audio or frames. | N/A | `"ffmpeg not installed. Install: brew install ffmpeg"` |
| Download timeout (120s) | No video to process. | true | `"Download timed out after 120s"` |
| Region-locked video | No video to process. | true | `"Video is region-locked or unavailable"` |
| Login-walled video (LinkedIn) | No video to process. Suggest yt-dlp with cookies. | true | `"Video requires login. Try: yt-dlp --cookies-from-browser chrome <url>"` |
| Silent video (no audio track) | Transcript empty. Frames + vision still run. | true | `"No audio track detected — transcript unavailable"` |
| Transcription returns empty | Transcript empty (music only, ambient). Frames + vision still run. | true | `"Transcription returned empty text (non-speech audio)"` |
| Vision API rate limit | Retry 3x with backoff. If still fails, return transcript-only report. | true | `"Vision analysis failed after 3 retries"` |
| Kyma API key not set | Return raw transcript + frame paths (no synthesis, no vision). | true | `"KYMA_API_KEY not set — raw video data only"` |
| Synthesis fails | Return transcript + vision descriptions without synthesized summary. | true | `"Synthesis failed: {error}"` |

---

## 11. Dependency Management

### 11.1 External Binaries

| Binary | Required for | Install command | Detection |
|---|---|---|---|
| `ffmpeg` | Audio extraction, frame extraction | `brew install ffmpeg` | `which ffmpeg` + version check |
| `yt-dlp` | External video platforms (YouTube, TikTok, etc.) | `brew install yt-dlp` | `which yt-dlp` + version check |

### 11.2 Dependency Check Strategy

**File:** `src/video/dependencies.ts`

```typescript
export function checkDependencies(needYtDlp: boolean): DependencyCheck {
  const ffmpeg = which('ffmpeg');
  const ytdlp = needYtDlp ? which('yt-dlp') : null;
  return {
    ffmpeg: ffmpeg ? { available: true, path: ffmpeg } : { available: false },
    ytdlp: ytdlp !== null
      ? (ytdlp ? { available: true, path: ytdlp } : { available: false })
      : undefined,
  };
}
```

- ffmpeg is always required (audio + frames).
- yt-dlp is only required for non-X-native videos.
- Missing dependencies throw `DependencyError` with platform-specific install instructions (brew on macOS, apt on Linux).
- Version checking is informational only (logged at debug). XRay does not enforce minimum versions — yt-dlp and ffmpeg are generally backward-compatible.

---

## 12. Test Plan

### 12.1 New Test Files

| File | What it covers | Est. test count |
|------|---------------|----------------|
| `tests/unit/video-download.test.ts` | Platform detection (X-native, YouTube, TikTok, Vimeo, LinkedIn URL patterns). Mock yt-dlp subprocess. Direct download path for X-native CDN URLs. | ~8 |
| `tests/unit/video-frames.test.ts` | Scene-detect parsing, min/max clamping logic, fallback to evenly-spaced. Mock ffmpeg output. | ~8 |
| `tests/unit/video-audio.test.ts` | Audio extraction command building, oversized file splitting logic. Mock ffmpeg. | ~5 |
| `tests/unit/video-transcribe.test.ts` | Kyma audio API request building, response parsing, segment extraction, empty transcript handling. Mock HTTP. | ~6 |
| `tests/unit/video-vision.test.ts` | Multimodal request building (base64 encoding, batching), response parsing. Mock HTTP. | ~5 |
| `tests/unit/video-synthesis.test.ts` | Synthesis prompt construction, VideoReport schema validation, partial result handling (transcript-only, vision-only). Mock Kyma chat. | ~6 |
| `tests/unit/video-report-model.test.ts` | VideoReport Zod schema: valid/invalid inputs, optional fields, cost fields. | ~5 |
| `tests/unit/video-cache.test.ts` | Cache key canonicalization, SQLite read/write, LRU eviction trigger. | ~5 |
| `tests/unit/video-markdown.test.ts` | Markdown rendering: standalone VideoReport, embedded in ResearchReport, partial results with errors. | ~6 |

### 12.2 Existing Test Survival

All existing 126+ tests (from P0/P1/P1.5) remain untouched. Phase 2 is purely additive — no existing schemas or behavior change.

### 12.3 Fixtures

| Fixture | Description |
|---------|-------------|
| `tests/fixtures/short.mp4` | 1-3 second test video clip with audio track. For testing audio extraction and frame extraction commands. Small enough to commit to git (~200KB). |
| `tests/fixtures/video-urls.txt` | List of real video URLs for manual smoke testing: one X-native video, one YouTube short, one TikTok. NOT used in automated tests. |
| `tests/fixtures/whisper-response.json` | Sample Kyma audio transcription response (verbose_json format) for mocking. |
| `tests/fixtures/vision-response.json` | Sample Kyma multimodal vision response for mocking. |

### 12.4 Target Test Count After P2

- Existing: ~126
- New: ~54
- **Target: ~180 tests across ~24 files**

### 12.5 Integration Testing

Live integration tests (not automated — manual smoke test):
1. `xray video https://x.com/<real-video-post>` — full pipeline, X-native
2. `xray video https://youtube.com/watch?v=<short-video>` — yt-dlp path
3. `xray thread <url-with-video> --video` — embedded in thread report
4. `xray video <url> --raw` — transcript + frames only, no synthesis
5. `xray video <url> --json` — JSON output validation against Zod schema

---

## 13. Sub-Phase Delivery

### P2.0 — Walking Skeleton: X-Native Video End-to-End (~10-12h)

**Scope:** Full pipeline for X-native video only (direct CDN download, no yt-dlp). Proves the architecture works end-to-end before adding external platform complexity.

**Files:**
- NEW: `src/video/download.ts` (X-native direct download only)
- NEW: `src/video/audio.ts`
- NEW: `src/video/frames.ts`
- NEW: `src/video/transcribe.ts`
- NEW: `src/video/vision.ts`
- NEW: `src/video/index.ts`
- NEW: `src/video/dependencies.ts`
- NEW: `src/intelligence/video.ts`
- NEW: `src/models/video-report.ts`
- NEW: `tests/unit/video-frames.test.ts`
- NEW: `tests/unit/video-audio.test.ts`
- NEW: `tests/unit/video-report-model.test.ts`
- NEW: `tests/fixtures/short.mp4`

**Acceptance criteria:**
```bash
# Full pipeline on a real X-native video
XRAY_LOG_LEVEL=debug bun run src/intelligence/video.ts \
  "https://video.twimg.com/ext_tw_video/xxx/pu/vid/avc1/720x1280/xxx.mp4"
# Should output a VideoReport JSON

# Frame extraction produces 4-12 frames
ls /tmp/xray-frames-test/
# Should show scene_0001.jpg through scene_NNNN.jpg

# All new tests pass
bun test tests/unit/video-
```

### P2.1 — External Videos via yt-dlp (~6-8h)

**Scope:** Add yt-dlp wrapper for YouTube, TikTok, Vimeo, LinkedIn. Platform detection logic. Dependency checker.

**Files:**
- MOD: `src/video/download.ts` (add yt-dlp subprocess, platform routing)
- NEW: `tests/unit/video-download.test.ts`

**Acceptance criteria:**
```bash
# YouTube download + full pipeline
xray video "https://youtube.com/watch?v=dQw4w9WgXcQ" --raw --json | jq '.platform'
# "youtube"

# TikTok
xray video "https://tiktok.com/@user/video/123" --raw --json | jq '.platform'
# "tiktok"

# Dependency check when yt-dlp missing
PATH=/usr/bin xray video "https://youtube.com/watch?v=xxx"
# Should throw DependencyError with install instructions

bun test
```

### P2.2 — Caching + LRU Eviction (~3-4h)

**Scope:** Video-specific SQLite cache tables. Cache key canonicalization. LRU eviction of downloaded video files. Integration with existing cache infrastructure.

**Files:**
- NEW: `src/video/cache.ts`
- MOD: `src/cache/db.ts` (add video table migrations)
- NEW: `tests/unit/video-cache.test.ts`

**Acceptance criteria:**
```bash
# First run: cache miss, downloads video
XRAY_LOG_LEVEL=debug xray video "<url>" 2>&1 | grep "cache"
# "video cache miss"

# Second run: cache hit, skips download
XRAY_LOG_LEVEL=debug xray video "<url>" 2>&1 | grep "cache"
# "video cache hit: transcript" + "video cache hit: vision"

# --no-cache forces re-download
XRAY_LOG_LEVEL=debug xray video "<url>" --no-cache 2>&1 | grep "cache"
# "video cache bypass"

bun test
```

### P2.3 — CLI + MCP + Markdown + Cost Surfacing (~4-5h)

**Scope:** Wire everything to the user-facing surface. `xray video` CLI command. `xray_video` MCP tool. `--video` flag on `xray thread`. Markdown rendering. Cost estimation in output.

**Files:**
- NEW: `src/cli/commands/video.ts`
- NEW: `src/mcp/tools/video.ts`
- NEW: `src/render/video-markdown.ts`
- MOD: `src/cli/index.ts` (register `xray video`)
- MOD: `src/cli/commands/thread.ts` (add `--video` flag)
- MOD: `src/mcp/server.ts` (register `xray_video`, add `video` arg to `xray_thread`)
- MOD: `src/models/report.ts` (add `videoAnalysis` field)
- MOD: `src/render/markdown.ts` (render `videoAnalysis` section)
- MOD: `src/intelligence/analyze-thread.ts` (video pipeline integration)
- MOD: `package.json` (version → 0.3.0)
- NEW: `tests/unit/video-markdown.test.ts`
- NEW: `tests/unit/video-synthesis.test.ts`
- NEW: `tests/unit/video-transcribe.test.ts`
- NEW: `tests/unit/video-vision.test.ts`

**Acceptance criteria:**
```bash
# Standalone video command
xray video "https://x.com/user/status/123" | grep "Video Analysis"
# Should render markdown

# Standalone JSON output
xray video "https://x.com/user/status/123" --json | jq '.estimatedCostUsd'
# Should output a number

# Thread with video
xray thread "https://x.com/user/status/123" --video | grep "## Video Analysis"
# Should show embedded video section

# MCP tool
echo '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"xray_video","arguments":{"url":"..."}},"id":1}' \
  | bun run src/mcp/index.ts
# Should return valid response

# Version bump
grep '"version"' package.json
# "0.3.0"

# Full test suite
bun test
# All ~180 tests pass
```

### Total Effort Estimate

| Sub-phase | Hours |
|-----------|-------|
| P2.0 Walking skeleton (X-native) | 10-12 |
| P2.1 External videos (yt-dlp) | 6-8 |
| P2.2 Caching + LRU | 3-4 |
| P2.3 CLI + MCP + Markdown + Cost | 4-5 |
| **Total** | **23-29 hours** |

---

## 14. Acceptance Criteria — Phase 2 Overall

All of the following must pass before Phase 2 is considered complete:

```bash
# 1. All tests pass (existing ~126 + new ~54)
bun test

# 2. Standalone video analysis works (X-native)
xray video "https://x.com/karpathy/status/XXXX" --json | jq '.platform'
# Must output "x-native"

# 3. Standalone video analysis works (YouTube via yt-dlp)
xray video "https://youtube.com/watch?v=XXXX" --json | jq '.platform'
# Must output "youtube"

# 4. Thread with video flag embeds VideoReport
xray thread "https://x.com/karpathy/status/XXXX" --video --json | jq '.videoAnalysis.platform'
# Must output "x-native" (if post has video)

# 5. Default thread behavior unchanged (no --video = no video processing)
xray thread "https://x.com/karpathy/status/XXXX" --json | jq '.videoAnalysis'
# Must output "null"

# 6. Cost surfaced in output
xray video "https://x.com/user/status/XXXX" --json | jq '.estimatedCostUsd'
# Must output a number > 0

# 7. Cache works
xray video "<url>" --json > /dev/null  # first run
xray video "<url>" --json > /dev/null  # second run (should be faster, debug log shows cache hit)

# 8. Raw mode skips synthesis
xray video "<url>" --raw --json | jq '.summary'
# Must output null (no synthesis)

# 9. Markdown rendering
xray video "<url>" | head -5
# Must start with "# Video Analysis"

# 10. MCP tool registered
echo '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}' \
  | bun run src/mcp/index.ts | grep xray_video
# Must appear in tool list

# 11. Version bump
grep '"version"' package.json
# Must show "0.3.0"

# 12. Dependency check
PATH=/usr/bin xray video "https://youtube.com/watch?v=xxx" 2>&1 | grep -i "yt-dlp"
# Must show install instructions
```

---

## 15. Migration & Backward Compatibility

### 15.1 No Breaking Changes

Phase 2 is fully additive. No existing CLI flags, MCP args, or data model fields change. Specifically:

- `xray thread <url>` (no flags) behaves identically to v0.2.0 — text-only research with invisible auth escalation.
- `ResearchReport` gains an optional `videoAnalysis` field that is absent unless `--video` is passed.
- `xray_thread` MCP tool gains an optional `video: boolean` arg that defaults to `false`.
- All 126+ existing tests pass without modification.

### 15.2 CHANGELOG Entry Suggestion

```markdown
## [0.3.0] - 2026-XX-XX

### Added
- **Video understanding pipeline** — analyze video content in X posts with
  transcript, scene-detected key frames, visual context, and synthesis.
- **`xray video <url>`** standalone command — analyze any video URL (X-native,
  YouTube, TikTok, Vimeo, LinkedIn).
- **`--video` flag** on `xray thread` — opt-in video analysis embedded in the
  thread research report.
- **`xray_video` MCP tool** — standalone video analysis for AI agents.
- **`video` arg** on `xray_thread` MCP tool — opt-in video processing.
- **Video caching** — transcript and vision results cached in SQLite. Downloaded
  files cached with 1GB LRU eviction.
- **Cost surfacing** — `estimatedCostUsd` and `costBreakdown` fields on every
  VideoReport. Debug-level per-stage cost logs. WARN on videos >10 minutes.
- **Scene-detect frame extraction** — hybrid algorithm using ffmpeg
  `select=gt(scene,0.3)` with min 4 / max 12 frame clamp. Falls back to
  evenly-spaced extraction if scene-detect returns 0 frames.

### Dependencies
- **ffmpeg** (external binary) — required for audio extraction and frame capture.
- **yt-dlp** (external binary) — required for YouTube, TikTok, Vimeo, LinkedIn
  video download. Not needed for X-native video.
```

---

## 16. Risks & Open Questions

### Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **yt-dlp version drift** — yt-dlp updates frequently to track platform anti-bot changes. An old yt-dlp version may fail on YouTube/TikTok. | High | Medium | Document minimum recommended version. Log yt-dlp version at debug level. Error messages suggest `yt-dlp -U` (self-update). |
| **Cost discipline** — Son explicitly rejected cost caps. A user running `xray thread <url> --video` on a thread with 5 embedded videos could burn $0.50+ in one command. OSS users may not expect this. | Medium | Medium | Cost is surfaced in output and logs. README documents per-minute cost table. No mitigation beyond transparency — this is a deliberate design decision. |
| **Scene-detect threshold 0.3 may not generalize** — Works well for X-native short videos (high cut rate). May under-extract from YouTube talking-head videos (low scene change) or over-extract from TikTok montages. | Medium | Low | Fallback to evenly-spaced when scene-detect returns 0 frames. The min/max clamp (4-12) bounds worst-case both directions. Future: per-platform default thresholds. |
| **Kyma audio API quota** — Whisper API typically caps at 25MB per request. Long videos need splitting. | Low | Medium | Audio extraction downsamples to 16kHz mono mp3 (~600KB/min). A 25MB cap accommodates ~40 minutes. Splitting logic handles longer videos. |
| **X CDN URL instability** — While X CDN video URLs are stable per upload today, X could change URL schemes or add auth tokens to CDN URLs. | Low | Medium | Fallback: if direct CDN download fails, route through yt-dlp (which handles X natively). |
| **ffmpeg/yt-dlp not installed** — Many users won't have these pre-installed, especially on fresh macOS installs. | High | Low | Clear error messages with `brew install` instructions. Dependency check runs at command start, fails fast. |

### Open Questions

1. **Should `xray thread --video` process videos in replies, or only root post?** Current spec: root post only. Processing reply videos would compound cost significantly. Recommend deferring reply-video support to Phase 3 or making it a separate `--video-depth` flag.

2. **Should the video cache TTL match thread cache TTL (24h)?** Videos are immutable after upload (unlike thread metrics which change). A longer TTL (7 days?) would reduce redundant transcription costs. Recommend: separate `XRAY_VIDEO_CACHE_TTL` env var, default 7 days.

3. **Concurrent video processing?** When `xray thread --video` finds multiple videos in one post (e.g., root post + author follow-up), should they be processed in parallel or sequentially? Parallel is faster but doubles concurrent Kyma API load. Recommend: sequential in P2, parallel optimization in Phase 5.

4. **yt-dlp cookies integration?** For login-walled platforms (LinkedIn, some YouTube), yt-dlp supports `--cookies-from-browser chrome`. Should XRay auto-pass this flag (leveraging the same Chromium cookie approach from P1.5)? Recommend: yes, but defer to P2.1 scope — surface the `--cookies-from-browser` suggestion in error messages first.

---

## 17. Out of Scope (Explicit Deferrals)

| Item | Deferred to | Rationale |
|------|------------|-----------|
| X Spaces audio analysis | Indefinite | Fundamentally different pipeline (audio-only, potentially live). |
| Live stream support | Indefinite | Requires real-time capture, different architecture. |
| OCR text-in-video | Phase 5+ | Specialized model needed. Vision analysis captures text presence but not OCR extraction. |
| Multi-language transcript routing | Phase 5+ | Whisper handles language detection automatically. |
| Video in reply tweets | Phase 3+ | Focus P2 on root post video. Reply videos compound cost. |
| Video comparison / fact-check | Phase 5+ | Higher-level orchestration beyond single-video analysis. |
| Per-platform scene-detect thresholds | Phase 3+ | 0.3 works as a reasonable default. Tuning is optimization. |
| Parallel multi-video processing | Phase 5 | Sequential is simpler and sufficient for P2. |
| Video-to-text timeline alignment | Phase 5+ | Aligning transcript words to specific frames. Useful but complex. |

---

**End of PHASE_2_PLAN.md**
