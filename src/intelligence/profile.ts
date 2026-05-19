/**
 * P4.2 — Profile analysis orchestrator.
 *
 * Pipeline (cache-only path — `--fresh` is documented but deferred to
 * P5+; we silently warn and fall back to cache when set):
 *
 *   1. Normalize handle (strip `@`, lowercase).
 *   2. Cache check via `profile_cache(handle, ...)`. 24h TTL inside
 *      `src/cache/profiles.ts`. Skip on `noCache`.
 *   3. Aggregate cache evidence:
 *        - walk `embedding_meta` rows for `author_handle = ?`
 *        - walk `threads` table for threads where the root post author
 *          matches (covers data not yet `cache embed`-ed)
 *        - dedup snippets by hash so the LLM doesn't see duplicates
 *   4. Defensive cap at SNIPPETS_CAP — beyond that we WARN + truncate
 *      so the prompt stays bounded (~$0.05-0.20 per profile target).
 *   5. Three Kyma calls (sequenced — each conditions the next):
 *        A. Topics + Expertise areas
 *        B. Stance (against the topics from A)
 *        C. Notable quotes + summary
 *   6. Lenient JSON repair on each — drop unrepairable rows, keep
 *      valid (P1.6 / P3.2 pattern). Schema-validate against Zod.
 *   7. Cache the assembled report. Return.
 *
 * Cost: ~$0.05-0.20 per profile (3 chat calls). Surface to caller via
 * `estimatedCostUsd`. We treat each chat() as a flat $0.02 when not
 * cached — same heuristic as `intelligence/video.ts` synthesis cost.
 *
 * Empty-cache UX: throw a clear actionable error rather than returning
 * a hollow report. The error message tells the user what to do next:
 * `xray thread <url>` to populate the cache, then `xray cache embed`.
 *
 * Test seam: `_orchestratorDeps` mirrors `intelligence/video.ts` so
 * tests can stub the 3 chat calls + the cache reader/writer without
 * monkey-patching modules.
 */
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { chat as defaultChat } from '../kyma/client.ts';
import {
  type NotableQuote,
  type ProfileReport,
  ProfileReportSchema,
  type ProfileStance,
  ProfileStanceSchema,
  type StanceSummary,
  type Topic,
} from '../models/profile.ts';
import { type XThread, XThreadSchema } from '../models/thread.ts';

// Cache + db go through lazy require so vitest under Node can import
// this orchestrator without crashing on `bun:sqlite` (same pattern as
// src/embeddings/store.ts / src/intelligence/article.ts).
type CacheMod = typeof import('../cache/profiles.ts');
type DbMod = typeof import('../cache/db.ts');
let cacheMod: CacheMod | undefined;
let dbMod: DbMod | undefined;

function getCacheMod(): CacheMod {
  if (!cacheMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cacheMod = require('../cache/profiles.ts') as CacheMod;
  }
  return cacheMod;
}
function getDbMod(): DbMod {
  if (!dbMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dbMod = require('../cache/db.ts') as DbMod;
  }
  return dbMod;
}

/** Per-chat-call flat cost — mirrors `intelligence/video.ts` SYNTHESIS_COST_USD. */
const CHAT_FLAT_COST_USD = 0.02;
/** Defensive cap on snippets fed into the LLM prompt. Above this we WARN + truncate. */
const SNIPPETS_CAP = 50;
/** Per-snippet character cap in the prompts (keeps token budget bounded). */
const SNIPPET_PROMPT_CHARS = 280;

export type ProfileAnalyzeOptions = {
  /** X handle, with or without leading `@`. */
  handle: string;
  /**
   * When set, the caller wants `N` fresh tweets pulled before analysis.
   * P4.2 does NOT yet implement this path — we silently warn and fall
   * back to the cache-only pipeline. Deferred to P5+ (would require an
   * X timeline fetcher).
   */
  fresh?: number;
  /** Skip the profile_cache read + write — force re-synthesis. */
  noCache?: boolean;
  /** Override the Kyma model used for the 3 synthesis calls. */
  synthesisModel?: string;
};

/**
 * Test seam — same shape as `intelligence/video.ts` / `intelligence/article.ts`.
 * Tests swap these to stub the 3 chat calls + the cache layer without
 * monkey-patching modules.
 */
export const _orchestratorDeps = {
  chat: defaultChat,
};

/** Internal — set the lazy cache + db modules for tests. */
export function _setCacheModuleForTests(mod: CacheMod | undefined): void {
  cacheMod = mod;
}
export function _setDbModuleForTests(mod: DbMod | undefined): void {
  dbMod = mod;
}

