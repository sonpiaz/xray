import type { XComment } from '../models/comment.ts';
import type { XPost } from '../models/post.ts';
import type { XThread } from '../models/thread.ts';

const SYSTEM_PROMPT = `You are XRay, a research assistant that analyzes X (Twitter) threads.
Your job is to produce concise, accurate, evidence-grounded analysis for an AI agent that will reason over your output.

Hard rules:
- Never invent facts. If something isn't in the thread, do not claim it.
- Quote-tweet authors are different speakers from the root author.
- Distinguish the OP's claims from replies' reactions.
- Prefer short, dense sentences over flowery prose.
- Output VALID JSON ONLY when JSON is requested — no markdown fences, no preamble.`;

export function systemPrompt(): string {
  return SYSTEM_PROMPT;
}

export const MAX_REPLIES_IN_PROMPT = 40;

export function renderThreadForPrompt(thread: XThread): string {
  const lines: string[] = [];
  const root = thread.rootPost;

  lines.push('## ROOT POST');
  lines.push(`id: ${root.id}`);
  lines.push(`url: ${root.url}`);
  lines.push(`author: @${root.author.handle}${root.author.verified ? ' (verified)' : ''}`);
  if (root.createdAt) lines.push(`createdAt: ${root.createdAt}`);
  lines.push(
    `metrics: likes=${root.metrics.likes ?? '?'} reposts=${root.metrics.reposts ?? '?'} replies=${root.metrics.replies ?? '?'} views=${root.metrics.views ?? '?'}`,
  );
  if (root.media.length > 0) {
    lines.push(`media: ${root.media.map((m) => m.type).join(', ')}`);
  }
  if (root.links.length > 0) {
    lines.push(`links: ${root.links.map((l) => l.expandedUrl ?? l.url).join(' | ')}`);
  }
  lines.push('');
  lines.push(root.text);

  if (thread.authorPosts.length > 0) {
    lines.push('');
    lines.push('## AUTHOR FOLLOW-UPS (same thread)');
    for (const p of thread.authorPosts) {
      lines.push(`- [${p.id}] ${p.text}`);
    }
  }

  if (thread.quoteTweets.length > 0) {
    lines.push('');
    lines.push('## QUOTE TWEETS (other authors quoting OP)');
    for (const q of thread.quoteTweets.slice(0, 20)) {
      lines.push(`- [${q.id}] @${q.author.handle}: ${q.text}`);
    }
  }

  if (thread.comments.length > 0) {
    lines.push('');
    lines.push(`## REPLIES (top ${Math.min(thread.comments.length, MAX_REPLIES_IN_PROMPT)})`);
    for (const c of thread.comments.slice(0, MAX_REPLIES_IN_PROMPT)) {
      const likes = c.metrics.likes ?? 0;
      lines.push(`- [${c.id}] (♥${likes}) @${c.author.handle}: ${c.text}`);
    }
  }

  return lines.join('\n');
}

export const REPORT_JSON_INSTRUCTION = `Analyze the thread above and output a SINGLE JSON object with this exact shape:
{
  "topic": "short noun phrase, max 12 words",
  "tldr": "1-2 sentence summary an agent could quote",
  "summary": "3-6 sentence narrative summary",
  "keyInsights": [
    { "insight": "...", "evidencePostIds": ["<post id>"], "confidence": "low|medium|high" }
  ],
  "notableReplies": [
    { "postId": "<reply id>", "reason": "why notable", "summary": "what the reply says" }
  ],
  "openQuestions": ["question 1", "question 2"]
}
Constraints:
- 3-6 keyInsights.
- 0-5 notableReplies (only if genuinely substantive).
- 0-4 openQuestions.
- evidencePostIds MUST reference actual ids from the thread above.
- Output JSON only. No commentary.`;

// ─────────────────────────────────────────────────────────────────────────────
// P1.1 — Classification prompts
// ─────────────────────────────────────────────────────────────────────────────

export const CLASSIFICATION_SYSTEM_PROMPT = `You classify X (Twitter) replies.
For each reply, output: stance (agree|disagree|neutral|question|humor|meta),
quality (substantive|anecdotal|noise|expert|correction),
and qualityScore (float 0.0-1.0).

Rules:
- Stance is relative to the ROOT POST's main claim. A reply that disagrees with another
  reply but agrees with OP = "agree".
- qualityScore measures information value, not agreement with OP.
- Humor that makes a substantive point = quality "substantive" + stance "humor".
- Corrections with evidence > corrections without evidence (0.8+ vs 0.5).
- One-word replies, emoji-only, "ratio", "+1" = noise + qualityScore 0.0-0.05.
- Output VALID JSON ONLY — no markdown fences, no preamble.`;

function truncateText(s: string, max = 400): string {
  const cleaned = s.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

/**
 * Render the user-facing classification prompt given a root post and a batch of comments.
 * Comments may include nested replies — we flatten to a single ordered list keyed by id.
 */
export function renderClassificationPrompt(rootPost: XPost, batch: XComment[]): string {
  const lines: string[] = [];
  lines.push(`ROOT POST by @${rootPost.author.handle}:`);
  lines.push(`"${truncateText(rootPost.text, 600)}"`);
  lines.push('');
  lines.push('Classify each reply below. Output a JSON object with a "classifications" array:');
  lines.push('{');
  lines.push('  "classifications": [');
  lines.push('    { "id": "<reply id>", "stance": "...", "quality": "...", "qualityScore": 0.XX }');
  lines.push('  ]');
  lines.push('}');
  lines.push('');
  lines.push('REPLIES:');
  for (const c of batch) {
    const likes = c.metrics.likes ?? 0;
    lines.push(`- id=${c.id} @${c.author.handle} (likes=${likes}): "${truncateText(c.text)}"`);
  }
  return lines.join('\n');
}
