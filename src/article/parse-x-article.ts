/**
 * P3.0 — X Article body extractor.
 *
 * X serves long-form Articles as a tweet `card` payload with the article
 * content packed into `card.legacy.binding_values`. The exact key set is
 * unstable — X has shipped multiple variants across their Articles
 * rollout. This parser is intentionally conservative:
 *
 *   1. Reads the card via `parseCardBindings()` (already lazy + defensive).
 *   2. Probes a known-good list of keys for each output field, taking the
 *      first non-empty match.
 *   3. Throws `ArticleParseError` when no body text is recoverable so the
 *      orchestrator can escalate or skip rather than emit a body of "".
 *
 * Documented assumed key shapes (any may be missing on a given tweet):
 *   - title:       `title`, `card_title`, `unified_card.title`
 *   - body text:   `body_text`, `article_text`, `article_content`,
 *                  `description`, `summary`
 *   - byline:      `author_name`, `author`, `byline`
 *   - publishedAt: `created_at`, `published_at`
 *   - canonical:   `card_url`, `url`, `article_url`
 *
 * If X ships a new shape (binary content, nested objects, etc.) this
 * parser will return undefined for that field and rely on others — or
 * throw `ArticleParseError` when no body survives. Edge cases beyond the
 * documented shapes are deferred — re-evaluate when real fixtures show
 * the parser missing data.
 */
import { parseCardBindings } from '../fetcher/parser.ts';
import type { ArticleBody } from '../models/article.ts';
import { ArticleParseError } from './detect.ts';

/** Defensive object-ish guard — mirrors parser.ts conventions. */
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Strip HTML tags + collapse whitespace. P3.0 keeps it dumb — no DOM. */
function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/** Pick the first non-empty string from `obj` matching any of `keys`. */
function pick(o: Record<string, string>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Parse an X Article body from a raw tweet card payload.
 *
 * `cardOrTweet` can be either:
 *   - The raw `tweet` GraphQL object (the parser's `unwrapTweetResult` output), OR
 *   - The `tweet.card` sub-object itself, OR
 *   - The `{ card }` envelope we stash in `XPost.raw` (see `parser.ts`).
 *
 * We try `parseCardBindings(input)` first (treats input as a tweet),
 * then walk into `input.card` if that returned nothing. Tolerates the
 * various nesting depths so callers can pass whichever shape they have.
 */
export function parseXArticle(cardOrTweet: unknown): ArticleBody {
  // Attempt 1: input might already be a tweet shape.
  let bindings = parseCardBindings(cardOrTweet);

  // Attempt 2: input is `{ card }` envelope (from XPost.raw).
  if (!bindings && isObj(cardOrTweet) && 'card' in cardOrTweet) {
    bindings = parseCardBindings(cardOrTweet);
  }

  // Attempt 3: input is the card itself — wrap into a fake tweet.
  if (!bindings) {
    bindings = parseCardBindings({ card: cardOrTweet });
  }

  if (!bindings) {
    throw new ArticleParseError('X Article card has no binding_values');
  }

  const title = pick(bindings, ['title', 'card_title', 'article_title']) ?? 'Untitled';
  const byline = pick(bindings, ['author_name', 'author', 'byline']);
  const publishedAt = isoDate(pick(bindings, ['published_at', 'created_at', 'date_published']));

  // Prefer the largest body field. Fall back through summary / description
  // when the long-form text isn't present (some X Article previews only
  // ship a description).
  const rawBody = pick(bindings, [
    'body_text',
    'article_text',
    'article_content',
    'content',
    'body',
    'description',
    'summary',
  ]);

  if (!rawBody) {
    throw new ArticleParseError('X Article card has no body / text content');
  }

  // The X card values tend to be plain text already, but defensively
  // strip any inline HTML so the word count + downstream summarization
  // see clean text.
  const text = plainText(rawBody);
  if (text.length === 0) {
    throw new ArticleParseError('X Article body was empty after sanitization');
  }

  const body: ArticleBody = {
    title,
    wordCount: wordCount(text),
    text,
    contentSource: 'x-article-card',
  };
  if (byline) body.byline = byline;
  if (publishedAt) body.publishedAt = publishedAt;
  return body;
}