// ─── Snippet aggregation ───────────────────────────────────────────

type Snippet = {
  text: string;
  sourceUrl?: string;
  postId?: string;
  entityType: 'post' | 'comment' | 'thread';
};

type EmbeddingRow = {
  entity_type: string;
  entity_id: string;
  source_url: string | null;
  snippet: string;
};

type ThreadRow = {
  json: string;
};

/**
 * Collect every snippet attributed to `handle`. Pulls from:
 *   - `embedding_meta` rows with matching `author_handle` (covers
 *     embedded posts + comments + article passages where this user
 *     authored the source).
 *   - `threads` table — root post + author follow-ups when the root
 *     author matches. This is a safety net for threads cached but not
 *     yet `cache embed`-ed.
 *
 * Dedup by snippet text so the LLM doesn't see the same line twice
 * (embedded thread root + raw thread row will produce duplicates).
 */
function collectSnippetsForHandle(handle: string): Snippet[] {
  const db = getDbMod().getDb();
  const collected: Snippet[] = [];
  const seen = new Set<string>();
  const push = (s: Snippet): void => {
    const key = s.text.trim().slice(0, 200);
    if (!key) return;
    if (seen.has(key)) return;
    seen.add(key);
    collected.push(s);
  };

  // 1. Embedded rows for this author.
  try {
    const rows = db
      .query<EmbeddingRow, [string]>(
        `SELECT entity_type, entity_id, source_url, snippet
         FROM embedding_meta WHERE author_handle = ?`,
      )
      .all(handle);
    for (const r of rows) {
      if (r.entity_type !== 'post' && r.entity_type !== 'comment') continue;
      const snip: Snippet = {
        text: r.snippet,
        entityType: r.entity_type,
      };
      if (r.source_url) snip.sourceUrl = r.source_url;
      else snip.sourceUrl = `https://x.com/${handle}/status/${r.entity_id}`;
      snip.postId = r.entity_id;
      push(snip);
    }
  } catch (err) {
    logger.debug('profile: embedding_meta walk failed (continuing)', { err: String(err) });
  }

  // 2. Threads table — root + authorPosts when the root author matches.
  try {
    const threadRows = db.query<ThreadRow, []>('SELECT json FROM threads').all();
    for (const row of threadRows) {
      let thread: XThread;
      try {
        thread = XThreadSchema.parse(JSON.parse(row.json));
      } catch {
        continue;
      }
      if (thread.rootPost.author.handle.toLowerCase() !== handle) continue;

      const allAuthorPosts = [thread.rootPost, ...thread.authorPosts];
      for (const post of allAuthorPosts) {
        if (!post.text.trim()) continue;
        push({
          text: post.text,
          sourceUrl: post.url,
          postId: post.id,
          entityType: 'post',
        });
      }
    }
  } catch (err) {
    logger.debug('profile: threads walk failed (continuing)', { err: String(err) });
  }

  return collected;
}

