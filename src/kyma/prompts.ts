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

const MAX_REPLIES_IN_PROMPT = 40;

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
