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

// ─────────────────────────────────────────────────────────────────────────────
// P1.3 — Deep mode prompts (per-subtree analysis + cross-subtree synthesis)
// ─────────────────────────────────────────────────────────────────────────────

export const DEEP_SUBTREE_SYSTEM_PROMPT = `You analyze a single conversation subtree from an X (Twitter) thread.
A subtree is one top-level reply + its nested descendants.

For the subtree, produce:
- A 1-sentence "headline" describing the through-line of the conversation
- "keyPoints": 2-4 short bullets capturing the substantive claims/sub-arguments raised
- "dissent": 0-3 bullets capturing pushback against the subtree-root reply OR against the original ROOT POST.
  If there is no meaningful dissent, return an empty array.

Hard rules:
- Never invent facts. Stick to what the messages actually say.
- The subtree root's stance is relative to the ROOT POST, not to other subtrees.
- Output VALID JSON ONLY — no markdown fences, no preamble.`;

export const DEEP_SYNTHESIS_SYSTEM_PROMPT = `You synthesize multiple conversation subtrees from a single X (Twitter) thread.
You will receive: the ROOT POST, the shallow thread-level analysis (tldr/summary/insights), and a list of per-subtree summaries.

Your job is to produce ONE unified deep report that explicitly maps the structure of the debate:
- "topArguments": the major argument clusters across subtrees, each labeled with the subtree handles that voiced it
- "dissentMap": the major lines of disagreement (with OP or among repliers)
- "subThreadsWorthReading": which subtree handles a reader should jump into first, and why

Hard rules:
- Never invent facts. Cite only ideas present in the subtree summaries or root post.
- Distinguish the OP's claims from replies' claims.
- Output VALID JSON ONLY — no markdown fences, no preamble.`;

/**
 * Per-subtree user prompt: one Kyma call per subtree, produces a SubtreeSummary
 * (headline + keyPoints + dissent).
 *
 * `subtreeRoot` is the top-level reply that defines this subtree; `nestedReplies`
 * are its descendants (already flattened in DFS order with depth tags).
 */
export function renderDeepSubtreePrompt(
  rootPost: XPost,
  subtreeRoot: XComment,
  nestedReplies: XComment[],
): string {
  const lines: string[] = [];
  lines.push(`ROOT POST by @${rootPost.author.handle}:`);
  lines.push(`"${truncateText(rootPost.text, 600)}"`);
  lines.push('');
  lines.push(
    `SUBTREE ROOT by @${subtreeRoot.author.handle}${subtreeRoot.author.verified ? ' (verified)' : ''}:`,
  );
  const subRootLikes = subtreeRoot.metrics.likes ?? 0;
  lines.push(`- id=${subtreeRoot.id} (♥${subRootLikes}): "${truncateText(subtreeRoot.text, 600)}"`);

  if (nestedReplies.length > 0) {
    lines.push('');
    lines.push(`NESTED REPLIES IN THIS SUBTREE (${nestedReplies.length}):`);
    for (const r of nestedReplies) {
      const indent = '  '.repeat(Math.max(0, r.depth - subtreeRoot.depth));
      const likes = r.metrics.likes ?? 0;
      lines.push(
        `${indent}- id=${r.id} @${r.author.handle} (♥${likes}): "${truncateText(r.text)}"`,
      );
    }
  }

  lines.push('');
  lines.push('Output a JSON object with this exact shape:');
  lines.push('{');
  lines.push('  "headline": "1 sentence describing the through-line of this subtree",');
  lines.push('  "keyPoints": ["bullet 1", "bullet 2"],');
  lines.push('  "dissent":   ["bullet 1"]');
  lines.push('}');
  lines.push('Constraints:');
  lines.push('- 2-4 keyPoints.');
  lines.push('- 0-3 dissent bullets (empty array if none).');
  lines.push('- Output JSON only. No commentary.');
  return lines.join('\n');
}

/** Compact shallow-analysis projection passed into the synthesis prompt. */
export type ShallowAnalysisDigest = {
  topic?: string;
  tldr: string;
  summary: string;
  keyInsights: Array<{ insight: string; confidence: 'low' | 'medium' | 'high' }>;
  openQuestions: string[];
};

/** SubtreeSummary projection accepted by the synthesis prompt. */
export type SubtreeSummaryForSynthesis = {
  rootReplyPostId: string;
  rootReplyHandle: string;
  replyCount: number;
  headline: string;
  keyPoints: string[];
  dissent: string[];
};

/**
 * Synthesis prompt: one final Kyma call that consumes all subtree summaries plus
 * the shallow `analyzeThread` digest + the root post, and produces the unified
 * deep report (topArguments, dissentMap, subThreadsWorthReading).
 */
export function renderDeepSynthesisPrompt(
  rootPost: XPost,
  shallow: ShallowAnalysisDigest,
  subtrees: SubtreeSummaryForSynthesis[],
): string {
  const lines: string[] = [];
  lines.push(`ROOT POST by @${rootPost.author.handle}:`);
  lines.push(`"${truncateText(rootPost.text, 600)}"`);
  lines.push('');
  lines.push('SHALLOW THREAD-LEVEL ANALYSIS (already produced):');
  if (shallow.topic) lines.push(`- topic: ${shallow.topic}`);
  lines.push(`- tldr: ${shallow.tldr}`);
  lines.push(`- summary: ${shallow.summary}`);
  if (shallow.keyInsights.length > 0) {
    lines.push('- keyInsights:');
    for (const k of shallow.keyInsights) {
      lines.push(`  • [${k.confidence}] ${k.insight}`);
    }
  }
  if (shallow.openQuestions.length > 0) {
    lines.push('- openQuestions:');
    for (const q of shallow.openQuestions) lines.push(`  • ${q}`);
  }
  lines.push('');
  lines.push(`SUBTREE SUMMARIES (${subtrees.length}):`);
  for (const s of subtrees) {
    lines.push(
      `- @${s.rootReplyHandle} (id=${s.rootReplyPostId}, ${s.replyCount} replies): ${s.headline}`,
    );
    for (const p of s.keyPoints) lines.push(`  • point: ${p}`);
    for (const d of s.dissent) lines.push(`  • dissent: ${d}`);
  }
  lines.push('');
  lines.push('Output a SINGLE JSON object with this exact shape:');
  lines.push('{');
  lines.push('  "topArguments": [');
  lines.push(
    '    { "argument": "...", "voicedBy": ["@handle"], "evidenceSubtreeIds": ["<reply id>"] }',
  );
  lines.push('  ],');
  lines.push('  "dissentMap": [');
  lines.push(
    '    { "claim": "...", "againstOp": true, "voicedBy": ["@handle"], "evidenceSubtreeIds": ["<reply id>"] }',
  );
  lines.push('  ],');
  lines.push('  "subThreadsWorthReading": [');
  lines.push('    { "rootReplyPostId": "<reply id>", "handle": "@handle", "reason": "..." }');
  lines.push('  ]');
  lines.push('}');
  lines.push('Constraints:');
  lines.push('- 2-6 topArguments. evidenceSubtreeIds must reference real subtree reply ids above.');
  lines.push('- 0-5 dissentMap entries (empty array if the thread is consensual).');
  lines.push('- 1-5 subThreadsWorthReading (pick the most informative subtrees).');
  lines.push('- Output JSON only. No commentary.');
  return lines.join('\n');
}