function countCachedThreads(handle: string): number {
  const db = getDbMod().getDb();
  let count = 0;
  try {
    const rows = db.query<ThreadRow, []>('SELECT json FROM threads').all();
    for (const row of rows) {
      try {
        const t = XThreadSchema.parse(JSON.parse(row.json));
        if (t.rootPost.author.handle.toLowerCase() === handle) count++;
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logger.debug('profile: thread count failed', { err: String(err) });
  }
  return count;
}

// ─── Prompt builders ───────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function snippetBlock(snippets: Snippet[]): string {
  return snippets
    .map(
      (s, i) => `${i + 1}. ${truncate(s.text.replace(/\s+/g, ' ').trim(), SNIPPET_PROMPT_CHARS)}`,
    )
    .join('\n');
}

function buildTopicsPrompt(
  handle: string,
  snippets: Snippet[],
): {
  system: string;
  user: string;
} {
  const system = [
    "You analyze a person's tweet snippets to identify their top topics + expertise areas.",
    '',
    'Output JSON only:',
    '{',
    '  "topics": [',
    '    { "topic": "AI safety", "mentions": 12, "confidence": "high", "representativeSnippet": "..." },',
    '    ...',
    '  ],',
    '  "expertiseAreas": ["LLMs", "computer vision"]',
    '}',
    '',
    'Constraints:',
    '- Include 3-7 topics (the most prominent — drop one-offs).',
    '- mentions = approximate count of snippets that touch the topic (integer).',
    '- confidence ∈ {"low", "medium", "high"} based on how many snippets corroborate.',
    '- representativeSnippet is an optional short quote from the snippets list (≤ 200 chars).',
    '- 2-5 expertiseAreas — short skill / domain labels (e.g. "deep learning", "startup advice").',
    '- Topics describe SUBJECTS tweeted about; expertise describes SKILLS/DOMAINS the person knows.',
  ].join('\n');

  const user = [`HANDLE: @${handle}`, '', 'SNIPPETS:', snippetBlock(snippets)].join('\n');
  return { system, user };
}

function buildStancePrompt(
  handle: string,
  snippets: Snippet[],
  topics: Topic[],
): { system: string; user: string } {
  const topicList = topics.map((t) => t.topic).join(', ');
  const system = [
    "You classify a person's STANCE on each provided topic based on their tweet snippets.",
    '',
    'Output JSON only:',
    '{',
    '  "stance": [',
    '    {',
    '      "subject": "agentic AI",',
    '      "stance": "bullish",',
    '      "evidenceSnippets": ["...", "..."],',
    '      "confidence": "high"',
    '    },',
    '    ...',
    '  ]',
    '}',
    '',
    'Constraints:',
    '- One entry per provided topic, in the same order.',
    '- stance ∈ {"bullish", "bearish", "neutral", "critical", "enthusiastic", "skeptical"}.',
    '- evidenceSnippets: 1-3 short quotes from the snippets list (≤ 200 chars each).',
    '- confidence ∈ {"low", "medium", "high"} — low when only 1 weak snippet, high when consistent across many.',
    '- If a topic genuinely has no clear stance, use "neutral" with confidence "low".',
  ].join('\n');

  const user = [
    `HANDLE: @${handle}`,
    `TOPICS: ${topicList}`,
    '',
    'SNIPPETS:',
    snippetBlock(snippets),
  ].join('\n');
  return { system, user };
}

function buildNotableQuotesPrompt(
  handle: string,
  snippets: Snippet[],
): {
  system: string;
  user: string;
} {
  const system = [
    "You pick the most NOTABLE / QUOTABLE lines from this person's tweets + write a brief voice overview.",
    '',
    'Output JSON only:',
    '{',
    '  "notableQuotes": [',
    '    { "text": "...", "context": "optional 1-line context", "snippetIndex": 7 },',
    '    ...',
    '  ],',
    '  "summary": "2-4 sentence overview of this person\'s tweet voice"',
    '}',
    '',
    'Constraints:',
    '- 3-5 notableQuotes. Pick lines that are quotable, opinionated, or insightful — not bland status updates.',
    '- text ≤ 280 chars, prefer the exact snippet phrasing.',
    '- snippetIndex = the 1-based index from the SNIPPETS list above so we can attribute back to a source URL.',
    '- summary: 2-4 sentences capturing what reading their feed FEELS like (tone, themes, recurring ideas).',
  ].join('\n');

  const user = [`HANDLE: @${handle}`, '', 'SNIPPETS:', snippetBlock(snippets)].join('\n');
  return { system, user };
}

// ─── Lenient JSON repair ───────────────────────────────────────────

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const CONFIDENCE_VALUES = new Set(['low', 'medium', 'high']);
const STANCE_VALUES = new Set<ProfileStance>(ProfileStanceSchema.options);
const STANCE_SYNONYMS: Record<string, ProfileStance> = {
  optimistic: 'bullish',
  positive: 'bullish',
  excited: 'enthusiastic',
  enthused: 'enthusiastic',
  pessimistic: 'bearish',
  negative: 'bearish',
  doubtful: 'skeptical',
  cynical: 'skeptical',
};

function coerceStance(raw: unknown): ProfileStance | undefined {
  if (typeof raw !== 'string') return undefined;
  const lc = raw.toLowerCase().trim();
  if (STANCE_VALUES.has(lc as ProfileStance)) return lc as ProfileStance;
  if (STANCE_SYNONYMS[lc]) return STANCE_SYNONYMS[lc];
  return undefined;
}

function coerceConfidence(raw: unknown): 'low' | 'medium' | 'high' {
  if (typeof raw !== 'string') return 'low';
  const lc = raw.toLowerCase().trim();
  if (CONFIDENCE_VALUES.has(lc)) return lc as 'low' | 'medium' | 'high';
  return 'low';
}

function repairTopics(payload: unknown): { topics: Topic[]; expertiseAreas: string[] } {
  if (!payload || typeof payload !== 'object') return { topics: [], expertiseAreas: [] };
  const obj = payload as Record<string, unknown>;
  const rawTopics = Array.isArray(obj.topics) ? obj.topics : [];
  const rawExpertise = Array.isArray(obj.expertiseAreas) ? obj.expertiseAreas : [];

  const topics: Topic[] = [];
  for (const raw of rawTopics) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const topic = typeof item.topic === 'string' ? item.topic.trim() : '';
    if (!topic) continue;
    let mentions = 0;
    if (typeof item.mentions === 'number' && Number.isFinite(item.mentions)) {
      mentions = Math.max(0, Math.floor(item.mentions));
    } else if (typeof item.mentions === 'string') {
      const n = Number.parseInt(item.mentions, 10);
      if (Number.isFinite(n)) mentions = Math.max(0, n);
    }
    const entry: Topic = {
      topic,
      mentions,
      confidence: coerceConfidence(item.confidence),
    };
    if (typeof item.representativeSnippet === 'string' && item.representativeSnippet.trim()) {
      entry.representativeSnippet = truncate(item.representativeSnippet.trim(), 200);
    }
    topics.push(entry);
  }

  const expertiseAreas: string[] = [];
  for (const raw of rawExpertise) {
    if (typeof raw !== 'string') continue;
    const s = raw.trim();
    if (s) expertiseAreas.push(s);
  }

  return { topics, expertiseAreas };
}

function repairStance(payload: unknown): StanceSummary[] {
  if (!payload || typeof payload !== 'object') return [];
  const obj = payload as Record<string, unknown>;
  const raw = Array.isArray(obj.stance) ? obj.stance : [];
  const out: StanceSummary[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const item = r as Record<string, unknown>;
    const subject = typeof item.subject === 'string' ? item.subject.trim() : '';
    if (!subject) continue;
    const stance = coerceStance(item.stance);
    if (!stance) continue;
    const evidence: string[] = [];
    if (Array.isArray(item.evidenceSnippets)) {
      for (const e of item.evidenceSnippets) {
        if (typeof e !== 'string') continue;
        const s = e.trim();
        if (s) evidence.push(truncate(s, 200));
        if (evidence.length >= 3) break;
      }
    }
    out.push({
      subject,
      stance,
      evidenceSnippets: evidence,
      confidence: coerceConfidence(item.confidence),
    });
  }
  return out;
}

function repairNotableQuotes(
  payload: unknown,
  snippets: Snippet[],
): { quotes: NotableQuote[]; summary: string } {
  if (!payload || typeof payload !== 'object') return { quotes: [], summary: '' };
  const obj = payload as Record<string, unknown>;
  const raw = Array.isArray(obj.notableQuotes) ? obj.notableQuotes : [];
  const quotes: NotableQuote[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const item = r as Record<string, unknown>;
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) continue;
    const q: NotableQuote = { text: truncate(text, 500) };
    if (typeof item.context === 'string' && item.context.trim()) {
      q.context = item.context.trim();
    }
    // Attribute back to the source via snippetIndex when present.
    let idx: number | undefined;
    if (typeof item.snippetIndex === 'number' && Number.isFinite(item.snippetIndex)) {
      idx = Math.floor(item.snippetIndex) - 1;
    } else if (typeof item.snippetIndex === 'string') {
      const n = Number.parseInt(item.snippetIndex, 10);
      if (Number.isFinite(n)) idx = n - 1;
    }
    if (idx !== undefined && idx >= 0 && idx < snippets.length) {
      const src = snippets[idx]!;
      if (src.sourceUrl) q.sourceUrl = src.sourceUrl;
      if (src.postId) q.postId = src.postId;
    }
    quotes.push(q);
  }
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  return { quotes, summary };
}

// ─── Main entrypoint ───────────────────────────────────────────────

export async function analyzeProfile(opts: ProfileAnalyzeOptions): Promise<ProfileReport> {
  const handle = opts.handle.trim().replace(/^@/, '').toLowerCase();
  if (!handle) {
    throw new Error('analyzeProfile: handle is required');
  }

  const cfg = loadConfig();
  const warnings: string[] = [];
  let partial = false;

  // 1. Cache check.
  if (!opts.noCache) {
    const cached = getCacheMod().getCachedProfile(handle);
    if (cached) {
      logger.debug('profile cache hit', { handle });
      return cached;
    }
  }

  // 2. `--fresh N` is documented but deferred — silently warn + fall back.
  if (opts.fresh !== undefined && opts.fresh > 0) {
    const msg = '--fresh fetch is not yet implemented (deferred to P5); using cache-only path';
    logger.warn(msg, { handle, fresh: opts.fresh });
    warnings.push(msg);
    partial = true;
  }

  // 3. Aggregate snippets from cache.
  let snippets = collectSnippetsForHandle(handle);
  const cachedThreadsAnalyzed = countCachedThreads(handle);
  const cachedCommentsAnalyzed = snippets.filter((s) => s.entityType === 'comment').length;

  if (snippets.length === 0) {
    throw new Error(
      `No cached data for @${handle}. Run \`xray thread <url>\` on their posts first, then \`xray cache embed\` (optional), then re-run \`xray profile @${handle}\`.`,
    );
  }

  // 4. Defensive cap so the prompt doesn't blow the token budget.
  if (snippets.length > SNIPPETS_CAP) {
    const dropped = snippets.length - SNIPPETS_CAP;
    const msg = `snippet cap reached: analyzing ${SNIPPETS_CAP} of ${snippets.length} (dropped ${dropped}). Bump SNIPPETS_CAP if you need more.`;
    logger.warn('profile snippet cap', { handle, total: snippets.length, cap: SNIPPETS_CAP });
    warnings.push(msg);
    partial = true;
    snippets = snippets.slice(0, SNIPPETS_CAP);
  }

  // 5. Require a Kyma key for synthesis.
  if (!cfg.kyma.key) {
    throw new Error(
      'KYMA_API_KEY is not set — profile synthesis requires Kyma. Set it in .env first.',
    );
  }

  let estimatedCostUsd = 0;

  // ── Call A: Topics + Expertise ──
  let topics: Topic[] = [];
  let expertiseAreas: string[] = [];
  try {
    const { system, user } = buildTopicsPrompt(handle, snippets);
    const res = await _orchestratorDeps.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 800,
      ...(opts.synthesisModel ? { model: opts.synthesisModel } : {}),
    });
    if (!res.cached) estimatedCostUsd += CHAT_FLAT_COST_USD;
    const parsed = repairTopics(safeJsonParse(res.content));
    topics = parsed.topics;
    expertiseAreas = parsed.expertiseAreas;
  } catch (err) {
    const msg = `topics synthesis failed: ${String(err)}`;
    logger.warn('profile call A failed', { err: String(err) });
    warnings.push(msg);
    partial = true;
  }

  // ── Call B: Stance ── (only if we have topics to ask about)
  let stance: StanceSummary[] = [];
  if (topics.length > 0) {
    try {
      const { system, user } = buildStancePrompt(handle, snippets, topics);
      const res = await _orchestratorDeps.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 1200,
        ...(opts.synthesisModel ? { model: opts.synthesisModel } : {}),
      });
      if (!res.cached) estimatedCostUsd += CHAT_FLAT_COST_USD;
      stance = repairStance(safeJsonParse(res.content));
    } catch (err) {
      const msg = `stance synthesis failed: ${String(err)}`;
      logger.warn('profile call B failed', { err: String(err) });
      warnings.push(msg);
      partial = true;
    }
  }

  // ── Call C: Notable quotes + summary ──
  let notableQuotes: NotableQuote[] = [];
  let summary = '';
  try {
    const { system, user } = buildNotableQuotesPrompt(handle, snippets);
    const res = await _orchestratorDeps.chat({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      jsonMode: true,
      temperature: 0.2,
      maxTokens: 800,
      ...(opts.synthesisModel ? { model: opts.synthesisModel } : {}),
    });
    if (!res.cached) estimatedCostUsd += CHAT_FLAT_COST_USD;
    const parsed = repairNotableQuotes(safeJsonParse(res.content), snippets);
    notableQuotes = parsed.quotes;
    summary = parsed.summary;
  } catch (err) {
    const msg = `notable-quotes synthesis failed: ${String(err)}`;
    logger.warn('profile call C failed', { err: String(err) });
    warnings.push(msg);
    partial = true;
  }

  // Build + validate the report.
  const report: ProfileReport = ProfileReportSchema.parse({
    handle,
    samplingScope: 'cache',
    cachedThreadsAnalyzed,
    cachedCommentsAnalyzed,
    topics,
    stance,
    expertiseAreas,
    notableQuotes,
    summary,
    estimatedCostUsd: round6(estimatedCostUsd),
    partial,
    warnings,
    generatedAt: new Date().toISOString(),
  });

  // 7. Cache write — even partial results are worth caching; the user
  // can override with `--no-cache` to force re-synthesis.
  if (!opts.noCache) {
    try {
      getCacheMod().putCachedProfile(report);
    } catch (err) {
      logger.debug('profile cache write failed (continuing)', { err: String(err) });
    }
  }

  return report;
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// Export for tests.
export { collectSnippetsForHandle as _collectSnippetsForHandle };
export { repairTopics as _repairTopics };
export { repairStance as _repairStance };
export { repairNotableQuotes as _repairNotableQuotes };
export { SNIPPETS_CAP as _SNIPPETS_CAP };
